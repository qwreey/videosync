/**
 * The extension in Firefox, in a room with the extension in Chromium.
 *
 * STATE.md used to say Firefox was "deliberately not claimed": the manifest
 * declared `background.service_worker`, which Firefox has never shipped. The
 * build now emits `dist-firefox/` with `background.scripts`. This checks that
 * it actually works, against a Chromium member, on YouTube (no account).
 *
 * Needs:
 *   - a Chromium-family browser on CDP :9222 with client/extension/dist loaded
 *     and a tab on $VIDEO (member A);
 *   - Firefox on BiDi :9223 (`firefox --remote-debugging-port 9223`), which this
 *     probe installs the local-ext.mjs Firefox build into (run that first) and
 *     opens a window in (member B);
 *   - videosyncd at $SERVER.
 *
 * Firefox gives no handle on a content script's realm, so B is driven the way
 * a person would: through the panel. A is driven through its adapter.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Bidi } from './bidi.mjs';
import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.SERVER || 'http://127.0.0.1:8787';
// LOCAL=1 runs against local-media.mjs with the local-ext.mjs builds instead of
// YouTube, which stops serving an automated Firefox after ~40 s of playback.
const LOCAL = !!process.env.LOCAL;
// LAFTEL=1 runs on the real Laftel (both profiles logged in, Widevine in both):
// member B starts on another episode and is taken to A's.
const LAFTEL = !LOCAL && !!process.env.LAFTEL;
const VIDEO = LOCAL ? 'http://127.0.0.1:8898/watch/1'
  : LAFTEL ? 'https://laftel.net/player/45462/93304'
  : 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny
const ELSEWHERE = LOCAL ? 'http://127.0.0.1:8898/watch/2'
  : LAFTEL ? 'https://laftel.net/player/45462/93295'
  : 'https://www.youtube.com/watch?v=eRsGyueVLvQ'; // Sintel
// Always the local-ext.mjs build: a shipped build closes the panel's shadow
// root, and Firefox gives this probe no other way to reach the panel.
// FF_EXT: a build elsewhere under the sandbox's grant (local-ext.mjs NAME=/VS_CACHE=).
const FF_EXT = process.env.FF_EXT || join(HERE, '..', '..', '.cache', 'firefox-profile', 'ext-local');
const HOLD_S = LOCAL || LAFTEL ? 30 : 15;

const results = { when: new Date().toISOString(), checks: [], measurements: {}, notes: [] };
function flush() {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, LOCAL ? 'results/firefox-local.json' : LAFTEL ? 'results/firefox-laftel.json' : 'results/firefox.json'), JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

// --- member A: Chromium over CDP ---------------------------------------------
async function chromium() {
  const list = (await (await fetch('http://127.0.0.1:9222/json/list')).json())
    .filter((x) => x.type === 'page' && x.url.startsWith(VIDEO));
  if (!list.length) throw new Error(`no Chromium tab on ${VIDEO}`);
  const s = await new Session(list[0].webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  await s.send('Runtime.enable');
  results.chromium = (await (await fetch('http://127.0.0.1:9222/json/version')).json())['Browser'];
  return s;
}
const isoA = (s, body) => s.evalIsolated(`(async () => { ${body} })()`);

// --- member B: Firefox over BiDi, through the panel ---------------------------
const PANEL = `document.getElementById('videosync-root')?.shadowRoot`;
const VIDEO_EL = `document.querySelector('video')`;
const stateB = (b, ctx) => b.eval(ctx, `(() => { const v = ${VIDEO_EL}; const r = ${PANEL};
  return { href: location.href, at: Date.now(), pos: v ? v.currentTime : null, paused: v ? v.paused : null,
    dot: r ? r.querySelector('.dot').className : null, status: r ? r.querySelector('.status').textContent : null }; })()`);
const stateA = async (s) => {
  const r = await isoA(s, 'const st = VideoSync.adapter.readState(); return { at: Date.now(), pos: st.positionS, paused: st.paused, state: VideoSync.status().state }');
  return r;
};
/** B's engine as the probe build mirrors it (content.ts, OPEN_PANEL). */
async function dumpB(b, ctx, label) {
  const raw = await b.eval(ctx, `document.getElementById('videosync-root')?.getAttribute('data-dump') ?? null`).catch(() => null);
  if (!raw) return;
  const d = JSON.parse(raw);
  (results.dumps ??= {})[label] = {
    acquisition: d.engine?.acquisition ?? null, stats: d.engine?.stats ?? null,
    anchor: d.engine?.anchor ?? null, player: d.player ?? null,
    trace: (d.engine?.trace ?? []).filter((e) => e.t !== 'hb' && e.t !== 'time' && e.t !== 'time.reply').slice(-40),
  };
  flush();
}

/** A's position projected to B's sampling instant. */
const gapMs = (a, b) => Math.round(((a.pos + (a.paused ? 0 : (b.at - a.at) / 1000)) - b.pos) * 1000);

async function main() {
  const a = await chromium();
  if ((await isoA(a, 'return VideoSync.status().state')) !== 'idle') await isoA(a, 'VideoSync.leave(); return 1');
  await isoA(a, 'await VideoSync.adapter.pause(); await VideoSync.adapter.seekTo(30); return 1');

  const b = await Bidi.connect();
  bidi = b;
  results.firefox = (await b.send('session.status')).message ?? '';
  try {
    await b.installExtension(FF_EXT);
  } catch (e) {
    results.notes.push(`install: ${e.message}`);   // already installed in this session
  }
  const ctx = await b.newTab(ELSEWHERE);
  await b.waitFor(ctx, `!!${PANEL}`, { timeoutMs: 20000 });
  // A fresh profile's first YouTube visit can reload the page once.
  await sleep(3000);
  await b.waitFor(ctx, `!!${PANEL}`, { timeoutMs: 20000 });
  check('the Firefox build loads and mounts its panel', true, (await stateB(b, ctx)).status);

  // A makes the room.
  const room = await isoA(a, `return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'chromium')`);
  await a.waitFor("VideoSync.status().state === 'joined'", { isolated: true });

  // B joins through the panel, from a different video.
  await b.eval(ctx, `(() => { const r = ${PANEL};
    const set = (ph, v) => { const i = [...r.querySelectorAll('input')].find((x) => x.placeholder === ph); i.value = v; };
    set('http://localhost:8787', ${JSON.stringify(SERVER)}); set('이름', 'firefox');
    set('방 ID', ${JSON.stringify(room.roomId)}); set('참가 비밀키', ${JSON.stringify(room.secret)});
    [...r.querySelectorAll('button')].find((x) => x.textContent === '참가').click(); return 1; })()`);
  const t0 = Date.now();
  await b.waitFor(ctx, `location.href.startsWith(${JSON.stringify(VIDEO)})`, { timeoutMs: 20000 });
  check('Firefox is taken to the room\'s video', true, `after ${Date.now() - t0} ms`);
  await b.waitFor(ctx, `(${PANEL})?.querySelector('.dot')?.className.includes('joined')`, { timeoutMs: 30000 });
  check('and rejoins there (the rejoin survived Firefox\'s storage)', true, `after ${Date.now() - t0} ms`);
  await a.waitFor('VideoSync.status().members === 2', { isolated: true, timeoutMs: 10000 });
  // Clocks settle, and B -- which YouTube autoplayed on arrival -- is paused by
  // the reconciler, which waits RECONCILE_AFTER (3 s) on purpose.
  await sleep(5000);

  let sa = await stateA(a); let sb = await stateB(b, ctx);
  await dumpB(b, ctx, 'conformed');
  check('B conformed to the room: paused at A\'s position', sb.paused && Math.abs(gapMs(sa, sb)) < 300,
    `A ${sa.pos.toFixed(2)} B ${sb.pos.toFixed(2)} B paused=${sb.paused}`);

  // A plays. Both run; compare after they settle.
  await isoA(a, 'await VideoSync.adapter.play(); return 1');
  await sleep(4000);
  sa = await stateA(a); sb = await stateB(b, ctx);
  results.measurements.gapAfterPlayMs = gapMs(sa, sb);
  check('Chromium presses play, Firefox follows', !sb.paused && Math.abs(gapMs(sa, sb)) < 300,
    `gap ${gapMs(sa, sb)} ms`);

  // B pauses on its own player.
  await b.eval(ctx, `${VIDEO_EL}.pause(), 1`);
  await sleep(1500);
  sa = await stateA(a); sb = await stateB(b, ctx);
  await dumpB(b, ctx, 'after-pause');
  check('Firefox pauses, Chromium follows', sa.paused && sb.paused && Math.abs(gapMs(sa, sb)) < 300,
    `gap ${gapMs(sa, sb)} ms`);

  // B plays: the hold runs in Firefox too.
  await b.eval(ctx, `${VIDEO_EL}.play(), 1`);
  await sleep(4000);
  sa = await stateA(a); sb = await stateB(b, ctx);
  results.measurements.gapAfterFirefoxPlayMs = gapMs(sa, sb);
  check('Firefox presses play, both run together', !sa.paused && !sb.paused && Math.abs(gapMs(sa, sb)) < 300,
    `gap ${gapMs(sa, sb)} ms`);

  // A seeks during playback -- inside B's buffer. In this Firefox, YouTube
  // cannot complete an out-of-buffer seek at all, even through its own
  // movie_player.seekTo: it sits at readyState 1 for ~17 s and then resets the
  // element (BROWSER-FINDINGS §19). That is not a sync question.
  // Locally there is no such limit, so seek well past the buffer.
  const target = LOCAL || LAFTEL ? 200 : Math.floor(sa.pos) + 8;
  await isoA(a, `VideoSync.adapter.seekTo(${target}).catch(() => {}); return 1`);
  await sleep(LOCAL || LAFTEL ? 5000 : 3000);
  sa = await stateA(a); sb = await stateB(b, ctx);
  check('Chromium seeks, Firefox follows', sb.pos > target - 0.5 && Math.abs(gapMs(sa, sb)) < 300,
    `target ${target}: A ${sa.pos.toFixed(2)} B ${sb.pos.toFixed(2)}, gap ${gapMs(sa, sb)} ms`);

  // Stay together for a while: the servo works on Firefox's playbackRate too.
  const gaps = [];
  for (let i = 0; i < HOLD_S / 5; i++) {
    await sleep(5000);
    sa = await stateA(a); sb = await stateB(b, ctx);
    gaps.push(gapMs(sa, sb));
  }
  results.measurements.gapsEvery5sMs = gaps;
  await dumpB(b, ctx, 'after-hold');
  check(`still together over ${HOLD_S} s`, gaps.every((g) => Math.abs(g) < 300), `gaps ${gaps.join(', ')} ms`);

  await isoA(a, 'VideoSync.leave(); await VideoSync.adapter.pause(); return 1');
  await b.eval(ctx, `(() => { const r = ${PANEL}; [...r.querySelectorAll('button')].find((x) => x.textContent === '나가기').click();
    ${VIDEO_EL}.pause(); return 1; })()`);
  await sleep(500);
  sb = await b.eval(ctx, `${VIDEO_EL}.playbackRate`);
  check('Firefox hands back its playback rate on leaving', sb === 1, `rate ${sb}`);
  await b.send('browsingContext.close', { context: ctx });
  await b.close();
  a.close();
}

let bidi = null;
process.on('exit', () => { try { bidi?.ws.close(); } catch {} });

main().then(() => {
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} passed`);
  process.exit(failed ? 1 : 0);
}).catch(async (e) => {
  results.notes.push(`aborted: ${e.message}`);
  flush();
  console.error(e);
  await bidi?.close();
  process.exit(1);
});
