// End-to-end validation of the shipping detector against a real browser.
// Everything it asserts was derived from measurement; this checks that the
// code actually implements it.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const br = await launch({ headful: true, port: 9611,
  extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
const out = { chromium: br.version, cases: [] };
const step = (m) => process.stderr.write(`[step] ${m}\n`);
const record = (name, expect, got, extra = {}) =>
  out.cases.push({ name, expect, got, pass: JSON.stringify(expect) === JSON.stringify(got), ...extra });

try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');
  step('page ready');
  const activate = async (id) => { await fetch(`http://127.0.0.1:${br.port}/json/activate/${id}`); await sleep(700); };
  // NB: do not open a second tab before the media is loaded. Opening one makes
  // it active, which hides this tab -- and Chrome does not load media in a
  // hidden tab at all, so loadHls() never resolves.

  step('loading hls');
  await s.eval('probe.loadHls()');
  await s.eval('probe.play()');
  await sleep(3000);
  await s.eval('probe.attachDetector()');
  step('detector attached');
  await sleep(500);

  // --- 1. steady playback is not an event ---------------------------------
  await s.eval('probe.detectorReset()');
  await sleep(4000);
  record('steady playback broadcasts nothing', 0,
    (await s.eval('probe.detectorBroadcasts()')).length,
    { kinds: await s.eval('probe.detectorKinds()') });
  step('case1 steady');

  // --- 2. a genuine user seek IS user intent ------------------------------
  await s.eval('probe.detectorReset()');
  step('user seek');
  await s.eval('probe.userSeek(6)');
  await sleep(1500);
  const afterUser = await s.eval('probe.detectorBroadcasts()');
  record('a user seek is broadcast', 'seek',
    afterUser[0]?.kind ?? null, { broadcasts: afterUser });
  step('case2 user seek');

  // --- 3. a server-applied correction is NOT (two-diff echo suppression) ---
  await s.eval('probe.play()'); await sleep(1500);
  await s.eval('probe.detectorReset()');
  step('server correction');
  await s.eval('probe.serverCorrection(5)');
  await sleep(2000);
  const afterServer = await s.eval('probe.detectorBroadcasts()');
  record('a server correction is not rebroadcast', 0, afterServer.length, { broadcasts: afterServer });
  step('case3 server correction');

  // --- 4. a buffering stall is a stall, never a backward seek --------------
  await s.eval('probe.play()'); await sleep(2500);
  await s.eval('probe.detectorReset()');
  step('starving player');
  const seg = await s.eval('(async () => { const st = probe.state(); const n = Math.floor(st.ct/2)+1; await probe.ctl(`delayMs=9000&delayFromSeg=${n}`); return n; })()');
  await sleep(14000);
  await s.eval(`probe.ctl('reset')`);
  const stallKinds = await s.eval('probe.detectorKinds()');
  const stallBroadcasts = await s.eval('probe.detectorBroadcasts()');
  record('a stall is detected as a stall', true, (stallKinds.stall ?? 0) > 0, { kinds: stallKinds, starvedFromSeg: seg });
  record('a stall broadcasts nothing', 0, stallBroadcasts.length, { broadcasts: stallBroadcasts });
  step('case4 stall');

  s.close();
} finally { await br.close(); }

// --- 5. browser suspension is not a user pause -----------------------------
// A separate browser, because Chrome's exemption from background pausing is
// granted once a tab has produced sound and then persists for that tab -- it
// survives reloading the element (measured). Only a session that has never
// been audible can reproduce the case.
{
  const br2 = await launch({ headful: true, port: 9612,
    extraFlags: ['--autoplay-policy=no-user-gesture-required', '--window-size=800,600'] });
  try {
    const tab = await newTab(br2.port, `http://127.0.0.1:${PORT}/page.html`);
    const s2 = await new Session(tab.webSocketDebuggerUrl).open();
    await s2.send('Runtime.enable');
    await s2.waitFor('window.__ready === true');
    await s2.eval('probe.loadHls()');
    await s2.eval('probe.setMuted(true)');   // muted BEFORE play: never audible
    await s2.eval('probe.play()');
    await sleep(3000);
    await s2.eval('probe.attachDetector()');
    await s2.eval('probe.detectorReset()');
    step('suspension: hiding a never-audible tab');

    const other = await newTab(br2.port, 'about:blank');
    await fetch(`http://127.0.0.1:${br2.port}/json/activate/${other.id}`);
    await sleep(700);
    const vis = await s2.eval('probe.visibility()');
    if (vis.visibilityState !== 'hidden') throw new Error(`tab did not hide: ${JSON.stringify(vis)}`);
    await sleep(5000);
    out.suspendState = await s2.eval('probe.state()');
    const kinds = await s2.eval('probe.detectorKinds()');
    const bc = await s2.eval('probe.detectorBroadcasts()');
    record('a never-audible hidden tab is detected as suspension', true, (kinds.suspended ?? 0) > 0, { kinds });
    record('suspension broadcasts nothing', 0, bc.length, { broadcasts: bc });
    step('case5 suspension');

    await fetch(`http://127.0.0.1:${br2.port}/json/activate/${tab.id}`);
    await sleep(3000);
    const resumeBc = await s2.eval('probe.detectorBroadcasts()');
    record('resuming from suspension broadcasts nothing', 0, resumeBc.length, { broadcasts: resumeBc });
    s2.close();
  } finally { await br2.close(); }
}

const failed = out.cases.filter((c) => !c.pass);
console.log(JSON.stringify(out, null, 2));
if (failed.length) process.exitCode = 1;
