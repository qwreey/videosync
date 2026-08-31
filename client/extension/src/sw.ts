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
import { PORT_NAME } from './relay.ts';
import type { FromWorker, ToWorker } from './relay.ts';

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
    ws.addEventListener('close', (ev: CloseEvent) => {
      ws = null;
      post({ t: 'closed', clean: closedByUs, reason: `${ev.code} ${ev.reason}` });
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
 * make that call to a private address either -- so it is relayed too.
 */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.t !== 'createRoom') return false;
  fetch(msg.url, { method: 'POST', body: msg.body })
    .then(async (r) => respond({ ok: r.ok, status: r.status, body: await r.text() }))
    .catch((e) => respond({ ok: false, status: 0, body: '', error: String(e) }));
  return true; // async response
});
