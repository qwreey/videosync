/**
 * Gesture evidence for the engine (docs/design/acquire.md): when the member
 * last did something with their hands, so a change to the player can be told
 * apart from the site's own autoplay, resume, or next-episode routing.
 *
 * Privacy-neutral on purpose: a timestamp and nothing else -- no target, no
 * key, no position. Only trusted events count, and only the kinds that give a
 * page user activation (HTML "activation-triggering input event"): `keydown`
 * other than Escape, `mousedown`, `pointerdown` from a mouse, `pointerup` from
 * anything else, `touchend`. A site's own synthetic presses are not the
 * member's, and are not counted.
 *
 * Input on VideoSync's own panel is kept apart: it is the member, but not a
 * press on the player, and it still activates the page -- so it must not make
 * an activation rise look like a media key either.
 */
import type { GestureEvidence } from '../engine/engine.ts';

const TYPES = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend'] as const;
/** Keys that do not activate a page, or that are only half of a shortcut. */
const INERT_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);

export interface GestureTracker extends GestureEvidence {
  stop(): void;
}

interface Target {
  addEventListener(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e: Event) => void, opts?: EventListenerOptions): void;
}

/**
 * @param win     where to listen (capture phase, so a page that stops
 *                propagation still cannot hide a press)
 * @param ours    VideoSync's own UI: input inside it is not a press on the player
 * @param now     the engine's clock
 */
export function trackGestures(win: Target, ours: () => Node | null, now: () => number): GestureTracker {
  let last = -Infinity;
  let ignored = -Infinity;
  const onInput = (e: Event): void => {
    if (!e.isTrusted) return;
    if (e.type === 'keydown' && INERT_KEYS.has((e as KeyboardEvent).key)) return;
    const pt = (e as PointerEvent).pointerType;
    if (e.type === 'pointerdown' && pt !== 'mouse') return;
    if (e.type === 'pointerup' && pt === 'mouse') return;
    const host = ours();
    // A closed shadow root still shows its host in the composed path.
    if (host && typeof e.composedPath === 'function' && e.composedPath().includes(host)) {
      ignored = now();
      return;
    }
    last = now();
  };
  const opts = { capture: true, passive: true };
  for (const t of TYPES) win.addEventListener(t, onInput, opts);
  return {
    lastInputAt: () => last,
    lastIgnoredInputAt: () => ignored,
    activationActive: () => {
      const ua = (globalThis.navigator as Navigator & { userActivation?: { isActive: boolean } } | undefined)
        ?.userActivation;
      return ua ? ua.isActive : null;
    },
    stop: () => { for (const t of TYPES) win.removeEventListener(t, onInput, { capture: true }); },
  };
}
