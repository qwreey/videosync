/**
 * The seam between the sync engine and whatever is playing the video.
 *
 * Shape derived from the three reference interfaces (VideoTogether's
 * `VideoWrapper`, watchparty's `Player`, cytube's `player/base`) plus two
 * constraints that came out of measurement rather than from any of them:
 *
 *  - Seeking outside the MSE buffered range does not throw. It stalls into
 *    `waiting` until the data arrives, so `seekTo` must be async and resolve on
 *    `seeked` -- never assumed complete.
 *  - `play()` rejects with `NotAllowedError` when the tab holds no user-gesture
 *    credit, and nothing exposes the Media Engagement Index, so the only
 *    correct handling is a typed error plus a gesture-capture overlay.
 */

/** What a given provider's player can actually be asked to do. */
export interface AdapterCapabilities {
  /** Writing `currentTime` works. False for players that fight a raw DOM seek. */
  readonly supportsDirectSeek: boolean;
  /** `play()`/`pause()` on the element work, rather than needing an internal API. */
  readonly supportsDirectPlayPause: boolean;
  /**
   * `playbackRate` can be nudged without the player resetting it or the audio
   * desyncing. The servo correction law leans on this heavily, so a provider
   * that lacks it must fall back to seek-only correction.
   */
  readonly supportsPlaybackRateNudge: boolean;
  /** The adapter can tell us an ad is playing, so we can stop judging position. */
  readonly supportsAdDetection: boolean;
  /**
   * The underlying element is replaced on navigation (YouTube's SPA router
   * does this), so it must be re-resolved rather than cached.
   */
  readonly volatileVideoElement: boolean;
}

/** Raised when playback was refused for lack of a user gesture. */
export class AutoplayBlockedError extends Error {
  override readonly name = 'AutoplayBlockedError';
  constructor(cause?: unknown) {
    super('play() was refused: no user-gesture credit and no way to query the Media Engagement Index');
    this.cause = cause;
  }
}

/** A buffered range in seconds. */
export interface BufferedRange {
  readonly start: number;
  readonly end: number;
}

/** Everything the detector needs to observe, sampled together. */
export interface PlayerState {
  /** Seconds. */
  readonly positionS: number;
  readonly paused: boolean;
  readonly rate: number;
  readonly readyState: number;
  readonly muted: boolean;
  /**
   * Whether the media carries sound at all. Undefined where the browser does
   * not say. Unmuted playback of silent media is still "never audible" to the
   * background-pause rule, so the detector needs this besides `muted`.
   */
  readonly hasAudio?: boolean | undefined;
  readonly durationS: number;
  readonly buffered: readonly BufferedRange[];
  /** Seconds of contiguous buffer ahead of the current position. */
  readonly bufferedAheadS: number;
  /** Seconds of contiguous buffer behind it -- a backward seek into this is free. */
  readonly bufferedBehindS: number;
}

export type AdapterEvent =
  | 'play' | 'pause' | 'seeked' | 'seeking' | 'ratechange'
  | 'waiting' | 'playing' | 'stalled' | 'timeupdate'
  /** The underlying element was swapped out; every cached reference is stale. */
  | 'elementreplaced';

export interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;

  /** Snapshot of everything the detector reads. Must be cheap: called at ~10 Hz. */
  readState(): PlayerState;

  /** Resolves when the browser confirms the seek via `seeked`, or rejects on timeout. */
  seekTo(positionS: number, timeoutMs?: number): Promise<void>;
  /** @throws AutoplayBlockedError when refused for lack of a gesture. */
  play(): Promise<void>;
  pause(): Promise<void>;
  setRate(rate: number): void;

  on(event: AdapterEvent, fn: () => void): () => void;
  destroy(): void;
}
