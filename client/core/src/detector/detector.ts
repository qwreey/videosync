import type { PlayerState } from '../adapter/types.ts';
import type { DetectorConfig, DetectorReport, Observation } from './types.ts';
import { DEFAULT_DETECTOR_CONFIG } from './types.ts';

interface Sample { readonly t: number; readonly res: number }

/**
 * Decides whether what just happened to the local player is user intent worth
 * telling the room about.
 *
 * Every rule here is here because something measurable went wrong without it:
 *
 *  - **Two-diff test.** A jump is a user seek only if it is a jump relative to
 *    where we last were AND relative to where the room says we should be. The
 *    AND is echo suppression built into detection: a correction the server just
 *    applied makes the first diff large and the second ~0, so it is never
 *    rebroadcast. Unlike an ignore-flag it has no timeout and cannot get stuck
 *    (syncwatch's global flag does, silently, forever).
 *
 *  - **Stall guard.** A buffering player reports `paused === false` with a
 *    frozen `currentTime`, so a detector that dead-reckons reads it as a
 *    backward seek and drags the whole room back. Measured on a real MSE
 *    player: `readyState` 4 -> 2, buffer draining, `waiting` fired. syncplay
 *    ships without this guard.
 *
 *  - **Suspension guard.** Chrome pauses a *muted, hidden* tab and fires a real
 *    `pause`. Broadcast naively, one member switching tabs pauses the room --
 *    and resumes it on return. `document.hidden` alone is not enough to detect
 *    this: media keys deliver genuine user pauses to hidden tabs, so the
 *    `muted` conjunct is what separates the browser's power saving from intent.
 */
export class SeekDetector {
  private readonly cfg: DetectorConfig;
  private lastKnownPos = 0;
  private haveLastKnown = false;
  private lastEvalPos = 0;
  private haveEvalPos = false;
  private stallSuspected = false;
  private suspended = false;
  private lastPaused: boolean | null = null;
  private history: Sample[] = [];

  /** Counters for diagnostics and for the browser probe's assertions. */
  seekDetections = 0;
  stallDetections = 0;
  suspensions = 0;
  /** Any increase here is a bug: a stall or suspension read as user intent. */
  falsePositives = 0;

  /** Returns true when the document is hidden. Injected so it is testable. */
  private readonly isHidden: () => boolean;

  constructor(isHidden: () => boolean, cfg: Partial<DetectorConfig> = {}) {
    this.isHidden = isHidden;
    this.cfg = { ...DEFAULT_DETECTOR_CONFIG, ...cfg };
  }

  /**
   * @param s          fresh player state
   * @param expectedMs where the room says we should be, at our best estimate of
   *                   server time. Null before the clock has settled -- with no
   *                   room reference the two-diff test cannot run, so nothing
   *                   is reported.
   * @param nowMs      monotonic local time
   */
  evaluate(s: PlayerState, expectedMs: number | null, nowMs: number): {
    observation: Observation;
    report: DetectorReport | null;
  } {
    const posMs = s.positionS * 1000;

    // --- suspension: the browser paused us, we did not ---------------------
    const wasSuspended = this.suspended;
    this.suspended = s.paused && s.muted && this.isHidden() && s.readyState >= this.cfg.minReadyState;
    if (this.suspended) {
      if (!wasSuspended) this.suspensions++;
      this.lastKnownPos = posMs;
      this.lastEvalPos = posMs;
      this.lastPaused = s.paused;
      this.history = [];
      return { observation: { kind: 'suspended' }, report: this.buildReport(s, posMs, 0, 0) };
    }
    if (wasSuspended) {
      // Coming back: the browser will fire `play`. Not user intent either.
      this.lastPaused = s.paused;
      this.lastKnownPos = posMs;
      this.haveLastKnown = true;
      this.history = [];
    }

    // --- stall inference ---------------------------------------------------
    const frozen =
      this.haveEvalPos && !s.paused &&
      posMs - this.lastEvalPos < this.cfg.evalIntervalMs * 0.5;
    const wasStalled = this.stallSuspected;
    this.stallSuspected = s.readyState < this.cfg.minReadyState || frozen;
    this.lastEvalPos = posMs;
    this.haveEvalPos = true;

    if (!this.haveLastKnown) {
      this.lastKnownPos = posMs;
      this.haveLastKnown = true;
    }

    let observation: Observation = { kind: 'idle' };

    if (this.stallSuspected) {
      // Frozen playback is not a seek. Hold the reference so the gap cannot
      // accumulate into a false positive; the readiness gate handles the rest.
      this.lastKnownPos = posMs;
      this.stallDetections++;
      observation = { kind: 'stall' };
    } else {
      if (wasStalled) {
        this.lastKnownPos = posMs; // just resumed: re-baseline, do not judge the gap
      } else if (!s.paused) {
        this.lastKnownPos += this.cfg.evalIntervalMs * s.rate;
      }

      const playerDiff = Math.abs(posMs - this.lastKnownPos);
      const roomDiff = expectedMs === null ? Infinity : Math.abs(posMs - expectedMs);
      if (
        expectedMs !== null &&
        playerDiff > this.cfg.seekThresholdMs &&
        roomDiff > this.cfg.seekThresholdMs
      ) {
        this.seekDetections++;
        this.lastKnownPos = posMs;
        observation = { kind: 'seek', positionS: s.positionS };
      } else if (this.lastPaused !== null && this.lastPaused !== s.paused) {
        observation = { kind: 'playstate', paused: s.paused, positionS: s.positionS };
      }
      this.lastPaused = s.paused;
    }

    // --- residual and slope ------------------------------------------------
    if (expectedMs === null) return { observation, report: null };
    const res = posMs - expectedMs;
    this.history.push({ t: nowMs, res });
    const cut = nowMs - this.cfg.slopeWindowMs;
    while (this.history.length > 0 && this.history[0]!.t < cut) this.history.shift();

    const report = this.buildReport(s, posMs, res, this.slope());
    return { observation, report };
  }

  /** Call when the room applied a correction, so we do not judge our own jump. */
  rebaseline(positionS: number): void {
    this.lastKnownPos = positionS * 1000;
    this.lastEvalPos = this.lastKnownPos;
    this.haveLastKnown = true;
    this.history = [];
  }

  /**
   * d(residual)/dt in ms/s. Computed locally at high frequency with zero
   * network noise -- the server must never try to differentiate 1 Hz reports.
   */
  private slope(): number {
    const n = this.history.length;
    if (n < 3) return 0;
    const t0 = this.history[0]!.t;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const s of this.history) {
      const x = (s.t - t0) / 1000;
      sx += x; sy += s.res; sxx += x * x; sxy += x * s.res;
    }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return 0;
    return (n * sxy - sx * sy) / den;
  }

  private buildReport(s: PlayerState, posMs: number, res: number, slope: number): DetectorReport {
    return {
      residualMs: res,
      slopeMsPerS: slope,
      positionMs: posMs,
      paused: s.paused,
      readyState: s.readyState,
      bufferedAheadS: s.bufferedAheadS,
      bufferedBehindS: s.bufferedBehindS,
      suspended: this.suspended,
    };
  }

  /** Should this observation reach the wire at all? */
  static isUserIntent(o: Observation): boolean {
    return o.kind === 'seek' || o.kind === 'playstate';
  }
}
