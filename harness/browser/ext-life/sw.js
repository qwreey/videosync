/**
 * Does an MV3 service worker hold a WebSocket, and for how long?
 *
 * Methodology matters more than usual here, because the obvious probe measures
 * itself:
 *
 *  - Every `chrome.runtime.sendMessage` to the worker IS activity and resets
 *    its idle timer. So after the initial connect the driver never messages the
 *    worker again; the worker writes its own log to `chrome.storage.local` and
 *    the content script reads it with `chrome.storage.local.get`, which does
 *    not wake the worker.
 *  - Module-scope variables are exactly what a teardown destroys, so the log
 *    lives in storage and every entry carries the worker instance that wrote
 *    it. A silently restarted worker is then obvious rather than invisible.
 *  - The worker speaks the real protocol -- create a room, `hello`, then a
 *    periodic `time` frame. A socket the server closes for protocol reasons
 *    would otherwise look exactly like a socket the browser tore down.
 */
const INSTANCE = Math.random().toString(36).slice(2, 8);
const SERVER = 'http://127.0.0.1:8788';
// Flipped by the driver writing storage before the worker starts.
let SILENT = false;
let ws = null;

// Serialised. A read-modify-write on chrome.storage from two handlers at once
// loses entries, and the first run of this probe duly reported `ticks: 0` for a
// worker that was ticking perfectly -- the tick writes were being clobbered by
// the message writes they had themselves caused.
let logChain = Promise.resolve();
function log(event, extra = {}) {
  logChain = logChain.then(async () => {
    const cur = (await chrome.storage.local.get('log')).log || [];
    cur.push({ at: Date.now(), instance: INSTANCE, event, ...extra });
    await chrome.storage.local.set({ log: cur.slice(-2000) });
  }).catch(() => {});
  return logChain;
}

log('worker-start');

async function start() {
  try {
    const r = await fetch(`${SERVER}/api/rooms`, { method: 'POST', body: '{}' });
    const { roomId, secret } = await r.json();
    await log('room-created', { roomId });
    ws = new WebSocket(`ws://127.0.0.1:8788/ws`);
    ws.onopen = () => {
      log('open');
      ws.send(JSON.stringify({ t: 'hello', room: roomId, secret, name: 'sw', mediaKey: 'probe' }));
    };
    ws.onmessage = (e) => {
      const t = (() => { try { return JSON.parse(e.data).t; } catch { return '?'; } })();
      log('message', { frame: t });
    };
    ws.onclose = (e) => { log('close', { code: e.code, reason: String(e.reason).slice(0, 60) }); };
    ws.onerror = () => log('error');

    // A real client heartbeats. A timer in a torn-down worker simply does not
    // fire, so the gap in this log is the measurement.
    if (SILENT) {
      // The control arm: hold the socket and send NOTHING. If it survives this,
      // the socket itself is what keeps the worker alive; if only the traffic
      // arm survives, it is the traffic.
      setInterval(() => log('tick', { readyState: ws ? ws.readyState : null, silent: true }), 10000);
      return;
    }
    setInterval(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: 'time', t0: Date.now() }));
        log('tick', { readyState: ws.readyState });
      } else {
        log('tick', { readyState: ws ? ws.readyState : null });
      }
    }, 10000);
  } catch (e) {
    log('start-failed', { err: String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg?.t === 'start') { SILENT = !!msg.silent; start(); respond({ ok: true, instance: INSTANCE }); }
  return false;
});
