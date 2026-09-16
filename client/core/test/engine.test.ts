import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../src/engine/engine.ts';
import type { EngineConfig, EngineEvents } from '../src/engine/engine.ts';
import { ServerClock } from '../src/engine/clock.ts';
import type { Anchor } from '../src/engine/clock.ts';
import { SwappableAdapter } from '../src/adapter/swappable.ts';
import { FakePlayer, FakeTransport, VirtualTime, flush } from './fakes.ts';
import type { FakePlayerOptions } from './fakes.ts';

const CFG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  room: 'r', secret: 's', name: 'me', mediaKey: 'yt:abc',
};

interface Harness {
  vt: VirtualTime;
  player: FakePlayer;
  tr: FakeTransport;
  engine: SyncEngine;
  events: {
    gates: Array<[boolean, readonly string[]]>;
    autoplayBlocked: number;
    errors: Array<[string, string]>;
    statuses: string[];
  };
  /** Complete the handshake: open, welcome, and let the clock settle. */
  join(anchor?: Partial<Anchor>, seq?: number, members?: number): Promise<void>;
}

function harness(opts: FakePlayerOptions = {}, cfg: Partial<EngineConfig> = {}): Harness {
  const vt = new VirtualTime();
  const player = new FakePlayer(vt, opts);
  const tr = new FakeTransport();
  const events = {
    gates: [] as Array<[boolean, readonly string[]]>,
    autoplayBlocked: 0,
    errors: [] as Array<[string, string]>,
    statuses: [] as string[],
  };
  const ev: EngineEvents = {
    onGate: (w, on) => { events.gates.push([w, on]); },
    onAutoplayBlocked: () => { events.autoplayBlocked++; },
    onError: (c, m) => { events.errors.push([c, m]); },
    onStatus: (s) => { events.statuses.push(s); },
  };
  const engine = new SyncEngine(
    { adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false },
    { ...CFG, ...cfg },
    ev,
  );
  const h: Harness = {
    vt, player, tr, engine, events,
    async join(anchor = {}, seq = 0, members = 0) {
      tr.autoAnswerTime(OFFSET);
      engine.start();
      tr.open();
      tr.deliver({
        t: 'welcome', you: 'me-1', seq,
        anchor: { positionMs: 0, atServerMs: 0, paused: true, mediaKey: 'yt:abc', ...anchor },
        members: Array.from({ length: members }, (_, i) => (
          { id: i === 0 ? 'me-1' : `other-${i}`, name: `m${i}`, suspended: false, ready: true })),
        serverMs: vt.now, mediaKey: 'yt:abc',
      });
      // The transport answers each probe in the same instant, so the samples
      // have a true zero RTT and `serverMs = vt.now + OFFSET` exactly.
      await vt.advance(400);
      await flush();
    },
  };
  return h;
}

/** The server's clock reads this much more than ours. */
const OFFSET = 1_000_000;

interface ParkedSeek {
  readonly pos: number;
  /** Finish the seek. `move: false` is a seek whose target never took -- a
   *  real adapter's timeout after the user scrubbed somewhere else. */
  release(move?: boolean): void;
}

/**
 * Make every seek on this player wait until the test lets it finish, the way
 * an out-of-buffer seek does for up to ten seconds. Returns the parked seeks,
 * oldest first; their `pos` is what the engine asked for.
 */
function parkSeeks(p: FakePlayer): ParkedSeek[] {
  const parked: ParkedSeek[] = [];
  const original = p.seekTo.bind(p);
  p.seekTo = (pos: number) => new Promise<void>((res) => {
    parked.push({
      pos,
      release: (move = true) => { if (move) void original(pos).then(res); else res(); },
    });
  });
  return parked;
}

describe('handshake', () => {
  it('sends hello on open and joins on welcome', async () => {
    const h = harness();
    await h.join();
    const hello = h.tr.sentOf('hello');
    assert.equal(hello.length, 1);
    assert.deepEqual(
      { room: hello[0]!.room, secret: hello[0]!.secret, mediaKey: hello[0]!.mediaKey },
      { room: 'r', secret: 's', mediaKey: 'yt:abc' },
    );
    assert.equal(h.engine.state, 'joined');
    assert.equal(h.engine.id, 'me-1');
  });

  it('settles the clock from the rapid connect probes before scheduling anything', async () => {
    const h = harness();
    await h.join();
    // 5 probes on connect: nothing may be scheduled against an unsettled offset.
    assert.ok(h.tr.sentOf('time').length >= 5, `only ${h.tr.sentOf('time').length} probes`);
    assert.ok(h.engine.clock.ready);
    assert.equal(h.engine.clock.serverNow(h.vt.now), h.vt.now + OFFSET);
  });

  it('refuses to keep running after join_refused', async () => {
    const h = harness();
    h.engine.start();
    h.tr.open();
    h.tr.deliver({ t: 'error', code: 'join_refused', msg: 'unknown room or secret' });
    assert.equal(h.engine.state, 'refused');
    assert.deepEqual(h.events.errors, [['join_refused', 'unknown room or secret']]);
  });
});

describe('scheduled transitions', () => {
  it('applies a state at `when`, not on arrival', async () => {
    const h = harness({ paused: true, positionS: 10 });
    await h.join();
    const when = h.vt.now + OFFSET + 800;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'play',
    });
    await h.vt.advance(400);
    assert.equal(h.player.paused, true, 'transitioned early');
    await h.vt.advance(500);
    assert.equal(h.player.paused, false, 'never transitioned');
    assert.equal(h.engine.appliedSeq, 1);
  });

  it('applies an ack down the SAME path as a state', async () => {
    // Excluding the sender from the broadcast for echo suppression must not
    // exclude it from the scheduling the timebase exists to provide. Measured
    // cost of getting this wrong: 4743 ms -> 32 ms (POC-FINDINGS §20).
    const h = harness({ paused: true, positionS: 10 });
    await h.join();
    const when = h.vt.now + OFFSET + 800;
    h.tr.deliver({
      t: 'ack', reqId: 'me-1', seq: 1, when, emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      kind: 'play',
    });
    await h.vt.advance(400);
    assert.equal(h.player.paused, true, 'the sender transitioned early -- it is not exempt');
    await h.vt.advance(500);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.appliedSeq, 1, 'ack did not advance lastAppliedSeq');
  });

  it('reports the seq an ack advanced, or every command triggers a resend', async () => {
    // The server resends state whenever a report's lastAppliedSeq lags. If an
    // ack does not advance it, the client asks for a resync after every
    // command it sends -- forever.
    const h = harness();
    await h.join();
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: 'x', seq: 7, when, emittedAt: when,
      anchor: { positionMs: 0, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      kind: 'pause',
    });
    await h.vt.advance(1200);
    const hbs = h.tr.sentOf('hb');
    assert.ok(hbs.length > 0);
    assert.equal(hbs.at(-1)!.lastAppliedSeq, 7);
  });

  it('aims at where the room is NOW when `when` has already passed', async () => {
    // The normal case on a slow link. Aiming at expected(when) would bake the
    // downlink delay in as sync error -- the client-side twin of the bug that
    // made every server correction land one downlink behind.
    const h = harness({ paused: false, positionS: 0 });
    await h.join();
    const late = h.vt.now + OFFSET - 5_000; // emitted 5 s ago
    h.tr.deliver({
      t: 'state', seq: 1, when: late, emittedAt: late - 500,
      anchor: { positionMs: 100_000, atServerMs: late, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'seek',
    });
    await h.vt.advance(50);
    // expected(when) would be 100 s; the room has run 5 s since.
    assert.ok(
      Math.abs(h.player.positionS - 105) < 0.5,
      `landed at ${h.player.positionS}s, want ~105s (100s anchor + the 5s it has been running)`,
    );
    assert.equal(h.engine.stats.lateApplies, 1);
  });

  it('discards a state at or below lastAppliedSeq', async () => {
    const h = harness({ paused: true, positionS: 0 });
    await h.join({}, 5);
    h.tr.deliver({
      t: 'state', seq: 5, when: h.vt.now + OFFSET,
      emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: 500_000, atServerMs: h.vt.now + OFFSET, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'seek',
    });
    await h.vt.advance(300);
    assert.equal(h.player.paused, true, 'a stale state was applied');
    assert.equal(h.player.seeks, 0);
  });

  it('does not seek when it is already within tolerance of the target', async () => {
    // An in-buffer seek is cheap but not free, and a visible re-render for
    // 50 ms of error is worse than the error.
    const h = harness({ paused: true, positionS: 10 });
    await h.join();
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 10_050, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      by: 'other', kind: 'pause',
    });
    await h.vt.advance(50);
    assert.equal(h.player.seeks, 0, 'seeked to fix 50 ms');

    // The control: 5 s out and it does seek.
    h.tr.deliver({
      t: 'state', seq: 2, when: h.vt.now + OFFSET, emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: 15_000, atServerMs: h.vt.now + OFFSET, paused: true, mediaKey: 'yt:abc' },
      by: 'other', kind: 'seek',
    });
    await h.vt.advance(50);
    assert.equal(h.player.seeks, 1);
    assert.equal(h.player.positionS, 15);
  });
});

describe('echo suppression is structural', () => {
  it('a server-ordered seek produces no outbound command', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET, why: 'test' });
    await h.vt.advance(2000);
    assert.equal(h.tr.sentOf('cmd').length, before, 'rebroadcast our own correction');
    assert.equal(h.engine.stats.correctionsSeek, 1);
  });

  it('a server-ordered pause produces no outbound command', async () => {
    // The two-diff test protects seeks structurally; pause has no such
    // protection unless rebaseline carries the new pause state.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 11_000, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      by: 'other', kind: 'pause',
    });
    await h.vt.advance(3000);
    assert.equal(h.player.paused, true);
    assert.equal(h.tr.sentOf('cmd').length, before, 'rebroadcast the pause the room just told us to make');
  });

  it('a genuine local pause IS broadcast', async () => {
    // The control: the suppression above must not be "never broadcast".
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    await h.player.pause(); // the user pressed pause
    await h.vt.advance(300);
    const cmds = h.tr.sentOf('cmd');
    assert.equal(cmds.length, before + 1, 'a real user pause was swallowed');
    assert.equal(cmds.at(-1)!.kind, 'pause');
  });

  it('a genuine local seek IS broadcast', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    h.player.positionS = 400; // the user dragged the scrubber
    await h.vt.advance(300);
    const cmds = h.tr.sentOf('cmd');
    assert.equal(cmds.length, before + 1);
    assert.equal(cmds.at(-1)!.kind, 'seek');
    assert.ok(Math.abs(cmds.at(-1)!.positionMs - 400_000) < 2000);
  });
});

describe('heartbeat', () => {
  it('carries every field PROTOCOL §4 lists', async () => {
    // Each omission disables a mechanism silently: no uncertaintyMs collapses
    // the server's dead-band, no rttMs pins CMD_DELAY at its floor, no
    // suspended makes the server seek a member who is not watching.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1500);
    const hb = h.tr.sentOf('hb').at(-1);
    assert.ok(hb, 'no heartbeat was ever sent');
    for (const k of [
      'residualMs', 'slopeMsPerS', 'positionMs', 'paused', 'readyState',
      'bufferedAheadS', 'bufferedBehindS', 'lastAppliedSeq', 'atServerMs',
      'uncertaintyMs', 'rttMs', 'clockSamples', 'suspended',
    ]) {
      assert.ok(k in hb, `heartbeat is missing ${k}`);
      assert.notEqual((hb as unknown as Record<string, unknown>)[k], undefined, `${k} is undefined`);
    }
    // Stamped from our own estimate of the server clock at send time.
    assert.ok(hb.atServerMs > OFFSET && hb.atServerMs <= h.vt.now + OFFSET,
      `atServerMs ${hb.atServerMs} is not a plausible server instant`);
  });

  it('beats about once a second, not once per evaluation', async () => {
    // The server's hb bucket is burst 40 then 20/s and drops the excess
    // SILENTLY. An engine reporting at the 10 Hz eval rate would be throttled
    // without ever being told.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(10_000);
    const n = h.tr.sentOf('hb').length;
    assert.ok(n >= 8 && n <= 14, `${n} heartbeats in 10 s; want ~10`);
  });

  it('reports an anomaly immediately, but never faster than the floor', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('hb').length;
    h.player.positionS += 4; // 4 s out of position, well past REPORT_THRESHOLD
    await h.vt.advance(900);
    const n = h.tr.sentOf('hb').length - before;
    assert.ok(n >= 2, `only ${n} reports in 900 ms of a 4 s divergence`);
    assert.ok(n <= 5, `${n} reports in 900 ms; the 250 ms floor allows at most 4`);
  });
});

describe('corrections', () => {
  it('applies a nudge within the clamp', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.04, when: h.vt.now + OFFSET });
    await flush();
    assert.equal(h.player.rate, 1.04);
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 3, when: h.vt.now + OFFSET });
    await flush();
    assert.equal(h.player.rate, 1.1, 'an out-of-range rate was applied verbatim');
  });

  it('counts a nudge it cannot honour instead of ignoring it', async () => {
    // A provider that fights playbackRate gets seek-only correction. Silently
    // dropping the frequency half of the control law would look like the servo
    // merely performing badly.
    const h = harness({ paused: false, positionS: 10, capabilities: { supportsPlaybackRateNudge: false } });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.05, when: h.vt.now + OFFSET });
    await flush();
    assert.equal(h.player.rate, 1, 'nudged a player that said it could not be nudged');
    assert.equal(h.engine.stats.nudgesUnsupported, 1);
  });

  it('re-derives the seek target at apply time', async () => {
    const h = harness({ paused: false, positionS: 0 });
    await h.join({ positionMs: 50_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(2000);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await h.vt.advance(50);
    // anchor 50 s at t=0, room has run ~2 s: the target is ~52 s, and the
    // frame carried no position at all.
    assert.ok(Math.abs(h.player.positionS - 52) < 0.5, `landed at ${h.player.positionS}s, want ~52s`);
  });
});

describe('the browser taking playback away', () => {
  it('surfaces a refused autoplay and reports itself as absent', async () => {
    // Swallowing this leaves the member paused while the room plays, reporting
    // a residual that grows forever, with the server seeking it in circles --
    // every seek "working" and the residual never closing.
    const h = harness({ paused: true, positionS: 0, autoplayBlocked: true });
    await h.join();
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 0, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'play',
    });
    await h.vt.advance(1500);
    assert.equal(h.events.autoplayBlocked, 1);
    assert.equal(h.engine.blocked, true);
    assert.equal(h.player.paused, true);
    const hb = h.tr.sentOf('hb').at(-1)!;
    assert.equal(hb.suspended, true, 'a member the browser will not let play must read as absent');
    assert.equal(h.tr.sentOf('cmd').length, 0, 'a blocked member must not command the room');
  });

  it('recovers on a user gesture', async () => {
    const h = harness({ paused: true, positionS: 0, autoplayBlocked: true });
    await h.join();
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 0, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'play',
    });
    await h.vt.advance(500);
    h.player.autoplayBlocked = false; // the user clicked
    await h.engine.resumeAfterGesture();
    await h.vt.advance(1200);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.blocked, false);
    assert.equal(h.tr.sentOf('hb').at(-1)!.suspended, false);
  });
});

describe('the readiness gate is not the client\'s business', () => {
  it('never touches the player', async () => {
    // The gate holds the command on the server, before the anchor moves. If
    // the client acted on the frame we would have reintroduced the client
    // cooperation the design deliberately does without.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(500);
    const seeks = h.player.seeks, pauses = h.player.pauses;
    h.tr.deliver({ t: 'gate', waiting: true, waitingOn: ['someone'], reason: 'buffering' });
    await h.vt.advance(1000);
    assert.equal(h.player.paused, false, 'the client paused itself for the gate');
    assert.equal(h.player.pauses, pauses);
    assert.equal(h.player.seeks, seeks);
    assert.deepEqual(h.events.gates, [[true, ['someone']]]);
  });
});

describe('buffering', () => {
  it('is reported, and never mistaken for a backward seek', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    h.player.stall();
    await h.vt.advance(5000);
    assert.equal(h.tr.sentOf('cmd').length, before, 'a stall was broadcast as user intent');
    const hb = h.tr.sentOf('hb').at(-1)!;
    assert.equal(hb.readyState, 2);
    assert.equal(hb.bufferedAheadS, 0);
    assert.equal(hb.suspended, false, 'buffering is not absence: the room may wait for us');
  });

  it('a playing element whose clock freezes at readyState 4 is a stall, not a seek', async () => {
    // The other half of the stall guard: a decoder that stops advancing
    // without ever dropping readyState. Dead-reckoned, the held reference
    // walks away from the frozen position while the room keeps moving, and
    // within a second both diffs are large -- a backward "seek" the whole room
    // would follow. The readyState test above cannot catch this one.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    const before = h.tr.sentOf('cmd').length;
    const stalls = h.engine.detector.stallDetections;
    const read = h.player.readState.bind(h.player);
    const frozenAt = read().positionS;
    h.player.readState = () => ({ ...read(), positionS: frozenAt });
    await h.vt.advance(4000);
    assert.deepEqual(h.tr.sentOf('cmd').slice(before), [], 'a frozen element was broadcast as a seek');
    assert.ok(h.engine.detector.stallDetections > stalls, 'the freeze was not recognised as a stall');
  });

  it('holds back an unready report while the buffer is full, briefly', async () => {
    // BROWSER-FINDINGS §14: an in-buffer seek on Laftel reads readyState 1
    // with 45 s ahead for ~100 ms. Sent, it gates the room for nothing.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    h.tr.sent.length = 0;
    h.player.readyState = 1;                      // mid-seek, buffer intact
    await h.vt.advance(150);
    h.player.readyState = 4;                      // seeked
    await h.vt.advance(1500);
    assert.ok(h.tr.sentOf('hb').every((f) => f.readyState === 4),
      'a mid-seek readyState reached the server');
    assert.ok(h.engine.stats.reportsDeferred >= 1);
  });

  it('still reports a player that stays unready with a full buffer', async () => {
    // The deferral is bounded: a decoder that is genuinely stuck must still
    // be able to hold the room.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    h.tr.sent.length = 0;
    h.player.readyState = 1;
    await h.vt.advance(2000);
    assert.ok(h.tr.sentOf('hb').some((f) => f.readyState === 1), 'a stuck player was never reported');
  });
});

describe('reconnect', () => {
  it('throws the clock estimate away and backs off', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    assert.ok(h.engine.clock.ready);
    h.tr.drop('link died');
    assert.equal(h.engine.clock.ready, false, 'kept an offset measured against a dead socket');
    assert.equal(h.engine.stats.reconnects, 1);
    const connects = h.tr.connects;
    await h.vt.advance(600);
    assert.equal(h.tr.connects, connects + 1);
  });

  it('reconnects with the secret the room rotated to, not the one it joined with', async () => {
    // The server replaces the secret on rotation and checks every hello
    // against the new one. Sending the old one gets `join_refused`, which ends
    // the session for good -- for everybody whose link blips afterwards,
    // including whoever pressed rotate.
    const h = harness();
    await h.join();
    h.tr.deliver({ t: 'secret', secret: 'NEW', rotated: 'other-1' });
    h.tr.drop('link blip');
    await h.vt.advance(1000);
    h.tr.open();
    const hellos = h.tr.sentOf('hello');
    assert.equal(hellos.length, 2);
    assert.equal(hellos[0]!.secret, 's');
    assert.equal(hellos[1]!.secret, 'NEW', 'reconnected with a secret the server no longer accepts');
  });

  it('does not reconnect after a clean stop', async () => {
    const h = harness();
    await h.join();
    const connects = h.tr.connects;
    h.engine.stop();
    h.tr.handlers?.onClose(true, 'bye');
    await h.vt.advance(30_000);
    assert.equal(h.tr.connects, connects);
    assert.equal(h.engine.state, 'closed');
  });
});

describe('the wire contract', () => {
  it('never puts a fractional number where the server expects an int64', async () => {
    // Found the hard way by the end-to-end test: `performance.now()` is
    // fractional, so `{"t":"time","t0":874.47}` was rejected with `bad_frame`
    // by every server. Nothing failed -- the session stayed joined, the clock
    // never settled, and no correction ever fired again. A mock of either side
    // alone cannot catch this, so it is pinned here as well.
    const INT_FIELDS: Record<string, readonly string[]> = {
      time: ['t0'],
      cmd: ['positionMs'],
      hb: ['residualMs', 'positionMs', 'readyState', 'lastAppliedSeq',
        'atServerMs', 'uncertaintyMs', 'rttMs', 'clockSamples'],
    };
    const h = harness({ paused: false, positionS: 10.4567 });
    await h.join({ positionMs: 10_456, atServerMs: OFFSET, paused: false });
    await h.vt.advance(3000);
    h.player.positionS += 7; // provoke a seek command and an anomaly report
    await h.vt.advance(2000);

    let checked = 0;
    for (const f of h.tr.sent) {
      const fields = INT_FIELDS[f.t];
      if (!fields) continue;
      for (const k of fields) {
        const v = (f as unknown as Record<string, unknown>)[k];
        assert.equal(typeof v, 'number', `${f.t}.${k} is ${typeof v}`);
        assert.ok(Number.isInteger(v), `${f.t}.${k} = ${v} is not an integer`);
        checked++;
      }
    }
    assert.ok(checked > 10, `only ${checked} integer fields were exercised`);
  });
});

describe('the element being replaced under us', () => {
  /** A harness whose adapter is swappable, as a single-page app requires. */
  function swapHarness() {
    const vt = new VirtualTime();
    const swap = new SwappableAdapter();
    const first = new FakePlayer(vt, { paused: false, positionS: 300 });
    swap.setTarget(first);
    const tr = new FakeTransport();
    tr.autoAnswerTime(OFFSET);
    const engine = new SyncEngine(
      {
        adapter: swap, transport: tr, now: () => vt.now,
        setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false,
      },
      { ...CFG, mediaKey: 'yt:one' },
    );
    return { vt, swap, first, tr, engine };
  }

  async function join(h: ReturnType<typeof swapHarness>, mediaKey = 'yt:one'): Promise<void> {
    h.engine.start();
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 300_000, atServerMs: OFFSET, paused: false, mediaKey },
      members: [], serverMs: h.vt.now + OFFSET, mediaKey,
    });
    await h.vt.advance(1000);
  }

  it('does not broadcast a router swap as a user seek', async () => {
    // The replacement element is somewhere else entirely -- here at 400 s,
    // because the site restored a "continue watching" position. Without a
    // reset the next evaluation sees a jump that is large in BOTH diffs, so the
    // two-diff test calls it a user seek and the whole room follows it into a
    // video nobody else is watching.
    //
    // What absorbs it is the `elementreplaced` reset, in both directions. The
    // stall guard does not: since the detector compares the held reference
    // even while unready or frozen (BROWSER-FINDINGS §19), a jump that is
    // large in both diffs is a seek there too.
    const h = swapHarness();
    await join(h);
    const before = h.tr.sentOf('cmd').length;

    h.swap.setTarget(new FakePlayer(h.vt, { paused: false, positionS: 400 }));
    await h.vt.advance(3000);

    const sent = h.tr.sentOf('cmd').slice(before);
    assert.deepEqual(sent, [], `the swap produced commands: ${JSON.stringify(sent)}`);
  });

  it('the backward case is absorbed by the same element-replaced reset', async () => {
    // A swap to an element at 0 is a 300 s BACKWARD jump. It once looked as if
    // the stall guard absorbed that for free; it does not, and making the
    // reset conditional on direction would broadcast every such swap as a
    // seek to 0.
    const h = swapHarness();
    await join(h);
    const before = h.tr.sentOf('cmd').length;
    h.swap.setTarget(new FakePlayer(h.vt, { paused: false, positionS: 0 }));
    await h.vt.advance(3000);
    assert.deepEqual(h.tr.sentOf('cmd').slice(before), []);
  });

  it('puts the new element where the room is, when it is the same media', async () => {
    const h = swapHarness();
    await join(h);
    const next = new FakePlayer(h.vt, { paused: false, positionS: 0 });
    h.swap.setTarget(next);
    await h.vt.advance(500);
    assert.ok(Math.abs(next.readState().positionS - 301) < 1.5,
      `new element left at ${next.readState().positionS}s while the room is at ~301s`);
  });

  it('leaves a DIFFERENT video alone, and stops steering the room', async () => {
    // Snapping someone's next episode to the previous one's timestamp is worse
    // than doing nothing, and a member on other media must not command a room
    // whose timeline theirs has nothing to do with.
    //
    // In the order `bootstrap`'s PageWatcher does it: the element is retargeted
    // FIRST and the media key follows. `setTarget` fires `elementreplaced`
    // synchronously, so at that instant the engine still believes it is on the
    // room's media; only a check made when the queued work actually runs can
    // see the navigation.
    const h = swapHarness();
    await join(h);
    const before = h.tr.sentOf('cmd').length;

    const next = new FakePlayer(h.vt, { paused: false, positionS: 0 });
    h.swap.setTarget(next);
    h.engine.setLocalMediaKey('yt:two');
    await h.vt.advance(3000);

    assert.equal(h.engine.followingRoom, false);
    assert.ok(next.readState().positionS < 5, `the other video was yanked to ${next.readState().positionS}s`);
    assert.deepEqual(h.tr.sentOf('cmd').slice(before), []);

    // A member watching something else is absent, not behind: reporting
    // otherwise makes the server correct them against a foreign timeline.
    const hb = h.tr.sentOf('hb').at(-1)!;
    assert.equal(hb.suspended, true);
  });

  it('ignores room transitions while on different media', async () => {
    const h = swapHarness();
    await join(h);
    h.engine.setLocalMediaKey('yt:two');
    const next = new FakePlayer(h.vt, { paused: false, positionS: 10 });
    h.swap.setTarget(next);
    await h.vt.advance(500);

    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 900_000, atServerMs: when, paused: true, mediaKey: 'yt:one' },
      by: 'other', kind: 'seek',
    });
    await h.vt.advance(500);
    assert.ok(next.readState().positionS < 15, `seeked to ${next.readState().positionS}s on foreign media`);
    assert.equal(h.engine.stats.skippedOffMedia, 1);
    // The anchor is still tracked, so rejoining the room's media resumes cleanly.
    assert.equal(h.engine.currentAnchor.positionMs, 900_000);
  });

  it('announces the CURRENT media when it reconnects', async () => {
    // Reconnecting after a navigation must not tell the server we are still on
    // the video we joined with.
    const h = swapHarness();
    await join(h);
    h.engine.setLocalMediaKey('yt:two');
    h.tr.drop('link died');
    await h.vt.advance(2000);
    h.tr.open();
    await h.vt.advance(100);
    assert.equal(h.tr.sentOf('hello').at(-1)!.mediaKey, 'yt:two');
  });

  it('says where its media can be opened, in the hello and in a media command', async () => {
    const h = harness({}, { mediaUrl: 'https://www.youtube.com/watch?v=abc' });
    await h.join();
    assert.equal(h.tr.sentOf('hello')[0]!.mediaUrl, 'https://www.youtube.com/watch?v=abc');

    h.engine.setLocalMediaKey('yt:two', 'https://www.youtube.com/watch?v=two');
    h.engine.setMedia('yt:two', 0, 'https://www.youtube.com/watch?v=two');
    const cmd = h.tr.sentOf('cmd').at(-1)!;
    assert.deepEqual([cmd.kind, cmd.mediaKey, cmd.mediaUrl], ['media', 'yt:two', 'https://www.youtube.com/watch?v=two']);

    // And nothing at all when it does not know, rather than an empty string.
    h.engine.setMedia('yt:three');
    assert.equal('mediaUrl' in h.tr.sentOf('cmd').at(-1)!, false);
  });
});

describe('applying transitions is serialised', () => {
  it('a command arriving mid-seek cannot invert an earlier one', async () => {
    // A frame arriving while an earlier transition is parked in seekTo is
    // bookkept at once and its player work queued behind. Without the queue
    // the effects could land out of order, leaving the player paused with an
    // anchor that says playing and nothing that will ever notice: the corrector
    // only ever seeks or nudges, it never presses play.
    //
    // The adapter makes the overlap concrete rather than theoretical: two
    // in-flight seekTo calls both resolve on the same `seeked` event.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });

    const gate: { release: (() => void) | null } = { release: null };
    const original = h.player.seekTo.bind(h.player);
    h.player.seekTo = (pos: number) => {
      if (gate.release) return original(pos);
      return new Promise<void>((res) => {
        gate.release = () => { void original(pos).then(res); };
      });
    };

    const when1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when: when1, emittedAt: when1,
      anchor: { positionMs: 500_000, atServerMs: when1, paused: true, mediaKey: 'yt:abc' },
      by: 'other', kind: 'pause',
    });
    await h.vt.advance(50);          // seq 1 is now parked inside seekTo

    const when2 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 2, when: when2, emittedAt: when2,
      anchor: { positionMs: 500_000, atServerMs: when2, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'play',
    });
    await h.vt.advance(200);
    gate.release?.();                // seq 1 finally completes
    await h.vt.advance(500);

    assert.equal(h.engine.appliedSeq, 2);
    assert.equal(h.engine.currentAnchor.paused, false);
    assert.equal(h.player.paused, false,
      'the player is paused while the room plays, and nothing in the design will ever press play');
  });

  it('a newer command is taken on while an older one is still seeking, and the older one yields', async () => {
    // Waiting for each transition's player work before even bookkeeping the
    // next meant a pause pressed by somebody else sat unacknowledged for as
    // long as a slow seek took: the heartbeat kept saying the old seq, and
    // when the seek finished the stale transition's play() ran first.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);

    const when1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when: when1, emittedAt: when1,
      anchor: { positionMs: 500_000, atServerMs: when1, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'seek',
    });
    await h.vt.advance(1000);
    assert.equal(parked.length, 1, 'seq 1 is not parked in its seek');

    const when2 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 2, when: when2, emittedAt: when2,
      anchor: { positionMs: 500_000, atServerMs: when2, paused: true, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'pause',
    });
    await h.vt.advance(4000);
    assert.equal(h.engine.appliedSeq, 2, 'a pause waited for somebody else\'s seek');
    assert.equal(h.engine.currentAnchor.paused, true);
    assert.equal(h.tr.sentOf('hb').at(-1)!.lastAppliedSeq, 2);

    const plays = h.player.plays;
    parked[0]!.release();
    await h.vt.advance(100);
    assert.equal(h.player.plays, plays, 'the superseded transition still pressed play');
    assert.equal(h.player.paused, true);
    assert.ok(h.engine.stats.supersededApplies >= 1);
  });
});

describe('queued player work re-checks the session when it runs', () => {
  // Every mutation is serialised, and one can wait behind a seek for ten
  // seconds. Whatever held when it was queued may not hold when it runs.

  it('a correction queued behind a slow seek does nothing once the link drops', async () => {
    // With the clock reset to a zero offset, `expected()` of a playing anchor
    // is about -1.8e12 ms: a real element clamps that to 0, and the seek then
    // blocks the queue for its whole timeout.
    const h = harness({ paused: false, positionS: 100 });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await flush();
    assert.equal(parked.length, 1);

    h.tr.drop('link died');
    parked[0]!.release();
    await flush(); await flush();
    assert.deepEqual(parked.slice(1).map((p) => p.pos), [], 'a queued correction ran into a dead session');
    assert.ok(h.player.positionS > 99, `moved to ${h.player.positionS}s`);
  });

  it('a correction queued behind a slow seek does nothing after leaving', async () => {
    const h = harness({ paused: false, positionS: 100 });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await flush();
    h.engine.stop();
    parked[0]!.release();
    await flush(); await flush();
    assert.equal(parked.length, 1, 'moved the player of somebody who left the room');
  });

  it('a click to sync while reconnecting waits for the session, then plays', async () => {
    const h = harness({ paused: true, positionS: 0, autoplayBlocked: true });
    await h.join({}, 0, 2);
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 100_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'play',
    });
    await h.vt.advance(300);
    assert.equal(h.engine.blocked, true);

    h.tr.drop('link blip');
    h.player.autoplayBlocked = false;             // the user clicks the overlay
    const seeks = h.player.seeks;
    await h.engine.resumeAfterGesture();
    await flush();
    assert.equal(h.player.seeks, seeks, `seeked to ${h.player.positionS}s with no clock`);
    assert.equal(h.player.paused, true, 'started playing with no session');

    // The session comes back; the click is honoured then.
    await h.vt.advance(600);
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 1,
      anchor: { positionMs: 100_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      members: [], serverMs: h.vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    await h.vt.advance(500);
    assert.equal(h.player.paused, false, 'the click was forgotten');
    assert.equal(h.engine.blocked, false);
    const expected = h.engine.expectedMs()! / 1000;
    assert.ok(Math.abs(h.player.positionS - expected) < 0.5, `at ${h.player.positionS}s, room at ${expected}s`);
  });

  /** A joined engine on a swappable adapter; `answerTime` false leaves the clock unsettled. */
  async function swapJoined(answerTime: boolean) {
    const vt = new VirtualTime();
    const swap = new SwappableAdapter();
    const first = new FakePlayer(vt, { paused: false, positionS: 300 });
    swap.setTarget(first);
    const tr = new FakeTransport();
    if (answerTime) tr.autoAnswerTime(OFFSET);
    const engine = new SyncEngine(
      { adapter: swap, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false },
      { ...CFG },
    );
    engine.start();
    tr.open();
    tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 300_000, atServerMs: OFFSET, paused: false, mediaKey: 'yt:abc' },
      members: [], serverMs: OFFSET, mediaKey: 'yt:abc',
    });
    await vt.advance(answerTime ? 1000 : 10);
    return { vt, swap, first, tr, engine };
  }

  it('an element swap before the clock settles leaves the new element alone', async () => {
    // Joined is not the same as settled: the welcome arrives before the probes
    // come back, and a router swap in that window aimed at ~-1.8e12 ms.
    const h = await swapJoined(false);
    assert.equal(h.engine.clock.ready, false);
    const next = new FakePlayer(h.vt, { paused: false, positionS: 5 });
    h.swap.setTarget(next);
    await h.vt.advance(50);
    assert.equal(next.seeks, 0, `seeked the new element to ${next.positionS}s`);
  });

  it('an element swap queued behind a slow seek does not start playback after leaving', async () => {
    const h = await swapJoined(true);
    const parked = parkSeeks(h.first);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await flush();
    assert.equal(parked.length, 1);
    const next = new FakePlayer(h.vt, { paused: true, positionS: 0 });
    h.swap.setTarget(next);                     // queues "put it where the room is"
    h.engine.stop();                            // the user presses Leave
    parked[0]!.release();
    await flush(); await flush();
    assert.equal(next.plays, 0, 'started the video playing after the user left');
    assert.equal(next.seeks, 0);
  });

  it('a pause and a scrub made during an engine seek are sent, not swallowed', async () => {
    // While a seek is in flight the engine used to skip every observation and
    // then rebaseline onto whatever the player showed -- so the user's pause
    // and scrub became the baseline, were never sent, and the reconciler then
    // put the player back where the room was and pressed play.
    const h = harness({ paused: false, positionS: 50 });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    const before = h.tr.sentOf('cmd').length;
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await h.vt.advance(500);
    assert.equal(parked.length, 1);

    await h.player.pause();                     // the user pauses
    h.player.emit('pause');
    await h.vt.advance(1500);
    h.player.positionS = 500;                   // ...and scrubs
    h.player.emit('seeked');
    await h.vt.advance(100);
    parked[0]!.release(false);                  // the engine's seek never took
    await h.vt.advance(100);

    const sent = h.tr.sentOf('cmd').slice(before);
    assert.deepEqual(sent.map((c) => c.kind), ['pause', 'seek'], `sent ${JSON.stringify(sent)}`);
    assert.ok(Math.abs(sent[1]!.positionMs - 500_000) < 1000);
  });

  it('control: the engine\'s own seek and pause inside that window are not sent', async () => {
    const h = harness({ paused: false, positionS: 50 });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    const before = h.tr.sentOf('cmd').length;
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 300_000, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'pause',
    });
    await h.vt.advance(300);
    assert.equal(parked.length, 1);
    parked[0]!.release();
    h.player.emit('seeked');
    await flush();
    await h.vt.advance(3000);
    assert.equal(h.player.paused, true);
    assert.ok(Math.abs(h.player.positionS - 300) < 0.01, `at ${h.player.positionS} after ${h.player.seeks} seeks`);
    assert.deepEqual(h.tr.sentOf('cmd').slice(before), []);
  });
});

describe('going absent', () => {
  it('hands the playback rate back before it stops being judged', async () => {
    // A member the server has stopped judging keeps whatever rate the servo
    // last set -- including onto whatever they navigate to next, because a site
    // that reuses its <video> keeps its playbackRate. Watching an unrelated
    // episode at 1.05x forever, with nothing that will ever notice.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.05, when: h.vt.now + OFFSET });
    await h.vt.advance(300);
    assert.equal(h.player.rate, 1.05);

    h.engine.setLocalMediaKey('yt:somewhere-else');
    await h.vt.advance(1200);
    assert.equal(h.player.rate, 1, 'left the player running fast on media the room is not watching');
    assert.equal(h.tr.sentOf('hb').at(-1)!.suspended, true);
  });

  it('hands the playback rate back on leaving the room', async () => {
    // Measured on Laftel: two tabs that had left their room were still
    // playing at 0.997x and 1.036x.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.036, when: h.vt.now + OFFSET });
    await h.vt.advance(300);
    assert.equal(h.player.rate, 1.036);
    h.engine.stop();
    assert.equal(h.player.rate, 1, 'kept the room\'s nudge after leaving it');
  });

  it('leaves a rate somebody else chose after the last nudge', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.036, when: h.vt.now + OFFSET });
    await h.vt.advance(300);
    h.player.setRate(1.5);                        // the user picked 1.5x from the site's menu
    h.engine.stop();
    assert.equal(h.player.rate, 1.5);
  });
});

describe('the anchor is truth about being paused, too', () => {
  it('re-applies when the player is paused against a playing room', async () => {
    // Nothing used to enforce this. A play() that failed, a transition that
    // lost a race, or a site pausing the element for its own reasons all left
    // the member paused against a playing room -- reporting a growing residual
    // and being seek-corrected forever, because the corrector only ever seeks
    // or nudges and never presses play.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(500);

    // Something outside our control stops the element. Not a user gesture as
    // far as the room is concerned -- the anchor still says playing.
    h.player.paused = true;
    h.tr.sent.length = 0;
    await h.vt.advance(1500);
    assert.equal(h.player.paused, true, 'reconciled far too eagerly');

    await h.vt.advance(2500);
    assert.equal(h.player.paused, false, 'never came back to what the room is doing');
    assert.ok(h.engine.stats.reconciles >= 1);
  });

  it('leaves a genuine local pause alone long enough to become a command', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(500);

    await h.player.pause();                      // the user pressed pause
    await h.vt.advance(400);
    const cmds = h.tr.sentOf('cmd');
    assert.equal(cmds.at(-1)?.kind, 'pause', 'the pause was not broadcast');
    assert.equal(h.player.paused, true, 'fought the user before the room could answer');

    // The room agrees, and the disagreement is over.
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: cmds.at(-1)!.reqId, seq: 1, when, emittedAt: when,
      anchor: { positionMs: 10_500, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      kind: 'pause',
    });
    await h.vt.advance(5000);
    assert.equal(h.player.paused, true);
    assert.equal(h.engine.stats.reconciles, 0);
  });
});

describe('a local play waits for the room (holdLocalPlay)', () => {
  // BROWSER-FINDINGS §15: left playing, the presser's picture jumped back
  // ~650 ms when their own play landed, and the seek-back left them behind.

  async function pressPlay(members: number, cfg: Partial<EngineConfig> = {}, positionS = 10) {
    const h = harness({ paused: true, positionS }, cfg);
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, members);
    await h.vt.advance(500);
    h.tr.sent.length = 0;
    await h.player.play();            // the user pressed play
    h.player.emit('play');
    await h.vt.advance(60);           // the element runs a little before anyone reacts
    await flush();
    return h;
  }

  it('re-pauses at the anchor and sends exactly one play', async () => {
    const h = await pressPlay(2);
    await h.vt.advance(100);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['play']);
    assert.equal(h.player.paused, true, 'kept playing ahead of the room');
    assert.ok(Math.abs(h.player.positionS - 10) <= 0.08, `held at ${h.player.positionS}, not at the anchor`);
    assert.equal(h.engine.stats.playsHeld, 1);

    // The ack lands at `when`: everybody starts together, and nobody seeks.
    const seeksBefore = h.player.seeks;
    const when = h.vt.now + OFFSET + 400;
    h.tr.deliver({
      t: 'ack', reqId: cmds[0]!.reqId, seq: 1, when, emittedAt: when - 500,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      kind: 'play',
    });
    await h.vt.advance(300);
    assert.equal(h.player.paused, true, 'started before `when`');
    await h.vt.advance(200);
    assert.equal(h.player.paused, false, 'never started');
    assert.equal(h.player.seeks, seeksBefore, 'the landing seeked -- the hold should have made it unnecessary');

    // The pause the hold made never became a command.
    await h.vt.advance(3000);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['play']);
    assert.equal(h.engine.stats.reconciles, 0);
  });

  it('re-aims a player that was off the anchor, and leaves a near miss alone', async () => {
    // The previous pause lands every member who is within seekToleranceMs
    // where they are, so a presser can start up to 250 ms off.
    const far = await pressPlay(2, {}, 10.2);
    await far.vt.advance(100);
    assert.equal(far.player.seeks, 1);
    assert.ok(Math.abs(far.player.positionS - 10) < 0.001, `held at ${far.player.positionS}`);

    // A paused seek makes the next start ~70 ms late on Laftel: not worth it
    // for less than that.
    const near = await pressPlay(2, {}, 9.98);   // ~40 ms off by the time the hold runs
    await near.vt.advance(100);
    assert.equal(near.player.paused, true);
    assert.equal(near.player.seeks, 0, "seeked to fix 40 ms");
  });

  it('stays paused, without fighting, if the room never answers', async () => {
    // A play the gate holds, or one a later command supersedes, gets no ack.
    // Paused is what the room says, so that is where the player belongs.
    const h = await pressPlay(2);
    await h.vt.advance(6000);
    assert.equal(h.player.paused, true);
    assert.equal(h.engine.stats.reconciles, 0);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['play']);
  });

  it('ends up playing when the press races somebody else\'s play', async () => {
    // Both pressed at once: ours goes out and is held, theirs lands. The room
    // is playing, so the player must be too -- the hold must not outlive it.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'play',
    });
    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(200);
    assert.equal(h.player.paused, false, 'the hold outlived the room starting');
    await h.vt.advance(4000);
    assert.equal(h.player.paused, false);
  });

  it('an echo of the room\'s own play is not held', async () => {
    // The room is already playing: the play the detector sees is our applied
    // transition coming back around, not a local press.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'play',
    });
    await h.vt.advance(10);           // applied: the room is playing now
    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(200);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.stats.playsHeld, 0, 'an echo of the room is not a local play');
  });

  it('control: alone in a room there is nothing to wait for', async () => {
    const h = await pressPlay(1);
    await h.vt.advance(100);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.stats.playsHeld, 0);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['play']);
  });

  it('control: switched off, the presser keeps playing', async () => {
    const h = await pressPlay(2, { holdLocalPlay: false });
    await h.vt.advance(100);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.stats.playsHeld, 0);
  });
});

describe('DOM events are the second input to the same decision', () => {
  it('a seek is detected on the event, not one poll later', async () => {
    // PROTOCOL §4: "DOM events TRIGGER this evaluation, they never broadcast
    // directly. One decision path, two input sources." The second source was
    // wired up in the adapter and subscribed by nobody.
    const h = harness({ paused: false, positionS: 10 }, { evalIntervalMs: 1000 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(2000);
    const before = h.tr.sentOf('cmd').length;

    h.player.positionS = 400;
    h.player.emit('seeked');            // the element says so immediately
    await flush();
    assert.equal(h.tr.sentOf('cmd').length, before + 1,
      'the seek waited for the next poll');
    assert.equal(h.tr.sentOf('cmd').at(-1)!.kind, 'seek');
  });

  it('an off-cadence evaluation does not manufacture a seek', async () => {
    // The detector used to dead-reckon a full evalIntervalMs per call. Running
    // it more often than that -- which an event does, and a busy page does --
    // walked lastKnownPos ahead of the player and eventually invented a jump.
    const h = harness({ paused: false, positionS: 10 }, { evalIntervalMs: 100 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    const before = h.tr.sentOf('cmd').length;
    for (let i = 0; i < 60; i++) {
      h.player.emit('playing');         // 60 extra evaluations, no time passing
      await flush();
    }
    await h.vt.advance(3000);
    assert.equal(h.tr.sentOf('cmd').length, before, 'invented a seek out of extra evaluations');
  });
});

describe('the clock estimate follows a clock that steps', () => {
  /** Deterministic noise, so a failure reproduces. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }

  /** One exchange against a server `offset` ahead, with separate up/down delays. */
  function probe(c: ServerClock, clientNow: number, offset: number, up: number, down: number): void {
    const tRecv = clientNow + up + offset;
    c.addSample({ t0: clientNow, tRecv, tSend: tRecv + 1, t1: clientNow + up + 1 + down });
  }

  it('stays inside its own error bound on a stable, asymmetric path', () => {
    // The control: whatever lets the estimate move on a step must not let it
    // wander while nothing has changed. min-RTT's guarantee is |error| <= rtt/2.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rnd = lcg(seed);
      const c = new ServerClock();
      const offset = 1_700_000_000_000;
      let now = 1000;
      for (let i = 0; i < 400; i++) {
        probe(c, now, offset, 5 + rnd() * 80, 5 + rnd() * 20);
        const err = Math.abs(c.serverNow(now) - (now + offset));
        assert.ok(err <= c.uncertaintyMs + 0.5,
          `seed ${seed} probe ${i}: error ${err} ms outside the ${c.uncertaintyMs} ms bound`);
        now += 5000;
      }
      assert.ok(c.rttMs <= 30, `seed ${seed}: settled on a ${c.rttMs} ms sample`);
    }
  });

  it('re-converges within a probe after the local clock stops for 30 s', () => {
    // performance.now() does not run while a laptop is suspended; the server's
    // clock does. A 30 s sleep is well under the socket's read timeout, so
    // nothing reconnects -- and a minimum RTT never improves just because the
    // offset moved, so the stale estimate used to survive the whole session.
    for (const seed of [11, 12, 13, 14, 15]) {
      const rnd = lcg(seed);
      const c = new ServerClock();
      let offset = 1_700_000_000_000;
      let now = 1000;
      for (let i = 0; i < 20; i++) { probe(c, now, offset, 10 + rnd() * 10, 10 + rnd() * 10); now += 5000; }
      offset += 30_000;                        // suspended: server time ran on, ours did not
      probe(c, now, offset, 15 + rnd() * 30, 15 + rnd() * 30);
      const err = Math.abs(c.serverNow(now) - (now + offset));
      assert.ok(err <= c.uncertaintyMs + 0.5,
        `seed ${seed}: still ${err} ms off after the first probe past the step`);
      // And it keeps tightening from there, as min-RTT does.
      for (let i = 0; i < 20; i++) { now += 5000; probe(c, now, offset, 10 + rnd() * 10, 10 + rnd() * 10); }
      assert.ok(Math.abs(c.serverNow(now) - (now + offset)) <= c.uncertaintyMs + 0.5);
      assert.ok(c.rttMs <= 30, `seed ${seed}: never tightened past ${c.rttMs} ms`);
    }
  });
});
