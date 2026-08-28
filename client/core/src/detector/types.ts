/** What the detector concluded about the last observation. */
export type Observation =
  | { kind: 'idle' }
  /** A local user genuinely seeked. Broadcast it. */
  | { kind: 'seek'; positionS: number }
  /** A local user genuinely pressed play/pause. Broadcast it. */
  | { kind: 'playstate'; paused: boolean; positionS: number }
  /** Buffering. The room may wait for us; we are behind but present. */
  | { kind: 'stall' }
  /**
   * The browser paused us because the tab is hidden and muted. We are ABSENT,
   * not behind. Never broadcast; never let the room gate on us.
   */
  | { kind: 'suspended' };

export interface DetectorReport {
  /** Signed: localPosition - expected. Negative means behind the room. */
  readonly residualMs: number;
  /** d(residual)/dt in ms per second, least squares over a short window. */
  readonly slopeMsPerS: number;
  readonly positionMs: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly bufferedAheadS: number;
  readonly bufferedBehindS: number;
  readonly suspended: boolean;
}

export interface DetectorConfig {
  /** A jump bigger than this in BOTH diffs is a user seek. */
  seekThresholdMs: number;
  /** Report immediately once the residual crosses this. */
  reportThresholdMs: number;
  /** How often the local loop evaluates. */
  evalIntervalMs: number;
  /** Least-squares window for the slope. */
  slopeWindowMs: number;
  /** readyState below this counts as not-playable. */
  minReadyState: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  seekThresholdMs: 1000,
  reportThresholdMs: 250,
  evalIntervalMs: 100,
  slopeWindowMs: 3000,
  minReadyState: 3,
};
