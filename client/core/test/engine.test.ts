import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../src/engine/engine.ts';
import type { EngineConfig, EngineEvents } from '../src/engine/engine.ts';
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
  join(anchor?: Partial<Anchor>, seq?: number): Promise<void>;
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
    async join(anchor = {}, seq = 0) {
      tr.autoAnswerTime(OFFSET);
      engine.start();
      tr.open();
      tr.deliver({
        t: 'welcome', you: 'me-1', seq,
        anchor: { positionMs: 0, atServerMs: 0, paused: true, mediaKey: 'yt:abc', ...anchor },
        members: [], serverMs: vt.now, mediaKey: 'yt:abc',
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
    // Note the direction. A swap to an element at 0 is absorbed for free: a
    // BACKWARD jump makes `posMs - lastEvalPos` negative, the stall guard reads
    // that as frozen playback and re-baselines. Only the forward case reaches
    // the two-diff test, which is exactly why it needed a test of its own.
    const h = swapHarness();
    await join(h);
    const before = h.tr.sentOf('cmd').length;

    h.swap.setTarget(new FakePlayer(h.vt, { paused: false, positionS: 400 }));
    await h.vt.advance(3000);

    const sent = h.tr.sentOf('cmd').slice(before);
    assert.deepEqual(sent, [], `the swap produced commands: ${JSON.stringify(sent)}`);
  });

  it('the backward case is absorbed by the stall guard', async () => {
    // Documented rather than assumed: this is why the bug above only shows up
    // in one direction, and it would be easy to "fix" the stall guard in a way
    // that quietly opened the second half of the hole.
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
    const h = swapHarness();
    await join(h);
    const before = h.tr.sentOf('cmd').length;

    h.engine.setLocalMediaKey('yt:two');
    const next = new FakePlayer(h.vt, { paused: false, positionS: 0 });
    h.swap.setTarget(next);
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
});
