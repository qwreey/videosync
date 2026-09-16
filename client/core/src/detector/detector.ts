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
 *  - **Suspension guard.** Chrome pauses a hidden tab's video and fires a real
 *    `pause` -- but only when that playback has **never been audible**. Measured
 *    across four conditions: muted-before-play pauses, no-audio-track pauses,
 *    audible-then-muted does NOT, audible-throughout does NOT. So the trigger is
 *    "never made a sound", not "muted right now". Broadcast naively, one member
 *    who started muted and switched tabs pauses the whole room -- and resumes it
 *    on return. `document.hidden` alone cannot be the test either: media keys
 *    deliver genuine user pauses to hidden tabs.
 */
export class SeekDetector {
  private readonly cfg: DetectorConfig;
  private lastKnownPos = 0;
  private haveLastKnown = false;
  private lastEvalPos = 0;
  private lastEvalAt = 0;
  private haveEvalPos = false;
  private stallSuspected = false;
  private suspended = false;
  /**
   * Whether this playback has ever actually produced sound. Chrome exempts a
   * tab that has from background pausing, permanently -- muting it afterwards
   * does not bring the exemption back down.
   */
  private everAudible = false;
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
    if (!s.paused && !s.muted) this.everAudible = true;
    const wasSuspended = this.suspended;
    // readyState 4 with a full buffer is what separates this from buffering,
    // where readyState drops below 3 and the buffer drains.
    this.suspended =
      s.paused && this.isHidden() && !this.everAudible &&
      s.readyState >= this.cfg.minReadyState;
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

    // How long since the last evaluation, measured rather than assumed.
    //
    // This used to be `cfg.evalIntervalMs`, which made every rule below depend
    // on the loop actually running at that rate. It does not: a hidden tab is
    // throttled, a busy page delays a timer, and a DOM event triggers an
    // evaluation off-cadence entirely. Dead-reckoning a full interval for a
    // partial one walks `lastKnownPos` away from the truth and eventually
    // manufactures a seek that never happened.
    const dt = this.haveEvalPos
      ? Math.max(0, Math.min(5000, nowMs - this.lastEvalAt))
      : this.cfg.evalIntervalMs;
    this.lastEvalAt = nowMs;

    // --- stall inference ---------------------------------------------------
    // A video sitting at its end has a frozen currentTime too. That is not a
    // stall and the room must not gate on it -- the member has finished.
    const ended = s.durationS > 0 && s.positionS >= s.durationS - 0.25;
    // "Moved less than half of what it should have" -- at the rate it is
    // playing at. Against wall time alone, anything at 0.5x or slower reads as
    // frozen on every sample, and a stall never reports a play-state change,
    // so a play pressed at 0.25x would never reach the room. And only if it
    // was running at the previous evaluation too: straight after a play, part
    // of `dt` was spent paused and says nothing about progress.
    const frozen =
      !ended && this.haveEvalPos && !s.paused && this.lastPaused === false && dt > 0 &&
      posMs - this.lastEvalPos < dt * s.rate * 0.5;
    const wasStalled = this.stallSuspected;
    // Whether the element was running between the previous evaluation and
    // this one, i.e. whether the reference has playback to catch up on.
    const wasPlaying = !wasStalled && this.lastPaused === false;
    this.stallSuspected = !ended && (s.readyState < this.cfg.minReadyState || frozen);
    this.lastEvalPos = posMs;
    this.haveEvalPos = true;

    if (!this.haveLastKnown) {
      this.lastKnownPos = posMs;
      this.haveLastKnown = true;
    }

    let observation: Observation = { kind: 'idle' };

    const roomDiff = expectedMs === null ? Infinity : Math.abs(posMs - expectedMs);
    const jumped = (playerDiff: number) =>
      expectedMs !== null && playerDiff > this.cfg.seekThresholdMs && roomDiff > this.cfg.seekThresholdMs;

    if (this.stallSuspected) {
      // Frozen playback is not a seek: while stalled the reference is held at
      // the frozen position, so no gap can accumulate into a false positive.
      //
      // But "unready" is not the same as "frozen". A seek drops readyState
      // itself -- ~100 ms at 1 on Laftel even inside the buffer, far longer on
      // YouTube outside it -- and the position has ALREADY moved when it
      // does. Re-baselining onto that position without looking absorbed the
      // jump, so the seek never reached the room and the room then corrected
      // the user straight back (BROWSER-FINDINGS §19). Compare against the
      // held reference first: a stall leaves it where it is, a seek does not.
      //
      // "Where it is" is a range, not a point, when the element was playing
      // up to here: it ran for some unknown part of `dt` before it froze. In
      // a throttled hidden tab that is a whole second or more, which alone
      // clears the threshold -- a stall read as a seek pulls the room back.
      // Only a position outside everything playback could have reached is a
      // jump. (Dead-reckoning all of `dt` instead would misread a stall that
      // began early in the interval as a backward seek.)
      const lo = this.lastKnownPos;
      const hi = wasPlaying ? lo + dt * Math.max(0, s.rate) : lo;
      if (jumped(posMs < lo ? lo - posMs : posMs > hi ? posMs - hi : 0)) {
        this.seekDetections++;
        observation = { kind: 'seek', positionS: s.positionS };
      } else {
        this.stallDetections++;
        observation = { kind: 'stall' };
      }
      this.lastKnownPos = posMs;
    } else {
      if (wasStalled) {
        this.lastKnownPos = posMs; // just resumed: re-baseline, do not judge the gap
      } else if (!s.paused) {
        this.lastKnownPos += dt * s.rate;
      }

      if (jumped(Math.abs(posMs - this.lastKnownPos))) {
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

  /**
   * Call after applying anything the room told us to do, so we do not judge our
   * own jump.
   *
   * `paused` matters as much as the position. The two-diff test makes a
   * server-driven *seek* structurally unbroadcastable, but a server-driven
   * *pause* has no such protection: the next evaluation would see
   * `lastPaused !== s.paused` and report user intent. Passing the new pause
   * state closes that hole structurally rather than leaving it to the
   * `applyingRemote` timeout flag, which is a backstop and must never be
   * load-bearing (syncwatch ships one and it deadlocks silently).
   */
  rebaseline(positionS: number, paused?: boolean): void {
    this.lastKnownPos = positionS * 1000;
    this.lastEvalPos = this.lastKnownPos;
    this.haveLastKnown = true;
    this.history = [];
    if (paused !== undefined) this.lastPaused = paused;
  }

  /** Forget everything measured against a connection that no longer exists. */
  reset(): void {
    this.haveLastKnown = false;
    this.haveEvalPos = false;
    this.lastEvalAt = 0;
    this.lastPaused = null;
    this.stallSuspected = false;
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
