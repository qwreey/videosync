/**
 * Browser-probe entry point. Bundled into the Risk-B harness so the real
 * detector -- not a model of it -- can be driven against a real <video>.
 */
import { Html5Adapter } from './adapter/html5.ts';
import { SeekDetector } from './detector/detector.ts';
import type { Observation } from './detector/types.ts';
import { type Anchor, expectedAt, ServerClock } from './engine/clock.ts';

export interface TraceRow {
  t: number;
  kind: Observation['kind'];
  posMs: number;
  residualMs: number | null;
  readyState: number;
  paused: boolean;
  suspended: boolean;
}

/**
 * Runs the real detector at ~10 Hz against a real element, with a perfect
 * clock (offset 0) so that anything the detector concludes is a property of
 * the detector and of the browser, not of a clock estimate.
 */
export class ProbeHarness {
  readonly adapter: Html5Adapter;
  readonly detector: SeekDetector;
  readonly clock = new ServerClock();
  readonly trace: TraceRow[] = [];
  /** Observations the detector said were user intent, i.e. would hit the wire. */
  readonly broadcast: Array<{ t: number; o: Observation }> = [];

  private anchor: Anchor;
  private timer = 0;
  private readonly t0 = performance.now();

  private readonly el: HTMLVideoElement;

  constructor(el: HTMLVideoElement) {
    this.el = el;
    this.adapter = new Html5Adapter(el);
    this.detector = new SeekDetector(() => document.hidden);
    this.anchor = {
      positionMs: el.currentTime * 1000,
      atServerMs: performance.now(),
      paused: el.paused,
      mediaKey: 'probe',
    };
    // A perfect clock: three identical samples with zero RTT.
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      this.clock.addSample({ t0: t, tRecv: t, tSend: t, t1: t });
    }
  }

  /** Re-anchor the room, as a server command would. */
  setAnchor(positionMs: number, paused: boolean): void {
    this.anchor = { positionMs, atServerMs: performance.now(), paused, mediaKey: 'probe' };
  }

  /** Follow the element, as if the room were perfectly tracking it. */
  syncAnchorToElement(): void {
    this.setAnchor(this.el.currentTime * 1000, this.el.paused);
  }

  start(intervalMs = 100): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs) as unknown as number;
  }

  stop(): void { clearInterval(this.timer); this.timer = 0; }

  private tick(): void {
    const now = performance.now();
    const state = this.adapter.readState();
    const expected = this.clock.ready ? expectedAt(this.anchor, this.clock.serverNow(now)) : null;
    const { observation, report } = this.detector.evaluate(state, expected, now);
    this.trace.push({
      t: +(now - this.t0).toFixed(1),
      kind: observation.kind,
      posMs: +state.positionS.toFixed(3) * 1000,
      residualMs: report ? +report.residualMs.toFixed(1) : null,
      readyState: state.readyState,
      paused: state.paused,
      suspended: report?.suspended ?? false,
    });
    if (SeekDetector.isUserIntent(observation)) this.broadcast.push({ t: +(now - this.t0).toFixed(1), o: observation });
  }

  counters(): Record<string, number> {
    return {
      seekDetections: this.detector.seekDetections,
      stallDetections: this.detector.stallDetections,
      suspensions: this.detector.suspensions,
      broadcasts: this.broadcast.length,
      samples: this.trace.length,
    };
  }

  reset(): void { this.trace.length = 0; this.broadcast.length = 0; }
}

// Exposed for the CDP driver.
declare global { interface Window { VSProbe?: ProbeHarness } }
export function attach(el: HTMLVideoElement): ProbeHarness {
  const h = new ProbeHarness(el);
  window.VSProbe = h;
  return h;
}
