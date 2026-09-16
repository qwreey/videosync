/**
 * The settings store the extension's tabs share (`sharedstore.ts`): each tab's
 * synchronous cache must follow what other tabs and the options page write.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sharedStore } from '../src/app/sharedstore.ts';
import type { SharedArea } from '../src/app/sharedstore.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

/**
 * `chrome.storage.local` as far as the store sees it: shared by every view,
 * async, events delivered later to every subscriber, and -- as Chrome does --
 * no event for a write that changed nothing.
 */
class FakeStorage {
  data = new Map<string, string>();
  private subs: Array<(c: Record<string, { newValue?: unknown }>) => void> = [];

  /**
   * One context's view. `timing` says, in ms, when a write lands, when its
   * change event reaches the subscribers after that, and when the writer's
   * own promise resolves after that -- the orders a real browser does not
   * promise.
   */
  view(timing: { get?: number[]; apply?: number[]; event?: number[]; resolve?: number[] } = {}): SharedArea {
    const next = (xs: number[] | undefined) => xs?.shift() ?? 0;
    return {
      // Read when asked, answered later.
      get: async (keys) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (this.data.has(k)) out[k] = this.data.get(k);
        await sleep(next(timing.get));
        await tick();
        return out;
      },
      set: (items) => new Promise<void>((res) => {
        const ev = next(timing.event);
        const rs = next(timing.resolve);
        setTimeout(() => {
          const changes: Record<string, { newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            if (this.data.get(k) !== v) changes[k] = { newValue: v };
            this.data.set(k, v);
          }
          if (Object.keys(changes).length) setTimeout(() => { for (const s of this.subs) s(changes); }, ev);
          setTimeout(res, rs);
        }, next(timing.apply));
      }),
      onChanged: (fn) => { this.subs.push(fn); },
    };
  }

  /** What `chrome.storage.local.remove` does. */
  remove(k: string): void {
    this.data.delete(k);
    setTimeout(() => { for (const s of this.subs) s({ [k]: {} }); }, 0);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYS = ['server', 'providers.adopted'];

describe('the settings store the tabs share', () => {
  it('follows what another tab writes', async () => {
    const st = new FakeStorage();
    st.data.set('v.server', 'https://x.example');
    const a = await sharedStore(st.view(), 'v.', KEYS);
    const b = await sharedStore(st.view(), 'v.', KEYS);
    assert.equal(a.load('server'), 'https://x.example');
    b.save('server', 'https://y.example');
    await settle();
    assert.equal(a.load('server'), 'https://y.example', 'a tab kept the server it loaded with');
    b.save('providers.adopted', '[]');
    await settle();
    assert.equal(a.load('providers.adopted'), '[]');
  });

  it('ignores keys it does not hold, and a removal clears the key', async () => {
    const st = new FakeStorage();
    const a = await sharedStore(st.view(), 'v.', KEYS);
    const other = st.view();
    await other.set({ 'v.secret': 's' });
    await settle();
    assert.equal(a.load('secret', 'none'), 'none');
    await other.set({ 'v.server': 'https://x.example' });
    await settle();
    assert.equal(a.load('server'), 'https://x.example');
    // A removal (the options page resetting a key) is an event with no value.
    st.remove('v.server');
    await settle();
    assert.equal(a.load('server', 'gone'), 'gone');
  });

  it('is not rolled back by the echo of its own older write', async () => {
    const st = new FakeStorage();
    // Both writes land and resolve at once; their events come later, in
    // order, one task apart -- time for the page to read the cache between.
    const a = await sharedStore(st.view({ event: [10, 15] }), 'v.', KEYS);
    a.save('server', 'https://1.example');
    a.save('server', 'https://2.example');
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) { await sleep(1); seen.push(a.load('server')); }
    assert.deepEqual([...new Set(seen)], ['https://2.example'], `the cache went ${seen.join(' -> ')}`);
  });

  it('ends on whoever wrote last, even when its own write changed nothing', async () => {
    const st = new FakeStorage();
    st.data.set('v.server', 'https://x.example');
    // a writes what is already there, so no event says it landed, and its
    // promise is slow; b's write lands meanwhile, while a's is outstanding.
    const a = await sharedStore(st.view({ resolve: [20] }), 'v.', KEYS);
    const b = await sharedStore(st.view({ apply: [5] }), 'v.', KEYS);
    a.save('server', 'https://x.example');
    b.save('server', 'https://y.example');
    await a.flush!();
    await settle();
    assert.equal(st.data.get('v.server'), 'https://y.example');
    assert.equal(a.load('server'), 'https://y.example', 'the cache stuck on its own stale write');
    // And it still follows afterwards.
    b.save('server', 'https://z.example');
    await settle();
    assert.equal(a.load('server'), 'https://z.example');
  });

  it('is not rolled back by a slow read of an older value', async () => {
    const st = new FakeStorage();
    // The first read-back (after the first load) is slow; the next is not.
    const a = await sharedStore(st.view({ get: [0, 20, 0] }), 'v.', KEYS);
    const other = st.view();
    await other.set({ 'v.server': 'https://y.example' });
    await sleep(2);
    await other.set({ 'v.server': 'https://z.example' });
    await sleep(40);
    assert.equal(a.load('server'), 'https://z.example', 'an older read-back landed over a newer one');
  });

  it('keeps its own write while it is on its way', async () => {
    const st = new FakeStorage();
    const a = await sharedStore(st.view({ apply: [15] }), 'v.', KEYS);
    const other = st.view();
    a.save('server', 'https://mine.example');
    await sleep(1);
    await other.set({ 'v.server': 'https://theirs.example' }); // lands first; ours lands after it
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) { await sleep(1); seen.push(a.load('server')); }
    assert.equal(st.data.get('v.server'), 'https://mine.example');
    assert.deepEqual([...new Set(seen)], ['https://mine.example'], `the cache went ${seen.join(' -> ')}`);
  });

  it('serves defaults when the area cannot be read', async () => {
    const area: SharedArea = {
      get: () => Promise.reject(new Error('no storage')),
      set: () => Promise.resolve(),
      onChanged: () => {},
    };
    const s = await sharedStore(area, 'v.', KEYS);
    assert.equal(s.load('server', 'dflt'), 'dflt');
    s.save('server', 'https://x.example');
    assert.equal(s.load('server'), 'https://x.example');
    await s.flush!();
  });
});
