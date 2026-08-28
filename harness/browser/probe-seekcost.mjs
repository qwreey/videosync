// How much does a seek actually cost, as a function of segment fetch latency?
// The simulation harness treats seeks as free (docs/POC-FINDINGS.md 19), which
// silently flatters every hard-seek strategy. These are the constants that fix
// that.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// localhost / LAN / CDN-ish / poor mobile
const DELAYS = [0, 50, 150, 400];

const br = await launch({ extraFlags: ['--autoplay-policy=no-user-gesture-required'] });
const out = { chromium: br.version, runs: [] };
try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');

  for (const delayMs of DELAYS) {
    for (const kind of ['inBuffer', 'outOfBuffer']) {
      await s.eval(`probe.ctl('reset')`);
      await s.eval('probe.loadHls()');
      await s.eval('probe.play()');
      await sleep(5000);                       // build a buffer at full speed
      await s.eval(`probe.ctl('delayMs=${delayMs}&delayFromSeg=0')`);
      const st = await s.eval('probe.state()');
      const target = kind === 'inBuffer' ? Math.max(0.5, st.ct - 1.0) : 95;
      const r = await s.eval(`probe.measureSeek(${target.toFixed(3)}, { settleMs: 6000 })`);
      out.runs.push({ delayMs, kind, ...r, samples: undefined });
      await s.eval(`probe.ctl('reset')`);
    }
  }
  s.close();
} finally { await br.close(); }
console.log(JSON.stringify(out, null, 2));
