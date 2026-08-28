// Second pass at timer throttling. Two things changed from the first attempt:
// headful under Xvfb (headless may not background renderers at all), and a
// long hidden dwell before measuring, since Chrome's throttling engages on a
// delay rather than immediately.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DWELL_MS = Number(process.env.DWELL_MS || 70000); // > 1 min hidden

async function run({ label, headful, extraFlags, audible }) {
  const br = await launch({ port: 9500 + Math.floor(Math.random() * 200), headful, extraFlags });
  const res = { label, headful, audible, chromium: br.version, cases: [] };
  try {
    const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
    const s = await new Session(tab.webSocketDebuggerUrl).open();
    await s.send('Runtime.enable');
    await s.waitFor('window.__ready === true');
    await s.eval('probe.loadHls()');
    await s.eval(`(() => { document.getElementById('v').muted = ${!audible}; })()`);
    await s.eval('probe.play()');
    await sleep(3000);
    res.playing = await s.eval('probe.state()');

    res.cases.push({ phase: 'visible', ...(await s.eval('probe.measureTimers(6000, 100)')) });

    const other = await newTab(br.port, 'about:blank');
    await fetch(`http://127.0.0.1:${br.port}/json/activate/${other.id}`);
    await sleep(800);
    res.cases.push({ phase: 'hidden-immediate', ...(await s.eval('probe.measureTimers(6000, 100)')) });
    await sleep(DWELL_MS);
    res.cases.push({ phase: `hidden-after-${Math.round(DWELL_MS / 1000)}s`, ...(await s.eval('probe.measureTimers(10000, 100)')) });
    res.afterHidden = await s.eval('probe.state()');
    s.close();
  } finally { await br.close(); }
  return res;
}

const out = [];
for (const audible of [true, false]) {
  out.push(await run({ label: 'headful-xvfb', headful: true, audible,
    extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] }));
}
console.log(JSON.stringify(out, null, 2));
