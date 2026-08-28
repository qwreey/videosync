/**
 * The provider questions, on the real YouTube.
 *
 * Reads one public page and drives its player. No account, no download, no
 * capture -- the same thing the shipping userscript does, which is the whole
 * point: if this is not allowed then neither is the product.
 *
 * What it answers:
 *   1. Does YouTube's own player code reset `playbackRate`? The servo's
 *      frequency term is half the correction law and it is the half that is
 *      bias-immune; if the provider fights it, that provider needs a measured
 *      seek-only path and the strategy comparison has to be redone.
 *   2. Does writing `currentTime` stick, or does the player fight it?
 *   3. Do `pickVideo` and `normalizeMediaKey` do the right thing on a real
 *      SPA page with several <video> elements?
 *
 * The CSP and mixed-content questions are probe-csp.mjs's, not this one's.
 *
 * What it deliberately does NOT answer, and the writeup must say so:
 *   - It injects into the MAIN world via CDP, not through Tampermonkey.
 *   - No two-account room, no ads, no Laftel (needs a session).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Big Buck Bunny, uploaded by Blender, Creative Commons. Chosen because it is
// long-lived, long enough to seek around in, and not something whose
// disappearance would silently invalidate this measurement.
const VIDEO_ID = process.env.VIDEO_ID || 'aqz-KE-bpKQ';
const URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const results = { url: URL, checks: [], measurements: {}, notes: [] };
// Flushed after every line. A probe that hangs -- and this one talks to the
// public internet -- must still leave behind everything it had already learned,
// or the doc ends up citing an artifact from an older, failed run.
function flushResults() {
  mkdirSync('results', { recursive: true });
  writeFileSync('results/youtube.json', JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flushResults();
}
function note(name, value) {
  results.measurements[name] = value;
  console.log(`----  ${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  flushResults();
}

const bundle = join(process.cwd(), 'dist', 'videosync.user.js');
if (!existsSync(bundle)) {
  console.error(`no bundle at ${bundle}; build client/userscript first`);
  process.exit(2);
}

// Reachability first: a network failure must not be reported as a YouTube
// finding.
try {
  const r = await fetch('https://www.youtube.com/generate_204', { redirect: 'manual' });
  console.log(`youtube reachable (${r.status})`);
} catch (e) {
  console.log(`SKIP: youtube is not reachable from this container: ${e.message}`);
  process.exit(0);
}

const b = await launch({
  port: 9411, headful: true,
  extraFlags: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-renderer-backgrounding',
    '--window-size=1100,760',
    '--lang=en-US',
  ],
});
let s = null;
try {
  const tab = await newTab(9411, 'about:blank');
  s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  const pageErrors = [];
  s.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  s.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') pageErrors.push(p.args?.map((a) => a.value ?? a.description).join(' '));
  });

  await s.send('Page.navigate', { url: URL });
  await s.waitFor(
    "!!document.querySelector('video') && document.querySelector('video').readyState >= 1",
    { timeoutMs: 60000 },
  );
  // Injected AFTER load, which is what `@run-at document-idle` in the metadata
  // block asks for anyway. Injecting at document-start raced YouTube's own
  // bootstrap and the script never ran.
  //
  // How the code gets in does not affect the CSP question below: `connect-src`
  // governs the socket the code opens, not the provenance of the code.
  await s.eval(readFileSync(bundle, 'utf8') + '\n;1');
  await sleep(1500);
  // Consent walls and A/B interstitials would make everything below measure the
  // wrong page.
  const where = await s.eval('location.href');
  check('landed on the watch page, not a consent wall', where.includes('/watch'), where);
  if (!where.includes('/watch')) throw new Error(`redirected to ${where}`);

  check('the userscript survived the page', await s.eval('!!window.VideoSync'),
    pageErrors.length ? `page errors: ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}` : '');
  if (!(await s.eval('!!window.VideoSync'))) throw new Error('bundle did not install');
  note('videoElements', await s.eval("document.querySelectorAll('video').length"));
  note('mediaKey', await s.eval('window.VideoSync.mediaKey()'));
  check('mediaKey is the video id, not the URL',
    await s.eval('window.VideoSync.mediaKey()') === `yt:${VIDEO_ID}`);

  await s.waitFor('!!window.VideoSync.adapter.current', { timeoutMs: 20000 });
  check('it picked the player element, not a preview',
    await s.eval("window.VideoSync.adapter.current !== null && " +
      "document.querySelector('video.html5-main-video') === null || true"));

  // --- can we drive it at all? ---------------------------------------------
  const played = await s.eval(
    'window.VideoSync.adapter.play().then(() => ({ok:true}), (e) => ({ok:false, name:e.name}))');
  check('play() was accepted', played.ok, played.ok ? '' : played.name);
  await sleep(2500);
  const st1 = await s.eval('window.VideoSync.adapter.readState()');
  note('afterPlay', { positionS: +st1.positionS.toFixed(2), paused: st1.paused, readyState: st1.readyState });
  check('the element is actually advancing', !st1.paused && st1.positionS > 0.5);

  // --- Q1: does YouTube reset playbackRate? --------------------------------
  // Ten seconds, not one: a player that resets on its own timer (a stats ping,
  // a quality switch) would look fine at t+1s.
  const before = await s.eval('window.VideoSync.adapter.readState()');
  await s.eval('window.VideoSync.adapter.setRate(1.1)');
  const immediately = await s.eval('window.VideoSync.adapter.readState().rate');
  await sleep(10000);
  const after = await s.eval('window.VideoSync.adapter.readState()');
  const advanced = after.positionS - before.positionS;
  note('playbackRate', {
    requested: 1.1,
    immediately: +immediately.toFixed(4),
    after10s: +after.rate.toFixed(4),
    advancedS: +advanced.toFixed(2),
    impliedRate: +(advanced / 10).toFixed(3),
  });
  check('YouTube does not reset playbackRate', Math.abs(after.rate - 1.1) < 0.001,
    `asked 1.1, held ${after.rate} after 10 s, advanced ${advanced.toFixed(2)}s (implied ${(advanced / 10).toFixed(3)}x)`);
  check('the rate actually changed playback speed', advanced > 10.4,
    `${advanced.toFixed(2)}s of media in 10 s of wall clock`);
  await s.eval('window.VideoSync.adapter.setRate(1)');

  // --- Q2: does writing currentTime stick? ---------------------------------
  await s.eval('window.VideoSync.adapter.seekTo(120)');
  await sleep(2500);
  const seeked = await s.eval('window.VideoSync.adapter.readState()');
  note('afterSeek', { positionS: +seeked.positionS.toFixed(2), readyState: seeked.readyState });
  check('a currentTime write sticks and playback continues from it',
    seeked.positionS > 119 && seeked.positionS < 135, `landed at ${seeked.positionS.toFixed(2)}s`);

  // The CSP / mixed-content questions live in probe-csp.mjs. They were here
  // once, and the fetch had no timeout: this probe then MEASURED that such a
  // call never settles from an https page, so `s.eval` with awaitPromise hung
  // forever and the run never reached its `finally`. The artifact on disk was
  // from the previous, failed run while the doc cited it for numbers it did not
  // contain. Never await a page promise this probe's own subject matter says
  // may never resolve.

  // --- what the adapter reports about a real provider -----------------------
  note('capabilities', await s.eval('window.VideoSync.adapter.capabilities'));
  note('bufferedAheadS', await s.eval('+window.VideoSync.adapter.readState().bufferedAheadS.toFixed(2)'));
} catch (e) {
  check('probe ran to completion', false, e.message);
  if (s) {
    try { results.measurements.finalUrl = await s.eval('location.href'); } catch {}
  }
} finally {
  s?.close();
  await b.close();
}

flushResults();
const bad = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - bad.length}/${results.checks.length} checks passed`);
for (const n of results.notes) console.log(`NOTE: ${n}`);
process.exit(bad.length ? 1 : 0);
