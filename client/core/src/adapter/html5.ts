import type {
  AdapterCapabilities, AdapterEvent, BufferedRange, PlayerState, ProviderAdapter,
} from './types.ts';
import { AutoplayBlockedError } from './types.ts';

const DOM_EVENTS: readonly AdapterEvent[] = [
  'play', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'playing', 'stalled', 'timeupdate',
];

/**
 * The generic adapter: a plain HTML5 `<video>`.
 *
 * This is the fallback every provider gets, and for Laftel it is expected to be
 * the whole story. Per-provider adapters override only what they must.
 */
export class Html5Adapter implements ProviderAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities = {
    supportsDirectSeek: true,
    supportsDirectPlayPause: true,
    supportsPlaybackRateNudge: true,
    supportsAdDetection: false,
    volatileVideoElement: false,
  };

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private readonly domHandlers: Array<[string, EventListener]> = [];

  private readonly el: HTMLVideoElement;

  constructor(el: HTMLVideoElement, id = 'html5') {
    this.el = el;
    this.id = id;
    for (const type of DOM_EVENTS) {
      const h: EventListener = () => this.emit(type);
      this.el.addEventListener(type, h);
      this.domHandlers.push([type, h]);
    }
  }

  private emit(event: AdapterEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  on(event: AdapterEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  readState(): PlayerState {
    const t = this.el.currentTime;
    const buffered: BufferedRange[] = [];
    let aheadS = 0;
    let behindS = 0;
    for (let i = 0; i < this.el.buffered.length; i++) {
      const start = this.el.buffered.start(i);
      const end = this.el.buffered.end(i);
      buffered.push({ start, end });
      if (start <= t && t <= end) { aheadS = end - t; behindS = t - start; }
    }
    return {
      positionS: t,
      paused: this.el.paused,
      rate: this.el.playbackRate,
      readyState: this.el.readyState,
      muted: this.el.muted || this.el.volume === 0,
      durationS: Number.isFinite(this.el.duration) ? this.el.duration : 0,
      buffered,
      bufferedAheadS: aheadS,
      bufferedBehindS: behindS,
    };
  }

  /**
   * Resolves on `seeked`, not on assignment. Seeking outside the buffered range
   * does not throw -- it stalls into `waiting` until data arrives -- so a
   * caller that assumes completion is wrong exactly when it matters most.
   */
  seekTo(positionS: number, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const done = () => {
        this.el.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      this.el.addEventListener('seeked', done, { once: true });
      timer = setTimeout(() => {
        this.el.removeEventListener('seeked', done);
        reject(new Error(`seek to ${positionS}s did not complete within ${timeoutMs}ms`));
      }, timeoutMs) as unknown as number;
      this.el.currentTime = positionS;
    });
  }

  async play(): Promise<void> {
    try {
      await this.el.play();
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') throw new AutoplayBlockedError(e);
      throw e;
    }
  }

  async pause(): Promise<void> { this.el.pause(); }

  setRate(rate: number): void { this.el.playbackRate = rate; }

  destroy(): void {
    for (const [type, h] of this.domHandlers) this.el.removeEventListener(type, h);
    this.domHandlers.length = 0;
    this.listeners.clear();
  }
}
