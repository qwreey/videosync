/**
 * A synchronous `Store` over an asynchronous storage area that other contexts
 * write too -- the extension's `chrome.storage.local`, which every tab, the
 * options page and the worker share.
 *
 * The panel is built before anything can await, so values are read once up
 * front and served from a cache. The cache used to be read once and never
 * again, which made every tab's picture of the settings as old as the tab:
 * a tab that joined server X kept believing X after another tab chose Y, and
 * a tab opened before the user switched a descriptor off on the options page
 * wrote the old descriptor state back on its next join. So the cache follows
 * the area's change events.
 *
 * An event is not applied as it stands, though: it is only a cue to read the
 * key back. Events for our own writes arrive after the writes, possibly one
 * task each, so applying the first of two quick writes' events would roll the
 * cache back to the older value; and an area need not report a write that
 * changed nothing (Chrome does not), so no echo can be waited for either.
 * The area itself is the truth whoever wrote last, so a read-back that
 * nothing newer has overtaken -- no later read, no save of ours, no write of
 * ours still out -- is what lands in the cache.
 *
 * No extension API in here: the shim passes the area in.
 */
import type { Store } from './bootstrap.ts';

export interface SharedArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
  /** Changes made by anyone, this context included. `newValue` absent: removed. */
  onChanged(fn: (changes: Record<string, { newValue?: unknown }>) => void): void;
}

export async function sharedStore(area: SharedArea, prefix: string, keys: readonly string[]): Promise<Store> {
  const names = keys.map((k) => prefix + k);
  const listed = new Set(names);
  const cache = new Map<string, string>();
  /** Writes of ours not yet landed, per key. */
  const outstanding = new Map<string, number>();
  /** Bumped by every save and every read-back, so only the newest read-back lands. */
  const version = new Map<string, number>();
  const bump = (k: string) => {
    const v = (version.get(k) ?? 0) + 1;
    version.set(k, v);
    return v;
  };

  const readBack = async (k: string) => {
    const mine = bump(k);
    let got: Record<string, unknown>;
    try {
      got = await area.get([k]);
    } catch {
      return; // keep what we have
    }
    if (version.get(k) !== mine || (outstanding.get(k) ?? 0) > 0) return;
    const v = got[k];
    if (typeof v === 'string') cache.set(k, v);
    else cache.delete(k);
  };

  // Subscribed before the first read, so nothing written in between is lost.
  area.onChanged((changes) => {
    for (const k of Object.keys(changes)) {
      if (listed.has(k)) void readBack(k);
    }
  });

  try {
    const got = await area.get(names);
    for (const k of names) {
      // A key an event already had read back is newer than this read.
      if (!version.has(k) && typeof got[k] === 'string') cache.set(k, got[k]);
    }
  } catch { /* first run, or storage is unavailable; defaults are fine */ }

  let pending: Promise<unknown> = Promise.resolve();
  return {
    load: (key, fallback = '') => cache.get(prefix + key) ?? fallback,
    save: (key, value) => {
      const k = prefix + key;
      cache.set(k, value);
      bump(k);
      outstanding.set(k, (outstanding.get(k) ?? 0) + 1);
      const write = area.set({ [k]: value }).catch(() => {}).then(() => {
        const n = (outstanding.get(k) ?? 1) - 1;
        outstanding.set(k, n);
        // Our write landed; whatever the area holds now is the truth,
        // including a write another context made meanwhile.
        return n === 0 ? readBack(k) : undefined;
      });
      pending = Promise.all([pending, write]);
    },
    flush: () => pending.then(() => {}),
  };
}
