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
 * to do that.
 */
import { grantedOrigins, syncContentScripts } from './dynamic.ts';
import { PORT_NAME, providersPath } from './relay.ts';
import type { FetchReply, FromWorker, SyncReply, ToWorker, WorkerRequest } from './relay.ts';

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
 * Room creation is HTTP, and a content script on a public-origin page cannot
 * make that call to a private address either -- so it is relayed too. So is
 * the provider index, for the same reason, and only that: this worker can
 * reach addresses the page cannot, so it fetches nothing a caller names
 * beyond the two provider paths.
 */
chrome.runtime.onMessage.addListener((msg: WorkerRequest, sender, respond) => {
  // Only our own pages and content scripts can reach this listener at all
  // (no `externally_connectable`); the check is for a future manifest edit.
  if (sender.id !== chrome.runtime.id) return false;
  const reply = (p: Promise<unknown>) => {
    p.then(respond, (e) => respond({ ok: false, status: 0, body: '', error: String(e) } satisfies FetchReply));
  };
  switch (msg?.t) {
    case 'createRoom':
      reply(fetch(msg.url, { method: 'POST', body: msg.body })
        .then(async (r): Promise<FetchReply> => ({ ok: r.ok, status: r.status, body: await r.text() })));
      return true; // async response
    case 'providers.fetch': {
      let url: URL;
      try {
        url = new URL(msg.path, msg.server);
      } catch {
        respond({ ok: false, status: 0, body: '', error: 'bad server URL' } satisfies FetchReply);
        return false;
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !providersPath(url.pathname) || url.search) {
        respond({ ok: false, status: 0, body: '', error: 'not a provider path' } satisfies FetchReply);
        return false;
      }
      reply(fetch(url, { cache: 'no-cache' })
        .then(async (r): Promise<FetchReply> => ({ ok: r.ok, status: r.status, body: await r.text() })));
      return true;
    }
    case 'providers.granted':
      reply(grantedOrigins().then((origins) => ({ origins })));
      return true;
    case 'providers.sync':
      reply(syncContentScripts().then(
        (patterns): SyncReply => ({ patterns }),
        (e): SyncReply => ({ patterns: [], error: String(e) })));
      return true;
    default:
      return false;
  }
});

// The registration follows the stored descriptors and the granted hosts,
// whichever changed and from wherever. Firefox's MV2 registration also has to
// be redone every time this background starts.
const resync = () => { syncContentScripts().catch(() => { /* the options page reports its own sync */ }); };
chrome.permissions?.onAdded?.addListener(resync);
chrome.permissions?.onRemoved?.addListener(resync);
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('videosync.providers.'))) resync();
});
resync();
