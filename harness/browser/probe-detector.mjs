// End-to-end validation of the shipping detector against a real browser.
// Everything it asserts was derived from measurement; this checks that the
// code actually implements it.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const br = await launch({ headful: true, port: 9611,
  extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
const out = { chromium: br.version, cases: [] };
const record = (name, expect, got, extra = {}) =>
  out.cases.push({ name, expect, got, pass: JSON.stringify(expect) === JSON.stringify(got), ...extra });

try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');
  const other = await newTab(br.port, 'about:blank');
  const activate = async (id) => { await fetch(`http://127.0.0.1:${br.port}/json/activate/${id}`); await sleep(700); };

  await s.eval('probe.loadHls()');
  await s.eval('probe.play()');
  await sleep(3000);
  await s.eval('probe.attachDetector()');
  await sleep(500);

  // --- 1. steady playback is not an event ---------------------------------
  await s.eval('probe.detectorReset()');
  await sleep(4000);
  record('steady playback broadcasts nothing', 0,
    (await s.eval('probe.detectorBroadcasts()')).length,
    { kinds: await s.eval('probe.detectorKinds()') });

  // --- 2. a genuine user seek IS user intent ------------------------------
  await s.eval('probe.detectorReset()');
  await s.eval('probe.userSeek(6)');
  await sleep(1500);
  const afterUser = await s.eval('probe.detectorBroadcasts()');
  record('a user seek is broadcast', 'seek', afterUser[0]?.kind ?? null, { broadcasts: afterUser });

  // --- 3. a server-applied correction is NOT (two-diff echo suppression) ---
  await s.eval('probe.play()'); await sleep(1500);
  await s.eval('probe.detectorReset()');
  await s.eval('probe.serverCorrection(5)');
  await sleep(2000);
  const afterServer = await s.eval('probe.detectorBroadcasts()');
  record('a server correction is not rebroadcast', 0, afterServer.length, { broadcasts: afterServer });

  // --- 4. a buffering stall is a stall, never a backward seek --------------
  await s.eval('probe.play()'); await sleep(2500);
  await s.eval('probe.detectorReset()');
  const seg = await s.eval('(async () => { const st = probe.state(); const n = Math.floor(st.ct/2)+1; await probe.ctl(`delayMs=9000&delayFromSeg=${n}`); return n; })()');
  await sleep(14000);
  await s.eval(`probe.ctl('reset')`);
  const stallKinds = await s.eval('probe.detectorKinds()');
  const stallBroadcasts = await s.eval('probe.detectorBroadcasts()');
  record('a stall is detected as a stall', true, (stallKinds.stall ?? 0) > 0, { kinds: stallKinds, starvedFromSeg: seg });
  record('a stall broadcasts nothing', 0, stallBroadcasts.length, { broadcasts: stallBroadcasts });

  // --- 5. browser suspension is not a user pause --------------------------
  await s.eval('probe.play()'); await sleep(3000);
  await s.eval('probe.setMuted(true)');
  await s.eval('probe.detectorReset()');
  await activate(other.id);              // hide -> Chrome pauses the muted element
  await sleep(4000);
  const suspKinds = await s.eval('probe.detectorKinds()');
  const suspBroadcasts = await s.eval('probe.detectorBroadcasts()');
  const suspCounters = await s.eval('probe.detectorCounters()');
  record('hidden+muted is detected as suspension', true, (suspKinds.suspended ?? 0) > 0,
    { kinds: suspKinds, counters: suspCounters });
  record('suspension broadcasts nothing', 0, suspBroadcasts.length, { broadcasts: suspBroadcasts });

  await activate(tab.id);                // show again -> Chrome fires `play`
  await sleep(3000);
  const resumeBroadcasts = await s.eval('probe.detectorBroadcasts()');
  record('resuming from suspension broadcasts nothing', 0, resumeBroadcasts.length,
    { broadcasts: resumeBroadcasts });

  s.close();
} finally { await br.close(); }

const failed = out.cases.filter((c) => !c.pass);
console.log(JSON.stringify(out, null, 2));
if (failed.length) process.exitCode = 1;
