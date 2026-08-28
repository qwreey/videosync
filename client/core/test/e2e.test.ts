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

function peer(roomId: string, secret: string, name: string, opts = {}): Peer {
  const player = new FakePlayer(realTime, { paused: true, positionS: 0, ...opts });
  const gates: Array<[boolean, readonly string[]]> = [];
  const chat: Array<{ name: string; text: string }> = [];
  const cfg: EngineConfig = {
    ...DEFAULT_ENGINE_CONFIG,
    room: roomId, secret, name, mediaKey: 'e2e:media',
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
  await waitFor(() => ps.every((p) => p.engine.state === 'joined' && p.engine.clock.ready),
    5000, 'every peer to join and settle its clock');
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
});
