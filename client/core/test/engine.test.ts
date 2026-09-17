import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../src/engine/engine.ts';
import type { EngineConfig, EngineEvents } from '../src/engine/engine.ts';
import { expectedAt, ServerClock } from '../src/engine/clock.ts';
import type { Anchor } from '../src/engine/clock.ts';
import { SwappableAdapter } from '../src/adapter/swappable.ts';
import { AutoplayBlockedError } from '../src/adapter/types.ts';
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

  it('re-times a pending transition when the clock estimate steps', async () => {
    // The timer was converted through the old offset. A sleep that moved the
    // server 1.5 s ahead of our estimate would otherwise fire this play 1.5 s
    // after everybody else's.
    const h = harness({ paused: true, positionS: 10 });
    await h.join();
    const when = h.vt.now + OFFSET + 2000;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other', kind: 'play',
    });
    await h.vt.advance(100);
    const t0 = h.vt.now;
    h.tr.deliver({ t: 'time.reply', t0, tRecv: t0 + OFFSET + 1500, tSend: t0 + OFFSET + 1500 });
    assert.equal(h.engine.clock.steps, 1);
    await h.vt.advance(300);
    assert.equal(h.player.paused, true, 'transitioned early');
    await h.vt.advance(200);
    assert.equal(h.player.paused, false, 'still waiting on the timer set through the old offset');
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

  /**
   * A playing member whose element reads `readyState` 1 with its buffer
   * intact for `unreadyMs`, placed over a heartbeat that is due: without that,
   * nothing would be sent inside the window whether or not it is held back.
   */
  async function unreadyOverHeartbeat(unreadyMs: number) {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(1000);
    h.tr.sent.length = 0;
    // Find the heartbeat cadence, then open the window just before the next one.
    while (h.tr.sentOf('hb').length === 0) await h.vt.advance(10);
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.hbIntervalMs - 50);
    const before = h.tr.sentOf('hb').length;
    h.player.readyState = 1;                      // mid-seek, buffer intact
    for (let t = 0; t < unreadyMs; t += 10) await h.vt.advance(10);
    const during = h.tr.sentOf('hb').slice(before);
    h.player.readyState = 4;                      // seeked
    await h.vt.advance(1500);
    return { h, during };
  }

  it('holds back an unready report while the buffer is full, briefly', async () => {
    // BROWSER-FINDINGS §14: an in-buffer seek on Laftel reads readyState 1
    // with 45 s ahead for ~100 ms. Sent, it gates the room for nothing.
    const { h, during } = await unreadyOverHeartbeat(200);
    assert.deepEqual(during, [], 'a heartbeat fell due mid-seek and was sent anyway');
    assert.ok(h.tr.sentOf('hb').every((f) => f.readyState === 4),
      'a mid-seek readyState reached the server');
    assert.ok(h.engine.stats.reportsDeferred >= 1);
  });

  it('control: the same window, held longer than the deferral, is reported', async () => {
    // Same placement, so the test above is not passing on a window that no
    // heartbeat could have fallen into.
    const { during } = await unreadyOverHeartbeat(600);
    assert.ok(during.some((f) => f.readyState === 1), 'the window covered no heartbeat');
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

  /**
   * A member playing with a room of two at 10 s loses its link, `offline`
   * does something to the player 200 ms later, and the session comes back
   * 800 ms after that into the room as `anchor` and `seq` say -- by default,
   * exactly the room it left. `beforeDrop` runs in the same instant as the
   * drop, so nothing evaluates in between.
   */
  async function changedWhileAway(
    offline: (p: FakePlayer, h: Harness) => void,
    o: { anchor?: Partial<Anchor>; seq?: number; beforeDrop?: (p: FakePlayer) => void } = {},
  ) {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    await h.vt.advance(2000);
    o.beforeDrop?.(h.player);
    h.tr.drop('link blip');
    await h.vt.advance(200);
    offline(h.player, h);
    await h.vt.advance(800);
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: o.seq ?? 0,
      anchor: {
        mediaKey: 'yt:abc',
        ...(o.anchor ?? { positionMs: 10_000, atServerMs: OFFSET, paused: false }),
      },
      members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    await h.vt.advance(600);
    return h;
  }

  it('sends a pause made while reconnecting, rather than undoing it', async () => {
    const h = await changedWhileAway((p) => { p.paused = true; });
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['pause'], 'the member\'s pause never reached the room');
    assert.ok(Math.abs(cmds[0]!.positionMs - 12_200) < 300, `paused at ${cmds[0]!.positionMs}`);
  });

  it('sends a seek made while reconnecting', async () => {
    const h = await changedWhileAway((p) => { p.positionS = 300; });
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['seek']);
    assert.ok(Math.abs(cmds[0]!.positionMs - 301_400) < 500, `seeked to ${cmds[0]!.positionMs}`);
  });

  it('sends a pause made while reconnecting once an apply from before the drop settles', async () => {
    // A correction seek parked when the link went is still running at the
    // welcome. The first evaluation then must not spend the offline snapshot:
    // it is the only record of the pause, and the reconciler undoes it.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    await h.vt.advance(2000);
    const parked = parkSeeks(h.player);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await h.vt.advance(100);
    assert.equal(parked.length, 1);
    h.tr.drop('link blip');
    await h.vt.advance(200);
    await h.player.pause();                       // the member pauses offline
    await h.vt.advance(800);
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { mediaKey: 'yt:abc', positionMs: 10_000, atServerMs: OFFSET, paused: false },
      members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    await h.vt.advance(600);
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'sent while our own seek was still landing');
    parked[0]!.release();
    await h.vt.advance(300);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause'], 'the offline pause never reached the room');
  });

  it('keeps an offline pause through a second drop while an old apply is still running', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    await h.vt.advance(2000);
    const parked = parkSeeks(h.player);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await h.vt.advance(100);
    assert.equal(parked.length, 1);
    const welcome = () => h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { mediaKey: 'yt:abc', positionMs: 10_000, atServerMs: OFFSET, paused: false },
      members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    h.tr.drop('link blip');
    await h.vt.advance(200);
    await h.player.pause();                       // the member pauses offline
    await h.vt.advance(800);
    h.tr.open();
    welcome();
    await h.vt.advance(600);                      // settled, the snapshot still waits on the seek
    h.tr.drop('link blip again');
    await h.vt.advance(1000);
    h.tr.open();
    welcome();
    await h.vt.advance(600);
    parked[0]!.release();
    await h.vt.advance(300);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause'], 'the offline pause never reached the room');
  });

  describe('a second drop before the reconnected clock settles', () => {
    // A reconnect is joined at its welcome and reads the offline snapshot only
    // once its clock settles. A drop in between used to take a new snapshot
    // from a player that already showed the change, with nothing lost to
    // resend: the first snapshot's change was never sent (review 5 P6).
    async function flap(second: boolean, o: { lostPause: boolean }) {
      const vt = new VirtualTime();
      const player = new FakePlayer(vt, { paused: false, positionS: 10 });
      const tr = new FakeTransport();
      let input = -Infinity;
      const engine = new SyncEngine({
        adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer,
        isHidden: () => false,
        gestures: { lastInputAt: () => input, lastIgnoredInputAt: () => -Infinity, activationActive: () => null },
      }, CFG);
      const members = [
        { id: 'me-1', name: 'm0', suspended: false, ready: true },
        { id: 'other-1', name: 'm1', suspended: false, ready: true },
      ];
      const anchor: Anchor = { positionMs: 10_000, atServerMs: OFFSET, paused: false, mediaKey: 'yt:abc' };
      const welcome = () => tr.deliver({ t: 'welcome', you: 'me-1', seq: 0, anchor, members, serverMs: vt.now + OFFSET, mediaKey: 'yt:abc' });
      tr.autoAnswerTime(OFFSET);
      engine.start(); tr.open(); welcome();
      await vt.advance(2000);
      assert.equal(engine.acquisition, 'steady');
      const pause = async () => { input = vt.now; await player.pause(); player.emit('pause'); };
      if (o.lostPause) {
        await pause();                            // sent, and lost with the link
        await vt.advance(100);
        tr.drop('dead');
        await vt.advance(1000);
      } else {
        tr.drop('dead');
        await vt.advance(300);
        await pause();                            // made offline
        await vt.advance(700);
      }
      if (second) {
        tr.autoAnswerTime(null);
        tr.open(); welcome();
        await vt.advance(30);                     // welcome in, probes not yet answered
        tr.drop('dead again');
        await vt.advance(2000);
        tr.autoAnswerTime(OFFSET);
      }
      tr.open(); welcome();
      await vt.advance(600);
      return tr.sentOf('cmd').map((c) => c.kind);
    }

    it('adds a command lost at the second drop to the snapshot it keeps', async () => {
      // The first snapshot waits on an old seek. Meanwhile a media key -- no
      // input -- pauses the member, the pause is sent, and the link drops
      // with it. Nothing but the lost command makes that pause the member's.
      const vt = new VirtualTime();
      const player = new FakePlayer(vt, { paused: false, positionS: 10 });
      const tr = new FakeTransport();
      const engine = new SyncEngine({
        adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer,
        isHidden: () => false,
        gestures: { lastInputAt: () => -Infinity, lastIgnoredInputAt: () => -Infinity, activationActive: () => null },
      }, CFG);
      const members = [
        { id: 'me-1', name: 'm0', suspended: false, ready: true },
        { id: 'other-1', name: 'm1', suspended: false, ready: true },
      ];
      const anchor: Anchor = { positionMs: 10_000, atServerMs: OFFSET, paused: false, mediaKey: 'yt:abc' };
      const welcome = () => tr.deliver({ t: 'welcome', you: 'me-1', seq: 0, anchor, members, serverMs: vt.now + OFFSET, mediaKey: 'yt:abc' });
      tr.autoAnswerTime(OFFSET);
      engine.start(); tr.open(); welcome();
      await vt.advance(2000);
      assert.equal(engine.acquisition, 'steady');
      const parked = parkSeeks(player);
      tr.deliver({ t: 'correct', mode: 'seek', when: vt.now + OFFSET });
      await vt.advance(100);
      assert.equal(parked.length, 1);
      tr.drop('dead');
      await vt.advance(1000);
      tr.open(); welcome();
      await vt.advance(600);                      // settled, the snapshot still waits on the seek
      await player.pause();                       // a media key
      player.emit('pause');
      await vt.advance(100);
      assert.deepEqual(tr.sentOf('cmd').map((c) => c.kind), ['pause']);
      tr.drop('dead again');
      await vt.advance(1000);
      tr.open(); welcome();
      await vt.advance(600);
      parked[0]!.release();
      await vt.advance(300);
      assert.deepEqual(tr.sentOf('cmd').map((c) => c.kind), ['pause', 'pause'], 'the lost pause was not resent');
    });

    for (const second of [false, true]) {
      const tag = second ? '' : ' (control: one drop)';
      it(`still resends a pause lost with the link${tag}`, async () => {
        assert.deepEqual(await flap(second, { lostPause: true }), ['pause', 'pause']);
      });
      it(`still sends a pause made offline${tag}`, async () => {
        assert.deepEqual(await flap(second, { lostPause: false }), ['pause']);
      });
    }
  });

  it('control: a player that just kept playing sends nothing', async () => {
    const h = await changedWhileAway(() => {});
    assert.deepEqual(h.tr.sentOf('cmd'), []);
  });

  it('control: a player that stalled while away is not read as a seek', async () => {
    const h = await changedWhileAway((p) => p.stall());
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'a stall offline dragged the room back');
  });

  it('does not send a jump offline that lands where the room is', async () => {
    // Behind the room when the link went, then moved onto it: that is
    // catching up, and the room has nowhere to be sent.
    const h = await changedWhileAway((p, hh) => {
      p.readState();
      p.positionS = (hh.vt.now + 10_000) / 1000;
    }, { beforeDrop: (p) => { p.readState(); p.positionS = 5; } });
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'a member catching up to the room sent the room a seek');
    assert.ok(Math.abs(h.player.positionS * 1000 - (h.vt.now + 10_000)) < 300, `at ${h.player.positionS}`);
  });

  it('control: the same member jumping elsewhere sends the seek', async () => {
    const h = await changedWhileAway((p) => { p.readState(); p.positionS = 300; },
      { beforeDrop: (p) => { p.readState(); p.positionS = 5; } });
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['seek']);
  });

  it('follows a room another member moved while away, over its own pause', async () => {
    // Somebody seeked the playing room to 50 s while this member was
    // offline pausing: the room's move is newer, and the pause is dropped.
    const moved = { positionMs: 50_000, atServerMs: OFFSET + 2700, paused: false };
    const h = await changedWhileAway((p) => { p.paused = true; }, { anchor: moved, seq: 1 });
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'an older offline pause overrode the room');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 1000);
    assert.deepEqual(h.tr.sentOf('cmd'), []);
    assert.equal(h.player.paused, false, 'the member was left paused against the room');
    const room = 50_000 + (h.vt.now + OFFSET - moved.atServerMs);
    assert.ok(Math.abs(h.player.positionS * 1000 - room) < 500, `at ${h.player.positionS}, room at ${room}`);
  });

  it('follows a room another member moved while away, over its own seek', async () => {
    const moved = { positionMs: 50_000, atServerMs: OFFSET + 2700, paused: true };
    const h = await changedWhileAway((p) => { p.positionS = 300; }, { anchor: moved, seq: 1 });
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'an older offline seek overrode the room');
  });

  it('control: a room that moved while away is followed, not overridden', async () => {
    const h = await changedWhileAway(() => {},
      { anchor: { positionMs: 50_000, atServerMs: OFFSET + 3000, paused: true }, seq: 1 });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 1000);
    assert.deepEqual(h.tr.sentOf('cmd'), []);
    assert.equal(h.player.paused, true);
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
    //
    // With a clock and a server that make those fields fractional: the
    // shared harness has an integer clock and a zero-RTT server, so t0,
    // atServerMs, uncertaintyMs and rttMs came out whole whether or not the
    // engine rounded them, and this test could not fail for them (review 4 N31).
    const FRACTION = 0.4567;
    const vt = new VirtualTime();
    const player = new FakePlayer(vt, { paused: false, positionS: 10.4567 });
    /** A server 7 ms away, whose own timestamps are whole milliseconds. */
    class DistantServer extends FakeTransport {
      override send(f: Parameters<FakeTransport['send']>[0]): void {
        super.send(f);
        if (f.t !== 'time') return;
        const t0 = f.t0;
        vt.setTimer(() => {
          const tRecv = Math.round(t0 + OFFSET + 3);
          this.deliver({ t: 'time.reply', t0, tRecv, tSend: tRecv + 1 });
        }, 7);
      }
    }
    const tr = new DistantServer();
    const engine = new SyncEngine({
      adapter: player, transport: tr, now: () => vt.now + FRACTION,
      setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false,
    }, CFG);
    engine.start();
    tr.open();
    tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 10_456, atServerMs: OFFSET, paused: false, mediaKey: 'yt:abc' },
      members: [], serverMs: OFFSET, mediaKey: 'yt:abc',
    });
    await vt.advance(3000);
    assert.equal(engine.stats.timeSamples > 0, true, 'the clock never settled');
    player.positionS += 7; // provoke a seek command and an anomaly report
    await vt.advance(2000);

    const seen = new Set<string>();
    let checked = 0;
    for (const f of tr.sent) {
      const fields = INT_FIELDS[f.t];
      if (!fields) continue;
      for (const k of fields) {
        const v = (f as unknown as Record<string, unknown>)[k];
        assert.equal(typeof v, 'number', `${f.t}.${k} is ${typeof v}`);
        assert.ok(Number.isInteger(v), `${f.t}.${k} = ${v} is not an integer`);
        seen.add(`${f.t}.${k}`);
        checked++;
      }
    }
    assert.ok(checked > 10, `only ${checked} integer fields were exercised`);
    for (const [t, ks] of Object.entries(INT_FIELDS)) {
      for (const k of ks) assert.ok(seen.has(`${t}.${k}`), `${t}.${k} was never sent`);
    }
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

describe('a page that names no media', () => {
  // The key comes from the URL, so an empty one is a search page, a channel
  // page, a site's front page -- whose only <video> is often a hover preview
  // or a trailer that has nothing to do with the room.

  it('leaves the page\'s video alone and never steers the room from it', async () => {
    const h = harness({ paused: false, positionS: 3 }, { mediaKey: '' });
    await h.join({ positionMs: 500_000, atServerMs: OFFSET, paused: false }, 0, 2);
    assert.equal(h.engine.followingRoom, false);
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 900_000, atServerMs: when, paused: true, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'pause',
    });
    await h.vt.advance(500);
    assert.equal(h.player.seeks, 0, `seeked the preview to ${h.player.positionS}s`);
    assert.equal(h.player.paused, false, 'paused the preview for the room');
    assert.equal(h.engine.stats.skippedOffMedia, 1);

    // The preview loops back to its start: a jump in both diffs, and not the
    // room's business.
    h.player.positionS = 0;
    h.player.emit('seeked');
    await h.vt.advance(5000);
    assert.deepEqual(h.tr.sentOf('cmd'), []);
    assert.equal(h.player.paused, false, 'the reconciler paused the preview');
    assert.equal(h.tr.sentOf('hb').at(-1)!.suspended, true, 'judged against a timeline it is not on');
  });

  it('is not the media of a room that names none either, and seeds nothing', async () => {
    // A room created from such a page has an empty key too. Matching them
    // made the creator adopt the preview into the room.
    const h = harness({ paused: false, positionS: 42 }, { mediaKey: '', adoptLocalStateOnJoin: true });
    await h.join({ mediaKey: '' }, 0, 1);
    await h.vt.advance(5000);
    assert.equal(h.engine.followingRoom, false);
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'seeded the room from a page with no media');
    assert.equal(h.player.seeks + h.player.pauses, 0);
  });

  it('control: once the member navigates onto the room\'s media it follows', async () => {
    const h = harness({ paused: false, positionS: 3 }, { mediaKey: '' });
    await h.join({ positionMs: 500_000, atServerMs: OFFSET, paused: false }, 0, 2);
    h.engine.setLocalMediaKey('yt:abc');
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await h.vt.advance(100);
    assert.equal(h.engine.followingRoom, true);
    const expected = h.engine.expectedMs()! / 1000;
    assert.ok(Math.abs(h.player.positionS - expected) < 0.5, `at ${h.player.positionS}s, room at ${expected}s`);
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

  it('a click to sync queued behind a slow seek does nothing once the link drops', async () => {
    // Queued while the session was fine, run after it ended: aimed through a
    // reset clock, it seeks to about -1.8e12 ms, which an element clamps to 0.
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

    const parked = parkSeeks(h.player);
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
    await flush();
    assert.equal(parked.length, 1);
    h.player.autoplayBlocked = false;
    void h.engine.resumeAfterGesture();          // the user clicks; queued behind the seek
    h.tr.drop('link blip');
    parked[0]!.release();
    await flush(); await flush();
    assert.deepEqual(parked.slice(1).map((p) => p.pos), [], 'the click aimed with no clock');
    assert.equal(h.player.paused, true);
    assert.equal(h.engine.blocked, true, 'the click was spent on a session that had ended');
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
    // A real element is below HAVE_FUTURE_DATA for as long as its seek is in
    // flight, so the user's pause is seen on an unready sample.
    h.player.readyState = 1;
    await h.vt.advance(500);
    assert.equal(parked.length, 1);

    await h.player.pause();                     // the user pauses
    h.player.emit('pause');
    await h.vt.advance(1500);
    h.player.positionS = 500;                   // ...and scrubs
    h.player.emit('seeked');
    await h.vt.advance(100);
    parked[0]!.release(false);                  // the engine's seek never took
    h.player.readyState = 4;
    await h.vt.advance(100);

    const sent = h.tr.sentOf('cmd').slice(before);
    assert.deepEqual(sent.map((c) => c.kind), ['pause', 'seek'], `sent ${JSON.stringify(sent)}`);
    assert.ok(Math.abs(sent[1]!.positionMs - 500_000) < 1000);
  });

  /** A playing room of two at 50 s, and another member's seek to 400 s. */
  async function roomSeek(h: Harness): Promise<void> {
    await h.join({ positionMs: 50_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 400_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'seek',
    });
    await h.vt.advance(100);
  }

  it('a pause made unready while a room seek is landing is sent (no gesture evidence)', async () => {
    // Without gesture evidence only the play() after our seek excuses an
    // unready pause; the seek itself does not.
    const h = harness({ paused: false, positionS: 50 });
    const parked = parkSeeks(h.player);
    await roomSeek(h);
    assert.equal(parked.length, 1);
    h.player.readyState = 1;
    await h.vt.advance(200);
    await h.player.pause();                     // the user pauses
    h.player.emit('pause');
    await h.vt.advance(100);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause']);
  });

  it('a pause made on a ready element under our post-seek play() is sent (no gesture evidence)', async () => {
    // The excuse is for a site reacting to an element our seek left unready.
    const h = harness({ paused: false, positionS: 50 });
    const p = h.player;
    p.play = () => { p.paused = false; p.plays++; return new Promise<void>(() => {}); };
    await roomSeek(h);
    assert.ok(Math.abs(p.positionS - 400) < 1, `at ${p.positionS}`);
    await p.pause();                            // the user pauses
    p.emit('pause');
    await h.vt.advance(100);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause']);
  });

  for (const readyState of [4, 2]) {
    it(`a pause made while a room play waits on the element is sent (readyState ${readyState})`, async () => {
      // No seek of ours: the member is already where the room plays from, so
      // the transition only presses play -- and on an element below
      // HAVE_FUTURE_DATA that play() stays pending. The member's pause in that
      // window is unready and inside the apply, and is still the member's.
      const h = harness({ paused: true, positionS: 100 });
      await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: true }, 0, 2);
      await h.vt.advance(1000);
      const p = h.player;
      p.readyState = readyState;
      let reject: ((e: unknown) => void) | null = null;
      p.play = () => {
        p.paused = false; p.plays++;
        if (readyState >= 3) return Promise.resolve();
        return new Promise<void>((_, rj) => { reject = rj; });
      };
      const pause = p.pause.bind(p);
      p.pause = async () => {
        await pause();
        reject?.(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
        reject = null;
      };
      const when = h.vt.now + OFFSET;
      h.tr.deliver({
        t: 'state', seq: 1, when, emittedAt: when,
        anchor: { positionMs: 100_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
        by: 'other-1', kind: 'play',
      });
      await h.vt.advance(300);
      assert.equal(p.paused, false);
      assert.equal(p.seeks, 0);
      await p.pause();                            // the member pauses
      p.emit('pause');
      await h.vt.advance(100);
      assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause']);
    });
  }

  it('a seek of the engine\'s that the element clamps to its end is not sent', async () => {
    // A room past this member's end: the element lands on its duration, far
    // from the target, and until the seek resolves that position looks like
    // somebody scrubbed there. Sent, the engine's own transition moves the
    // whole room to this member's end of media.
    const h = harness({ paused: false, positionS: 1390, durationS: 1400 });
    const read = h.player.readState.bind(h.player);
    h.player.readState = () => {                  // a real element stops at its end
      const s = read();
      h.player.positionS = Math.min(s.positionS, h.player.durationS);
      return { ...s, positionS: h.player.positionS };
    };
    await h.join({ positionMs: 1_390_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    const clamp = h.player.seekTo;
    h.player.seekTo = (pos: number) => {          // the element clamps at once, `seeked` comes later
      h.player.positionS = Math.min(pos, h.player.durationS);
      return clamp(pos);
    };
    const when = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when, emittedAt: when,
      anchor: { positionMs: 1_500_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'seek',
    });
    await h.vt.advance(100);
    assert.equal(parked.length, 1);
    h.player.emit('seeking');
    await h.vt.advance(2000);
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'sent the engine\'s own clamped seek to the room');
    parked[0]!.release(false);
    await h.vt.advance(100);
    assert.deepEqual(h.tr.sentOf('cmd'), []);
  });

  it('a seek of the engine\'s that is still landing after it was superseded is not sent', async () => {
    // The room has moved on to seq 2 while seq 1's seek was parked. When that
    // seek lands it is far from the NEW anchor as well as from where the
    // player was -- a jump in both diffs -- and it is still the engine's.
    const h = harness({ paused: false, positionS: 50 });
    await h.join({ positionMs: 50_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const parked = parkSeeks(h.player);
    const when1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when: when1, emittedAt: when1,
      anchor: { positionMs: 500_000, atServerMs: when1, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'seek',
    });
    await h.vt.advance(100);
    assert.equal(parked.length, 1);
    const when2 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 2, when: when2, emittedAt: when2,
      anchor: { positionMs: 100_000, atServerMs: when2, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'seek',
    });
    await h.vt.advance(100);
    parked[0]!.release();
    h.player.emit('seeked');                      // seq 1's seek lands, before its rebaseline
    await flush();
    await h.vt.advance(100);
    assert.equal(parked.length, 2, 'seq 2 did not queue its own seek');
    parked[1]!.release();
    await h.vt.advance(2000);
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'sent the superseded seek\'s landing to the room');
    const expected = h.engine.expectedMs()! / 1000;
    assert.ok(Math.abs(h.player.positionS - expected) < 0.5, `at ${h.player.positionS}s, room at ${expected}s`);
  });

  it('a play of the engine\'s that starts after a pause superseded it is not sent', async () => {
    // play() resolves when playback actually starts, which can take a while.
    // A pause that arrives meanwhile is bookkept at once, so when the element
    // finally starts, it disagrees with the anchor -- and it is still the
    // engine's play, not the user's.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    const starting: Array<() => void> = [];
    const play = h.player.play.bind(h.player);
    h.player.play = () => new Promise<void>((res) => { starting.push(() => { void play().then(res); }); });

    const when1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when: when1, emittedAt: when1,
      anchor: { positionMs: 10_000, atServerMs: when1, paused: false, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'play',
    });
    await h.vt.advance(100);
    assert.equal(starting.length, 1, 'the play is not in flight');
    const when2 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 2, when: when2, emittedAt: when2,
      anchor: { positionMs: 10_000, atServerMs: when2, paused: true, mediaKey: 'yt:abc' },
      by: 'other-1', kind: 'pause',
    });
    await h.vt.advance(100);
    assert.equal(h.engine.currentAnchor.paused, true);

    h.player.paused = false;                      // the element starts, the promise has not settled
    h.player.emit('play');
    await h.vt.advance(200);
    h.player.emit('playing');
    await h.vt.advance(200);
    assert.deepEqual(h.tr.sentOf('cmd'), [], 'sent the engine\'s own play to the room');
    starting[0]!();
    await h.vt.advance(500);
    assert.equal(h.player.paused, true, 'the pause that superseded it did not land');
    assert.deepEqual(h.tr.sentOf('cmd'), []);
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

  it('hands the playback rate back when the connection drops', async () => {
    // BROWSER-FINDINGS §24: an 8 s outage at a held nudge put the member
    // 660 ms away from the room by the time it was back.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.06, when: h.vt.now + OFFSET });
    await h.vt.advance(300);
    assert.equal(h.player.rate, 1.06);
    h.tr.drop();
    assert.equal(h.player.rate, 1, 'ran on at the nudge with nobody to answer to');
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

  it('re-applies even while the room keeps seek-correcting the paused player', async () => {
    // BROWSER-FINDINGS §24: a paused member in a playing room falls behind,
    // so the server sends it a free seek about every 2 s. Each seek is an
    // apply, and an apply used to restart the reconciler's wait -- 2 s is less
    // than reconcileAfterMs, so the member stayed paused, seek-corrected
    // forever. A seek that takes time (~100 ms on Laftel) is what exposes it.
    const h = harness({ paused: false, positionS: 10 });
    const seekTo = h.player.seekTo.bind(h.player);
    h.player.seekTo = (s: number) => new Promise<void>((r) => {
      h.vt.setTimer(() => { void seekTo(s).then(r); }, 150);
    });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(500);

    h.player.paused = true;
    for (let i = 0; i < 5 && h.player.paused; i++) {
      h.tr.deliver({ t: 'correct', mode: 'seek', when: h.vt.now + OFFSET });
      await h.vt.advance(2000);
    }
    assert.equal(h.player.paused, false, 'the seek corrections starved the reconciler');
    assert.ok(h.engine.stats.reconciles >= 1);
    assert.ok(h.engine.stats.correctionsSeek >= 1, 'the corrections were not applied at all');
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

  describe('alone, while the readiness gate would hold the play', () => {
    // The server holds a `play` while anybody is gated, the presser included,
    // whatever the room's size. Left playing, a lone presser ran ahead of an
    // anchor still paused at the old position, and the ack that the release
    // sent seeked them back by however long that took -- or the reconciler
    // paused them first, if it took over `reconcileAfterMs` (review N25).

    /** A room of one paused at 10 s, `before` done to it, then play pressed 800 ms before the gate lets it through. */
    async function soloPress(before: (h: Harness) => Promise<void> | void) {
      const h = harness({ paused: true, positionS: 10 });
      await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 1);
      await h.vt.advance(500);
      await before(h);
      h.tr.sent.length = 0;
      await h.player.play();
      h.player.emit('play');
      // The detector sees a play once the element can play: a stalled one's
      // play-state is not read.
      h.player.recover();
      await h.vt.advance(100);
      const cmds = h.tr.sentOf('cmd');
      assert.deepEqual(cmds.map((c) => c.kind), ['play']);
      const heldAtPress = h.player.paused;
      await h.vt.advance(700);
      h.tr.deliver({ t: 'gate', waiting: false, waitingOn: [] });
      // The release: `CmdDelay` is 0 alone, so the play is due at once, from
      // where the room was paused.
      const seeks = h.player.seeks;
      const when = h.vt.now + OFFSET;
      h.tr.deliver({
        t: 'ack', reqId: cmds[0]!.reqId, seq: 1, when, emittedAt: when, kind: 'play',
        anchor: { positionMs: 10_000, atServerMs: when, paused: false, mediaKey: 'yt:abc' },
      });
      await h.vt.advance(200);
      return { h, heldAtPress, seeksAtAck: h.player.seeks - seeks };
    }

    it('holds a play the gate frame says will wait', async () => {
      // A `media` command gates every member, ready or not.
      const m = await soloPress((h) => { h.tr.deliver({ t: 'gate', waiting: false, waitingOn: ['me-1'] }); });
      assert.equal(m.heldAtPress, true, 'played on ahead of a room the gate holds');
      assert.equal(m.h.player.paused, false, 'never started');
      assert.equal(m.seeksAtAck, 0, 'the release seeked the presser back');
      assert.ok(Math.abs(m.h.player.positionS - 10.2) < 0.05, `at ${m.h.player.positionS}`);
      await m.h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 1000);
      assert.equal(m.h.engine.stats.reconciles, 0);
      assert.deepEqual(m.h.tr.sentOf('cmd').map((c) => c.kind), ['play']);
    });

    it('holds a play while its own last report said unready', async () => {
      // Seeked out of the buffer while paused: the report that gates the room
      // is out, the gate frame not back yet.
      const m = await soloPress(async (h) => {
        h.player.stall();
        await h.vt.advance(DEFAULT_ENGINE_CONFIG.hbIntervalMs + 100);
        assert.ok(h.tr.sentOf('hb').at(-1)!.readyState < 3);
      });
      assert.equal(m.heldAtPress, true, 'played on ahead of a room the gate holds');
      assert.equal(m.h.player.paused, false, 'never started');
      assert.equal(m.seeksAtAck, 0);
    });

    it('control: a gate that has opened again holds nothing', async () => {
      const m = await soloPress(async (h) => {
        h.tr.deliver({ t: 'gate', waiting: false, waitingOn: ['me-1'] });
        await h.vt.advance(100);
        h.tr.deliver({ t: 'gate', waiting: false, waitingOn: [] });
      });
      assert.equal(m.heldAtPress, false);
      assert.equal(m.h.engine.stats.playsHeld, 0);
    });
  });

  it('control: switched off, the presser keeps playing', async () => {
    const h = await pressPlay(2, { holdLocalPlay: false });
    await h.vt.advance(100);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.stats.playsHeld, 0);
  });

  /** Log every position the engine seeks the player to. */
  function logSeeks(p: FakePlayer): number[] {
    const log: number[] = [];
    const original = p.seekTo.bind(p);
    p.seekTo = (pos: number) => { log.push(pos); return original(pos); };
    return log;
  }

  it('a play pressed before our own seek is acked is held where we seeked to', async () => {
    // A seek on a paused room has no lead, but its ack still takes a round
    // trip. A play pressed inside it used to be held at the anchor the seek
    // was about to replace: the picture jumped back to where the room had
    // been, then forward again when the ack landed -- two seeks nobody asked
    // for, either of which can be out of buffer.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    const seeks = logSeeks(h.player);
    h.tr.sent.length = 0;

    h.player.positionS = 60;                     // the user scrubs...
    h.player.emit('seeked');
    await h.vt.advance(100);
    await h.player.play();                       // ...and presses play before the ack
    h.player.emit('play');
    // Long enough to play past `seekToleranceMs` but not past the hold's own
    // tolerance: the ack below is a hold, and is aimed as tightly as one.
    await h.vt.advance(150);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['seek', 'play']);
    assert.ok(seeks.every((s) => s >= 59), `pulled back to ${seeks.join(', ')}`);

    // The seek's ack lands: the room is paused at 60. That is where we hold.
    const t1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: cmds[0]!.reqId, seq: 1, when: t1, emittedAt: t1,
      anchor: { positionMs: 60_000, atServerMs: t1, paused: true, mediaKey: 'yt:abc' },
      kind: 'seek',
    });
    await h.vt.advance(50);
    assert.equal(h.player.paused, true, 'not held for the room');
    assert.ok(Math.abs(h.player.positionS - 60) <= 0.08, `held at ${h.player.positionS}`);

    // And the play starts everybody from there.
    const t2 = h.vt.now + OFFSET + 400;
    h.tr.deliver({
      t: 'ack', reqId: cmds[1]!.reqId, seq: 2, when: t2, emittedAt: t2 - 500,
      anchor: { positionMs: 60_000, atServerMs: t2, paused: false, mediaKey: 'yt:abc' },
      kind: 'play',
    });
    await h.vt.advance(1000);
    assert.equal(h.player.paused, false);
    assert.ok(seeks.every((s) => s >= 59), `pulled back to ${seeks.join(', ')}`);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['seek', 'play']);
  });

  it('a seek of ours lost with the connection does not stop the next play being held', async () => {
    // Nothing the old socket carried will come back. Still counted as on its
    // way, it made the hold stand aside for an ack that could not arrive, and
    // the presser played on ahead of the room.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    h.player.positionS = 60;                     // the user scrubs...
    h.player.emit('seeked');
    await h.vt.advance(100);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['seek']);

    h.tr.drop('link blip');                      // ...and the seek goes down with the link
    await h.vt.advance(600);
    h.tr.open();
    // Into a room somebody else moved meanwhile (back to 10 s), so the lost
    // seek is not sent again: the one the hold must not wait for is gone.
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 1,
      anchor: { positionMs: 10_000, atServerMs: OFFSET, paused: true, mediaKey: 'yt:abc' },
      members: [
        { id: 'me-1', name: 'm0', suspended: false, ready: true },
        { id: 'other-1', name: 'm1', suspended: false, ready: true },
      ],
      serverMs: h.vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    await h.vt.advance(400);

    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(100);
    assert.equal(h.player.paused, true, 'not held for the room');
    assert.ok(Math.abs(h.player.positionS - 10) < 0.001, `held at ${h.player.positionS}`);
  });

  it('control: a play with no seek outstanding is still held at the anchor', async () => {
    const h = await pressPlay(2, {}, 10.3);
    await h.vt.advance(100);
    assert.equal(h.player.paused, true);
    assert.ok(Math.abs(h.player.positionS - 10) < 0.001);
  });
});

describe('the creator adopting a room', () => {
  async function adopt(members: number) {
    const h = harness({ paused: false, positionS: 100 }, { adoptLocalStateOnJoin: true });
    await h.join({}, 0, members);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['seek', 'play']);
    const pauses = h.player.pauses;
    // A fresh room is paused@0 and a seek keeps it paused: the seek's ack says
    // paused, the play's ack a moment later says playing.
    const t1 = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: cmds[0]!.reqId, seq: 1, when: t1, emittedAt: t1,
      anchor: { positionMs: cmds[0]!.positionMs, atServerMs: t1, paused: true, mediaKey: 'yt:abc' },
      kind: 'seek',
    });
    await h.vt.advance(5);
    const t2 = h.vt.now + OFFSET + (members < 2 ? 0 : 500);
    h.tr.deliver({
      t: 'ack', reqId: cmds[1]!.reqId, seq: 2, when: t2, emittedAt: h.vt.now + OFFSET,
      anchor: { positionMs: cmds[0]!.positionMs, atServerMs: t2, paused: false, mediaKey: 'yt:abc' },
      kind: 'play',
    });
    const pausedBetween = h.player.paused;
    await h.vt.advance(1000);
    return { h, pauses: h.player.pauses - pauses, pausedBetween };
  }

  it('does not pause a creator who is already playing, alone in the room', async () => {
    // The seek's paused ack is only the first half of the adoption; applying
    // it on its own paused the creator and then spent a play() -- one that can
    // be refused -- to undo it.
    const { h, pauses, pausedBetween } = await adopt(1);
    assert.equal(pauses, 0, 'paused the creator between the two halves of the adoption');
    assert.equal(pausedBetween, false);
    assert.equal(h.player.paused, false);
    assert.equal(h.engine.appliedSeq, 2);
  });

  it('a play of ours the server dropped does not shape a later ack', async () => {
    // Acks come back in order, so a command older than the one acked that is
    // still unanswered was dropped. Kept, a dropped play made the paused ack of
    // a later seek look like the first half of an adoption, and alone in the
    // room that ack was skipped: the member kept playing in a paused room.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 1);
    await h.vt.advance(500);
    await h.player.play();                       // the user presses play; it is dropped
    h.player.emit('play');
    await h.vt.advance(100);
    h.player.positionS = 60;                     // then scrubs
    h.player.emit('seeked');
    await h.vt.advance(100);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['play', 'seek']);

    const t = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: cmds[1]!.reqId, seq: 1, when: t, emittedAt: t,
      anchor: { positionMs: 60_000, atServerMs: t, paused: true, mediaKey: 'yt:abc' },
      kind: 'seek',
    });
    await h.vt.advance(100);
    assert.equal(h.player.paused, true, 'kept playing in a paused room');
    assert.equal(h.engine.stats.reconciles, 0);
  });

  it('control: with somebody else in the room it waits for the play like any other press', async () => {
    const { h, pausedBetween } = await adopt(2);
    assert.equal(pausedBetween, true, 'did not wait for `when` with the others');
    assert.equal(h.player.paused, false);
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
      assert.equal(c.steps, 0, `seed ${seed}: took a step on a clock that never moved`);
    }
  });

  /**
   * One exchange as the wire really carries it: `t0` rounded by the engine,
   * the server's stamps truncated to whole ms (Go's `UnixMilli`), `t1` left
   * fractional, and a server clock that is not on a millisecond boundary of
   * ours.
   */
  function wireProbe(c: ServerClock, clientNow: number, offset: number, up: number, hold: number, down: number): void {
    const recv = clientNow + up + offset;
    c.addSample({
      t0: Math.round(clientNow), tRecv: Math.floor(recv), tSend: Math.floor(recv + hold),
      t1: clientNow + up + hold + down,
    });
  }

  it('does not mistake whole-millisecond wire stamps for a step, on a loopback path', () => {
    // A server on this machine -- which the extension exists to reach -- has
    // RTTs under 2 ms, where the stamps' own rounding is as large as the path.
    // Each sample can then sit up to 1.5 ms outside its rtt/2, so two of them
    // up to 3 ms apart with nothing having changed.
    let falseSteps = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = lcg(seed);
      const c = new ServerClock();
      const offset = 1_700_000_000_000 + rnd();
      let now = 1000 + rnd();
      for (let i = 0; i < 300; i++) {
        wireProbe(c, now, offset, rnd() * 1.5, rnd() * 0.5, rnd() * 0.3);
        now += 5000 + rnd();
      }
      falseSteps += c.steps;
    }
    assert.equal(falseSteps, 0, `${falseSteps} steps on a clock that never moved`);
  });

  it('control: a 20 ms step on that same loopback path is still taken', () => {
    for (const seed of [21, 22, 23, 24, 25]) {
      const rnd = lcg(seed);
      const c = new ServerClock();
      let offset = 1_700_000_000_000 + rnd();
      let now = 1000 + rnd();
      for (let i = 0; i < 20; i++) { wireProbe(c, now, offset, rnd() * 1.5, rnd() * 0.5, rnd() * 0.3); now += 5000; }
      offset += 20;
      // Long enough that rounding cannot make the RTT negative, which
      // discards a sample outright; the step would then be taken one probe on.
      wireProbe(c, now, offset, 1.5 + rnd(), rnd() * 0.5, rnd() * 0.3);
      assert.equal(c.steps, 1, `seed ${seed}`);
      assert.ok(Math.abs(c.serverNow(now) - (now + offset)) <= c.uncertaintyMs + 1.5,
        `seed ${seed}: ${c.serverNow(now) - (now + offset)} ms off after the step`);
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

/**
 * A `<video>` below HAVE_FUTURE_DATA: `play()` flips `paused` at once and its
 * promise waits for data -- here, for ever -- unless `pause()` rejects it with
 * an AbortError, as the HTML spec says.
 */
class StarvedPlayer extends FakePlayer {
  private pendingPlays: Array<(e: Error) => void> = [];
  constructor(vt: VirtualTime, o: FakePlayerOptions) { super(vt, o); this.readyState = 2; this.bufferedAheadS = 0; }
  override play(): Promise<void> {
    this.readState();
    this.plays++;
    this.paused = false;
    return new Promise<void>((_, reject) => { this.pendingPlays.push(reject); });
  }
  override async pause(): Promise<void> {
    await super.pause();
    const rejects = this.pendingPlays;
    this.pendingPlays = [];
    for (const r of rejects) r(Object.assign(new Error('The play() request was interrupted by a call to pause()'), { name: 'AbortError' }));
  }
}

describe('a play() that waits for data does not hold up the room', () => {
  // `applyTransition` awaited play() inside the apply chain. An element stuck
  // below HAVE_FUTURE_DATA never settles it, and everything the room did after
  // -- the seek that would have moved it off the stuck spot, the pause --
  // queued behind it for good, while `lastAppliedSeq` said it was applied.

  async function starvedMember() {
    const vt = new VirtualTime();
    const player = new StarvedPlayer(vt, { paused: true, positionS: 600 });
    const tr = new FakeTransport();
    const errors: string[] = [];
    const engine = new SyncEngine(
      { adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false },
      CFG, { onError: (c) => { errors.push(c); } },
    );
    tr.autoAnswerTime(OFFSET);
    engine.start();
    tr.open();
    tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 600_000, atServerMs: OFFSET, paused: true, mediaKey: 'yt:abc' },
      members: [], serverMs: vt.now, mediaKey: 'yt:abc',
    });
    await vt.advance(400);
    let seq = 0;
    const state = async (kind: string, positionMs: number, paused: boolean) => {
      const t = vt.now + OFFSET;
      tr.deliver({
        t: 'state', seq: ++seq, when: t, emittedAt: t, by: 'other-1', kind,
        anchor: { positionMs, atServerMs: t, paused, mediaKey: 'yt:abc' },
      });
      await vt.advance(100);
    };
    return { vt, player, tr, engine, errors, state };
  }

  it('applies the room\'s later seek and pause', async () => {
    const m = await starvedMember();
    await m.state('play', 600_000, false);
    assert.equal(m.player.paused, false, 'the room\'s play was not pressed');
    await m.vt.advance(5000);
    await m.state('seek', 700_000, false);
    await m.vt.advance(5000);
    assert.ok(Math.abs(m.player.positionS - 700) < 1, `still at ${m.player.positionS}: the seek never ran`);
    await m.state('pause', 700_000, true);
    await m.vt.advance(1000);
    assert.equal(m.player.paused, true, 'the room\'s pause never ran');
    // The pause interrupting a play nobody waits for any more is routine.
    assert.deepEqual(m.errors, []);
  });

  it('control: a play() that settles at once is still waited for', async () => {
    // An autoplay refusal arrives as a rejection straight away, and must
    // still be seen by the transition that pressed play.
    const m = await starvedMember();
    m.player.play = () => Promise.reject(new AutoplayBlockedError());
    await m.state('play', 600_000, false);
    assert.equal(m.engine.blocked, true);
  });
});

describe('a socket that dies without closing', () => {
  // A network change can black-hole a TCP path with no FIN or RST reaching
  // the client. The browser then reports no close until the kernel gives up
  // retransmitting -- about fifteen minutes on Linux -- and page code never
  // sees the server's pings. Until then the panel said "joined" while every
  // command and chat line went nowhere.

  function silence(h: Harness): void {
    (h.tr as unknown as { timeOffset: number | null }).timeOffset = null;
  }

  it('is given up on when the server stops answering, and reconnected', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    const connects = h.tr.connects;
    silence(h);
    await h.vt.advance(60_000);
    assert.notEqual(h.engine.state, 'joined', 'still "joined" a minute into a dead socket');
    assert.ok(h.tr.connects > connects, 'never tried to reconnect');
    assert.equal(h.engine.stats.reconnects >= 1, true);
  });

  it('control: a server that answers keeps the session, however quiet the room', async () => {
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    await h.vt.advance(20 * 60_000);
    assert.equal(h.engine.state, 'joined');
    assert.equal(h.tr.connects, 1);
  });

  it('control: a throttled tab whose probes go out a minute apart is not given up on', async () => {
    // Chrome's intensive throttling runs a hidden tab's timers once a
    // minute; the replies still arrive at once.
    const vt = new VirtualTime();
    const player = new FakePlayer(vt, { paused: false, positionS: 10 });
    const tr = new FakeTransport();
    let throttled = false;
    const engine = new SyncEngine({
      adapter: player, transport: tr, now: () => vt.now, clearTimer: vt.clearTimer, isHidden: () => throttled,
      setTimer: (fn, ms) => vt.setTimer(fn, throttled ? Math.max(ms, 60_000) : ms),
    }, CFG);
    tr.autoAnswerTime(OFFSET);
    engine.start();
    tr.open();
    tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 10_000, atServerMs: OFFSET, paused: false, mediaKey: 'yt:abc' },
      members: [], serverMs: vt.now, mediaKey: 'yt:abc',
    });
    await vt.advance(400);
    throttled = true;
    const probes = tr.sentOf('time').length;
    await vt.advance(10 * 60_000);
    assert.equal(engine.state, 'joined');
    assert.equal(tr.connects, 1);
    // Each tick found a minute without a frame; only the answered probes
    // say the socket is alive.
    assert.ok(tr.sentOf('time').length - probes >= 9, 'the liveness check never ran');
  });

  it('a new socket starts its own count', async () => {
    // Two probes went unanswered on the old socket before it reset. The new
    // one has not answered anything yet either -- but it has had no chance
    // to miss three probes.
    const h = harness({ paused: false, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: false }, 0, 2);
    silence(h);
    await h.vt.advance(12_000);
    assert.equal(h.engine.state, 'joined');
    h.tr.drop('reset');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconnectBaseMs);
    const connects = h.tr.connects;
    h.tr.open();
    await h.vt.advance(12_000);
    assert.equal(h.tr.connects, connects, 'gave up on a socket that had missed two probes');
    await h.vt.advance(10_000);
    assert.ok(h.tr.connects > connects, 'never gave up on the silent new socket');
  });
});

describe('a command lost with the connection', () => {
  // A command sent into a socket that was already dead, and noticed a moment
  // later: the old socket takes its ack with it, and the snapshot taken at the
  // drop already showed the change, so there was nothing "offline" to send.
  // The room never heard of it, and the reconciler then undid it.

  /**
   * A member in a room of two playing at 10 s does `act` 2 s in; the command
   * goes out and the link is found dead `dropAfterMs` later. The session comes
   * back 600 ms after that into `room` (by default exactly what it left).
   */
  async function lostWithLink(
    act: (p: FakePlayer) => Promise<void> | void,
    o: {
      dropAfterMs?: number; room?: Partial<Anchor>; seq?: number; paused?: boolean; gestures?: boolean;
      /** What the site does to the player while the link is down, with nobody touching anything. */
      offline?: (p: FakePlayer) => Promise<void> | void;
    } = {},
  ) {
    const vt = new VirtualTime();
    const paused = o.paused ?? false;
    const player = new FakePlayer(vt, { paused, positionS: 10 });
    const tr = new FakeTransport();
    let input = -Infinity;
    const engine = new SyncEngine({
      adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer,
      isHidden: () => false,
      ...(o.gestures ? {
        gestures: { lastInputAt: () => input, lastIgnoredInputAt: () => -Infinity, activationActive: () => null },
      } : {}),
    }, CFG);
    const members = [
      { id: 'me-1', name: 'm0', suspended: false, ready: true },
      { id: 'other-1', name: 'm1', suspended: false, ready: true },
    ];
    const anchor = { positionMs: 10_000, atServerMs: OFFSET, paused, mediaKey: 'yt:abc' };
    const welcome = (a: Anchor, seq: number) => tr.deliver({
      t: 'welcome', you: 'me-1', seq, anchor: a, members, serverMs: vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    tr.autoAnswerTime(OFFSET);
    engine.start();
    tr.open();
    welcome(anchor, 0);
    await vt.advance(2000);
    // Gesture evidence settles acquisition first; this member is past it.
    assert.equal(engine.acquisition, 'steady');
    input = vt.now;
    await act(player);
    await vt.advance(100);
    const sent = tr.sentOf('cmd').length;
    assert.ok(sent >= 1, 'the change never became a command');
    await vt.advance(o.dropAfterMs ?? 200);
    tr.drop('link was dead');
    await vt.advance(300);
    await o.offline?.(player);
    await vt.advance(300);
    tr.open();
    welcome({ ...anchor, ...o.room }, o.seq ?? 0);
    await vt.advance(600);
    return { vt, player, tr, engine, sent };
  }

  const pause = async (p: FakePlayer) => { await p.pause(); p.emit('pause'); };
  const play = async (p: FakePlayer) => { await p.play(); p.emit('play'); };
  const kinds = (tr: FakeTransport) => tr.sentOf('cmd').map((c) => c.kind);

  it('a pause is sent again after the welcome, and stays', async () => {
    const m = await lostWithLink(pause);
    const cmds = m.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['pause', 'pause'], 'the lost pause never reached the room');
    const t = m.vt.now + OFFSET;
    m.tr.deliver({
      t: 'ack', reqId: cmds[1]!.reqId, seq: 1, when: t, emittedAt: t, kind: 'pause',
      anchor: { positionMs: cmds[1]!.positionMs, atServerMs: t, paused: true, mediaKey: 'yt:abc' },
    });
    await m.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 1000);
    assert.equal(m.player.paused, true, 'the reconciler undid the member\'s pause');
  });

  it('a pause is sent again with gesture evidence, whose press came before the drop', async () => {
    const m = await lostWithLink(pause, { gestures: true });
    assert.deepEqual(kinds(m.tr), ['pause', 'pause']);
  });

  it('with gesture evidence, a site\'s own seek during the outage is not sent with a lost pause', async () => {
    // Resume-from-history, or an ad break's return: nobody pressed anything
    // after the drop, and the lost command was a pause, not a seek.
    const m = await lostWithLink(pause, {
      gestures: true, offline: (p) => { p.readState(); p.positionS = 300; },
    });
    assert.deepEqual(kinds(m.tr), ['pause', 'pause']);
  });

  it('with gesture evidence, a site\'s own pause during the outage is not sent with a lost seek', async () => {
    const m = await lostWithLink((p) => { p.readState(); p.positionS = 300; p.emit('seeked'); }, {
      gestures: true, offline: async (p) => { await p.pause(); },
    });
    assert.deepEqual(kinds(m.tr), ['seek', 'seek']);
  });

  it('with gesture evidence, a site\'s own seek during the outage is not taken for a lost seek', async () => {
    // The lost command is a seek, but not to where the site put the player.
    const m = await lostWithLink((p) => { p.readState(); p.positionS = 300; p.emit('seeked'); }, {
      gestures: true, offline: (p) => { p.readState(); p.positionS = 1200; },
    });
    assert.deepEqual(kinds(m.tr), ['seek']);
  });

  it('control: with gesture evidence, a site\'s own play during the outage cancels a lost pause', async () => {
    // Paused, lost, and then the site started playback again by itself: the
    // player now agrees with the room, and nothing the member asked for is left.
    const m = await lostWithLink(pause, { gestures: true, offline: async (p) => { await p.play(); } });
    assert.deepEqual(kinds(m.tr), ['pause']);
  });

  it('a seek is sent again', async () => {
    const m = await lostWithLink((p) => { p.readState(); p.positionS = 300; p.emit('seeked'); });
    const cmds = m.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['seek', 'seek']);
    assert.ok(Math.abs(cmds[1]!.positionMs - m.player.positionS * 1000) < 1500, `sent ${cmds[1]!.positionMs}`);
  });

  it('a held play is sent again, and still held', async () => {
    const m = await lostWithLink(play, { paused: true });
    assert.deepEqual(kinds(m.tr), ['play', 'play'], 'the lost play never reached the room');
    assert.equal(m.player.paused, true, 'played on ahead of a room that has not started');
  });

  it('control: a pause and a play that cancel out send nothing more', async () => {
    const m = await lostWithLink(async (p) => { await pause(p); await play(p); });
    assert.equal(m.sent, kinds(m.tr).length, `sent ${kinds(m.tr).join(', ')}`);
    assert.equal(m.player.paused, false);
  });

  it('control: a command the room took before the drop is not sent again', async () => {
    // Its ack went down with the socket, but the welcome's seq says the room
    // moved, and the room's word is the newer one.
    const m = await lostWithLink(pause, { room: { positionMs: 12_100, atServerMs: OFFSET + 2100, paused: true }, seq: 1 });
    assert.deepEqual(kinds(m.tr), ['pause']);
    assert.equal(m.player.paused, true);
  });

  it('control: a seek sent more than OWN_ACK_WAIT_MS before the drop is not sent again', async () => {
    // Nothing reverts a seek the room never took, so the player still shows
    // it: only the age says it is not the lost command's to resend.
    const m = await lostWithLink((p) => { p.readState(); p.positionS = 300; p.emit('seeked'); }, { dropAfterMs: 8000 });
    assert.deepEqual(kinds(m.tr), ['seek']);
    assert.ok(m.player.positionS > 290, `at ${m.player.positionS}`);
  });

  it('control: a command sent long before the drop is the reconciler\'s business', async () => {
    const m = await lostWithLink(pause, { dropAfterMs: 20_000 });
    assert.deepEqual(kinds(m.tr), ['pause']);
  });
});

describe('a joiner welcomed inside a play\'s lead', () => {
  // A `play` anchors the room at its own `when`, and a `welcome` carries that
  // anchor with no `when` beside it. Conformed at once, the joiner was aimed
  // at a position projected back from a start that had not happened -- before
  // 0, which an element clamps -- and started playing while everybody else
  // was still waiting, ahead of the room by the rest of the lead.

  /** A `<video>` that clamps a seek before the start to 0, as the spec says. */
  class ClampingPlayer extends FakePlayer {
    override seekTo(positionS: number): Promise<void> { return super.seekTo(Math.max(0, positionS)); }
  }

  async function joinDuringLead(anchor: Anchor) {
    const vt = new VirtualTime();
    const player = new ClampingPlayer(vt, { paused: true, positionS: 0 });
    const tr = new FakeTransport();
    const engine = new SyncEngine({
      adapter: player, transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer,
      isHidden: () => false,
      gestures: { lastInputAt: () => -Infinity, lastIgnoredInputAt: () => -Infinity, activationActive: () => null },
    }, CFG);
    tr.autoAnswerTime(OFFSET);
    engine.start();
    tr.open();
    tr.deliver({
      t: 'welcome', you: 'me-1', seq: 7, anchor,
      members: [
        { id: 'me-1', name: 'm0', suspended: false, ready: true },
        { id: 'other-1', name: 'm1', suspended: false, ready: true },
      ],
      serverMs: vt.now + OFFSET, mediaKey: 'yt:abc',
    });
    const room = () => expectedAt(anchor, Math.max(vt.now + OFFSET, anchor.atServerMs));
    return { vt, player, engine, room };
  }

  it('waits for the play to be due, then starts with the room', async () => {
    const m = await joinDuringLead({ positionMs: 0, atServerMs: OFFSET + 1500, paused: false, mediaKey: 'yt:abc' });
    await m.vt.advance(400);
    assert.equal(m.player.paused, true, `started at ${m.player.positionS}, before the room`);
    await m.vt.advance(1200);
    assert.equal(m.player.paused, false, 'never started');
    await m.vt.advance(1000);
    assert.ok(Math.abs(m.player.positionS * 1000 - m.room()) <= DEFAULT_ENGINE_CONFIG.seekToleranceMs,
      `at ${m.player.positionS * 1000}, the room at ${m.room()}`);
  });

  it('does not wait out an anchor further ahead than any command lead', async () => {
    // 10 s out is a clock error, not a lead: CMD_DELAY is at most 2 s.
    const m = await joinDuringLead({ positionMs: 30_000, atServerMs: OFFSET + 10_000, paused: false, mediaKey: 'yt:abc' });
    await m.vt.advance(3000);
    assert.equal(m.player.paused, false, 'still waiting for an anchor 10 s out');
  });

  it('control: an anchor already due is conformed at once', async () => {
    const m = await joinDuringLead({ positionMs: 30_000, atServerMs: OFFSET - 5000, paused: false, mediaKey: 'yt:abc' });
    await m.vt.advance(400);
    assert.equal(m.player.paused, false);
    assert.ok(Math.abs(m.player.positionS * 1000 - m.room()) <= DEFAULT_ENGINE_CONFIG.seekToleranceMs,
      `at ${m.player.positionS * 1000}, the room at ${m.room()}`);
  });
});

describe('a command of ours still on its way is where the room is going', () => {
  // `this.anchor` only becomes our command at its `when`. Judged against the
  // anchor it replaces, a member undoing their own change inside that window
  // looked like agreeing with the room: nothing was sent, and at `when` the
  // whole room moved to where the member had just decided not to be.

  /** A room of two playing at 100 s, one second in. */
  async function playingRoom() {
    const h = harness({ paused: false, positionS: 100 });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false }, 0, 2);
    await h.vt.advance(1000);
    h.tr.sent.length = 0;
    return h;
  }

  /** The server's answer to `cmd`, due `leadMs` from now, anchored as `room.go` anchors it. */
  function ack(h: Harness, cmd: { reqId: string; kind: string; positionMs: number }, seq: number,
    leadMs: number, paused: boolean) {
    const now = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'ack', reqId: cmd.reqId, seq, when: now + leadMs, emittedAt: now, kind: cmd.kind,
      anchor: { positionMs: cmd.positionMs, atServerMs: now + leadMs, paused, mediaKey: 'yt:abc' },
    });
  }

  /** Where the room would be had nobody touched it. */
  const untouched = (h: Harness) => 100_000 + h.vt.now;

  it('a seek taken back inside its own lead is sent too', async () => {
    const h = await playingRoom();
    h.player.readState();
    h.player.positionS += 5;                         // Right arrow
    h.player.emit('seeked');
    await h.vt.advance(100);
    const first = h.tr.sentOf('cmd');
    assert.deepEqual(first.map((c) => c.kind), ['seek']);
    ack(h, first[0]!, 1, 1500, false);
    await h.vt.advance(200);

    h.player.readState();
    h.player.positionS -= 5;                         // Left arrow: back where the room is
    h.player.emit('seeked');
    await h.vt.advance(100);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['seek', 'seek'], 'the seek back never reached the room');
    assert.ok(Math.abs(cmds[1]!.positionMs - untouched(h)) < 300,
      `sent ${cmds[1]!.positionMs}, the room was at ${untouched(h)}`);

    // Both land; the room ends where the member left it.
    ack(h, cmds[1]!, 2, 1500, false);
    await h.vt.advance(3000);
    assert.ok(Math.abs(h.player.positionS * 1000 - untouched(h)) < 2000,
      `at ${h.player.positionS}, the member left the room at ${untouched(h)}`);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['seek', 'seek']);
  });

  it('control: a seek left alone through its lead is sent once', async () => {
    const h = await playingRoom();
    h.player.readState();
    h.player.positionS += 5;
    h.player.emit('seeked');
    await h.vt.advance(100);
    const first = h.tr.sentOf('cmd');
    ack(h, first[0]!, 1, 1500, false);
    await h.vt.advance(5000);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['seek']);
    assert.ok(h.player.positionS * 1000 - untouched(h) > 3000, `at ${h.player.positionS}: the seek was undone`);
  });

  it('a play pressed right after our own pause is sent, and the room ends up playing', async () => {
    const h = await playingRoom();
    await h.player.pause();
    h.player.emit('pause');
    await h.vt.advance(80);
    await h.player.play();                            // a double click, or a change of mind
    h.player.emit('play');
    await h.vt.advance(80);
    const cmds = h.tr.sentOf('cmd');
    assert.deepEqual(cmds.map((c) => c.kind), ['pause', 'play'], 'the play was taken for an echo');

    ack(h, cmds[0]!, 1, 0, true);                     // a pause has no lead
    await h.vt.advance(50);
    ack(h, cmds[1]!, 2, 1000, false);
    await h.vt.advance(1500);
    assert.equal(h.player.paused, false, 'left paused although the last press was play');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 500);
    assert.equal(h.player.paused, false);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause', 'play']);
  });

  it('a second press of a play still on its way is held like the first', async () => {
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    h.tr.sent.length = 0;
    for (let i = 0; i < 2; i++) {
      await h.player.play();
      h.player.emit('play');
      await h.vt.advance(150);
      assert.equal(h.player.paused, true, `press ${i + 1} played on ahead of a room that has not started`);
    }
    assert.ok(h.tr.sentOf('cmd').every((c) => c.kind === 'play'));
    assert.ok(Math.abs(h.player.positionS - 10) <= 0.08, `held at ${h.player.positionS}`);
  });

  it('a play of ours that never got an ack stops counting after OWN_ACK_WAIT_MS', async () => {
    // The gate held it and then dropped it, or it was rate-limited: the room
    // never started, so a press after that is a press, not an echo.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    h.tr.sent.length = 0;
    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(150);
    assert.equal(h.player.paused, true);
    await h.vt.advance(5000 + 500);                  // OWN_ACK_WAIT_MS, and no ack
    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(150);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['play', 'play'],
      'the press was taken for an echo of a play the room never took');
  });

  it('somebody else\'s command applied first ends the prediction', async () => {
    const h = await playingRoom();
    await h.player.pause();
    h.player.emit('pause');
    await h.vt.advance(80);
    // Another member's seek lands before our pause does: the room plays on
    // from there, and so does the player.
    const t = h.vt.now + OFFSET;
    h.tr.deliver({
      t: 'state', seq: 1, when: t, emittedAt: t, by: 'other-1', kind: 'seek',
      anchor: { positionMs: 50_000, atServerMs: t, paused: false, mediaKey: 'yt:abc' },
    });
    await h.vt.advance(200);
    assert.equal(h.player.paused, false);
    await h.player.pause();
    h.player.emit('pause');
    await h.vt.advance(80);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause', 'pause'],
      'the pause was judged against our own superseded one');
  });

  it('a seek during a held play is judged against the paused anchor, not the start to come', async () => {
    // A play starts the room at `when`, from where it is paused; until then
    // the room stands still, and so does the held player.
    const h = harness({ paused: true, positionS: 10 });
    await h.join({ positionMs: 10_000, atServerMs: OFFSET, paused: true }, 0, 2);
    await h.vt.advance(500);
    h.tr.sent.length = 0;
    const pressedAt = h.vt.now;
    await h.player.play();
    h.player.emit('play');
    await h.vt.advance(3000);                        // the gate is holding it
    const [play] = h.tr.sentOf('cmd');
    assert.equal(h.player.paused, true);
    // Scrubbed to exactly where the play would have taken the room had it
    // started at once: a seek all the same.
    h.player.readState();
    h.player.positionS = (play!.positionMs + (h.vt.now - pressedAt)) / 1000;
    h.player.emit('seeked');
    await h.vt.advance(100);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['play', 'seek']);
  });

  it('reports still measure against the anchor while a seek of ours is on its way', async () => {
    // The report names `lastAppliedSeq`, and the server judges it against
    // that anchor: a residual against the prediction would say "on time"
    // for a member 5 s off the room it is still on.
    const h = await playingRoom();
    h.player.readState();
    h.player.positionS += 5;
    h.player.emit('seeked');
    await h.vt.advance(100);
    ack(h, h.tr.sentOf('cmd')[0]!, 1, 1500, false);
    h.tr.sent.length = 0;
    await h.vt.advance(1200);
    const hbs = h.tr.sentOf('hb');
    assert.ok(hbs.length > 0, 'no report');
    for (const hb of hbs) {
      assert.equal(hb.lastAppliedSeq, 0);
      assert.ok(Math.abs(hb.residualMs - 5000) < 300, `residual ${hb.residualMs}`);
    }
  });

  it('control: a pause alone is sent once and holds', async () => {
    const h = await playingRoom();
    await h.player.pause();
    h.player.emit('pause');
    await h.vt.advance(80);
    const cmds = h.tr.sentOf('cmd');
    ack(h, cmds[0]!, 1, 0, true);
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 500);
    assert.deepEqual(h.tr.sentOf('cmd').map((c) => c.kind), ['pause']);
    assert.equal(h.player.paused, true);
  });
});
