/**
 * Finding, and keeping hold of, the element that is actually playing.
 *
 * Two things make this non-trivial on real sites:
 *  - a page has more than one `<video>` (autoplaying previews, ad slots,
 *    hidden preload elements), so "the first one" is usually wrong;
 *  - single-page routers replace the element, or navigate without a reload, so
 *    a cached reference goes stale silently. YouTube does both.
 */

/** The subset of `<video>` that picking depends on. Kept narrow so the choice
 *  is testable without a DOM. */
export interface VideoLike {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly muted: boolean;
  readonly volume: number;
}

/**
 * Something the user evidently chose to watch: running, with sound. A muted
 * autoplaying preview is running too, and is exactly what must not count.
 * readyState 1 still counts -- a seek drops to it, and a seek is the user
 * watching.
 */
function audiblyPlaying(v: VideoLike): boolean {
  return !v.paused && v.readyState >= 1 && !v.muted && v.volume > 0;
}

/**
 * Choose the element the user is watching.
 *
 * Order: something audibly playing beats something that is not; then the
 * largest picture; then the one furthest along in loading. A muted 320x180
 * hover-preview must never win over the paused feature presentation.
 *
 * `current` is the element already chosen, and it is kept while it is still
 * on the page with media loaded, unless another element is audibly playing
 * and it is not. Every change of element resets the detector and moves the
 * new element to the room's state, so switching on anything less -- the
 * feature pausing with the room, or dipping to readyState 1 during a seek
 * while a preview runs -- moves the room onto a preview and swallows the
 * user's seek.
 */
export function pickVideo<T extends VideoLike>(videos: readonly T[], current: T | null = null): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const v of videos) {
    const area = (v.videoWidth || 0) * (v.videoHeight || 0);
    const playing = audiblyPlaying(v) ? 1 : 0;
    // Area dominates within a playing/not-playing tier; readyState only breaks
    // ties between elements that have not reported a size yet.
    const score = playing * 1e12 + area * 10 + Math.min(v.readyState, 4);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  if (current && best !== current && current.readyState >= 1 && videos.includes(current)) {
    // `videos` comes from the live document, so membership means "still on
    // the page". readyState 0 means its media was taken away.
    if (!(best && audiblyPlaying(best) && !audiblyPlaying(current))) return current;
  }
  return best;
}

export interface PageWatcherDeps {
  doc: Document;
  win: Window;
  /** Called whenever the element or the location changes, including at start. */
  onChange(el: HTMLVideoElement | null, href: string): void;
  /** How often to re-check. A router can change both without any event we see. */
  intervalMs?: number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(h: number): void;
}

/**
 * Watches for the playing element or the location changing.
 *
 * Polls rather than patching `history.pushState`. Patching a page's own globals
 * from a userscript is a compatibility risk out of all proportion to the
 * benefit here: the cost of noticing a navigation up to one interval late is a
 * second of stale UI, and the cost of breaking a site's router is the site.
 */
export class PageWatcher {
  private readonly d: PageWatcherDeps;
  private readonly intervalMs: number;
  private timer = 0;
  private observer: MutationObserver | null = null;
  private lastEl: HTMLVideoElement | null = null;
  private lastHref = '';
  private started = false;

  constructor(deps: PageWatcherDeps) {
    this.d = deps;
    this.intervalMs = deps.intervalMs ?? 1000;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => this.check());
      this.observer.observe(this.d.doc.documentElement, { childList: true, subtree: true });
    }
    this.d.win.addEventListener('popstate', this.check);
    this.tick();
  }

  stop(): void {
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    this.d.win.removeEventListener('popstate', this.check);
    this.d.clearTimer(this.timer);
    this.timer = 0;
  }

  private tick = (): void => {
    this.check();
    if (this.started) this.timer = this.d.setTimer(this.tick, this.intervalMs);
  };

  readonly check = (): void => {
    const el = pickVideo(Array.from(this.d.doc.querySelectorAll('video')), this.lastEl);
    const href = this.d.win.location.href;
    if (el === this.lastEl && href === this.lastHref) return;
    this.lastEl = el;
    this.lastHref = href;
    this.d.onChange(el, href);
  };

  get current(): HTMLVideoElement | null { return this.lastEl; }
}
