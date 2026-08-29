// The service worker exists only to answer the "must a content script relay
// through me?" question. It does nothing else.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.t === 'fetch') {
    fetch(msg.url, { method: msg.method || 'GET', body: msg.body })
      .then((r) => r.text().then((text) => respond({ ok: true, status: r.status, text })))
      .catch((e) => respond({ ok: false, err: String(e) }));
    return true; // async response
  }
  if (msg?.t === 'ws') {
    // Can the WORKER hold a socket the content script is not allowed to open?
    // If so, a plaintext localhost server is usable by an extension even
    // though it is not usable by a userscript -- at the price of putting the
    // session on the worker's lifetime instead of the tab's.
    let w;
    try { w = new WebSocket(msg.url); }
    catch (e) { respond({ ok: false, err: `construct: ${e.name}` }); return false; }
    const t = setTimeout(() => respond({ ok: false, err: 'timeout' }), 5000);
    w.onopen = () => { clearTimeout(t); try { w.close(); } catch {} respond({ ok: true }); };
    w.onerror = () => { clearTimeout(t); respond({ ok: false, err: 'error event' }); };
    return true;
  }
  return false;
});
