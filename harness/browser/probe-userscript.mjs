/**
 * Risk B, the real thing: the shipped userscript bundle, in a real Chromium,
 * against a real videosyncd, with two independent browsers in one room.
 *
 * Everything before this validated one layer at a time -- the Go harness
 * simulated clients, the engine tests scripted a transport, the e2e test used a
 * fake player. This is the first run where every layer is the shipping one:
 * a real MSE player, the real detector, the real WebSocket, the real server.
 *
 * Two SEPARATE browser processes, not two tabs. A background tab is throttled
 * and -- if its playback was never audible -- paused outright by the browser
 * (docs/BROWSER-FINDINGS.md §5), which would be measuring that finding again
 * instead of measuring sync. Separate processes with non-overlapping windows,
 * plus the backgrounding flags, keep both renderers foreground-live so what is
 * left is the sync behaviour.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch, newTab, Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = process.env.PORT || 8899;
const SYNC_PORT = 8788;
const PAGE = `http://127.0.0.1:${MEDIA}/sync-page.html`;
const SERVER = `http://127.0.0.1:${SYNC_PORT}`;

const results = { checks: [], measurements: {} };
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// --- the server -------------------------------------------------------------

const bin = join(process.cwd(), 'dist', 'videosyncd');
if (!existsSync(bin)) {
  console.error(`no videosyncd at ${bin}\n` +
    'Build it on the host first:\n' +
    '  cd server && go build -o ../harness/browser/dist/videosyncd ./cmd/videosyncd');
  process.exit(2);
}
const server = spawn(bin, ['-addr', `127.0.0.1:${SYNC_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

for (let i = 0; ; i++) {
  try { if ((await fetch(`${SERVER}/healthz`)).ok) break; } catch { /* not up yet */ }
  if (i > 60) { console.error('videosyncd never listened\n' + serverLog); process.exit(2); }
  await sleep(100);
}
console.log(`videosyncd up on ${SERVER}`);

// --- two browsers -----------------------------------------------------------

const FLAGS = (x) => [
  '--autoplay-policy=no-user-gesture-required',
  // See the header: we are measuring sync here, not the backgrounding rules
  // that §4 and §5 already measured.
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--window-size=600,420',
  `--window-position=${x},0`,
];

const browsers = [];
const peers = [];
async function openPeer(name, port, x) {
  const b = await launch({ port, headful: true, extraFlags: FLAGS(x) });
  browsers.push(b);
  const tab = await newTab(port, PAGE);
  const s = await new Session(tab.webSocketDebuggerUrl).open();
  await s.send('Runtime.enable');
  await s.waitFor('window.__ready === true && !!window.VideoSync');
  const media = await s.eval('window.page.loadHls()');
  peers.push({ name, s, b });
  return { s, media };
}

let failed = false;
try {
  const a = await openPeer('a', 9401, 0);
  const b = await openPeer('b', 9402, 620);
  check('the userscript loaded and found the element in both browsers',
    await a.s.eval('!!window.VideoSync.adapter.current') && await b.s.eval('!!window.VideoSync.adapter.current'));
  check('both are playing real MSE media', a.media.usingMSE && b.media.usingMSE,
    `duration ${a.media.duration?.toFixed(1)}s`);

  const key = await a.s.eval('window.VideoSync.mediaKey()');
  check('both derived the same mediaKey', key === await b.s.eval('window.VideoSync.mediaKey()'), key);

  // --- playbackRate: the open question the servo leans on --------------------
  // Measured BEFORE joining, deliberately. The servo nudges the rate itself, so
  // a measurement taken inside a room measures the corrector, not the player.
  // (The first version of this probe did exactly that and read 0.994 while
  // asking for 1.1.)
  await a.s.eval("window.page.userSeek(2)");
  await a.s.eval('window.page.userPlay()');
  // Wait until it is genuinely advancing before starting the window. Measuring
  // from the instant play() resolves includes the start-up stall and reads a
  // rate of 1.01 for a player that is faithfully doing 1.1 -- which is a
  // measurement bug, not a provider finding, and it flaked exactly that way
  // once.
  await a.s.eval(`(async () => {
    for (let i = 0; i < 60; i++) {
      const a1 = window.page.el().ct;
      await new Promise(r => setTimeout(r, 200));
      const a2 = window.page.el().ct;
      if (!window.page.el().paused && window.page.el().rs >= 3 && a2 - a1 > 0.15) return true;
    }
    return false;
  })()`);
  const rateWindowMs = 5000;
  const rateBefore = await a.s.eval('window.page.el()');
  await a.s.eval('window.VideoSync.adapter.setRate(1.1)');
  await sleep(rateWindowMs);
  const rateAfter = await a.s.eval('window.page.el()');
  const advanced = rateAfter.ct - rateBefore.ct;
  const implied = advanced / (rateWindowMs / 1000);
  results.measurements.rateNudge = {
    requested: 1.1, held: +rateAfter.rate.toFixed(4),
    windowMs: rateWindowMs, advancedS: +advanced.toFixed(3), impliedRate: +implied.toFixed(3),
  };
  check('playbackRate is honoured and holds on a real MSE player',
    Math.abs(rateAfter.rate - 1.1) < 0.001 && implied > 1.05,
    `rate stayed ${rateAfter.rate}, advanced ${advanced.toFixed(2)}s in ${rateWindowMs / 1000}s ` +
    `(implied ${implied.toFixed(3)}x)`);
  await a.s.eval('window.VideoSync.adapter.setRate(1)');
  await a.s.eval('window.page.userPause()');

  // --- join -----------------------------------------------------------------
  const room = await a.s.eval(`window.VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await a.s.waitFor("window.VideoSync.status().state === 'joined'");
  await b.s.eval(
    `window.VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ` +
    `${JSON.stringify(room.secret)}, 'b')`);
  await b.s.waitFor("window.VideoSync.status().state === 'joined'");
  check('two browsers joined one room', true, room.roomId);

  await a.s.waitFor('window.VideoSync.engine().clock.ready');
  await b.s.waitFor('window.VideoSync.engine().clock.ready');
  const rttA = await a.s.eval('window.VideoSync.engine().clock.rttMs');
  results.measurements.loopbackRttMs = rttA;
  check('the clock settled from real round trips', rttA >= 0 && rttA < 100, `bestRTT ${rttA} ms`);

  // --- a real play, applied by both at one instant ---------------------------
  await a.s.eval("window.VideoSync.engine().seek(20)");
  await a.s.waitFor('window.VideoSync.status().seq >= 1');
  await b.s.waitFor('window.VideoSync.status().seq >= 1');
  await a.s.eval("window.VideoSync.engine().play()");
  await a.s.waitFor('!window.page.el().paused', { timeoutMs: 8000 });
  await b.s.waitFor('!window.page.el().paused', { timeoutMs: 8000 });
  check('a play by one member started both', true);

  await sleep(4000);
  // Sample both as close together as possible and correct for the gap: a CDP
  // round trip is ~1 ms here, but saying so is cheaper than assuming it.
  const t0 = Date.now();
  const ea = await a.s.eval('window.page.el()');
  const tMid = Date.now();
  const eb = await b.s.eval('window.page.el()');
  const skewMs = Date.now() - tMid + (tMid - t0);
  const gapMs = Math.abs(ea.ct - eb.ct) * 1000;
  results.measurements.playbackGapMs = +gapMs.toFixed(1);
  results.measurements.samplingSkewMs = skewMs;
  check('the two players stayed together', gapMs < 400,
    `${gapMs.toFixed(0)} ms apart (sampling skew ${skewMs} ms), a=${ea.ct.toFixed(3)}s b=${eb.ct.toFixed(3)}s`);

  // The originator being CMD_DELAY ahead of everyone else is exactly what the
  // ack-carries-`when` rule prevents, and it is invisible from the server.
  const statsA = await a.s.eval('window.VideoSync.status().stats');
  results.measurements.senderAcks = statsA.acksApplied;
  check('the sender scheduled its own command against the ack', statsA.acksApplied >= 2,
    `${statsA.acksApplied} acks applied`);

  // --- a real user pause propagates, and does not echo ----------------------
  const cmdsB0 = (await b.s.eval('window.VideoSync.status().stats')).cmdsSent;
  await a.s.eval('window.page.userPause()');
  await b.s.waitFor('window.page.el().paused', { timeoutMs: 8000 });
  check('a pause on the element itself reached the other browser', true);
  await sleep(1200);
  const cmdsB1 = (await b.s.eval('window.VideoSync.status().stats')).cmdsSent;
  check('the receiver did not echo the pause back', cmdsB1 === cmdsB0,
    `b sent ${cmdsB1 - cmdsB0} commands while applying a remote pause`);

  // --- a real user seek propagates ------------------------------------------
  await a.s.eval('window.page.userSeek(60)');
  let dragOk = true;
  try {
    // Generous: b's seek lands outside its buffer, so it pays a segment fetch
    // before `seeked` resolves (BROWSER-FINDINGS §2).
    await b.s.waitFor('Math.abs(window.page.el().ct - 60) < 3', { timeoutMs: 20000 });
  } catch {
    dragOk = false;
  }
  const eb2 = await b.s.eval('window.page.el()');
  const sbDrag = await b.s.eval('window.VideoSync.status()');
  check('a scrubber drag on one element moved the other', dragOk,
    `b at ${eb2.ct.toFixed(2)}s rs=${eb2.rs} seq=${sbDrag.seq} (a sent ` +
    `${(await a.s.eval('window.VideoSync.status().stats')).cmdsSent} commands)`);

  // --- the readiness gate, over the real wire -------------------------------
  await a.s.eval('window.page.userPause()');
  await b.s.waitFor('window.page.el().paused', { timeoutMs: 8000 });
  await sleep(500);
  // Starve b from its next segment so it cannot buffer.
  const seg = Math.floor((await b.s.eval('window.page.el()')).ct / 2) + 1;
  await b.s.eval(`window.page.ctl('delayMs=12000&delayFromSeg=${seg}')`);
  await b.s.eval('window.page.userSeek(100)');   // seek b out of its buffer
  await b.s.waitFor('window.page.el().rs < 3', { timeoutMs: 12000 });
  await a.s.waitFor('window.VideoSync.status().waitingOn.length > 0', { timeoutMs: 12000 });
  check('the room saw the buffering member', true);

  await a.s.eval('window.VideoSync.engine().play()');
  await sleep(2500);   // longer than CMD_DELAY: it must still not have started
  const heldA = await a.s.eval('window.page.el()');
  check('the gate held the play for the buffering member', heldA.paused,
    `a is ${heldA.paused ? 'still paused' : 'PLAYING WITHOUT b'}`);

  await b.s.eval("window.page.ctl('reset')");
  await a.s.waitFor('!window.page.el().paused', { timeoutMs: 25000 });
  await b.s.waitFor('!window.page.el().paused', { timeoutMs: 25000 });
  check('the held play was released once the member recovered', true);

  // --- nobody sent malformed frames -----------------------------------------
  const sa = await a.s.eval('window.VideoSync.status().stats');
  const sb = await b.s.eval('window.VideoSync.status().stats');
  results.measurements.stats = { a: sa, b: sb };
  check('no frame was rejected as malformed', sa.badFrames === 0 && sb.badFrames === 0,
    `a=${sa.badFrames} b=${sb.badFrames}`);
  check('no correction storm', sa.correctionsSeek + sb.correctionsSeek < 12,
    `seeks a=${sa.correctionsSeek} b=${sb.correctionsSeek}, ` +
    `nudges a=${sa.correctionsNudge} b=${sb.correctionsNudge}`);
} catch (e) {
  failed = true;
  check('probe ran to completion', false, e.message);
} finally {
  for (const p of peers) p.s.close();
  for (const b of browsers) await b.close();
  server.kill();
}

mkdirSync('results', { recursive: true });
writeFileSync('results/userscript-sync.json', JSON.stringify(results, null, 2));
const bad = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - bad.length}/${results.checks.length} checks passed`);
if (bad.length || failed) {
  console.log('server log tail:\n' + serverLog.slice(-1500));
  process.exit(1);
}
