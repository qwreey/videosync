import type {
  AdapterCapabilities, AdapterEvent, PlayerState, ProviderAdapter,
} from './types.ts';

/** What a swappable adapter reports while there is no element at all. */
const ABSENT: PlayerState = {
  positionS: 0, paused: true, rate: 1, readyState: 0, muted: false,
  durationS: 0, buffered: [], bufferedAheadS: 0, bufferedBehindS: 0,
};

/**
 * An adapter that can have the element replaced underneath it.
 *
 * Single-page routers swap the `<video>` (YouTube does it on every navigation),
 * so a long-lived engine cannot hold a direct reference. Rather than teach the
 * engine about element lifecycles, it holds one of these forever and the page
 * watcher retargets it.
 *
 * With no target it reports `readyState: 0` and `paused: true` -- honestly
 * unready, which is exactly what the readiness gate is for. Reporting a
 * plausible-looking zero state instead would make the room start without a
 * member who has no video at all.
 */
export class SwappableAdapter implements ProviderAdapter {
  readonly id = 'swappable';
  private target: ProviderAdapter | null = null;
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private unsubs: Array<() => void> = [];

  get capabilities(): AdapterCapabilities {
    return this.target?.capabilities ?? {
      supportsDirectSeek: false,
      supportsDirectPlayPause: false,
      supportsPlaybackRateNudge: false,
      supportsAdDetection: false,
      volatileVideoElement: true,
    };
  }

  /** Point at a new adapter. The previous one is destroyed. */
  setTarget(next: ProviderAdapter | null): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.target?.destroy();
    this.target = next;
    if (!next) return;
    for (const [event, fns] of this.listeners) {
      this.unsubs.push(next.on(event, () => { for (const fn of fns) fn(); }));
    }
    // Subscribers care that the ground moved under them.
    for (const fn of this.listeners.get('elementreplaced') ?? []) fn();
  }

  get current(): ProviderAdapter | null { return this.target; }

  readState(): PlayerState { return this.target?.readState() ?? ABSENT; }

  async seekTo(positionS: number, timeoutMs?: number): Promise<void> {
    await this.target?.seekTo(positionS, timeoutMs);
  }

  async play(): Promise<void> { await this.target?.play(); }
  async pause(): Promise<void> { await this.target?.pause(); }
  setRate(rate: number): void { this.target?.setRate(rate); }

  on(event: AdapterEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
      // A newly interesting event on an already-attached target needs wiring.
      if (this.target) {
        const s = set;
        this.unsubs.push(this.target.on(event, () => { for (const f of s) f(); }));
      }
    }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.target?.destroy();
    this.target = null;
    this.listeners.clear();
  }
}
