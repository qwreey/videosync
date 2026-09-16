/**
 * The `play` jump, measured with two real members on the real Laftel.
 *
 * STATE.md 1b: whoever presses play has their picture pulled back by the
 * command's lead when the transition lands, because everyone must start moving
 * at the same instant from the same position. The simulation cannot answer how
 * big that is -- it applies commands at `when`, so it is insensitive to the lead
 * by construction (POC-FINDINGS §40c). This measures it.
 *
 * Like probe-laftel.mjs it attaches to a logged-in browser over CDP instead of
 * launching one. It needs TWO visible tabs on the same episode (separate
 * windows -- a background tab loads no media, BROWSER-FINDINGS §5b), the
 * extension loaded, and a videosyncd at $SERVER.
 *
 * Each trial: settle paused -> one member "presses" play through the adapter
 * (the detector sees a real element transition, exactly as with a click) ->
 * both players are sampled every 10 ms for 4 s -> the same member pauses ->
 * sampled again. Presser alternates.
 *
 * Timestamps are `performance.timeOrigin + performance.now()`, which is the
 * machine's wall clock in both tabs and so comparable across them; each tab's
 * own `performance.now()` is not.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
const TRIALS = +(process.env.TRIALS || 6);
// How a member "presses": through the extension's adapter, or through the
// site's own handlers -- a click on the video, or Space (see press()).
// The site path is the one users take, and the site has its own idea of
// whether it is playing, which the hold contradicts.
const PRESS = process.env.PRESS || 'adapter';
const HERE = dirname(fileURLToPath(import.meta.url));

const results = { when: new Date().toISOString(), server: SERVER, press: PRESS, trials: [], summary: {}, notes: [] };
function flush() {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  const name = PRESS === 'adapter' ? 'laftel-room.json' : `laftel-room-${PRESS}.json`;
  writeFileSync(join(HERE, 'results', name), JSON.stringify(results, null, 2));
}

async function attachAll() {
  const list = (await (await fetch(`${CDP}/json/list`)).json())
    .filter((x) => x.type === 'page' && /laftel\.net\/player\//.test(x.url));
  if (list.length < 2) throw new Error(`need two laftel player tabs, found ${list.length}`);
  const out = [];
  for (const [i, t] of list.slice(0, 2).entries()) {
    const s = await new Session(t.webSocketDebuggerUrl).open();
    s.trackContexts();
    s.isolatedName = 'VideoSync';
    await s.send('Runtime.enable');
    out.push({ name: 'ab'[i], s, url: t.url });
  }
  if (out[0].url !== out[1].url) throw new Error(`tabs are on different episodes: ${out[0].url} ${out[1].url}`);
  return out;
}

const iso = (m, body) => m.s.evalIsolated(`(async () => { ${body} })()`);
const NOW_EXPR = 'performance.timeOrigin + performance.now()';

/**
 * Press play or pause on member `m`; returns the page-clock instant of the press.
 *
 * The site paths dispatch the events from inside the page rather than with
 * CDP `Input.*`: on a Wayland desktop a window that is not on screen gets no
 * frame callbacks, and CDP input waits for a frame -- measured, clicks landed
 * 3-6 s late. Synthetic events reach the same site handlers (React does not
 * check `isTrusted`); what they lack is user activation, which this profile
 * does not need (`--autoplay-policy=no-user-gesture-required`).
 */
async function press(m, want) {
  if (PRESS === 'adapter') {
    return iso(m, `const t = ${NOW_EXPR}; await VideoSync.adapter.${want}(); return t`);
  }
  const body = PRESS === 'space'
    ? `for (const type of ['keydown', 'keyup']) document.activeElement.dispatchEvent(
         new KeyboardEvent(type, { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));`
    : `const b = document.querySelector('video').getBoundingClientRect();
       const x = b.left + b.width / 2, y = b.top + b.height / 2, el = document.elementFromPoint(x, y);
       const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
       el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
       el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
       el.dispatchEvent(new MouseEvent('click', o));`;
  // Toggles, so only press when the element is not already where we want it.
  return m.s.eval(`(() => { const t = ${NOW_EXPR};
    if (document.querySelector('video').paused !== ${want === 'play'}) return t;
    ${body} return t; })()`);
}

// A sampler that runs inside the tab, so the CDP round trip is not in the data.
const START_SAMPLER = (ms) => `
  const a = VideoSync.adapter, out = [];
  window.__vsSamples = out;
  const t0 = performance.now();
  const id = setInterval(() => {
    const st = a.readState();
    out.push([performance.timeOrigin + performance.now(), st.positionS, st.paused ? 1 : 0]);
    if (performance.now() - t0 > ${ms}) clearInterval(id);
  }, 10);
  return true;`;
const TAKE = 'return window.__vsSamples';

/**
 * The picture's movement relative to where it would have been had nobody
 * touched it: from each sample, predict the next one by its own play state,
 * and call any disagreement larger than a tick a jump.
 */
function jumps(samples, fromMs) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const [t0, p0, z0] = samples[i - 1];
    const [t1, p1] = samples[i];
    if (t1 < fromMs) continue;
    const predicted = p0 + (z0 ? 0 : (t1 - t0) / 1000);
    const d = p1 - predicted;
    if (Math.abs(d) > 0.08) out.push({ atMs: Math.round(t1 - fromMs), jumpMs: Math.round(d * 1000) });
  }
  return out;
}
const firstMoving = (samples, fromMs) => {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i][0] >= fromMs && samples[i][1] > samples[i - 1][1] + 0.001) return Math.round(samples[i][0] - fromMs);
  }
  return null;
};
const firstPaused = (samples, fromMs) => {
  const x = samples.find((q) => q[0] >= fromMs && q[2] === 1);
  return x ? Math.round(x[0] - fromMs) : null;
};
function posAt(samples, t) {
  let best = samples[0];
  for (const q of samples) if (Math.abs(q[0] - t) < Math.abs(best[0] - t)) best = q;
  return best[1] + (best[2] ? 0 : (t - best[0]) / 1000);
}

async function main() {
  const [a, b] = await attachAll();
  for (const m of [a, b]) {
    const st = await iso(m, 'return VideoSync.status()');
    if (st.state !== 'idle') await iso(m, 'VideoSync.leave(); return true');
    await iso(m, 'await VideoSync.adapter.pause(); return true');
  }
  await sleep(500);

  const room = await iso(a, `return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await a.s.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  await iso(b, `VideoSync.join(${JSON.stringify(SERVER)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'b'); return true`);
  await b.s.waitFor("VideoSync.status().state === 'joined'", { isolated: true });
  for (const m of [a, b]) await m.s.waitFor('VideoSync.engine().clock.ready', { isolated: true });
  results.roomId = room.roomId;
  results.clock = {};
  for (const m of [a, b]) {
    results.clock[m.name] = await iso(m, 'const c = VideoSync.engine().clock; return { rttMs: c.rttMs, uncertaintyMs: c.uncertaintyMs }');
  }
  console.log('room', room.roomId, JSON.stringify(results.clock));
  await sleep(4000);   // let the creator's adoption and B's alignment settle

  for (let k = 0; k < TRIALS; k++) {
    const [p, o] = k % 2 === 0 ? [a, b] : [b, a];
    const trial = { presser: p.name };

    // --- play ---
    for (const m of [p, o]) await iso(m, START_SAMPLER(4500));
    await sleep(300);
    const tPlay = await press(p, 'play');
    await sleep(4600);
    let sp = await iso(p, TAKE), so = await iso(o, TAKE);
    const p0 = posAt(sp, tPlay);
    const tEnd = sp.at(-1)[0];
    // With holdLocalPlay the presser is paused again in between: when did it
    // finally start moving for good?
    const lastPausedP = sp.filter((q) => q[0] >= tPlay && q[2] === 1).at(-1);
    trial.play = {
      presserJumps: jumps(sp, tPlay),
      presserHeld: !!lastPausedP,
      // More than play -> pause -> play means something (the site?) fought the hold.
      presserFlips: sp.filter((q, i) => i > 0 && q[0] >= tPlay && q[2] !== sp[i - 1][2]).length,
      presserStartsAfterMs: lastPausedP ? Math.round(lastPausedP[0] - tPlay) : 0,
      otherStartsAfterMs: firstMoving(so, tPlay),
      // Where the presser ended vs. where an untouched player would be.
      presserNetMs: Math.round((posAt(sp, tEnd) - (p0 + (tEnd - tPlay) / 1000)) * 1000),
      gapAtEndMs: Math.round((posAt(sp, tEnd) - posAt(so, tEnd)) * 1000),
    };

    // --- pause ---
    for (const m of [p, o]) await iso(m, START_SAMPLER(3000));
    await sleep(300);
    const tPause = await press(p, 'pause');
    await sleep(3100);
    sp = await iso(p, TAKE); so = await iso(o, TAKE);
    const e2 = sp.at(-1)[0];
    trial.pause = {
      presserJumps: jumps(sp, tPause),
      otherStopsAfterMs: firstPaused(so, tPause),
      gapAtEndMs: Math.round((posAt(sp, e2) - posAt(so, e2)) * 1000),
    };
    const st = await iso(p, 'return VideoSync.engine().stats');
    trial.presserStats = { cmdsSent: st.cmdsSent, playsHeld: st.playsHeld, reportsDeferred: st.reportsDeferred, correctionsSeek: st.correctionsSeek, lateApplies: st.lateApplies, reconciles: st.reconciles };
    results.trials.push(trial);
    flush();
    console.log(JSON.stringify(trial));
    await sleep(2500);
  }

  const d = JSON.parse(await iso(a, 'return VideoSync.dump()'));
  results.traceA = d.engine.trace.filter((e) => e.t === 'cmd' || e.t === 'ack' || e.t === 'state');
  const back = results.trials.map((t) => Math.min(0, ...t.play.presserJumps.map((j) => j.jumpMs)));
  const pauseJ = results.trials.map((t) => Math.max(0, ...t.pause.presserJumps.map((j) => Math.abs(j.jumpMs))));
  results.summary = {
    playPresserBackJumpMs: back,
    playGapAtEndMs: results.trials.map((t) => t.play.gapAtEndMs),
    playPresserStartsAfterMs: results.trials.map((t) => t.play.presserStartsAfterMs),
    playOtherStartsAfterMs: results.trials.map((t) => t.play.otherStartsAfterMs),
    playPresserNetMs: results.trials.map((t) => t.play.presserNetMs),
    pausePresserLargestJumpMs: pauseJ,
    pauseGapAtEndMs: results.trials.map((t) => t.pause.gapAtEndMs),
  };
  console.log(JSON.stringify(results.summary));
  flush();
  for (const m of [a, b]) { await iso(m, 'VideoSync.leave(); return true'); m.s.close(); }
}

main().then(() => process.exit(0)).catch((e) => {
  results.notes.push(`aborted: ${e.message}`);
  flush();
  console.error(e);
  process.exit(1);
});
