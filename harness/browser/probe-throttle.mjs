// Does a hidden tab keep a ~10 Hz loop? And does playing audio exempt it?
// Tested in four combinations, because the answer changes the client design:
// if a hidden tab is throttled to 1 Hz, no client-side high-rate authority
// survives; if audible playback exempts it, most of the worry evaporates.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, url) {
  const tab = await newTab(port, url);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  return { tab, s };
}

async function run(label, extraFlags) {
  const br = await launch({ port: 9400 + Math.floor(Math.random() * 100), extraFlags });
  const results = { label, chromium: br.version, flags: extraFlags, cases: [] };
  try {
    const { tab, s } = await connect(br.port, `http://127.0.0.1:${PORT}/page.html`);
    await s.waitFor('window.__ready === true');
    await s.eval('probe.loadHls()');
    await s.eval('probe.play()');
    await sleep(3000);

    for (const audible of [true, false]) {
      await s.eval(`(() => { const v = document.getElementById('v'); v.muted = ${!audible}; })()`);

      // visible
      await fetch(`http://127.0.0.1:${br.port}/json/activate/${tab.id}`);
      await sleep(400);
      const vis = await s.eval('probe.measureTimers(6000, 100)');
      results.cases.push({ audible, wanted: 'visible', ...vis });

      // hidden: bring another tab to the front
      const other = await newTab(br.port, 'about:blank');
      await fetch(`http://127.0.0.1:${br.port}/json/activate/${other.id}`);
      await sleep(600);
      const hid = await s.eval('probe.measureTimers(6000, 100)');
      results.cases.push({ audible, wanted: 'hidden', ...hid });
      await fetch(`http://127.0.0.1:${br.port}/json/close/${other.id}`);
    }
    s.close();
  } finally { await br.close(); }
  return results;
}

const out = [];
// Default flags. Headless Chrome historically disables background throttling,
// so this may not reflect a real browser -- measured and reported either way.
out.push(await run('headless-default', ['--autoplay-policy=no-user-gesture-required']));
// Explicitly ask for the real backgrounding behaviour.
out.push(await run('headless-backgrounding-enabled', [
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=IntensiveWakeUpThrottling',
]));
console.log(JSON.stringify(out, null, 2));
