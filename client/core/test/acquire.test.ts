/**
 * Acquiring a video (D8, docs/design/acquire.md): what a site does to an
 * element the engine has just found is not the member's doing until a gesture
 * says so, the end of the media is not a pause, and the room's media is named
 * and moved on by compare-and-set.
 *
 * Every property here has a control: the same scenario without gesture
 * evidence (the behaviour before D8), or without the one condition that makes
 * the difference.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SwappableAdapter } from '../src/adapter/swappable.ts';
import { trackGestures } from '../src/app/gestures.ts';
import type { Anchor } from '../src/engine/clock.ts';
import { DEFAULT_ENGINE_CONFIG, SyncEngine } from '../src/engine/engine.ts';
import type { EngineConfig, EngineDeps, GestureEvidence } from '../src/engine/engine.ts';
import type { CmdFrame } from '../src/engine/protocol.ts';
import { FakePlayer, FakeTransport, VirtualTime } from './fakes.ts';
import type { FakePlayerOptions } from './fakes.ts';

const OFFSET = 1_000_000;
const KEY = 'laftel:/player/1/1';
const NEXT = 'laftel:/player/1/2';

class FakeGestures implements GestureEvidence {
  input = -Infinity;
  ignored = -Infinity;
  active: boolean | null = false;
  private readonly vt: VirtualTime;
  constructor(vt: VirtualTime) { this.vt = vt; }
  lastInputAt(): number { return this.input; }
  lastIgnoredInputAt(): number { return this.ignored; }
  activationActive(): boolean | null { return this.active; }
  /** A trusted click or key, now. */
  press(): void { this.input = this.vt.now; this.active = true; }
}

interface Opts {
  player?: FakePlayerOptions;
  cfg?: Partial<EngineConfig>;
  /** false: no gesture evidence at all -- the behaviour before D8. */
  gestures?: boolean;
  continues?: EngineDeps['continues'];
  adapter?: (p: FakePlayer) => EngineDeps['adapter'];
  /** A player that ends as the HTML spec says. See `SpecPlayer`. */
  spec?: boolean;
}

function harness(o: Opts = {}) {
  const vt = new VirtualTime();
  const player = new (o.spec ? SpecPlayer : FakePlayer)(vt, { durationS: 1400, ...o.player });
  const tr = new FakeTransport();
  const g = new FakeGestures(vt);
  const acq: string[] = [];
  const errors: string[] = [];
  const tab = { hidden: false };
  const engine = new SyncEngine({
    adapter: o.adapter ? o.adapter(player) : player,
    transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => tab.hidden,
    ...(o.gestures === false ? {} : { gestures: g }),
    ...(o.continues ? { continues: o.continues } : {}),
  }, {
    ...DEFAULT_ENGINE_CONFIG, room: 'r', secret: 's', name: 'me', mediaKey: KEY, ...o.cfg,
  }, {
    onAcquisition: (s) => { acq.push(s); },
    onError: (c) => { errors.push(c); },
  });
  let seq = 0;
  const h = {
    vt, player, tr, engine, g, acq, errors, tab,
    cmds: () => tr.sentOf('cmd'),
    kinds: () => tr.sentOf('cmd').map((c) => c.kind),
    lastHb: () => tr.sentOf('hb').at(-1)!,
    serverNow: () => vt.now + OFFSET,
    async join(anchor: Partial<Anchor> = {}, members = 2) {
      tr.autoAnswerTime(OFFSET);
      engine.start();
      tr.open();
      tr.deliver({
        t: 'welcome', you: 'me-1', seq: 0,
        anchor: { positionMs: 0, atServerMs: 0, paused: true, mediaKey: KEY, ...anchor },
        members: Array.from({ length: members }, (_, i) => (
          { id: i === 0 ? 'me-1' : `other-${i}`, name: `m${i}`, suspended: false, ready: true })),
        serverMs: vt.now, mediaKey: anchor.mediaKey ?? KEY,
      });
      await vt.advance(400);
    },
    /** Somebody else's command, applied now. */
    async state(anchor: Partial<Anchor>, kind: string) {
      const t = vt.now + OFFSET;
      tr.deliver({
        t: 'state', seq: ++seq, when: t, emittedAt: t, by: 'other-1', kind,
        anchor: { positionMs: 0, atServerMs: t, paused: true, mediaKey: KEY, ...anchor },
      });
      await vt.advance(10);
    },
    /** The server's answer to one of our commands. */
    async ack(cmd: CmdFrame, anchor: Partial<Anchor>) {
      const t = vt.now + OFFSET;
      tr.deliver({
        t: 'ack', reqId: cmd.reqId, seq: ++seq, when: t, emittedAt: t, kind: cmd.kind,
        anchor: { positionMs: 0, atServerMs: t, paused: true, mediaKey: KEY, ...anchor },
      });
      await vt.advance(10);
    },
    /** What a site's own `play()` does: no gesture anywhere. */
    async siteAutoplay() {
      player.paused = false;
      player.emit('play');
      await vt.advance(20);
    },
  };
  return h;
}

/** A room paused at 30 s, and a joiner whose element sits at 0. */
async function joinPausedRoom(o: Opts = {}) {
  const h = harness({ ...o, player: { paused: true, positionS: 0, ...o.player } });
  await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
  return h;
}

describe('a joiner whose site autoplays', () => {
  it('is conformed to the room, and the autoplay is put back rather than sent', async () => {
    const h = await joinPausedRoom();
    assert.ok(Math.abs(h.player.positionS - 30) < 0.3, `not conformed: at ${h.player.positionS}`);
    assert.equal(h.engine.acquisition, 'guarded');
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), [], 'the site\'s autoplay started the room');
    assert.equal(h.player.paused, true, 'the autoplay was left running against a paused room');
    assert.ok(h.engine.stats.siteMovesAbsorbed >= 1);
  });

  it('control: with no gesture evidence the autoplay is sent as the member\'s play (C1)', async () => {
    const h = await joinPausedRoom({ gestures: false });
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
  });

  it('a gestured play is the member\'s: sent, and acquisition is over', async () => {
    const h = await joinPausedRoom();
    h.g.press();
    await h.vt.advance(30);
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
    assert.equal(h.engine.acquisition, 'steady');
    assert.equal(h.engine.stats.gesturedIntents, 1);
  });

  it('a gesture older than the gesture window is not the cause', async () => {
    const h = await joinPausedRoom();
    h.g.press();
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.gestureWindowMs + 100);
    h.g.active = true;
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), []);
  });

  it('a gesture from before the media epoch began is not the cause (a next-episode click)', async () => {
    // Measured: the site's autoplay comes 0.75-2 s after the click on the
    // link, isActive still true -- but always after `emptied` (§20).
    const h = await joinPausedRoom({ cfg: { gestureWindowMs: 5000 } });
    h.g.press();
    await h.vt.advance(10);
    h.player.emit('emptied'); // the load algorithm starts on the same element
    await h.vt.advance(1000);
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), [], 'the navigation click was read as a press on the new episode');
  });

  it('an activation with no input behind it is a media key, and is sent', async () => {
    const h = await joinPausedRoom();
    h.g.active = true; // MPRIS play in Chromium: isActive rises, no input event
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
  });

  it('an activation right after a click on our own panel is not a media key', async () => {
    const h = await joinPausedRoom();
    h.g.ignored = h.vt.now;
    h.g.active = true;
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), []);
  });

  // The 참가 click activates the page for seconds. A join slower than the
  // gesture window used to show that activation to the first joined sample as
  // a rise with no input behind it -- a media key -- and the site's autoplay
  // or resume right after went to the room (C1 again, review 4 N3).
  for (const [what, act] of [
    ['autoplay', async (h: H) => { await h.siteAutoplay(); }],
    ['resume', async (h: H) => { h.player.positionS = 600; h.player.emit('seeked'); await h.vt.advance(20); }],
  ] as const) {
    it(`a panel click is not a media key when the welcome comes late (site ${what})`, async () => {
      const h = harness({ player: { paused: true, positionS: 0 } });
      h.tr.autoAnswerTime(OFFSET);
      h.g.ignored = h.vt.now; // the 참가 click, on our own panel
      h.g.active = true;
      h.engine.start();
      await h.vt.advance(800); // ticket + connect
      h.tr.open();
      h.tr.deliver({
        t: 'welcome', you: 'me-1', seq: 0,
        anchor: { positionMs: 30_000, atServerMs: OFFSET, paused: true, mediaKey: KEY },
        members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
        serverMs: h.vt.now, mediaKey: KEY,
      });
      for (let t = 0; t < 400; t += 100) {
        await h.vt.advance(100);
        await act(h);
      }
      assert.deepEqual(h.kinds(), [], 'the site\'s move was sent as the member\'s');
    });

    it(`a click made long before the engine started is not a media key either (site ${what})`, async () => {
      // 방 만들기 creates the room first; the engine is built when that answers.
      const h = harness({ player: { paused: true, positionS: 0 } });
      h.g.ignored = h.vt.now;
      h.g.active = true;
      await h.vt.advance(800);
      h.engine.start();
      await h.vt.advance(5);
      await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
      await act(h);
      assert.deepEqual(h.kinds(), [], 'the site\'s move was sent as the member\'s');
    });
  }

  it('control: a media key pressed after a late welcome is still one', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.tr.autoAnswerTime(OFFSET);
    h.g.ignored = h.vt.now;
    h.g.active = true;
    h.engine.start();
    await h.vt.advance(800);
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    h.g.active = false; // the panel click's activation expires
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.gestureWindowMs + 200);
    h.g.active = true; // MPRIS play
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
  });

  it('after the settle time the member is steady, and an ungestured play is sent as before', async () => {
    const h = await joinPausedRoom();
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.equal(h.engine.acquisition, 'steady');
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
  });

  it('reports itself acquiring until conformed, and not after', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.player.readyState = 1; // metadata only, still loading
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(1000);
    assert.equal(h.lastHb().acquiring, true);
    assert.equal(h.lastHb().suspended, false, 'an acquiring member is present, not absent');
    assert.equal(h.player.seeks, 0, 'conformed while the site was still loading');
    h.player.readyState = 4;
    await h.vt.advance(300);
    assert.equal(h.engine.acquisition, 'guarded');
    assert.equal(h.lastHb().acquiring, undefined, 'the release was not reported at once');
  });
});

describe('a joiner whose site resumes from its history', () => {
  it('has the resume put back, and nothing sent', async () => {
    const h = await joinPausedRoom();
    h.player.positionS = 813; // the site's resume
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.deepEqual(h.kinds(), []);
    assert.ok(Math.abs(h.player.positionS - 30) < 0.3, `left at ${h.player.positionS}`);
  });

  it('control: with no gesture evidence the resume is sent as a seek (C1, Path B)', async () => {
    const h = await joinPausedRoom({ gestures: false });
    h.player.positionS = 813;
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.deepEqual(h.kinds(), ['seek']);
  });

  it('a site that keeps overriding the room is left alone, and the member reported absent', async () => {
    const h = await joinPausedRoom();
    for (let i = 0; i <= DEFAULT_ENGINE_CONFIG.maxReconforms; i++) {
      h.player.positionS = 813;
      h.player.emit('seeked');
      await h.vt.advance(50);
    }
    assert.equal(h.engine.acquisition, 'fought');
    assert.deepEqual(h.kinds(), []);
    const seeks = h.player.seeks;
    h.player.positionS = 900;
    h.player.emit('seeked');
    await h.vt.advance(1500);
    assert.equal(h.player.seeks, seeks, 'still fighting');
    assert.equal(h.lastHb().suspended, true);
    // The member takes it back.
    h.g.press();
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play']);
    assert.equal(h.engine.acquisition, 'steady');
  });

  it('is left by a press that agrees with the room, too, and the room applies again', async () => {
    const h = await joinPausedRoom();
    for (let i = 0; i <= DEFAULT_ENGINE_CONFIG.maxReconforms; i++) {
      h.player.positionS = 813;
      h.player.emit('seeked');
      await h.vt.advance(50);
    }
    assert.equal(h.engine.acquisition, 'fought');
    // The site keeps autoplaying; the member presses pause -- which is what the
    // paused room says anyway, so nothing needs sending.
    await h.siteAutoplay();
    h.g.press();
    h.player.paused = true;
    h.player.emit('pause');
    await h.vt.advance(50);
    assert.equal(h.engine.acquisition, 'steady', 'the panel asked for a press, and the press did nothing');
    assert.deepEqual(h.kinds(), [], 'an agreeing press is not a command');
    await h.vt.advance(1100);
    assert.equal(h.lastHb().suspended, false);
    // And the room moves this member again.
    await h.state({ positionMs: 30_000, atServerMs: h.serverNow(), paused: false }, 'play');
    await h.vt.advance(300);
    assert.equal(h.player.paused, false, 'a room play was not applied after leaving fought');
  });
});

describe('a joiner into a playing room', () => {
  it('is started with the room, and steady once it runs with it', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    await h.join({ positionMs: 60_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(100);
    assert.equal(h.player.paused, false, 'a joiner of a playing room was left paused');
    assert.equal(h.engine.acquisition, 'steady');
    assert.deepEqual(h.kinds(), []);
  });
});

describe('the end of the media', () => {
  async function playToEnd(o: Opts = {}) {
    const h = harness({ ...o, player: { paused: false, positionS: 1399, ...o.player } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(20);
    return h;
  }

  it('is not a pause: nothing is sent, and the member reports itself finished', async () => {
    const h = await playToEnd();
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.engine.stats.endsNotSent, 1);
    await h.vt.advance(1100);
    assert.equal(h.lastHb().finished, true);
    assert.equal(h.lastHb().suspended, true);
  });

  it('is not undone by the reconciler, which would start the video again', async () => {
    const h = await playToEnd();
    const plays = h.player.plays;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs * 3);
    assert.equal(h.player.plays, plays);
    assert.equal(h.engine.stats.reconciles, 0);
  });

  it('is not put back either while the member is still guarded', async () => {
    // A conform would press play on an ended element, which starts it over.
    // Guarded in a playing room means not yet running with it -- still
    // buffering after the conform's seek, say; a negative tolerance stands in.
    const h = harness({ player: { paused: false, positionS: 1399.5 }, cfg: { seekToleranceMs: -1 } });
    await h.join({ positionMs: 1_399_500, atServerMs: OFFSET, paused: false });
    await h.vt.advance(50);
    assert.notEqual(h.engine.acquisition, 'steady', 'the scenario needs a guarded member');
    const plays = h.player.plays;
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(20);
    assert.equal(h.player.plays, plays, 'the ended element was started again');
    assert.equal(h.engine.stats.endsNotSent, 1);
    assert.deepEqual(h.kinds(), []);
  });

  it('holds without gesture evidence too', async () => {
    const h = await playToEnd({ gestures: false });
    assert.deepEqual(h.kinds(), []);
  });

  it('control: the same pause short of the end is sent', async () => {
    const h = harness({ player: { paused: false, positionS: 700 } });
    await h.join({ positionMs: 700_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.paused = true;
    h.player.emit('pause');
    await h.vt.advance(20);
    assert.deepEqual(h.kinds(), ['pause']);
  });
});

/**
 * The end of media as the HTML spec has it, which FakePlayer does not model:
 * a seek clamps to the duration, playback that reaches the end pauses and
 * sets `ended`, and play() on an ended element seeks back to 0 first.
 */
class SpecPlayer extends FakePlayer {
  restarts = 0;
  private atEnd(): void {
    if (this.positionS < this.durationS) { this.ended = false; return; }
    this.positionS = this.durationS;
    this.ended = true;
    this.paused = true;
  }
  override readState() {
    super.readState();
    this.atEnd();
    return super.readState();
  }
  override async seekTo(positionS: number): Promise<void> {
    await super.seekTo(Math.max(0, Math.min(positionS, this.durationS)));
    this.atEnd();
  }
  override async play(): Promise<void> {
    if (this.ended) {
      this.restarts++;
      this.positionS = 0;
      this.ended = false;
    }
    await super.play();
  }
}

describe('an ended element and the room\'s transitions', () => {
  /** A room of two playing at `positionS`, and a steady member with it. */
  async function playing(positionS: number) {
    const h = harness({ spec: true, player: { paused: false, positionS } });
    await h.join({ positionMs: positionS * 1000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    assert.equal(h.engine.acquisition, 'steady');
    return { h, p: h.player as SpecPlayer };
  }

  it('a room seeked to the end leaves the member there, not at the start', async () => {
    const { h, p } = await playing(1000);
    await h.state({ positionMs: 1_400_000, paused: false }, 'seek');
    await h.vt.advance(500);
    assert.equal(p.restarts, 0, `play() restarted the ended element, now at ${p.positionS}`);
    assert.ok(p.positionS > 1399, `at ${p.positionS}`);
    assert.ok(!h.kinds().includes('seek'), 'a restart was sent to the room');
  });

  it('a member who already ended is not restarted by a pause and play just short of the end', async () => {
    const { h, p } = await playing(1399);
    await h.vt.advance(1500); // plays to its end
    assert.equal(p.ended, true);
    await h.state({ positionMs: 1_399_850, paused: true }, 'pause');
    await h.state({ positionMs: 1_399_850, paused: false }, 'play');
    await h.vt.advance(500);
    assert.equal(p.restarts, 0, `play() restarted the ended element, now at ${p.positionS}`);
    assert.deepEqual(h.kinds(), []);
  });

  it('the member who scrubs to the end is not restarted by its own ack', async () => {
    const { h, p } = await playing(1000);
    h.g.press();
    await p.seekTo(1400);
    p.emit('seeked');
    await h.vt.advance(50);
    assert.deepEqual(h.kinds(), ['seek']);
    await h.ack(h.cmds()[0]!, { positionMs: 1_400_000, paused: false });
    await h.vt.advance(500);
    assert.equal(p.restarts, 0, `play() restarted the ended element, now at ${p.positionS}`);
    assert.deepEqual(h.kinds(), ['seek']);
  });

  it('control: a room seeked short of the end is played', async () => {
    const { h, p } = await playing(1000);
    await h.state({ positionMs: 1_390_000, paused: false }, 'seek');
    await h.vt.advance(500);
    assert.equal(p.paused, false);
    assert.ok(p.positionS > 1390, `at ${p.positionS}`);
  });

  it('control: an ended member is played again by a room seeked back into the media', async () => {
    const { h, p } = await playing(1399);
    await h.vt.advance(1500);
    assert.equal(p.ended, true);
    await h.state({ positionMs: 600_000, paused: false }, 'seek');
    await h.vt.advance(500);
    assert.equal(p.paused, false);
    assert.equal(p.restarts, 0);
    assert.ok(Math.abs(p.positionS - 600.5) < 0.3, `at ${p.positionS}`);
  });
});

describe('the media changing under the same element', () => {
  async function playing(o: Opts = {}) {
    const h = harness({ ...o, player: { paused: false, positionS: 100, ...o.player } });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    return h;
  }
  /** The load algorithm: paused with no `pause` event, position 0. */
  function load(h: Awaited<ReturnType<typeof playing>>) {
    h.player.paused = true;
    h.player.positionS = 0;
    h.player.readyState = 0;
  }

  it('sends no seek to 0 on the media it had (Path D)', async () => {
    const h = await playing();
    load(h);
    h.player.emit('emptied');
    await h.vt.advance(500);
    h.player.readyState = 4;
    await h.siteAutoplay();
    await h.vt.advance(500);
    assert.deepEqual(h.kinds(), []);
  });

  it('control: the same change with no `emptied` is read as the member\'s seek', async () => {
    const h = await playing({ gestures: false });
    load(h);
    await h.vt.advance(500);
    assert.ok(h.kinds().includes('seek'), `sent ${h.kinds()}`);
  });

  it('an element that disappears sends no seek to 0 either (Path E)', async () => {
    const sw = new SwappableAdapter();
    const h = harness({ player: { paused: false, positionS: 100 }, adapter: (p) => { sw.setTarget(p); return sw; } });
    await h.join({ positionMs: 100_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    sw.setTarget(null);
    await h.vt.advance(1000);
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.lastHb().acquiring, true, 'a member with no element is present and unready');
  });
});

describe('a reconnect', () => {
  it('into a room that moved onto this member\'s page conforms, like any move of the room', async () => {
    const h = harness({ player: { paused: false, positionS: 10 } });
    await h.join({ mediaKey: 'laftel:/player/9/9', positionMs: 0, atServerMs: OFFSET, paused: true });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    assert.equal(h.engine.followingRoom, false);
    h.tr.drop();
    await h.vt.advance(1000); // backoff, then a new socket
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-2', seq: 3,
      anchor: { positionMs: 42_000, atServerMs: h.serverNow(), paused: true, mediaKey: KEY },
      members: [{ id: 'me-2', name: 'm', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now, mediaKey: KEY,
    });
    await h.vt.advance(600);
    assert.equal(h.engine.followingRoom, true);
    assert.ok(Math.abs(h.player.positionS - 42) < 0.3, `not conformed: at ${h.player.positionS}`);
    assert.equal(h.player.paused, true);
    assert.deepEqual(h.kinds(), [], 'the member\'s own playing was sent to a room it had just rejoined');
  });

  it('does not read a panel click made during the outage as a media key', async () => {
    const h = harness({ player: { paused: true, positionS: 10 } });
    await h.join({ mediaKey: 'laftel:/player/9/9', positionMs: 0, atServerMs: OFFSET, paused: true });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.tr.drop();
    await h.vt.advance(100);
    h.g.ignored = h.vt.now; // a click on the panel while it says "reconnecting"
    h.g.active = true;
    await h.vt.advance(900);
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-2', seq: 3,
      anchor: { positionMs: 42_000, atServerMs: h.serverNow(), paused: true, mediaKey: KEY },
      members: [{ id: 'me-2', name: 'm', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now, mediaKey: KEY,
    });
    for (let t = 0; t < 400; t += 100) {
      await h.vt.advance(100);
      await h.siteAutoplay();
    }
    assert.deepEqual(h.kinds(), [], 'the site\'s autoplay was sent as the member\'s');
  });
});

describe('the creator', () => {
  it('seeds the room once its own player has settled, not before', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 1);
    // The site resumes and autoplays after the join.
    h.player.positionS = 813;
    h.player.emit('seeked');
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), [], 'seeded from the pre-resume state');
    assert.equal(h.lastHb().acquiring, true, 'judged against paused@0 before it adopted');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.deepEqual(h.kinds(), ['seek', 'play']);
    assert.ok(Math.abs(h.cmds()[0]!.positionMs - 813_000) < 2000, `seeded at ${h.cmds()[0]!.positionMs}`);
    assert.equal(h.player.positionS > 800, true, 'the creator was moved');
  });

  it('control: with no gesture evidence it seeds at once, before the site has moved', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true }, gestures: false });
    await h.join({}, 1);
    assert.deepEqual(h.kinds(), ['seek']);
    assert.equal(h.cmds()[0]!.positionMs, 0);
  });

  it('does not seed a room somebody else has moved meanwhile, and conforms instead', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 2);
    h.player.positionS = 813;
    h.player.emit('seeked');
    await h.vt.advance(20);
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.deepEqual(h.kinds(), []);
    assert.ok(Math.abs(h.player.positionS - 50) < 0.3, `left at ${h.player.positionS}`);
  });
});

describe('the creator, moved while it settles', () => {
  it('ends where the room was moved, even if its site moved it again afterwards', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 2);
    assert.equal(h.engine.acquisition, 'guarded');
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    // The site's resume lands after the room's seek, and is absorbed.
    h.player.positionS = 813;
    h.player.emit('seeked');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), []);
    assert.ok(Math.abs(h.player.positionS - 50) < 0.3, `left at ${h.player.positionS}`);
  });
});

describe('the creator, still loading', () => {
  it('does not seed over a command that arrived before its player was ready', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    h.player.readyState = 1;
    await h.join({}, 2);
    assert.equal(h.engine.acquisition, 'detached');
    // Another member seeks while this player is still loading.
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    h.player.positionS = 813; // the site's resume
    h.player.readyState = 4;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), [], 'the creator seeded over the other member\'s seek');
    assert.ok(Math.abs(h.player.positionS - 50) < 0.3, `left at ${h.player.positionS}`);
  });

  it('control: with nobody else moving the room, it seeds from where it settled', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    h.player.readyState = 1;
    await h.join({}, 2);
    h.player.positionS = 813;
    h.player.readyState = 4;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), ['seek']);
  });
});

describe('a room that names nothing yet (C3)', () => {
  it('is named by the first member on media, conditionally, and then seeded', async () => {
    const h = harness({ player: { paused: false, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    const naming = h.cmds();
    assert.equal(naming.length, 1);
    assert.equal(naming[0]!.kind, 'media');
    assert.equal(naming[0]!.ifMediaKey, '');
    assert.equal(naming[0]!.mediaKey, KEY);
    await h.ack(naming[0]!, { positionMs: naming[0]!.positionMs, paused: true });
    // Lands paused where the member was; the member is not paused by it.
    await h.vt.advance(100);
    assert.equal(h.player.paused, false, 'the namer was conformed to its own placeholder');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.deepEqual(h.kinds(), ['media', 'seek', 'play']);
  });

  it('a member who lost the naming race follows the room, and it is no error', async () => {
    const h = harness({ player: { paused: false, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    h.tr.deliver({ t: 'error', code: 'media_stale', msg: 'x' });
    await h.vt.advance(10);
    assert.deepEqual(h.errors, []);
    assert.equal(h.engine.stats.badFrames, 0);
    assert.equal(h.engine.stats.mediaStale, 1);
    await h.vt.advance(3000);
    assert.equal(h.kinds().filter((k) => k === 'media').length, 1, 'named again');
  });

  it('a resync of its own naming, applied before the ack, does not stop the namer seeding', async () => {
    const h = harness({ player: { paused: false, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    const naming = h.cmds()[0]!;
    // The ack is due a little later; the server's resync of the same seq
    // (the namer's report lagged) arrives in between and is applied first.
    const t = h.serverNow();
    h.tr.deliver({
      t: 'ack', reqId: naming.reqId, seq: 1, when: t + 200, emittedAt: t, kind: 'media',
      anchor: { positionMs: naming.positionMs, atServerMs: t + 200, paused: true, mediaKey: KEY },
    });
    h.tr.deliver({
      t: 'state', seq: 1, when: t, emittedAt: t, by: 'server', kind: 'resync',
      anchor: { positionMs: naming.positionMs, atServerMs: t + 200, paused: true, mediaKey: KEY },
    });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 1000);
    assert.deepEqual(h.kinds(), ['media', 'seek', 'play'], 'the namer took its own resync for somebody else\'s move');
  });

  it('a member who lost the race to somebody on the same video does not seed over them', async () => {
    const h = harness({ player: { paused: false, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    assert.deepEqual(h.kinds(), ['media']);
    // The winner named the same video, paused at 100 s; then our refusal.
    await h.state({ mediaKey: KEY, positionMs: 100_000, paused: true }, 'media');
    h.tr.deliver({ t: 'error', code: 'media_stale', msg: 'x' });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 3000);
    assert.deepEqual(h.kinds(), ['media'], 'the loser overwrote the winner\'s position and play state');
    assert.ok(Math.abs(h.player.positionS - 100) < 0.3, `left at ${h.player.positionS}`);
    assert.equal(h.player.paused, true);
  });

  it('names the room again after a reconnect that lost the naming', async () => {
    const h = harness({ player: { paused: false, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    assert.deepEqual(h.kinds(), ['media']);
    h.tr.drop();
    await h.vt.advance(2000);
    h.tr.open();
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 0, atServerMs: 0, paused: true, mediaKey: '' },
      members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }],
      serverMs: h.vt.now, mediaKey: '',
    });
    await h.vt.advance(5000);
    assert.equal(h.kinds().filter((k) => k === 'media').length, 2, 'the room stays unnamed for good');
  });

  it('a member on no media names nothing and stays quiet', async () => {
    const h = harness({ player: { paused: false, positionS: 42 }, cfg: { mediaKey: '' } });
    await h.join({ mediaKey: '' }, 2);
    await h.vt.advance(3000);
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.lastHb().suspended, true);
    assert.equal(h.lastHb().acquiring, undefined);
  });
});

describe('gesture evidence from the page', () => {
  function tracker() {
    const fns = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (t: string, fn: (e: Event) => void) => { fns.set(t, fn); },
      removeEventListener: (t: string) => { fns.delete(t); },
    };
    const host = { panel: true } as unknown as Node;
    let clock = 0;
    const g = trackGestures(target, () => host, () => clock);
    const fire = (type: string, o: Record<string, unknown> = {}, path: unknown[] = []) => {
      clock += 10;
      fns.get(type)?.({ type, isTrusted: true, composedPath: () => path, ...o } as unknown as Event);
      return clock;
    };
    return { g, fns, host, fire };
  }

  it('counts the inputs that activate a page, and only those', () => {
    const { g, fire } = tracker();
    assert.equal(g.lastInputAt(), -Infinity);
    assert.equal(fire('keydown', { key: ' ' }), g.lastInputAt());
    assert.equal(fire('pointerdown', { pointerType: 'mouse' }), g.lastInputAt());
    assert.equal(fire('pointerup', { pointerType: 'touch' }), g.lastInputAt());
    assert.equal(fire('touchend'), g.lastInputAt());
    const before = g.lastInputAt();
    fire('keydown', { key: 'Escape' });
    fire('keydown', { key: 'Shift' });
    fire('pointerdown', { pointerType: 'touch' });
    fire('pointerup', { pointerType: 'mouse' });
    fire('keydown', { key: 'k', isTrusted: false });
    assert.equal(g.lastInputAt(), before);
  });

  it('keeps input on our own panel apart', () => {
    const { g, fire, host } = tracker();
    const t = fire('mousedown', {}, [{}, host, {}]);
    assert.equal(g.lastInputAt(), -Infinity);
    assert.equal(g.lastIgnoredInputAt(), t);
  });

  it('stops listening', () => {
    const { g, fns } = tracker();
    g.stop();
    assert.equal(fns.size, 0);
  });
});

describe('the next episode', () => {
  async function finishThenNavigate(o: Opts & { ended?: boolean; to?: string; hidden?: boolean } = {}) {
    const h = harness({ continues: (a, b) => a === KEY && b === NEXT, ...o,
      player: { paused: false, positionS: 1399, ...o.player } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    if (o.ended !== false) {
      h.player.positionS = 1400;
      h.player.paused = true;
      h.player.ended = true;
      h.player.emit('pause');
    }
    // A background tab that has made a sound keeps playing to the end.
    if (o.hidden) h.tab.hidden = true;
    await h.vt.advance(5500); // the site's countdown
    h.engine.setLocalMediaKey(o.to ?? NEXT, 'https://laftel.net/player/1/2');
    h.player.ended = false;
    h.player.paused = true;
    h.player.positionS = 0;
    h.player.emit('emptied');
    await h.vt.advance(20);
    return h;
  }

  it('moves the room on, conditionally, paused at 0, then starts it once conformed', async () => {
    const h = await finishThenNavigate();
    const media = h.cmds().filter((c) => c.kind === 'media');
    assert.equal(media.length, 1);
    assert.deepEqual([media[0]!.mediaKey, media[0]!.ifMediaKey, media[0]!.positionMs], [NEXT, KEY, 0]);
    // The site autoplays the new episode before the ack.
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['media']);
    await h.ack(media[0]!, { mediaKey: NEXT, positionMs: 0, paused: true });
    await h.vt.advance(300);
    assert.equal(h.player.paused, true, 'the new episode kept running under a paused room');
    assert.deepEqual(h.kinds(), ['media', 'play']);
  });

  it('a member that loses the race does not start the room', async () => {
    const h = await finishThenNavigate();
    h.tr.deliver({ t: 'error', code: 'media_stale' });
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    await h.siteAutoplay();
    await h.vt.advance(2000);
    assert.deepEqual(h.kinds(), ['media']);
    assert.equal(h.player.paused, true);
  });

  // A hidden tab cannot start what it moves the room onto: its media does not
  // load, so it is never conformed and never sends the `play`, and every member
  // that lost the compare-and-set to it has dropped its own (review 4 C1).
  it('is not moved on from a hidden tab, but is once the tab is shown in time', async () => {
    const h = await finishThenNavigate({ hidden: true });
    h.player.readyState = 0; // media does not load in a hidden tab
    await h.vt.advance(3000);
    assert.deepEqual(h.kinds(), [], 'a hidden tab moved the room on, and nothing will start it');
    h.tab.hidden = false;
    h.player.readyState = 4;
    await h.vt.advance(200);
    const media = h.cmds().filter((c) => c.kind === 'media');
    assert.equal(media.length, 1);
    assert.deepEqual([media[0]!.mediaKey, media[0]!.ifMediaKey], [NEXT, KEY]);
    await h.ack(media[0]!, { mediaKey: NEXT, positionMs: 0, paused: true });
    await h.vt.advance(300);
    assert.deepEqual(h.kinds(), ['media', 'play']);
  });

  it('a tab shown only after the continuation window keeps the button', async () => {
    const h = await finishThenNavigate({ hidden: true });
    await h.vt.advance(20_000);
    h.tab.hidden = false;
    await h.vt.advance(2000);
    assert.deepEqual(h.kinds(), []);
  });

  it('a tab shown after somebody else moved the room on follows it', async () => {
    const h = await finishThenNavigate({ hidden: true });
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    h.tab.hidden = false;
    await h.vt.advance(2000);
    assert.deepEqual(h.kinds(), []);
  });

  it('control: a provider that does not continue keeps the button', async () => {
    const h = await finishThenNavigate({ to: 'laftel:/player/9/9' });
    assert.deepEqual(h.kinds(), []);
  });

  it('control: a member who had not finished keeps the button', async () => {
    const h = harness({ continues: () => true, player: { paused: false, positionS: 600 } });
    await h.join({ positionMs: 600_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.engine.setLocalMediaKey(NEXT);
    await h.vt.advance(20);
    assert.deepEqual(h.kinds(), []);
  });

  it('a member still finishing when the room moves on is on its way, not absent', async () => {
    const h = harness({ player: { paused: false, positionS: 1399 } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(100);
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, true);
    assert.equal(h.lastHb().suspended, false);
  });

  it('a member who finished long ago is not on its way anywhere', async () => {
    const h = harness({ player: { paused: false, positionS: 1399 } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(10 * 60_000); // idle on the end screen
    await h.state({ mediaKey: 'yt:other', positionMs: 0, paused: true }, 'media');
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, undefined, 'held the room\'s next play for someone who is not coming');
    assert.equal(h.lastHb().suspended, true);
  });

  it('is on its way only for a while', async () => {
    const h = harness({ player: { paused: false, positionS: 1399 } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(100);
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, true);
    await h.vt.advance(60_000); // never arrives
    assert.equal(h.lastHb().acquiring, undefined, 'still "on its way" a minute later');
    assert.equal(h.lastHb().suspended, true);
  });

  it('control: a member who was elsewhere when the room moved on is absent', async () => {
    const h = harness({ player: { paused: false, positionS: 600 } });
    await h.join({ positionMs: 600_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, undefined);
    assert.equal(h.lastHb().suspended, true);
  });
});

describe('the edges the design names', () => {
  it('conforms a paused player that stays at metadata, after a while', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.player.readyState = 1;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(2000);
    assert.equal(h.engine.acquisition, 'detached', 'conformed while the site may still be resuming');
    await h.vt.advance(4000);
    assert.notEqual(h.engine.acquisition, 'detached', 'a preload=metadata player stays acquiring for good');
    assert.ok(Math.abs(h.player.positionS - 30) < 0.3, `left at ${h.player.positionS}`);
  });

  it('leaves alone an element the room is far past the end of', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 15 } }); // an ad, a preview
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(3000);
    assert.equal(h.engine.acquisition, 'detached');
    assert.equal(h.player.seeks, 0);
    // Control: within the slack it is the room's media, and is conformed.
    const c = harness({ player: { paused: true, positionS: 0, durationS: 29 } });
    await c.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await c.vt.advance(3000);
    assert.notEqual(c.engine.acquisition, 'detached');
  });

  it('ignores a correction while acquiring', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.player.readyState = 1;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    const seeks = h.player.seeks;
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.serverNow() });
    h.tr.deliver({ t: 'correct', mode: 'nudge', rate: 1.05, when: h.serverNow() });
    await h.vt.advance(100);
    assert.equal(h.player.seeks, seeks, 'a stale judgement moved a player the conform step owns');
    assert.deepEqual(h.player.rateSets, []);
  });

  async function nearEnd(o: { endedAt?: number; scrubBack?: boolean; playing?: boolean } = {}) {
    const h = harness({ continues: (a, b) => a === KEY && b === NEXT, player: { paused: false, positionS: 1395 } });
    await h.join({ positionMs: 1_395_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    // Within endWindow of the end, still playing: the site moves on before `ended`.
    await h.vt.advance(4400);
    assert.ok(h.player.positionS > 1400 - DEFAULT_ENGINE_CONFIG.endWindowMs / 1000, `at ${h.player.positionS}`);
    if (o.scrubBack) {
      h.player.positionS = 600;
      h.player.emit('seeked');
      await h.vt.advance(DEFAULT_ENGINE_CONFIG.evalIntervalMs * 3);
    }
    if (o.endedAt !== undefined) {
      h.player.positionS = 1400;
      h.player.paused = true;
      h.player.ended = true;
      h.player.emit('pause');
      await h.vt.advance(o.endedAt);
    }
    h.engine.setLocalMediaKey(NEXT, 'https://laftel.net/player/1/2');
    h.player.paused = true;
    h.player.positionS = 0;
    h.player.emit('emptied');
    await h.vt.advance(20);
    return h;
  }

  it('counts the last second of a playing room as finished', async () => {
    const h = await nearEnd();
    assert.deepEqual(h.kinds().filter((k) => k === 'media'), ['media']);
  });

  it('forgets a finish the member scrubbed back from', async () => {
    const h = await nearEnd({ scrubBack: true });
    assert.deepEqual(h.kinds().filter((k) => k === 'media'), [], 'moved the room on for a member watching the middle');
  });

  it('moves on only within the continuation window of the finish', async () => {
    const h = await nearEnd({ endedAt: 21_000 });
    assert.deepEqual(h.kinds().filter((k) => k === 'media'), [], 'a navigation long after the end moved the room');
    const c = await nearEnd({ endedAt: 5500 });
    assert.deepEqual(c.kinds().filter((k) => k === 'media'), ['media'], 'control: the site\'s own countdown');
  });
});

// --- integration review (D6-D8) ---------------------------------------------

type H = ReturnType<typeof harness>;

/** Drop the socket and come back to a room as `welcome` describes it. */
async function rejoin(h: H, seq: number, anchor: Partial<Anchor>) {
  h.tr.drop();
  await h.vt.advance(1000); // backoff, then a new socket
  h.tr.open();
  h.tr.deliver({
    t: 'welcome', you: 'me-2', seq,
    anchor: { positionMs: 0, atServerMs: h.serverNow(), paused: true, mediaKey: KEY, ...anchor },
    members: [{ id: 'me-2', name: 'm', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
    serverMs: h.vt.now, mediaKey: anchor.mediaKey ?? KEY,
  });
  await h.vt.advance(400);
}

describe('a pause made while the session is down', () => {
  const ROOM = { positionMs: 100_000, atServerMs: OFFSET, paused: false };

  /**
   * Playing in a playing room, the link drops; 200 ms later the player is
   * paused -- by a press if `pressed`, else by nobody we saw. `hidden` hides
   * the tab first, and `muted` makes the playback one that never made a
   * sound. The session comes back into `room` at `seq`.
   */
  async function pausedAway(pressed: boolean, o: {
    hidden?: boolean; muted?: boolean; room?: Partial<Anchor>; seq?: number;
  } = {}) {
    const h = harness({ player: { paused: false, positionS: 100 } });
    h.player.muted = o.muted ?? false;
    await h.join(ROOM);
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    assert.equal(h.engine.acquisition, 'steady');
    h.tr.drop();
    await h.vt.advance(200);
    if (pressed) h.g.press();
    if (o.hidden) h.tab.hidden = true;
    h.player.readState();
    h.player.paused = true;
    h.player.emit('pause');
    await rejoin(h, o.seq ?? 0, o.room ?? ROOM);
    return h;
  }

  it('is sent when a gesture made it', async () => {
    const h = await pausedAway(true);
    assert.deepEqual(h.kinds(), ['pause']);
  });

  it('control: with no gesture after the drop it is the site\'s, and put back', async () => {
    const h = await pausedAway(false);
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 500);
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.player.paused, false);
  });

  it('is not sent when it is the browser\'s pause of a hidden tab that never made a sound', async () => {
    // The member clicked, then switched tabs; the browser paused the muted
    // playback. Live, the detector calls that `suspended` and sends nothing.
    const h = await pausedAway(true, { hidden: true, muted: true });
    await h.vt.advance(2000);
    assert.deepEqual(h.kinds(), [], 'the browser\'s background pause paused the room');
  });

  it('control: a pause in a hidden tab that has made a sound is the member\'s (a media key)', async () => {
    const h = await pausedAway(true, { hidden: true });
    assert.deepEqual(h.kinds(), ['pause']);
  });

  it('is not sent over a room somebody else moved meanwhile', async () => {
    const moved = { positionMs: 400_000, atServerMs: OFFSET + 1000, paused: false };
    const h = await pausedAway(true, { room: moved, seq: 1 });
    assert.deepEqual(h.kinds(), [], 'an older offline pause overrode the room');
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.reconcileAfterMs + 500);
    assert.deepEqual(h.kinds(), []);
    assert.equal(h.player.paused, false, 'the member did not follow the room');
    assert.ok(h.player.positionS > 390, `left at ${h.player.positionS}`);
  });
});

describe('a creator that reconnects while it loads', () => {
  async function loadingCreator() {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    h.player.readyState = 1;
    await h.join({}, 2);
    assert.equal(h.engine.acquisition, 'detached');
    return h;
  }

  it('does not seed over a move it missed while disconnected', async () => {
    const h = await loadingCreator();
    // Somebody else moved the room while the socket was down.
    await rejoin(h, 5, { positionMs: 50_000, paused: true });
    h.player.positionS = 813; // the site's resume
    h.player.readyState = 4;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), [], 'the creator seeded over a move made while it was away');
    assert.ok(Math.abs(h.player.positionS - 50) < 0.3, `left at ${h.player.positionS}`);
  });

  it('control: a room nobody moved meanwhile is still seeded', async () => {
    const h = await loadingCreator();
    await rejoin(h, 0, { positionMs: 0, paused: true });
    h.player.positionS = 813;
    h.player.readyState = 4;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), ['seek']);
  });
});

describe('the first welcome', () => {
  it('is not a change of media: a press made just before it still counts', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.tr.autoAnswerTime(OFFSET);
    h.engine.start();
    h.tr.open();
    h.g.press(); // the member presses play as the page joins
    await h.vt.advance(10);
    h.tr.deliver({
      t: 'welcome', you: 'me-1', seq: 0,
      anchor: { positionMs: 0, atServerMs: 0, paused: true, mediaKey: KEY },
      members: [{ id: 'me-1', name: 'm0', suspended: false, ready: true }, { id: 'o', name: 'o', suspended: false, ready: true }],
      serverMs: h.vt.now, mediaKey: KEY,
    });
    await h.vt.advance(400);
    await h.siteAutoplay();
    assert.deepEqual(h.kinds(), ['play'], 'the member\'s press was disowned by joining');
  });
});

describe('a member that finished while disconnected', () => {
  async function finished() {
    const h = harness({ player: { paused: false, positionS: 1399 } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(100);
    return h;
  }

  it('is on its way to the media the room moved on to, as over a live socket', async () => {
    const h = await finished();
    await rejoin(h, 4, { mediaKey: NEXT, positionMs: 0, paused: true });
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, true, 'a welcome onto new media was not a new media epoch');
    assert.equal(h.lastHb().suspended, false);
  });

  it('control: a welcome on the same media leaves it finished', async () => {
    const h = await finished();
    await rejoin(h, 4, { positionMs: 1_400_000, paused: false, atServerMs: 0 });
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, undefined);
    assert.equal(h.lastHb().suspended, true);
  });
});

describe('a continuation that never reached the room', () => {
  async function continued() {
    const h = harness({ continues: (a, b) => a === KEY && b === NEXT, player: { paused: false, positionS: 1399 } });
    await h.join({ positionMs: 1_399_000, atServerMs: OFFSET, paused: false });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 100);
    h.player.positionS = 1400;
    h.player.paused = true;
    h.player.ended = true;
    h.player.emit('pause');
    await h.vt.advance(5500);
    h.engine.setLocalMediaKey(NEXT, 'https://laftel.net/player/1/2');
    h.player.ended = false;
    h.player.paused = true;
    h.player.positionS = 0;
    h.player.emit('emptied');
    await h.vt.advance(20);
    assert.deepEqual(h.kinds(), ['media']);
    return h;
  }
  /** Much later, somebody moves the room onto NEXT, paused, with the button. */
  async function movedLater(h: H, afterMs = 600_000) {
    await h.vt.advance(afterMs);
    await h.state({ mediaKey: NEXT, positionMs: 0, paused: true }, 'media');
    await h.vt.advance(2000);
  }

  it('does not start the room later when the socket lost it', async () => {
    const h = await continued();
    await rejoin(h, 0, { positionMs: 1_400_000, paused: false, atServerMs: 0 }); // still KEY
    // Soon, too: the welcome says it is lost, whatever the time.
    await movedLater(h, 10_000);
    assert.deepEqual(h.kinds(), ['media'], 'a play nobody pressed started the room');
  });

  it('does not start the room later when the server refused it', async () => {
    const h = await continued();
    h.tr.deliver({ t: 'error', code: 'rate_limited', msg: 'too many commands' });
    await h.vt.advance(10);
    await movedLater(h);
    assert.deepEqual(h.kinds(), ['media'], 'a play nobody pressed started the room');
  });

  it('control: one the room took over a reconnect still starts it', async () => {
    const h = await continued();
    // Applied before the socket went; the ack was lost with it.
    await rejoin(h, 1, { mediaKey: NEXT, positionMs: 0, paused: true });
    await h.vt.advance(2000);
    assert.deepEqual(h.kinds(), ['media', 'play']);
  });
});

describe('an element the room is far past the end of', () => {
  it('is not on the room\'s timeline, so the room does not wait for it', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 15 } }); // an ad, a preview
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(60_000);
    assert.equal(h.engine.acquisition, 'detached');
    assert.equal(h.lastHb().acquiring, undefined, 'held every play of the room for an ad');
    assert.equal(h.lastHb().suspended, true);
  });

  it('control: an element still loading is waited for', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 15 } });
    h.player.readyState = 1;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(1000);
    assert.equal(h.lastHb().acquiring, true);
    assert.equal(h.lastHb().suspended, false);
  });

  it('is conformed once the room is back within it', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 15 } });
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(3000);
    await h.state({ positionMs: 10_000, paused: true }, 'seek');
    await h.vt.advance(500);
    assert.notEqual(h.engine.acquisition, 'detached');
    assert.ok(Math.abs(h.player.positionS - 10) < 0.3, `left at ${h.player.positionS}`);
  });
});

describe('a seeder whose site keeps moving its player', () => {
  async function restless(cfg: Partial<EngineConfig>) {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg });
    await h.join({}, 2);
    for (let i = 0; i < 60; i++) {
      h.player.positionS = 100 + i * 7;
      h.player.emit('seeked');
      await h.vt.advance(800);
    }
    return h;
  }

  it('is left alone and reported absent, like a joiner (the K bound)', async () => {
    const h = await restless({ adoptLocalStateOnJoin: true });
    assert.equal(h.engine.acquisition, 'fought', 'guarded forever');
    assert.equal(h.lastHb().acquiring, undefined, 'held the room\'s plays for good');
    assert.equal(h.lastHb().suspended, true);
    assert.deepEqual(h.kinds(), [], 'seeded from a player the site is still moving');
  });

  it('seeds the room when the member takes the player back', async () => {
    const h = await restless({ adoptLocalStateOnJoin: true });
    h.g.press();
    h.player.positionS = 700;
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.equal(h.engine.acquisition, 'steady');
    assert.deepEqual(h.kinds(), ['seek']);
    assert.ok(Math.abs(h.cmds()[0]!.positionMs - 700_000) < 1000, `seeded at ${h.cmds()[0]!.positionMs}`);
  });

  it('sends the member\'s press when somebody else moved the room meanwhile', async () => {
    // No seed will be sent over the other member's move, so nothing else
    // carries the press.
    for (const adopt of [true, false]) {
      const h = await restless(adopt ? { adoptLocalStateOnJoin: true } : {});
      assert.equal(h.engine.acquisition, 'fought');
      await h.state({ positionMs: 50_000, paused: false }, 'play');
      h.g.press();
      h.player.positionS = 300;
      h.player.emit('seeked');
      await h.vt.advance(50);
      assert.equal(h.engine.acquisition, 'steady');
      assert.deepEqual(h.kinds(), ['seek'], `adopt=${adopt}: the press never reached the room`);
      assert.ok(Math.abs(h.cmds()[0]!.positionMs - 300_000) < 1000, `sent ${h.cmds()[0]!.positionMs}`);
    }
  });

  it('control: a joiner under the same site reaches the bound too', async () => {
    const h = await restless({});
    assert.equal(h.engine.acquisition, 'fought');
  });

  it('control: a site that moves it a few times, then stops, is still absorbed and seeded', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 2);
    for (let i = 0; i < DEFAULT_ENGINE_CONFIG.maxReconforms; i++) {
      h.player.positionS = 800 + i;
      h.player.emit('seeked');
      await h.vt.advance(300);
    }
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.deepEqual(h.kinds(), ['seek']);
  });
});

describe('a creator of a room with no media, who then names it', () => {
  it('seeds from its own player even though the room was moved while it named nothing', async () => {
    const h = harness({ player: { paused: false, positionS: 42 }, cfg: { adoptLocalStateOnJoin: true, mediaKey: '' } });
    await h.join({ mediaKey: '' }, 2);
    // Another member's command, while nobody's media is named.
    await h.state({ mediaKey: '', positionMs: 0, paused: true }, 'pause');
    assert.deepEqual(h.kinds(), []);
    h.engine.setLocalMediaKey(KEY);
    await h.vt.advance(200);
    const naming = h.cmds();
    assert.deepEqual(naming.map((c) => c.kind), ['media']);
    await h.ack(naming[0]!, { positionMs: naming[0]!.positionMs, paused: true });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 500);
    assert.deepEqual(h.kinds(), ['media', 'seek', 'play'], 'the namer took an old move for one against its naming');
    assert.equal(h.player.paused, false);
  });
});

describe('an element with no finite duration (a live stream)', () => {
  // Html5Adapter reports an Infinity or NaN duration as 0; past HAVE_METADATA
  // it is Infinity, not unknown.
  it('is acquired, and follows the room', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 0 } });
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.equal(h.engine.acquisition, 'steady');
    assert.equal(h.lastHb().acquiring, undefined, 'held every play of the room for good');
    await h.state({ positionMs: 30_000, paused: false }, 'play');
    await h.vt.advance(500);
    assert.equal(h.player.paused, false, 'the room\'s play was never applied');
    assert.equal(h.engine.stats.skippedAcquiring, 0);
  });

  it('names a room that names nothing', async () => {
    const h = harness({ player: { paused: false, positionS: 42, durationS: 0 } });
    await h.join({ mediaKey: '' }, 2);
    assert.deepEqual(h.kinds(), ['media']);
  });

  it('control: an element with no metadata yet is still waited for', async () => {
    const h = harness({ player: { paused: true, positionS: 0, durationS: 0 } });
    h.player.readyState = 0;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.equal(h.engine.acquisition, 'detached');
    assert.equal(h.lastHb().acquiring, true);
  });
});

describe('a creator moved by somebody else, then pressed', () => {
  it('while still loading: the press is sent', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    h.player.readyState = 1;
    await h.join({}, 2);
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    assert.equal(h.engine.acquisition, 'detached');
    h.g.press();
    h.player.positionS = 300;
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.deepEqual(h.kinds(), ['seek'], 'the press was dropped');
    assert.ok(Math.abs(h.cmds()[0]!.positionMs - 300_000) < 1000, `sent ${h.cmds()[0]!.positionMs}`);
  });

  it('while guarded: the press is sent, and the player is not put back over it', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 2);
    assert.equal(h.engine.acquisition, 'guarded');
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    h.g.press();
    h.player.positionS = 300;
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.equal(h.engine.acquisition, 'steady');
    assert.deepEqual(h.kinds(), ['seek'], 'the press was dropped');
    assert.ok(Math.abs(h.player.positionS - 300) < 0.3, `put back to ${h.player.positionS}`);
  });

  it('control: with nobody else moving the room, the press is carried by the seed', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 2);
    h.g.press();
    h.player.positionS = 300;
    h.player.emit('seeked');
    await h.vt.advance(50);
    assert.deepEqual(h.kinds(), ['seek']);
    assert.ok(Math.abs(h.cmds()[0]!.positionMs - 300_000) < 1000, `seeded at ${h.cmds()[0]!.positionMs}`);
  });
});

describe('the creator, moved while still loading', () => {
  it('conforms at once rather than waiting out a seed it will not send', async () => {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    h.player.readyState = 1;
    await h.join({}, 2);
    await h.state({ positionMs: 50_000, paused: true }, 'seek');
    h.player.positionS = 813;
    h.player.readyState = 4;
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs / 2);
    assert.ok(Math.abs(h.player.positionS - 50) < 0.3, `still at ${h.player.positionS}`);
    assert.equal(h.lastHb().acquiring, undefined, 'held the room as if it were about to seed it');
  });
});

describe('a namer that lost the race', () => {
  it('holds its own play for the room at once, with no naming of its own on the way', async () => {
    const h = harness({ player: { paused: true, positionS: 42 } });
    await h.join({ mediaKey: '' }, 2);
    assert.deepEqual(h.kinds(), ['media']);
    await h.state({ mediaKey: KEY, positionMs: 100_000, paused: true }, 'media');
    h.tr.deliver({ t: 'error', code: 'media_stale', msg: 'x' });
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.equal(h.engine.acquisition, 'steady');
    assert.ok(Math.abs(h.player.positionS - 100) < 0.3, `at ${h.player.positionS}`);
    // The member presses play, well inside OWN_ACK_WAIT_MS of the refused naming.
    h.g.press();
    h.player.paused = false;
    h.player.emit('play');
    await h.vt.advance(100);
    assert.deepEqual(h.kinds(), ['media', 'play']);
    assert.equal(h.player.paused, true, 'the play ran ahead of the room: a refused naming still counted as ours');
  });
});

describe('a hidden tab on the room\'s media', () => {
  it('whose media has not loaded is absent, so the room does not wait for it', async () => {
    // Media does not load in a hidden tab at all (BROWSER-FINDINGS §5b): an
    // invite opened in a background tab sits at readyState 0 until shown.
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.tab.hidden = true;
    h.player.readyState = 0;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(3000);
    assert.equal(h.engine.acquisition, 'detached');
    assert.equal(h.lastHb().acquiring, undefined);
    assert.equal(h.lastHb().suspended, true, 'judged present at readyState 0: the room gates every play on it');
    // Shown, it is on its way again.
    h.tab.hidden = false;
    await h.vt.advance(1100);
    assert.equal(h.lastHb().acquiring, true);
    assert.equal(h.lastHb().suspended, false);
  });

  it('control: the same member in a visible tab is acquiring, not absent', async () => {
    const h = harness({ player: { paused: true, positionS: 0 } });
    h.player.readyState = 0;
    await h.join({ positionMs: 30_000, atServerMs: OFFSET, paused: true });
    await h.vt.advance(3000);
    assert.equal(h.lastHb().acquiring, true);
    assert.equal(h.lastHb().suspended, false);
  });

  async function hiddenSeeder() {
    const h = harness({ player: { paused: true, positionS: 0 }, cfg: { adoptLocalStateOnJoin: true } });
    await h.join({}, 1);
    h.player.positionS = 813; // the site's resume, then its autoplay
    h.player.emit('seeked');
    await h.siteAutoplay();
    assert.equal(h.engine.acquisition, 'guarded');
    assert.equal(h.lastHb().acquiring, true);
    await h.vt.advance(100);
    h.tab.hidden = true; // the creator switches tabs to paste the invite
    await h.vt.advance(150);
    return h;
  }

  it('that is still to seed the room is absent, and not corrected to the placeholder', async () => {
    const h = await hiddenSeeder();
    assert.equal(h.lastHb().acquiring, undefined);
    assert.equal(h.lastHb().suspended, true, 'judged against paused@0');
    // A judgement the server made on an earlier report, arriving now.
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.serverNow() });
    await h.vt.advance(50);
    assert.ok(h.player.positionS > 800, `the seeder was moved to ${h.player.positionS}`);
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.deepEqual(h.kinds(), ['seek', 'play']);
    assert.ok(Math.abs(h.cmds()[0]!.positionMs - 813_000) < 2000, `seeded at ${h.cmds()[0]!.positionMs}`);
  });

  it('control: a correction reaches a seeder that has seeded', async () => {
    const h = await hiddenSeeder();
    await h.vt.advance(DEFAULT_ENGINE_CONFIG.settleMs + 200);
    assert.equal(h.engine.acquisition, 'steady');
    const seeks = h.player.seeks;
    h.tr.deliver({ t: 'correct', mode: 'seek', when: h.serverNow() });
    await h.vt.advance(50);
    assert.equal(h.player.seeks, seeks + 1);
  });
});
