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
}

function harness(o: Opts = {}) {
  const vt = new VirtualTime();
  const player = new FakePlayer(vt, { durationS: 1400, ...o.player });
  const tr = new FakeTransport();
  const g = new FakeGestures(vt);
  const acq: string[] = [];
  const errors: string[] = [];
  const engine = new SyncEngine({
    adapter: o.adapter ? o.adapter(player) : player,
    transport: tr, now: () => vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, isHidden: () => false,
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
    vt, player, tr, engine, g, acq, errors,
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
  async function finishThenNavigate(o: Opts & { ended?: boolean; to?: string } = {}) {
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
