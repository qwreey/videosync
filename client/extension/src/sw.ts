/**
 * The service worker: one WebSocket per connected tab, and nothing else.
 *
 * Deliberately not the engine. Putting the engine here would mean the player's
 * position crossing a message port on every evaluation, and this design
 * resolves position to tens of milliseconds. Keeping the worker a dumb relay
 * means the engine stays beside the `<video>` and the port only carries frames
 * that were already going to cross a network.
 *
 * It also means the worker holds no session state, so a teardown costs a
 * reconnect and nothing else -- the content script's engine already knows how
 * to do that. The one thing it keeps is a device token per server, in its own
 * database (`tokens.ts`), which is state about the browser and not about a
 * session.
 */
import { fetchHttp, makeAuthFetch, serverOrigin } from '@videosync/core/app/authfetch.ts';

import { PORT_NAME, SERVER_KEY } from './relay.ts';
import type { FromWorker, ToWorker, WorkerRequest } from './relay.ts';
import { idbTokens } from './tokens.ts';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let ws: WebSocket | null = null;
  let closedByUs = false;

  const post = (m: FromWorker) => {
    try { port.postMessage(m); } catch { /* the tab went away */ }
  };

  const open = (url: string) => {
    try {
      ws = new WebSocket(url);
    } catch (e) {
      post({ t: 'closed', clean: false, reason: `bad url: ${(e as Error).message}` });
      return;
    }
    ws.addEventListener('open', () => post({ t: 'open.ok' }));
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try {
        post({ t: 'frame', frame: JSON.parse(ev.data) });
      } catch {
        // A malformed frame is not a reason to tear the session down.
      }
    });
    const sock = ws;
    ws.addEventListener('close', (ev: CloseEvent) => {
      ws = null;
      // The URL the socket actually used, which is not always the one asked
      // for: a browser that upgrades ws:// to wss:// reports 1015 and nothing
      // else, and the reason is the only place a user can see it.
      post({ t: 'closed', clean: closedByUs, reason: `${ev.code} ${ev.reason} ${sock.url}`.replace(/\s+/g, ' ') });
    });
    ws.addEventListener('error', () => {
      // `error` on a WebSocket carries nothing useful and is always followed by
      // `close`; reporting both would double every reconnect.
      if (!ws) return;
    });
  };

  port.onMessage.addListener((m: ToWorker) => {
    switch (m.t) {
      case 'open':
        open(m.url);
        break;
      case 'send':
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m.frame));
        break;
      case 'close':
        closedByUs = true;
        ws?.close();
        ws = null;
        break;
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // The tab navigated away or was closed. Dropping the socket here is what
    // lets the room stop holding the readiness gate for a member who is gone.
    closedByUs = true;
    ws?.close();
    ws = null;
  });
});

/**
 * Every HTTP call to the server -- room creation, sign-in, tickets -- is made
 * here, for two reasons. A content script on a public-origin page cannot reach
 * a private address at all. And the device token lives here and only here
 * (`tokens.ts`); the content script gets tickets.
 *
 * This used to fetch whatever `msg.url` said, from the one context that can
 * reach the LAN. Now the URL is built from the server the settings store
 * holds and a fixed path list (`makeAuthFetch`), and a token only ever goes to
 * the origin that issued it.
 */
const authFetch = makeAuthFetch(fetchHttp, idbTokens());

async function storedServer(): Promise<string> {
  const got = await chrome.storage.local.get(SERVER_KEY);
  const v = got[SERVER_KEY];
  return typeof v === 'string' ? v : '';
}

chrome.runtime.onMessage.addListener((msg: WorkerRequest, sender, respond) => {
  // Only our own content scripts; a page cannot message an extension that
  // declares no `externally_connectable`, and this makes that explicit.
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.t) {
    case 'auth': {
      storedServer()
        .then((server) => serverOrigin(server)
          ? authFetch(server, msg.path, msg.req)
          : { status: 0, body: '', error: 'no server configured' })
        .then(respond, (e: unknown) => respond({ status: 0, body: '', error: String(e) }));
      return true; // async response
    }
    case 'openTab': {
      // A login page, from the server's answer. Web URLs only: this is a
      // privileged `tabs.create`, and it must not open an extension page or
      // a `javascript:` one on anybody's say-so.
      if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
        void chrome.tabs.create({ url: msg.url, active: true });
      }
      return false;
    }
    default:
      return false;
  }
});
