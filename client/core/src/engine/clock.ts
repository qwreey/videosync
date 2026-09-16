/**
 * Server-clock estimation by min-RTT sampling.
 *
 * The estimate is deliberately paired with an honest error bound. With min-RTT
 * the offset error is bounded by +/- rtt/2, reached exactly when the path is
 * fully asymmetric -- and one-way asymmetry is undetectable in principle, no
 * matter how many samples are taken. A residual smaller than that bound is
 * indistinguishable from our own measurement error, so the correction logic
 * must be able to ask how much it is allowed to believe.
 */
export interface ClockSample {
  /** Client clock when the request was sent. */
  t0: number;
  /** Server clock when it received, and when it replied. */
  tRecv: number;
  tSend: number;
  /** Client clock when the reply arrived. */
  t1: number;
}

/**
 * Rounding allowance for the consistency test below: `t0` goes out as an
 * integer (the wire is int64) while `t1` is fractional.
 */
const CONSISTENCY_SLACK_MS = 1;

export class ServerClock {
  private offsetMs = 0;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private samples = 0;
  /** Samples that proved the kept estimate wrong. See `addSample`. */
  steps = 0;

  /**
   * @returns whether this sample was accepted: a new minimum RTT, or proof
   * that the offset itself has moved.
   *
   * A sample's offset is within rtt/2 of the truth whatever the path's
   * asymmetry, so two samples of the SAME offset can never be further apart
   * than the sum of their half-RTTs. Further apart than that, and the offset
   * has changed under us -- most often because `performance.now()` stood still
   * through a system suspend while the server's clock ran on. The minimum RTT
   * never improves just because the offset moved, so without this the stale
   * estimate survived for as long as the socket did: `when`s fired late by the
   * length of the sleep and every report was stamped with the wrong instant.
   * The test is exact rather than a tuned threshold, so path jitter cannot
   * trip it; slow drift does, eventually, which is also a real change.
   */
  addSample(s: ClockSample): boolean {
    const rtt = (s.t1 - s.t0) - (s.tSend - s.tRecv);
    this.samples++;
    if (rtt < 0) return false;
    const offset = ((s.tRecv - s.t0) + (s.tSend - s.t1)) / 2;
    const contradicts = Number.isFinite(this.bestRttMs) &&
      Math.abs(offset - this.offsetMs) > (rtt + this.bestRttMs) / 2 + CONSISTENCY_SLACK_MS;
    if (rtt < this.bestRttMs || contradicts) {
      // A contradicting sample restarts the minimum from itself: it may be a
      // worse sample than the one it replaces, and later ones tighten it again.
      if (contradicts) this.steps++;
      this.bestRttMs = rtt;
      this.offsetMs = offset;
      return true;
    }
    return false;
  }

  get ready(): boolean { return this.samples >= 3 && Number.isFinite(this.bestRttMs); }
  /** Count of completed exchanges -- NOT of accepted ones. The minimum stops
   *  improving within a few probes, so a counter of accepted samples freezes
   *  low and would disable correction for the whole session. */
  get sampleCount(): number { return this.samples; }
  get rttMs(): number { return Number.isFinite(this.bestRttMs) ? this.bestRttMs : 0; }
  /** Honest bound on our own offset error. NTP calls this the maximum error. */
  get uncertaintyMs(): number { return this.rttMs / 2; }

  serverNow(clientNow: number): number { return clientNow + this.offsetMs; }

  /** The inverse: when our own clock will read a given server instant. This is
   *  what a scheduled command's `when` has to be converted through. */
  clientTime(serverMs: number): number { return serverMs - this.offsetMs; }

  /**
   * Throw the estimate away. A reconnect gets a new socket, possibly a new
   * route; the old offset was measured against a path that no longer exists,
   * and keeping it would let a stale bias survive the one event that could
   * have cleared it.
   */
  reset(): void {
    this.offsetMs = 0;
    this.bestRttMs = Number.POSITIVE_INFINITY;
    this.samples = 0;
  }
}

/** The room's position is a pure function of the anchor and server time. */
export interface Anchor {
  readonly positionMs: number;
  readonly atServerMs: number;
  readonly paused: boolean;
  readonly mediaKey: string;
  /**
   * Where a member can open `mediaKey`, if whoever named the media said.
   * Advisory: follow it only through `followableUrl`.
   */
  readonly mediaUrl?: string;
}

export function expectedAt(a: Anchor, serverMs: number): number {
  return a.paused ? a.positionMs : a.positionMs + (serverMs - a.atServerMs);
}
