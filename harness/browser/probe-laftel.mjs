/**
 * The provider questions, on the real Laftel.
 *
 * Unlike every other probe this one does NOT launch a browser: Laftel needs a
 * logged-in account and Widevine, and neither exists in the container. It
 * attaches over CDP to a browser somebody already logged into, with the
 * extension loaded, and drives the player through the extension's own
 * `VideoSync.adapter` -- the shipping path, not a raw element poke.
 *
 *   helium --user-data-dir=.cache/helium-profile --remote-debugging-port=9222 \
 *     --load-extension=client/extension/dist https://laftel.net/player/45462/93304
 *   (log in, open an episode)
 *   node harness/browser/probe-laftel.mjs
 *
 * A fresh --user-data-dir has no Widevine CDM: it is a component the browser
 * downloads into its profile. Copy `WidevineCdm/` from a profile that has one.
 *
 * What it answers (STATE.md "1. Laftel"):
 *   1. Does a programmatic pause() stick? The reconciler and every `media`
 *      command depend on it.
 *   2. Does Laftel reset playbackRate? The servo's frequency term depends on it.
 *   3. Does mediaKey differ per episode -- across a full load AND across the
 *      SPA's own navigation, which is how a viewer actually moves on?
 *   4. Does a currentTime write stick? (Answered in the field, §12; re-measured.)
 *
 * The extension must NOT be in a room while this runs, or corrections would be
 * measured instead of the player.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SERIES = process.env.SERIES || '45462';
const HERE = dirname(fileURLToPath(import.meta.url));

const results = { when: new Date().toISOString(), checks: [], measurements: {}, notes: [] };
function flush() {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results/laftel.json'), JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}
function note(name, value) {
  results.measurements[name] = value;
  console.log(`  ${name}: ${JSON.stringify(value)}`);
  flush();
}

async function attach() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && /laftel\.net\/player\//.test(x.url));
  if (!t) throw new Error('no laftel.net/player/ tab open in the attached browser');
  const s = await new Session(t.webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  results.browser = (await (await fetch(`${CDP}/json/version`)).json())['Browser'];
  return s;
}

const iso = (s, body) => s.evalIsolated(`(async () => { ${body} })()`);
const state = (s) => iso(s, 'return VideoSync.adapter.readState()');

async function waitPlayable(s, timeoutMs = 30000) {
  await s.waitFor(
    "!!window.VideoSync && !!VideoSync.adapter.current && VideoSync.adapter.readState().readyState >= 3",
    { timeoutMs, isolated: true, everyMs: 250 });
}

async function main() {
  const s = await attach();
  const st0 = await iso(s, 'return VideoSync.status()');
  if (st0.state !== 'idle') throw new Error(`extension is in a room (${st0.state}); leave it first`);
  results.notes.push(`visibility: ${await s.eval('document.visibilityState')}`);
  await waitPlayable(s);
  note('start', await state(s));

  // 4. seek sticks. Seek somewhere well inside, confirm, and watch 3 s. The
  //    player may be playing, so "sticks" means it stays on the line that
  //    starts at the target -- not that it stays AT the target.
  const seek = await iso(s, `
    const a = VideoSync.adapter;
    await a.seekTo(120);
    const w0 = performance.now(), out = [];
    for (let i = 0; i < 12; i++) {
      const st = a.readState();
      out.push({ pos: st.positionS, dt: (performance.now() - w0) / 1000, paused: st.paused, rate: st.rate });
      await new Promise(r => setTimeout(r, 250));
    }
    return out;`);
  note('seek_samples', seek);
  const offLine = seek.map((p) => p.pos - (120 + (p.paused ? 0 : p.dt * p.rate)));
  check('a currentTime write sticks', offLine.every((d) => Math.abs(d) < 0.5),
    `worst distance from the line through the target: ${Math.max(...offLine.map(Math.abs)).toFixed(3)} s`);

  // 1. pause sticks. Play 2 s, pause, then sample 5 s -- long enough for a
  //    player that "resumes after buffering" or re-asserts its own state.
  await iso(s, 'await VideoSync.adapter.play(); return true');
  await sleep(2000);
  const playing = await state(s);
  check('play() starts playback', !playing.paused, `position ${playing.positionS.toFixed(2)}`);
  await iso(s, 'await VideoSync.adapter.pause(); return true');
  const pauseSamples = [];
  for (let i = 0; i < 20; i++) {
    const p = await state(s);
    pauseSamples.push({ paused: p.paused, pos: +p.positionS.toFixed(3) });
    await sleep(250);
  }
  note('pause_samples', pauseSamples);
  const drift = pauseSamples.at(-1).pos - pauseSamples[0].pos;
  check('a programmatic pause() sticks for 5 s', pauseSamples.every((p) => p.paused) && Math.abs(drift) < 0.05,
    `position moved ${drift.toFixed(3)} s while paused`);

  // 2. playbackRate held. 1.1 for 10 s; compare media advance to wall clock.
  //    Wall time is taken in the page so the CDP hop is not in the ratio.
  await iso(s, 'await VideoSync.adapter.play(); return true');
  await sleep(1500);
  const rate = await iso(s, `
    const a = VideoSync.adapter;
    a.setRate(1.1);
    const s0 = a.readState(), w0 = performance.now(), rates = [];
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); rates.push(a.readState().rate); }
    const s1 = a.readState(), w1 = performance.now();
    a.setRate(1);
    return { rates, mediaS: s1.positionS - s0.positionS, wallS: (w1 - w0) / 1000, paused: s1.paused };`);
  note('rate_hold', rate);
  check('playbackRate 1.1 is held for 10 s', rate.rates.every((r) => r === 1.1),
    `distinct rates seen: ${[...new Set(rate.rates)].join(', ')}`);
  const ratio = rate.mediaS / rate.wallS;
  check('media actually advances at 1.1x', Math.abs(ratio - 1.1) < 0.02, `ratio ${ratio.toFixed(4)}`);
  await iso(s, 'await VideoSync.adapter.pause(); return true');

  // 3. mediaKey per episode, over the SPA's own navigation and a full load.
  const here = await s.eval('location.pathname');
  const key0 = await iso(s, 'return VideoSync.mediaKey()');
  const other = await s.eval(`(() => {
    const as = [...document.querySelectorAll('a[href*="/player/${SERIES}/"]')]
      .map(a => a.getAttribute('href')).filter(h => !h.endsWith(location.pathname.split('/').pop()));
    return as[0] || null; })()`);
  note('episode_links', { here, other });
  if (other) {
    // Click the episode link as a viewer would: this is a client-side route change.
    const frameNav = new Promise((res) => s.on('Page.frameNavigated', () => res('full')));
    await s.eval(`document.querySelector('a[href="${other}"]').click(), true`);
    const how = await Promise.race([frameNav, sleep(4000).then(() => 'spa')]);
    await sleep(1000);
    const path1 = await s.eval('location.pathname');
    let key1 = null;
    try { key1 = await iso(s, 'return VideoSync.mediaKey()'); } catch (e) { key1 = `ERR ${e.message}`; }
    note('navigation', { how, path1, key0, key1 });
    check('mediaKey changes when the episode changes (in-app click)', key1 && key1 !== key0 && key1.includes(path1),
      `${key0} -> ${key1} (${how})`);
    try {
      await waitPlayable(s);
      const st = await state(s);
      check('the adapter follows the player onto the new episode', st.readyState >= 3,
        `readyState ${st.readyState}, duration ${st.durationS}`);
    } catch (e) { check('the adapter follows the player onto the new episode', false, e.message); }

    // And a full load back to the first episode.
    await s.send('Page.navigate', { url: `https://laftel.net${here}` });
    await sleep(3000);
    await s.waitFor('!!window.VideoSync', { timeoutMs: 20000, isolated: true });
    const key2 = await iso(s, 'return VideoSync.mediaKey()');
    check('mediaKey is stable across a full reload of the same episode', key2 === key0, `${key2}`);
  } else {
    check('found a second episode to compare', false, 'no /player/ link on the page');
  }

  s.close();
}

main().then(() => {
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} passed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  results.notes.push(`aborted: ${e.message}`);
  flush();
  console.error(e);
  process.exit(1);
});
