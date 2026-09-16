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

export class ServerClock {
  private offsetMs = 0;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private samples = 0;

  /** @returns whether this sample was accepted (a new minimum RTT). */
  addSample(s: ClockSample): boolean {
    const rtt = (s.t1 - s.t0) - (s.tSend - s.tRecv);
    this.samples++;
    if (rtt < 0) return false;
    if (rtt < this.bestRttMs) {
      this.bestRttMs = rtt;
      this.offsetMs = ((s.tRecv - s.t0) + (s.tSend - s.t1)) / 2;
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
