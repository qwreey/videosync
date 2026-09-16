/**
 * The client core against the real server.
 *
 * Everything else in this repo tests one side against a model of the other:
 * the Go harness simulates clients, the unit tests script a transport. This is
 * the only place `videosyncd` and `SyncEngine` meet, over a real WebSocket, on
 * a real clock. It is therefore the only test that can catch a disagreement
 * about the wire itself -- a renamed field, a number sent as a string, a frame
 * one side never sends.
 *
 * Requires the Go toolchain. Skips (loudly) without it rather than failing, so
 * `npm test` still works in a JS-only checkout.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../src/engine/engine.ts';
import type { EngineConfig } from '../src/engine/engine.ts';
import { WebSocketTransport } from '../src/engine/transport.ts';
import { FakePlayer, realTime } from './fakes.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const serverDir = join(here, '..', '..', '..', 'server');

let proc: ChildProcess | null = null;
let base = '';
let skip: string | false = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

before(async () => {
  const bin = join(tmpdir(), 'videosync-e2e', 'videosyncd');
  try {
    mkdirSync(join(tmpdir(), 'videosync-e2e'), { recursive: true });
    execFileSync('go', ['build', '-o', bin, './cmd/videosyncd'], { cwd: serverDir, stdio: 'pipe' });
  } catch (e) {
    skip = `cannot build videosyncd (${(e as Error).message.split('\n')[0]})`;
    return;
  }
  if (!existsSync(bin)) { skip = 'videosyncd was not produced'; return; }

  // Port 0 would be ideal but the server logs its own address; pick a high one
  // and retry rather than parse.
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = 19000 + Math.floor(Math.random() * 4000);
    const p = spawn(bin, ['-addr', `127.0.0.1:${port}`], { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => {
        try { return (await fetch(`${url}/healthz`)).ok; } catch { return false; }
      }, 3000, 'videosyncd to listen');
      proc = p;
      base = url;
      return;
    } catch {
      p.kill();
    }
  }
  skip = 'could not start videosyncd on any port';
});

after(() => { proc?.kill(); });

async function createRoom(mediaKey: string): Promise<{ roomId: string; secret: string }> {
  const r = await fetch(`${base}/api/rooms`, {
    method: 'POST', body: JSON.stringify({ mediaKey }),
  });
  assert.equal(r.status, 201);
  return await r.json() as { roomId: string; secret: string };
}

interface Peer {
  engine: SyncEngine;
  player: FakePlayer;
  gates: Array<[boolean, readonly string[]]>;
  chat: Array<{ name: string; text: string }>;
}

function peer(roomId: string, secret: string, name: string, opts = {}, adopt = false): Peer {
  const player = new FakePlayer(realTime, { paused: true, positionS: 0, ...opts });
  const gates: Array<[boolean, readonly string[]]> = [];
  const chat: Array<{ name: string; text: string }> = [];
  const cfg: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    room: roomId, secret, name, mediaKey: 'e2e:media',
    adoptLocalStateOnJoin: adopt,
  };
  const engine = new SyncEngine({
    adapter: player,
    transport: new WebSocketTransport(`${base.replace('http', 'ws')}/ws`),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => { clearTimeout(h); },
    isHidden: () => false,
  }, cfg, {
    onGate: (w, on) => { gates.push([w, on]); },
    onChat: (l) => { chat.push({ name: l.name, text: l.text }); },
  });
  return { engine, player, gates, chat };
}

async function joined(...ps: Peer[]): Promise<void> {
  for (const p of ps) p.engine.start();
  // Generous on purpose. Joining is fast, but settling the clock needs the five
  // rapid connect probes to complete, and this suite shares a machine with
  // headful browser probes -- a 5 s budget failed under that load and looked
  // like a regression rather than contention.
  await waitFor(() => ps.every((p) => p.engine.state === 'joined' && p.engine.clock.ready),
    20000, 'every peer to join and settle its clock');
}

describe('client core against a real videosyncd', { concurrency: false }, () => {
  it('two members apply the same command at the same server instant', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    const b = peer(roomId, secret, 'b');
    try {
      await joined(a, b);

      a.engine.seek(300);
      await waitFor(() => a.engine.appliedSeq >= 1 && b.engine.appliedSeq >= 1, 4000, 'the seek to apply');
      // Both got the SAME anchor -- one is the ack path and one the broadcast.
      assert.deepEqual(a.engine.currentAnchor, b.engine.currentAnchor,
        'sender and receiver ended up on different anchors');

      a.engine.play();
      await waitFor(() => !a.player.paused && !b.player.paused, 4000, 'both to start playing');

      // Let them run, then compare positions sampled in the same instant. The
      // originator being CMD_DELAY ahead of everyone else is exactly what the
      // ack-carries-`when` rule prevents, and it is invisible from the server.
      await sleep(2500);
      const pa = a.player.readState().positionS;
      const pb = b.player.readState().positionS;
      assert.ok(Math.abs(pa - pb) < 0.25,
        `sender at ${pa.toFixed(3)}s, receiver at ${pb.toFixed(3)}s -- ` +
        'a gap this size is the sender skipping its own scheduling');
      assert.ok(pa > 300 && pa < 310, `position ${pa} is not ~300s + a couple of seconds`);
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  it('holds a play for a member who is buffering, and releases it', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    // POC-FINDINGS §38 across the real wire: without the hold the slow member is
    // skipped past ~14 s of media.
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    const b = peer(roomId, secret, 'b');
    try {
      await joined(a, b);
      b.player.stall();
      await waitFor(() => a.gates.some(([, on]) => on.length > 0), 4000, 'the gate to notice b');

      a.engine.play();
      await waitFor(() => a.gates.some(([waiting]) => waiting), 4000, 'the play to be held');
      await sleep(1200); // longer than CMD_DELAY: it must still not have started
      assert.equal(a.player.paused, true, 'the room started without the buffering member');
      assert.equal(b.player.paused, true);

      b.player.recover();
      await waitFor(() => !a.player.paused && !b.player.paused, 5000, 'the held play to be released');
      assert.ok(a.gates.some(([waiting]) => !waiting), 'the gate never reported itself closed');
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  it('corrects a member that fell behind buffering, without the fix echoing back', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    // A stall is the honest way to fall behind. Shoving the position instead
    // would be indistinguishable from the user dragging the scrubber -- the
    // client would broadcast it as a seek and the room would follow, which is
    // correct behaviour and tests nothing about correction.
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    const b = peer(roomId, secret, 'b');
    try {
      await joined(a, b);
      a.engine.play();
      await waitFor(() => !a.player.paused && !b.player.paused, 4000, 'playback');
      await sleep(600);

      const cmdsBefore = b.engine.stats.cmdsSent;
      b.player.stall();
      await sleep(4000);       // 4 s of buffering: past NUDGE_MAX_RESIDUAL
      b.player.recover();

      await waitFor(() => b.engine.stats.correctionsSeek > 0, 8000, 'a correction');
      await sleep(1200);

      const pa = a.player.readState().positionS;
      const pb = b.player.readState().positionS;
      assert.ok(Math.abs(pa - pb) < 0.5,
        `still ${Math.abs(pa - pb).toFixed(2)}s apart after the correction`);
      // The stall must not have been broadcast as a backward seek, and the
      // correction must not have come back round as a forward one.
      assert.equal(b.engine.stats.cmdsSent, cmdsBefore,
        'the buffering member commanded the room');
      assert.equal(b.engine.stats.badFrames, 0);
      assert.equal(a.engine.stats.badFrames, 0);
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  it('chat and membership round-trip', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    const b = peer(roomId, secret, 'b');
    try {
      await joined(a, b);
      await waitFor(() => a.engine.roster.length === 2 && b.engine.roster.length === 2,
        4000, 'both rosters to fill');
      assert.deepEqual(a.engine.roster.map((m) => m.name).sort(), ['a', 'b']);

      a.engine.chat('안녕');
      // Chat is not echo-suppressed: only room STATE is. The sender sees its
      // own line, with the identity and timestamp the server stamped on it.
      await waitFor(() => a.chat.length > 0 && b.chat.length > 0, 4000, 'the line to arrive');
      assert.deepEqual(a.chat[0], { name: 'a', text: '안녕' });
      assert.deepEqual(b.chat[0], { name: 'a', text: '안녕' });

      b.engine.stop();
      await waitFor(() => a.engine.roster.length === 1, 4000, 'the roster to shrink');
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  it('reconnects and comes back on the current anchor', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    const b = peer(roomId, secret, 'b');
    try {
      await joined(a, b);
      a.engine.seek(1200);
      await waitFor(() => b.engine.appliedSeq >= 1, 4000, 'the seek');

      // Kill b's socket the way a dropped link would.
      (b.engine as unknown as { d: { transport: { close(): void } } }).d.transport.close();
      (b.engine as unknown as { onClose(c: boolean, r: string): void }).onClose(false, 'test drop');
      await waitFor(() => b.engine.state === 'joined' && b.engine.clock.ready, 8000, 'b to rejoin');

      assert.equal(b.engine.currentAnchor.positionMs, a.engine.currentAnchor.positionMs,
        'the rejoined member is on a different anchor');
      assert.ok(b.engine.stats.reconnects >= 1);
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  // A room is created at `paused@0`. A creator whose video is already playing
  // never emits a play-state TRANSITION, so nothing announced them: the room
  // defended a position nobody was at, dragging the player back every
  // RECONCILE_AFTER while the servo nudged it. Found in the field on Laftel,
  // alone in a room, with `cmdsSent: 0` and `expectedMs: 0` as the proof.
  it('adopts the creator\'s already-playing player into the fresh room', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 640 }, true);
    try {
      await joined(a);
      await waitFor(() => a.engine.appliedSeq >= 2, 6000, 'the creator to seed the room');

      const anchor = a.engine.currentAnchor;
      assert.equal(anchor.paused, false, 'the room stayed paused under a playing creator');
      // CMD_DELAY behind the still-advancing player, and one correction closes
      // it. What must not happen is the anchor sitting at 0.
      assert.ok(Math.abs(anchor.positionMs - 640_000) < 3000,
        `anchor at ${anchor.positionMs}ms, not the creator's ~640s`);

      // The real symptom was the player being yanked to 0, over and over.
      await sleep(4000); // longer than reconcileAfterMs
      const pos = a.player.readState().positionS;
      assert.ok(pos > 640, `player fell back to ${pos.toFixed(2)}s -- the room is fighting it`);
      assert.equal(a.player.paused, false, 'the player was paused by its own room');
    } finally {
      a.engine.stop();
    }
  });

  // The control: without the flag the bug reproduces, which is what makes the
  // test above evidence rather than decoration.
  it('leaves the room at paused@0 when the creator does NOT adopt', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 640 });
    try {
      await joined(a);
      await sleep(2000);
      assert.equal(a.engine.stats.cmdsSent, 0, 'something announced an already-playing creator');
      assert.equal(a.engine.currentAnchor.positionMs, 0);
      assert.equal(a.engine.currentAnchor.paused, true);
      assert.ok(a.player.readState().positionS < 640,
        'the room did not drag the player back -- the bug no longer reproduces');
    } finally {
      a.engine.stop();
    }
  });

  // The joiner half of the same question the creator test asks. A joiner does
  // NOT seed the room, so the escape hatch is the reconciler: the anchor is
  // truth about pause state too, and nothing in the correction table can press
  // pause. Only the creator path was covered; this pins the other one.
  it('pauses a joining member whose player is playing against a paused room', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 0 });
    try {
      await joined(a);
      await sleep(6000); // twice reconcileAfterMs
      assert.equal(a.player.paused, true,
        'never reconciled to the paused anchor -- the member fights the room forever');
      assert.ok(a.engine.stats.reconciles >= 1, 'the player was paused by something else');
      assert.equal(a.engine.stats.cmdsSent, 0, 'a joiner steered the room');
    } finally {
      a.engine.stop();
    }
  });

  // The next-episode flow, which is the first thing a series watcher hits: the
  // member navigates, then moves the room with a `media` command while their
  // new episode is already autoplaying. A `media` anchor is deliberately
  // `paused` (`room.go:353`) and no `play` is emitted -- the detector reports
  // transitions only and `setLocalMediaKey` just reset it. What makes that
  // safe is that the command's OWN transition pauses the member; if it ever
  // stops doing so, this is the fresh-room bug again by another route.
  it('a media command pauses the member whose player was already playing', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 100 }, true);
    try {
      await joined(a);
      await waitFor(() => a.engine.appliedSeq >= 2, 6000, 'the creator to seed the room');

      a.engine.setLocalMediaKey('e2e:media2'); // the navigation lands first
      a.engine.setMedia('e2e:media2', 0);
      await sleep(5000); // longer than reconcileAfterMs

      assert.equal(a.engine.currentAnchor.mediaKey, 'e2e:media2');
      assert.equal(a.engine.currentAnchor.paused, true, 'a media anchor must start paused');
      assert.equal(a.player.paused, true,
        'the player kept playing under a paused anchor -- it will be fought forever');
      assert.ok(a.player.readState().positionS < 1,
        `player at ${a.player.readState().positionS.toFixed(2)}s, not the new media's 0`);
    } finally {
      a.engine.stop();
    }
  });

  // What the user actually feels, alone in a room: their own play/pause must
  // not move the picture. It used to move it by the whole CMD_DELAY -- pausing
  // at 103.20 s landed the player at 103.70 s, and pressing play ran to
  // 104.31 s and was then pulled back to 103.80 s. Both were the scheduled
  // transition doing its job against an anchor placed CMD_DELAY in the future,
  // for the benefit of nobody: the room had one member.
  it('does not move the picture when the only member pauses and plays', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 100 }, true);
    try {
      await joined(a);
      await waitFor(() => a.engine.appliedSeq >= 2, 6000, 'the creator to seed the room');
      await sleep(3000); // let the servo settle

      // The USER pauses on the site's own player: it stops at once, and only
      // then does the detector notice and send the command.
      const atPause = a.player.readState().positionS;
      await a.player.pause();
      await sleep(2500); // longer than the old CMD_DELAY floor
      const afterPause = a.player.readState().positionS;
      assert.ok(Math.abs(afterPause - atPause) < 0.1,
        `paused at ${atPause.toFixed(2)}s and the picture moved to ${afterPause.toFixed(2)}s`);

      // And play must not rewind. Sampled throughout, because the jump was a
      // single backward step in the middle of otherwise correct playback --
      // comparing only the endpoints would not have seen it.
      await a.player.play();
      let prev = a.player.readState().positionS;
      let worst = 0;
      for (let i = 0; i < 25; i++) {
        await sleep(100);
        const now = a.player.readState().positionS;
        worst = Math.min(worst, now - prev);
        prev = now;
      }
      assert.ok(worst > -0.1, `the picture jumped back ${(-worst).toFixed(2)}s after pressing play`);
      assert.equal(a.engine.stats.correctionsSeek, 0, 'the room seek-corrected its only member');
    } finally {
      a.engine.stop();
    }
  });

  // What "pause" means, with somebody else in the room. The pause and the
  // position it happened at ARE the thing being synchronised: the person who
  // pressed it must stay on the frame they stopped on, and everybody else
  // converges to that frame. Previously the room pushed the pause CMD_DELAY
  // into the future and anchored where playback WOULD have reached, so the
  // pauser's own picture jumped forward into media they never saw.
  it('stops both members on the frame the pauser actually stopped on', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: true, positionS: 0 });
    const b = peer(roomId, secret, 'b', { paused: true, positionS: 0 });
    try {
      await joined(a, b);
      a.engine.seek(300);
      await waitFor(() => a.engine.appliedSeq >= 1 && b.engine.appliedSeq >= 1, 4000, 'the seek');
      a.engine.play();
      await waitFor(() => !a.player.paused && !b.player.paused, 4000, 'both to play');
      await sleep(1500);

      // `a` pauses on their own player, the way a user does.
      await a.player.pause();
      const stoppedOn = a.player.readState().positionS;
      await sleep(2500);

      assert.ok(Math.abs(a.player.readState().positionS - stoppedOn) < 0.1,
        `the pauser stopped on ${stoppedOn.toFixed(2)}s and was moved to ` +
        `${a.player.readState().positionS.toFixed(2)}s`);
      assert.equal(b.player.paused, true, 'the other member never stopped');
      assert.ok(Math.abs(b.player.readState().positionS - stoppedOn) < 0.35,
        `the pauser is on ${stoppedOn.toFixed(2)}s but the room stopped at ` +
        `${b.player.readState().positionS.toFixed(2)}s`);
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  // The play counterpart, measured live on Laftel (BROWSER-FINDINGS §15-16).
  // Left playing, the presser's picture jumped back by the command lead when
  // their own play landed. The room of two is what turns the hold on, so this
  // also proves the roster the real server sends counts both members.
  it('the member who presses play waits for the room instead of jumping back', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: true, positionS: 0 });
    const b = peer(roomId, secret, 'b', { paused: true, positionS: 0 });
    try {
      await joined(a, b);
      await waitFor(() => a.engine.roster.length === 2, 4000, 'a to see both members');
      a.engine.seek(300);
      await waitFor(() => a.engine.appliedSeq >= 1 && b.engine.appliedSeq >= 1, 4000, 'the seek');
      await sleep(500);

      // `a` presses play on their own player, and the element says so.
      await a.player.play();
      a.player.emit('play');
      const t0 = performance.now();
      const samples: Array<[number, number, boolean, boolean]> = [];
      while (performance.now() - t0 < 2500) {
        const sa = a.player.readState(), sb = b.player.readState();
        samples.push([performance.now() - t0, sa.positionS, sa.paused, sb.paused]);
        await sleep(10);
      }

      // The hold may re-aim the presser at the moment of the press, while
      // paused; what must not happen is a step back once they are moving.
      const held = samples.findIndex((q) => q[2]);
      let worst = 0;
      for (let i = Math.max(1, held + 1); i < samples.length; i++) {
        worst = Math.min(worst, samples[i]![1] - samples[i - 1]![1]);
      }
      assert.ok(worst > -0.1, `the presser's picture jumped back ${(-worst).toFixed(2)}s after being held`);

      // Both start together: the presser is not moving while the other waits.
      const startA = samples.findLast((q) => q[2])?.[0] ?? 0;
      const startB = samples.findLast((q) => q[3])?.[0] ?? 0;
      assert.ok(startA > 100, `the presser was never held (moving from ${startA.toFixed(0)} ms)`);
      assert.ok(Math.abs(startA - startB) < 100,
        `presser started at ${startA.toFixed(0)} ms, the other at ${startB.toFixed(0)} ms`);
      const pa = a.player.readState().positionS, pb = b.player.readState().positionS;
      assert.ok(Math.abs(pa - pb) < 0.1, `presser at ${pa.toFixed(3)}s, other at ${pb.toFixed(3)}s`);
      assert.equal(a.engine.stats.playsHeld, 1, 'the press was not held');
      assert.equal(a.engine.stats.correctionsSeek, 0);
      assert.equal(a.engine.stats.cmdsSent, 2, 'the hold leaked a command (seek + play expected)');
    } finally {
      a.engine.stop(); b.engine.stop();
    }
  });

  // The trace is what a live session hands back instead of retyping `status()`
  // by hand, and it is always on because every field bug so far was one-shot.
  // A trace that silently recorded nothing would be worse than none: "the
  // client never sent it" would look like evidence.
  it('records both directions of the wire, always, and stays bounded', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a');
    try {
      await joined(a);
      a.engine.seek(42);
      await waitFor(() => a.engine.appliedSeq >= 1, 4000, 'the seek to apply');

      const kinds = (dir: string) =>
        new Set(a.engine.trace.filter((e) => e.dir === dir).map((e) => e.t));
      await waitFor(() => kinds('tx').has('hb'), 3000, 'a heartbeat to be traced');
      assert.ok(kinds('tx').has('hello'), 'no hello in the trace');
      assert.ok(kinds('tx').has('cmd'), 'no outbound command in the trace');
      assert.ok(kinds('rx').has('welcome'), 'no welcome in the trace');
      assert.ok(kinds('rx').has('ack'), 'no ack in the trace');

      const ack = a.engine.trace.find((e) => e.dir === 'rx' && e.t === 'ack');
      assert.ok(ack?.detail['anchor'], 'the ack recorded no anchor -- the useful half');
      assert.equal(ack?.detail['kind'], 'seek');

      // Bounded: a session lasting hours must not grow this without limit.
      for (let i = 0; i < 400; i++) a.engine.chat(`x${i}`);
      assert.ok(a.engine.trace.length <= 250, `trace grew to ${a.engine.trace.length}`);
    } finally {
      a.engine.stop();
    }
  });

  // A joiner is NOT a creator: the anchor is truth and they must conform to it,
  // however loudly their own player disagrees.
  it('does not let a joining member seed a room that already has one', async function () {
    if (skip) { console.log(`SKIP: ${skip}`); return; }
    const { roomId, secret } = await createRoom('e2e:media');
    const a = peer(roomId, secret, 'a', { paused: false, positionS: 100 }, true);
    try {
      await joined(a);
      await waitFor(() => a.engine.appliedSeq >= 2, 6000, 'the creator to seed');
      const b = peer(roomId, secret, 'b', { paused: false, positionS: 3000 });
      try {
        await joined(b);
        await sleep(2500);
        assert.equal(b.engine.stats.cmdsSent, 0, 'the joiner steered the room');
        assert.ok(Math.abs(a.engine.currentAnchor.positionMs - 100_000) < 5000,
          'the joiner dragged the room to its own position');
      } finally {
        b.engine.stop();
      }
    } finally {
      a.engine.stop();
    }
  });
});
