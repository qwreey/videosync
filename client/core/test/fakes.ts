/**
 * Test doubles for the engine: a virtual clock, a scripted transport, and a
 * player that behaves like a `<video>` without being one.
 *
 * The engine takes every time-shaped dependency by injection precisely so this
 * file can exist -- the whole protocol client is exercised with no browser, no
 * network and no real time.
 */
import type {
  AdapterCapabilities, AdapterEvent, PlayerState, ProviderAdapter,
} from '../src/adapter/types.ts';
import { AutoplayBlockedError } from '../src/adapter/types.ts';
import type { ClientFrame, ServerFrame } from '../src/engine/protocol.ts';
import type { Transport, TransportHandlers } from '../src/engine/transport.ts';

/** Deterministic virtual time. `advance` also flushes the microtask queue, so
 *  the engine's async apply paths complete before the next assertion. */
export class VirtualTime {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };

  clearTimer = (id: number): void => { this.timers.delete(id); };

  /** Run every timer due in the next `ms`, in time order. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let soonest: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) {
        if (e[1].at <= end && (soonest === null || e[1].at < soonest[1].at)) soonest = e;
      }
      if (!soonest) break;
      this.timers.delete(soonest[0]);
      this.now = soonest[1].at;
      soonest[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** Drain the microtask queue. */
export function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

export class FakeTransport implements Transport {
  readonly sent: ClientFrame[] = [];
  handlers: TransportHandlers | null = null;
  connects = 0;
  closed = false;

  connect(h: TransportHandlers): void {
    this.handlers = h;
    this.connects++;
    this.closed = false;
  }

  /** When set, a `time` probe is answered in the same instant, so the sample
   *  has a true zero RTT and the offset comes out exact. */
  private timeOffset: number | null = null;

  send(f: ClientFrame): void {
    this.sent.push(f);
    if (f.t === 'time' && this.timeOffset !== null) {
      const o = this.timeOffset;
      this.handlers?.onFrame({ t: 'time.reply', t0: f.t0, tRecv: f.t0 + o, tSend: f.t0 + o });
    }
  }

  /** Behave like a server whose clock is `offsetMs` ahead and which is
   *  infinitely close by. Real latency is the e2e test's job. `null` stops
   *  answering. */
  autoAnswerTime(offsetMs: number | null): void { this.timeOffset = offsetMs; }
  close(): void { this.closed = true; }

  /** Pretend the socket opened. */
  open(): void { this.handlers?.onOpen(); }
  /** Deliver a server frame. */
  deliver(f: ServerFrame): void { this.handlers?.onFrame(f); }
  /** Drop the connection the way a network failure would. */
  drop(reason = 'test'): void { this.handlers?.onClose(false, reason); }

  sentOf<K extends ClientFrame['t']>(t: K): Array<Extract<ClientFrame, { t: K }>> {
    return this.sent.filter((f) => f.t === t) as Array<Extract<ClientFrame, { t: K }>>;
  }
}

export interface FakePlayerOptions {
  positionS?: number;
  paused?: boolean;
  /** Refuse play() the way a tab with no gesture credit does. */
  autoplayBlocked?: boolean;
  /** A seek that never completes, as an out-of-buffer seek can. */
  seekHangs?: boolean;
  capabilities?: Partial<AdapterCapabilities>;
  durationS?: number;
}

/** Anything that can say what time it is. VirtualTime satisfies it, and so
 *  does a real-time source -- the same FakePlayer therefore serves both the
 *  unit tests and the end-to-end run against a real server. */
export interface NowSource { readonly now: number }

/** Wall-clock source for the end-to-end test. */
export const realTime: NowSource = { get now() { return performance.now(); } };

/** A `<video>`-shaped object driven by a NowSource. */
export class FakePlayer implements ProviderAdapter {
  readonly id = 'fake';
  readonly capabilities: AdapterCapabilities;

  positionS: number;
  paused: boolean;
  rate = 1;
  readyState = 4;
  muted = false;
  /** The element reached its end, as `HTMLMediaElement.ended`. */
  ended = false;
  durationS: number;
  bufferedAheadS = 30;
  bufferedBehindS = 30;
  autoplayBlocked: boolean;
  seekHangs: boolean;

  seeks = 0;
  plays = 0;
  pauses = 0;
  rateSets: number[] = [];

  private readonly vt: NowSource;
  private lastAdvanceAt: number;
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();

  constructor(vt: NowSource, o: FakePlayerOptions = {}) {
    this.vt = vt;
    this.positionS = o.positionS ?? 0;
    this.paused = o.paused ?? true;
    this.autoplayBlocked = o.autoplayBlocked ?? false;
    this.seekHangs = o.seekHangs ?? false;
    this.durationS = o.durationS ?? 7200;
    this.lastAdvanceAt = vt.now;
    this.capabilities = {
      supportsDirectSeek: true,
      supportsDirectPlayPause: true,
      supportsPlaybackRateNudge: true,
      supportsAdDetection: false,
      volatileVideoElement: false,
      ...o.capabilities,
    };
  }

  /** Advance playback to the current virtual instant. Called by readState, so
   *  the player moves whether or not anybody is watching it. */
  private settle(): void {
    const dt = this.vt.now - this.lastAdvanceAt;
    this.lastAdvanceAt = this.vt.now;
    if (!this.paused && this.readyState >= 3 && dt > 0) {
      this.positionS += (dt / 1000) * this.rate;
    }
  }

  readState(): PlayerState {
    this.settle();
    return {
      positionS: this.positionS,
      paused: this.paused,
      rate: this.rate,
      readyState: this.readyState,
      muted: this.muted,
      durationS: this.durationS,
      buffered: [{ start: Math.max(0, this.positionS - this.bufferedBehindS), end: this.positionS + this.bufferedAheadS }],
      bufferedAheadS: this.bufferedAheadS,
      bufferedBehindS: this.bufferedBehindS,
      ended: this.ended,
    };
  }

  async seekTo(positionS: number): Promise<void> {
    this.settle();
    this.seeks++;
    if (this.seekHangs) return new Promise<void>(() => { /* never resolves */ });
    this.positionS = positionS;
    return Promise.resolve();
  }

  async play(): Promise<void> {
    this.settle();
    if (this.autoplayBlocked) throw new AutoplayBlockedError();
    this.plays++;
    this.paused = false;
  }

  async pause(): Promise<void> {
    this.settle();
    this.pauses++;
    this.paused = true;
  }

  setRate(rate: number): void { this.settle(); this.rate = rate; this.rateSets.push(rate); }

  on(event: AdapterEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  destroy(): void { this.listeners.clear(); }

  /** Fire an adapter event, as the DOM would. */
  emit(event: AdapterEvent): void { for (const fn of this.listeners.get(event) ?? []) fn(); }

  /** Simulate a buffering stall: paused stays false, readyState drops. */
  stall(): void { this.settle(); this.readyState = 2; this.bufferedAheadS = 0; }
  recover(): void { this.settle(); this.readyState = 4; this.bufferedAheadS = 30; }
}
