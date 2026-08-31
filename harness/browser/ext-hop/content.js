/**
 * Measures the content-script <-> service-worker hop from ONE timebase.
 *
 * The round trip is measured entirely in this context's performance.now(), so
 * it is precise and needs no shared clock. The one-way delay is measured with
 * Date.now(), which is wall clock and comparable across contexts but only has
 * millisecond granularity -- enough to say "under a millisecond or two", which
 * is the question.
 *
 * What matters for the design is not the mean delay (a timestamped report can
 * be compensated for a constant) but the SPREAD: an engine extrapolating a
 * reported position forward is wrong by the jitter, times the playback rate.
 */
(async () => {
  const N = Number(new URLSearchParams(location.hash.slice(1)).get('n') || 400);
  const GAP = 50;
  const out = { origin: location.origin, n: N, gapMs: GAP, port: [], sendMessage: [], idle: [] };

  const port = chrome.runtime.connect({ name: 'hop' });
  const pending = new Map();
  port.onMessage.addListener((m) => {
    const p = pending.get(m.seq);
    if (!p) return;
    pending.delete(m.seq);
    p.resolve({ rttMs: performance.now() - p.t0perf, oneWayMs: m.swDate - p.t0date, swPerf: m.swPerf });
  });

  const ping = (seq) => new Promise((resolve) => {
    const rec = { resolve, t0perf: performance.now(), t0date: Date.now() };
    pending.set(seq, rec);
    port.postMessage({ t: 'ping', seq });
    setTimeout(() => { if (pending.delete(seq)) resolve(null); }, 5000);
  });

  const sendMsg = (seq) => new Promise((resolve) => {
    const t0perf = performance.now(), t0date = Date.now();
    chrome.runtime.sendMessage({ t: 'ping', seq }, (m) => {
      if (!m) return resolve(null);
      resolve({ rttMs: performance.now() - t0perf, oneWayMs: m.swDate - t0date });
    });
  });

  // Warm up: the first message after the worker starts pays its bootstrap.
  for (let i = 0; i < 5; i++) await ping(-i - 1);

  for (let i = 0; i < N; i++) {
    const r = await ping(i);
    if (r) out.port.push(r);
    if (i % 4 === 0) {
      const s = await sendMsg(10000 + i);
      if (s) out.sendMessage.push(s);
    }
    await new Promise((r2) => setTimeout(r2, GAP));
  }

  // How expensive is the first hop after a quiet period? If the worker is torn
  // down while idle, this is where it shows up -- and in the real design the
  // socket is what keeps it alive, so a large number here is an argument for
  // never letting the socket go quiet.
  for (const quietMs of [1000, 5000, 15000, 45000]) {
    await new Promise((r2) => setTimeout(r2, quietMs));
    const r = await ping(90000 + quietMs);
    if (r) out.idle.push({ quietMs, rttMs: r.rttMs, oneWayMs: r.oneWayMs });
  }

  // Demonstrate, rather than assert, that performance.now() is not shared.
  const probe = await ping(99999);
  out.perfOriginsDiffer = probe ? { csPerf: performance.now(), swPerf: probe.swPerf } : null;

  out.done = true;
  document.documentElement.setAttribute('data-hop', JSON.stringify(out));
})();
