/**
 * Live: what a member does to the player while its connection is down.
 *
 * Written for N20 (STATE.md "Review round 3"), when such a change was replayed
 * after the `welcome` if the room had not moved. **That was removed** (the
 * user's decision, 2026-09-18, STATE.md "Round 5: nothing done offline is
 * sent"): nothing done while the session is down is sent, ever. Case 1 was
 * inverted to match -- it now asserts the room is NOT moved by B, and that B
 * follows it back. Cases 2 and 3 are unchanged; they always asserted this.
 *
 * Member B reaches videosyncd through a TCP relay in this process, which the
 * probe can cut: open sockets are destroyed and new ones refused until it is
 * restored. The server sees B leave; B's engine reconnects and gets a fresh
 * `welcome`. Member A connects directly. Both are Helium tabs on $E1 (two
 * windows -- a background tab loads no media).
 *
 *   1. The room did not move: B, cut off, pauses with a real click. After the
 *      reconnect that pause must reach nobody: B sends nothing, A keeps
 *      playing, and B is put back on the room, playing at A's position.
 *   2. The room moved: B is cut off, A seeks the room 60 s on, B pauses with a
 *      real click. After the reconnect B must follow the room (playing, at A's
 *      position) and A must NOT be paused.
 *   3. Control: B is cut off and nobody touches anything: nothing is sent, and
 *      both keep playing together.
 *
 * The click is CDP `Input` (trusted, so it counts as the member's gesture), on
 * the centre of Laftel's player, which toggles playback. RESULT=<name>.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const UP_PORT = +(process.env.UP_PORT || 8787);
const RELAY_PORT = +(process.env.RELAY_PORT || 8788);
const SERVER = `http://127.0.0.1:${UP_PORT}`;
const RELAYED = `http://127.0.0.1:${RELAY_PORT}`;
const E1 = process.env.E1 || 'https://laftel.net/player/45462/93304';
const OUTAGE_MS = +(process.env.OUTAGE_MS || 8000);
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT = join(HERE, 'results', `${process.env.RESULT || 'offline'}.json`);

const results = { when: new Date().toISOString(), server: SERVER, relay: RELAYED, page: E1, outageMs: OUTAGE_MS, checks: [], cases: {}, notes: [] };
function flush() {
  mkdirSync(dirname(RESULT), { recursive: true });
  writeFileSync(RESULT, JSON.stringify(results, null, 2));
}
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  flush();
}

// --- the relay ----------------------------------------------------------------
let up = true;
const live = new Set();
const relay = net.createServer((c) => {
  if (!up) { c.destroy(); return; }
  const s = net.connect(UP_PORT, '127.0.0.1');
  live.add(c); live.add(s);
  const drop = () => { c.destroy(); s.destroy(); live.delete(c); live.delete(s); };
  c.on('error', drop); s.on('error', drop); c.on('close', drop); s.on('close', drop);
  c.pipe(s); s.pipe(c);
});
function cut() { up = false; for (const x of live) x.destroy(); live.clear(); }
function restore() { up = true; }

// --- the tabs -----------------------------------------------------------------
async function attach(t) {
  const s = await new Session(t.webSocketDebuggerUrl).open();
  s.trackContexts();
  s.isolatedName = 'VideoSync';
  await s.send('Runtime.enable');
  await s.send('Page.enable');
  return s;
}
const iso = (s, body) => s.evalIsolated(`(async () => { ${body} })()`);
const player = (s) => iso(s, 'const st = VideoSync.adapter.readState(); return { at: Date.now(), pos: st.positionS, paused: st.paused }');
const status = (s) => iso(s, 'return VideoSync.status()');
const gapMs = (a, b) => Math.round(((a.pos + (a.paused ? 0 : (b.at - a.at) / 1000)) - b.pos) * 1000);

/** A trusted click on the centre of the player. */
async function click(s) {
  await s.send('Page.bringToFront');
  const box = await s.eval(`(() => { const b = document.querySelector('video').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}
async function until(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(150);
  }
}
const joinedBoth = (a, b) => until(async () => {
  const [x, y] = [await status(a), await status(b)];
  return x.state === 'joined' && y.state === 'joined' && x.members === 2 && y.members === 2 && y.expectedMs !== null;
}, 30000, 'both joined');

async function main() {
  await new Promise((r) => relay.listen(RELAY_PORT, '127.0.0.1', r));
  const tabs = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page' && x.url.startsWith(E1));
  if (tabs.length < 2) throw new Error(`need two tabs on ${E1}`);
  const a = await attach(tabs[0]);
  const b = await attach(tabs[1]);
  for (const m of [a, b]) {
    if ((await status(m)).state !== 'idle') await iso(m, 'VideoSync.leave(); return 1');
  }
  await iso(a, 'await VideoSync.adapter.pause(); await VideoSync.adapter.seekTo(60); return 1');
  const room = await iso(a, `return await VideoSync.createRoom(${JSON.stringify(SERVER)}, 'a')`);
  await iso(b, `VideoSync.join(${JSON.stringify(RELAYED)}, ${JSON.stringify(room.roomId)}, ${JSON.stringify(room.secret)}, 'b'); return 1`);
  await joinedBoth(a, b);
  results.roomId = room.roomId;
  await sleep(3000);

  async function playing() {
    if ((await player(a)).paused) await iso(a, 'await VideoSync.adapter.play(); return 1');
    await until(async () => !(await player(a)).paused && !(await player(b)).paused, 10000, 'both playing');
    await sleep(3000);
  }
  async function outage(during) {
    const before = { a: await status(a), b: await status(b) };
    cut();
    await until(async () => (await status(b)).state !== 'joined', 10000, 'B to notice the cut');
    await until(async () => (await status(a)).members === 1, 15000, 'the server to drop B');
    await during();
    await sleep(OUTAGE_MS);
    restore();
    await joinedBoth(a, b);
    await sleep(5000);
    const after = { a: await status(a), b: await status(b) };
    return {
      aSent: after.a.stats.cmdsSent - before.a.stats.cmdsSent,
      bSent: after.b.stats.cmdsSent - before.b.stats.cmdsSent,
      bReconciles: after.b.stats.reconciles - before.b.stats.reconciles,
    };
  }

  // 1. The room stays put; B pauses offline. Nothing of it reaches the room,
  //    and the reconciler puts B back (see this file's header).
  await playing();
  const c1 = await outage(async () => { await click(b); await sleep(1500); });
  let pa = await player(a); let pb = await player(b);
  results.cases.unmoved = { ...c1, a: pa, b: pb };
  check('1. B\'s offline pause reaches nobody: A keeps playing', c1.bSent === 0 && !pa.paused,
    `A paused=${pa.paused}, B sent ${c1.bSent}`);
  check('   and B is put back on the room', !pb.paused && Math.abs(gapMs(pa, pb)) < 500,
    `A ${pa.pos.toFixed(2)} B ${pb.pos.toFixed(2)} B paused=${pb.paused}, gap ${gapMs(pa, pb)} ms`);

  // 2. A moves the room while B is away; B pauses offline.
  await playing();
  let target = 0;
  const c2 = await outage(async () => {
    target = Math.round((await player(a)).pos + 60);
    await iso(a, `await VideoSync.adapter.seekTo(${target}); return 1`);
    await sleep(1000);
    await click(b);
    await sleep(1500);
  });
  pa = await player(a); pb = await player(b);
  results.cases.moved = { ...c2, target, a: pa, b: pb };
  check('2. the room moved meanwhile: A is not paused by B', !pa.paused, `A paused=${pa.paused}, B sent ${c2.bSent}`);
  check('   and B follows the room', !pb.paused && pb.pos > target - 1 && Math.abs(gapMs(pa, pb)) < 500,
    `target ${target}: A ${pa.pos.toFixed(2)} B ${pb.pos.toFixed(2)} B paused=${pb.paused}, gap ${gapMs(pa, pb)} ms`);

  // 3. Control: an outage with nobody doing anything.
  await playing();
  const c3 = await outage(async () => {});
  pa = await player(a); pb = await player(b);
  results.cases.control = { ...c3, a: pa, b: pb };
  check('3. an outage alone sends nothing', c3.bSent === 0 && !pa.paused && !pb.paused && Math.abs(gapMs(pa, pb)) < 500,
    `B sent ${c3.bSent}, both playing=${!pa.paused && !pb.paused}, gap ${gapMs(pa, pb)} ms`);

  for (const m of [a, b]) await iso(m, 'VideoSync.leave(); await VideoSync.adapter.pause(); return 1');
  a.close(); b.close();
}

main().then(() => {
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(`\n${results.checks.length - failed}/${results.checks.length} passed`);
  relay.close();
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  results.notes.push(`aborted: ${e.stack}`);
  flush();
  console.error(e);
  process.exit(1);
});
