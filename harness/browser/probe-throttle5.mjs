// Resolve the contradiction in docs/BROWSER-FINDINGS.md section 5: does a hidden MUTED
// tab keep playing? probe-throttle3 said yes (ratio 1.00), probe-throttle4 said
// no (ratio 0.00). Vary the four things that differed between them, and record
// `paused` this time -- neither earlier run captured it, which is why the
// question is still open.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(s, tabId, port, { dwellMs, poll }) {
  const other = await newTab(port, 'about:blank');
  await fetch(`http://127.0.0.1:${port}/json/activate/${other.id}`);
  await sleep(600);
  const vis = await s.eval('probe.visibility()');
  const before = await s.eval('probe.state()');
  const t0 = Date.now();
  const trace = [];
  while (Date.now() - t0 < dwellMs) {
    await sleep(poll ? 5000 : Math.min(2000, dwellMs));
    if (poll) {
      const st = await s.eval('probe.state()');
      trace.push({ s: +((Date.now() - t0) / 1000).toFixed(0), ct: +st.ct.toFixed(2), paused: st.paused, rs: st.rs });
    }
    if (!poll && Date.now() - t0 >= dwellMs) break;
  }
  const wall = Date.now() - t0;
  const after = await s.eval('probe.state()');
  await fetch(`http://127.0.0.1:${port}/json/activate/${tabId}`);
  await sleep(300);
  await fetch(`http://127.0.0.1:${port}/json/close/${other.id}`);
  return {
    hiddenSeen: vis.visibilityState, wallS: +(wall / 1000).toFixed(1),
    ctBefore: +before.ct.toFixed(2), ctAfter: +after.ct.toFixed(2),
    pausedBefore: before.paused, pausedAfter: after.paused,
    ratio: +((after.ct - before.ct) / (wall / 1000)).toFixed(3),
    rsAfter: after.rs, aheadAfter: +after.ahead.toFixed(1),
    trace,
  };
}

const out = [];
for (const mode of ['hls', 'progressive']) {
  for (const muted of [true, false]) {
    for (const dwellMs of [20000, 60000]) {
      const br = await launch({ headful: true, port: 9900 + Math.floor(Math.random() * 90),
        extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
      try {
        const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
        const s = await new Session(tab.webSocketDebuggerUrl).open();
        await s.send('Runtime.enable');
        await s.waitFor('window.__ready === true');
        await s.eval(mode === 'hls' ? 'probe.loadHls()' : 'probe.loadProgressive()');
        await s.eval(`(() => { document.getElementById('v').muted = ${muted}; })()`);
        const played = await s.eval('probe.play()');
        await sleep(2500);
        const r = await measure(s, tab.id, br.port, { dwellMs, poll: true });
        out.push({ mode, muted, dwellMs, played, ...r });
        s.close();
      } finally { await br.close(); }
    }
  }
}
console.log(JSON.stringify(out, null, 2));
