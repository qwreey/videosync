/**
 * The other end of the hop.
 *
 * In the split architecture the engine lives here -- it owns the socket,
 * because a content script cannot reach a self-hosted server (BROWSER-FINDINGS
 * section 9) -- while the `<video>` lives in the content script. Every position
 * the engine judges therefore crosses a message port, and the design resolves
 * position to tens of milliseconds. So: how long is the hop, and how much does
 * it vary?
 *
 * It echoes rather than computes: the content script owns the arithmetic so
 * every timestamp it compares is from a single timebase.
 */
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((m) => {
    if (m.t === 'ping') {
      port.postMessage({
        t: 'pong', seq: m.seq,
        // Date.now() is wall clock and therefore comparable across contexts.
        // performance.now() is NOT: every context has its own time origin, so
        // the two sides cannot subtract each other's values. Sent so the probe
        // can demonstrate that rather than assert it.
        swDate: Date.now(),
        swPerf: performance.now(),
      });
    }
  });
});

chrome.runtime.onMessage.addListener((m, _s, respond) => {
  if (m?.t === 'ping') { respond({ t: 'pong', seq: m.seq, swDate: Date.now(), swPerf: performance.now() }); }
  return false;
});
