import type {
  AdapterCapabilities, AdapterEvent, BufferedRange, PlayerState, ProviderAdapter,
} from './types.ts';
import { AutoplayBlockedError } from './types.ts';
import type { CapabilityMask, SeekHints } from '../providers/descriptor.ts';

const DOM_EVENTS: readonly AdapterEvent[] = [
  'play', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'playing', 'stalled', 'timeupdate',
  'emptied', 'loadstart',
];

/** What a provider descriptor may tune on this adapter. */
export interface Html5Options {
  /**
   * Restrict-only: `false` turns a capability off, `true` changes nothing.
   * A descriptor someone else wrote must never promise a player more than
   * this code can do (a direct seek crashes some players outright).
   */
  capabilities?: CapabilityMask;
  seek?: Pick<SeekHints, 'landingToleranceS' | 'timeoutMs'>;
}

const BASE_CAPABILITIES: AdapterCapabilities = {
  supportsDirectSeek: true,
  supportsDirectPlayPause: true,
  supportsPlaybackRateNudge: true,
  supportsAdDetection: false,
  volatileVideoElement: false,
};

/**
 * The generic adapter: a plain HTML5 `<video>`.
 *
 * This is the fallback every provider gets, and for Laftel it is expected to be
 * the whole story. Per-provider adapters override only what they must.
 */
export class Html5Adapter implements ProviderAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private readonly domHandlers: Array<[string, EventListener]> = [];
  /** Seeks still waiting for `seeked`; calling one rejects and cleans it up. */
  private readonly pendingSeeks = new Set<() => void>();
  private destroyed = false;

  private readonly el: HTMLVideoElement;
  private readonly seekTimeoutMs: number;
  /** How far from the target a `seeked` may land and still be ours. */
  private readonly landingToleranceS: number;

  constructor(el: HTMLVideoElement, id = 'html5', opts: Html5Options = {}) {
    this.el = el;
    this.id = id;
    const m = opts.capabilities ?? {};
    this.capabilities = {
      ...BASE_CAPABILITIES,
      supportsDirectSeek: BASE_CAPABILITIES.supportsDirectSeek && m.directSeek !== false,
      supportsPlaybackRateNudge: BASE_CAPABILITIES.supportsPlaybackRateNudge && m.playbackRateNudge !== false,
    };
    this.seekTimeoutMs = opts.seek?.timeoutMs ?? 10_000;
    this.landingToleranceS = opts.seek?.landingToleranceS ?? 0.5;
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
      hasAudio: this.hasAudio(),
      durationS: Number.isFinite(this.el.duration) ? this.el.duration : 0,
      buffered,
      bufferedAheadS: aheadS,
      bufferedBehindS: behindS,
      ended: this.el.ended,
    };
  }

  /**
   * Whether the media has an audio track, from whichever non-standard signal
   * this browser exposes; undefined when there is none to read.
   *
   * Unknown is the safe answer: the detector counts it as sound, and calling
   * sound silent would read a real media-key pause in a hidden tab as the
   * browser's suspension (see `SeekDetector`). So only an answer the signal
   * can actually support is given:
   *  - Firefox's `mozHasAudio` and `audioTracks` say false before metadata
   *    has loaded, which is not knowledge;
   *  - Chrome exposes only decode counters, so "no audio" there means
   *    pictures have been decoded and sound has not. That is only trusted for
   *    clear media. Protected media can be decoded outside the renderer (a
   *    decrypt-and-decode CDM, hardware-secure playback), where nothing says
   *    the audio counter is kept -- and Laftel, the main target, is
   *    protected. Positive evidence of sound is trusted either way. None of
   *    this is measured beyond clear media (BROWSER-FINDINGS §5).
   */
  private hasAudio(): boolean | undefined {
    const el = this.el as HTMLVideoElement & {
      mozHasAudio?: boolean;
      audioTracks?: { length: number };
      webkitAudioDecodedByteCount?: number;
      webkitVideoDecodedByteCount?: number;
    };
    const haveMetadata = el.readyState >= 1;
    if (typeof el.mozHasAudio === 'boolean') return haveMetadata ? el.mozHasAudio : undefined;
    if (el.audioTracks && typeof el.audioTracks.length === 'number') {
      return haveMetadata ? el.audioTracks.length > 0 : undefined;
    }
    const audio = el.webkitAudioDecodedByteCount;
    const video = el.webkitVideoDecodedByteCount;
    if (typeof audio === 'number' && audio > 0) return true;
    const clear = el.mediaKeys == null;
    if (clear && typeof audio === 'number' && typeof video === 'number' && video > 0) return false;
    return undefined;
  }

  /**
   * Resolves on `seeked`, not on assignment. Seeking outside the buffered range
   * does not throw -- it stalls into `waiting` until data arrives -- so a
   * caller that assumes completion is wrong exactly when it matters most.
   */
  seekTo(positionS: number, timeoutMs = this.seekTimeoutMs): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('seek on a destroyed adapter'));
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const settle = (err: Error | null) => {
        this.el.removeEventListener('seeked', done);
        clearTimeout(timer);
        this.pendingSeeks.delete(abandon);
        if (err) reject(err); else resolve();
      };
      const done = () => {
        // A `seeked` from somebody else -- the user dragging the scrubber, or
        // the site's own player -- must not resolve OUR seek. Two promises
        // resolving on one event is how a superseded transition finishes after
        // the one that replaced it.
        //
        // Compared against where the browser actually puts us: per spec a
        // target past the end lands on the duration, one before the start on
        // 0. Against the raw target that `seeked` never matches, and the whole
        // apply queue waits out the timeout behind it.
        const d = this.el.duration;
        const lands = Number.isFinite(d) && d > 0
          ? Math.min(Math.max(positionS, 0), d)
          : Math.max(positionS, 0);
        if (Math.abs(this.el.currentTime - lands) > this.landingToleranceS) return;
        settle(null);
      };
      // The adapter is being let go of -- the page replaced the element, and
      // the old one may never report this seek. The engine's apply queue is
      // waiting on it and must not wait out the timeout for an element nobody
      // is watching any more.
      const abandon = () => { settle(new Error(`seek to ${positionS}s abandoned: element replaced`)); };
      this.pendingSeeks.add(abandon);
      this.el.addEventListener('seeked', done);
      timer = setTimeout(() => {
        settle(new Error(`seek to ${positionS}s did not complete within ${timeoutMs}ms`));
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
    this.destroyed = true;
    for (const abandon of [...this.pendingSeeks]) abandon();
    for (const [type, h] of this.domHandlers) this.el.removeEventListener(type, h);
    this.domHandlers.length = 0;
    this.listeners.clear();
  }
}
