/**
 * What is an MV3 content script actually allowed to do?
 *
 * The whole question of whether the browser extension is a thin wrapper around
 * the userscript comes down to this, and every part of it is something the
 * documentation is ambiguous about or has changed on:
 *
 *  - Can the content script open the WebSocket itself? If yes, the sync session
 *    lives as long as the TAB, and MV3's service-worker lifetime -- the reason
 *    the extension was sequenced last -- stops being a risk at all.
 *  - Is a content script's network request governed by the PAGE's CSP, or by
 *    the extension's? Every OTT site's `connect-src` excludes a self-hosted
 *    server, so this decides whether a content script can connect at all.
 *  - Does `host_permissions` still privilege a content script's cross-origin
 *    fetch in MV3, or must it relay through the service worker?
 *  - Does the mixed-content block (measured in BROWSER-FINDINGS section 8) apply
 *    to an extension's requests from an https page?
 */
(() => {
  const SERVER = 'http://127.0.0.1:8788';
  const TLS_SERVER = 'https://127.0.0.1:8789';
  const out = { origin: location.origin, world: 'content-script', results: {} };

  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, err: `timeout: ${label}` }), ms))]);

  async function directFetch(base = SERVER) {
    try {
      const r = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{}' });
      const j = await r.json();
      return { ok: true, roomId: j.roomId };
    } catch (e) {
      return { ok: false, err: `${e.name}: ${e.message}` };
    }
  }

  function relayFetch(base = SERVER) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ t: 'fetch', url: `${base}/api/rooms`, method: 'POST', body: '{}' },
          (r) => res(r ?? { ok: false, err: String(chrome.runtime.lastError?.message) }));
      } catch (e) {
        res({ ok: false, err: String(e) });
      }
    });
  }

  function socket(url) {
    return new Promise((res) => {
      let w;
      try { w = new WebSocket(url); }
      catch (e) { return res({ ok: false, err: `construct: ${e.name}` }); }
      w.onopen = () => { try { w.close(); } catch {} res({ ok: true }); };
      w.onerror = () => res({ ok: false, err: 'error event' });
    });
  }

  async function storage() {
    try {
      await chrome.storage.local.set({ probe: 'yes' });
      const got = await chrome.storage.local.get('probe');
      return { ok: got.probe === 'yes' };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }

  (async () => {
    // Plaintext, from the content script. Mixed content should block this on
    // an https page exactly as it blocks the userscript.
    out.results.directFetchHttp = await withTimeout(directFetch(), 6000, 'directFetchHttp');
    out.results.wsPlain = await withTimeout(socket('ws://127.0.0.1:8788/ws'), 6000, 'wsPlain');

    // Plaintext, relayed through the service worker. The worker runs at a
    // chrome-extension:// origin, which is not the page, so page mixed-content
    // rules should not reach it.
    out.results.relayFetchHttp = await withTimeout(relayFetch(), 6000, 'relayFetchHttp');
    out.results.relayWsPlain = await withTimeout(new Promise((res) => {
      chrome.runtime.sendMessage({ t: 'ws', url: 'ws://127.0.0.1:8788/ws' },
        (r) => res(r ?? { ok: false, err: String(chrome.runtime.lastError?.message) }));
    }), 8000, 'relayWsPlain');

    // TLS -- the shipping configuration. If these pass from the content
    // script, the socket can live in the tab and MV3's service-worker lifetime
    // never has to hold anything.
    out.results.directFetchTls = await withTimeout(directFetch(TLS_SERVER), 6000, 'directFetchTls');
    out.results.wssFromContent = await withTimeout(socket('wss://127.0.0.1:8789/ws'), 8000, 'wss');

    // Discriminators. If an ordinary public https request works from here but
    // 127.0.0.1 does not, the blocker is Private Network Access (the target's
    // ADDRESS), not the page's CSP and not the scheme.
    out.results.publicHttps = await withTimeout((async () => {
      try {
        await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors' });
        return { ok: true };
      } catch (e) { return { ok: false, err: `${e.name}: ${e.message}` }; }
    })(), 6000, 'publicHttps');

    // Does the request reach a listener at all, or does the browser refuse to
    // send it? Both look like a hang from here; only the server can tell.
    out.results.spyFetch = await withTimeout((async () => {
      try {
        await fetch('http://127.0.0.1:8790/spy', { method: 'POST', body: 'x' });
        return { ok: true };
      } catch (e) { return { ok: false, err: `${e.name}: ${e.message}` }; }
    })(), 6000, 'spyFetch');

    out.results.storage = await withTimeout(storage(), 3000, 'storage');
    out.done = true;
    // The page cannot read a content script's variables (isolated world), so
    // the result goes somewhere the CDP driver can see it from the MAIN world.
    document.documentElement.setAttribute('data-videosync-probe', JSON.stringify(out));
  })();
})();
