// Risk-B probe 1: seek cost, and what a real MSE stall looks like.
// These numbers parameterise the simulation harness (docs/POC-FINDINGS.md 19:
// "seeks are free" is the most misleading gap in it) and validate the stall
// signature the detector design rests on.
import { launch, newTab, Session } from './cdp.mjs';

const PORT = Number(process.env.PORT || 8899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { chromium: null, progressive: {}, hls: {} };

// Autoplay is deliberately allowed here: the rejection path is a separate
// measurement (probe-autoplay.mjs) and with it enabled nothing ever plays, so
// every seek number would describe a paused element instead of a playing one.
const br = await launch({ extraFlags: ['--autoplay-policy=no-user-gesture-required'] });
out.chromium = br.version;
try {
  const tab = await newTab(br.port, `http://127.0.0.1:${PORT}/page.html`);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true');

  for (const mode of ['progressive', 'hls']) {
    const bucket = out[mode];
    bucket.load = await s.eval(mode === 'hls' ? 'probe.loadHls()' : 'probe.loadProgressive()');
    bucket.play = await s.eval('probe.play()');
    await sleep(4000); // let it actually play and build a buffer
    if (!(await s.eval('probe.state()')).ct) throw new Error(`${mode}: never advanced -- autoplay still blocked?`);
    bucket.afterPlay = await s.eval('probe.state()');

    // --- M1/M2: seek cost, in-buffer vs far out of buffer -----------------
    const st = await s.eval('probe.state()');
    const near = Math.max(0.5, st.ct - 1.0);          // certainly buffered, behind the head
    bucket.seekInBuffer = await s.eval(`probe.measureSeek(${near.toFixed(3)})`);
    await s.eval('probe.play()'); await sleep(1500);
    bucket.seekOutOfBuffer = await s.eval('probe.measureSeek(95)');
    await s.eval('probe.play()'); await sleep(2000);

    // --- M3: the stall signature (hls only -- progressive cannot starve) ---
    if (mode === 'hls') {
      const stall = await s.eval('probe.observeStall({ delayMs: 9000, watchMs: 14000 })');
      const { samples, ...rest } = stall;
      bucket.stall = rest;
      // Keep a thin trace around the freeze for the writeup.
      bucket.stallEvents = rest.events;
      bucket.stallTrace = samples
        .filter((r) => rest.frozenStartMs !== null && r.t >= rest.frozenStartMs - 300 && r.t <= rest.frozenStartMs + rest.frozenMs + 400)
        .filter((_, i) => i % 5 === 0)
        .slice(0, 24);
    }
  }
  s.close();
} finally {
  await br.close();
}
console.log(JSON.stringify(out, null, 2));
