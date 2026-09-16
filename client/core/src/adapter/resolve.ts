/**
 * Finding, and keeping hold of, the element that is actually playing.
 *
 * Two things make this non-trivial on real sites:
 *  - a page has more than one `<video>` (autoplaying previews, ad slots,
 *    hidden preload elements), so "the first one" is usually wrong;
 *  - single-page routers replace the element, or navigate without a reload, so
 *    a cached reference goes stale silently. YouTube does both.
 */
import type { VideoHints } from '../providers/descriptor.ts';

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

const area = (v: VideoLike): number => (v.videoWidth || 0) * (v.videoHeight || 0);

/**
 * How much larger another picture must be to take over from a quiet current
 * element. The size is intrinsic -- the rendition being streamed, not the
 * layout -- so an adaptive player's picture moves by 2.25x between 720p and
 * 1080p on its own, and comparable players must not trade places over that.
 * A 320x180 banner against a 720p feature is 16x. The cost of the margin: a
 * feature still on a 360p start-up rendition loses to a paused 1080p element.
 */
export const OUTCLASSED = 4;

/**
 * Choose the element the user is watching.
 *
 * Order: something audibly playing beats something that is not; then the
 * largest picture; then the one furthest along in loading. A muted 320x180
 * hover-preview must never win over the paused feature presentation.
 *
 * `current` is the element already chosen, and it is kept while it is still
 * on the page with media loaded, unless it is not audibly playing and another
 * element either is, or has a picture more than `OUTCLASSED` times larger.
 * Every change of element resets the detector and moves the new element to
 * the room's state, so switching on anything less -- the feature pausing with
 * the room, or dipping to readyState 1 during a seek while a preview runs --
 * moves the room onto a preview and swallows the user's seek.
 *
 * The area escape is what lets a wrong first pick go. A banner that was on
 * the page before the feature would otherwise be held until the user presses
 * play with sound on the feature, and swapping elements at that moment resets
 * the detector, so the play is never reported and the room's paused state is
 * applied over it.
 */
export function pickVideo<T extends VideoLike>(
  videos: readonly T[], current: T | null = null, outclassed = OUTCLASSED,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const v of videos) {
    const playing = audiblyPlaying(v) ? 1 : 0;
    // Area dominates within a playing/not-playing tier; readyState only breaks
    // ties between elements that have not reported a size yet.
    const score = playing * 1e12 + area(v) * 10 + Math.min(v.readyState, 4);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  if (current && best !== current && current.readyState >= 1 && videos.includes(current)) {
    // `videos` comes from the live document, so membership means "still on
    // the page". readyState 0 means its media was taken away.
    if (audiblyPlaying(current) || !best) return current;
    if (audiblyPlaying(best) || area(best) > outclassed * area(current)) return best;
    return current;
  }
  return best;
}

/** What `closest` needs; a real element has it, a test double may not. */
interface Selectable {
  closest?(selector: string): unknown;
}

function matchesAny(el: Selectable, selectors: readonly string[]): boolean {
  for (const sel of selectors) {
    try {
      // `closest` includes the element itself, so a selector may name the
      // video or the player around it.
      if (el.closest?.(sel)) return true;
    } catch {
      // A selector this browser does not parse matches nothing. The
      // descriptor was validated for shape, not against every engine's CSS.
    }
  }
  return false;
}

/**
 * The elements a provider's hints leave in the running. An `include` that
 * finds nothing is ignored rather than obeyed: a site redesign that renames a
 * class must degrade to the generic choice, not to "no video on this page".
 */
export function filterCandidates<T extends VideoLike & Selectable>(
  all: readonly T[], hints: VideoHints | undefined,
): { candidates: T[]; staleInclude: boolean } {
  if (!hints) return { candidates: [...all], staleInclude: false };
  const min = hints.minIntrinsicArea ?? 0;
  let out = all.filter((v) => {
    if (hints.exclude?.length && matchesAny(v, hints.exclude)) return false;
    // Only a known size is held against an element: the feature itself has
    // none until its metadata loads.
    const a = area(v);
    return !(min > 0 && a > 0 && a < min);
  });
  let staleInclude = false;
  if (hints.include?.length) {
    const inc = out.filter((v) => matchesAny(v, hints.include!));
    if (inc.length) out = inc;
    else staleInclude = out.length > 0;
  }
  return { candidates: out, staleInclude };
}

/** Every `<video>` in `root`, and in open shadow roots below it when asked. */
function collectVideos(root: ParentNode, pierce: boolean, depth = 0): HTMLVideoElement[] {
  const found = Array.from(root.querySelectorAll('video'));
  if (!pierce || depth >= 8) return found;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const sr = (el as Element).shadowRoot;
    if (sr) found.push(...collectVideos(sr, true, depth + 1));
  }
  return found;
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
  /** The provider's hints for the page at `href`, if its descriptor has any. */
  hints?(href: string): VideoHints | undefined;
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
  private stale = false;

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
    const href = this.d.win.location.href;
    const hints = this.d.hints?.(href);
    const { candidates, staleInclude } = filterCandidates(
      collectVideos(this.d.doc, hints?.pierceShadow === true), hints);
    this.stale = staleInclude;
    const el = pickVideo(candidates, this.lastEl, hints?.outclassedFactor ?? OUTCLASSED);
    if (el === this.lastEl && href === this.lastHref) return;
    this.lastEl = el;
    this.lastHref = href;
    this.d.onChange(el, href);
  };

  get current(): HTMLVideoElement | null { return this.lastEl; }

  /** The provider's `include` found nothing at the last check, so it was ignored. */
  get staleInclude(): boolean { return this.stale; }
}
