import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OUTCLASSED, PageWatcher, pickVideo } from '../src/adapter/resolve.ts';
import type { VideoLike } from '../src/adapter/resolve.ts';
import type { VideoHints } from '../src/providers/descriptor.ts';

type FakeVideo = { -readonly [K in keyof VideoLike]: VideoLike[K] } & {
  /** CSS classes of this element and its ancestors, for `closest`. */
  classes?: string[];
  closest?(sel: string): unknown;
};

const video = (o: Partial<FakeVideo>): FakeVideo => {
  const v: FakeVideo = {
    videoWidth: 1920, videoHeight: 1080, duration: 600, paused: true, readyState: 4, muted: false, volume: 1, ...o,
  };
  // Class selectors only (`.name`); anything else is a syntax error, as an
  // unsupported selector is in a browser.
  v.closest = (sel: string) => {
    if (!/^\.[a-z-]+$/.test(sel)) throw new SyntaxError(sel);
    return (v.classes ?? []).includes(sel.slice(1)) ? v : null;
  };
  return v;
};

/** A node whose open shadow root holds `videos` (and maybe more shadow hosts). */
function shadowHost(videos: FakeVideo[], hosts: unknown[] = []) {
  return {
    shadowRoot: {
      querySelectorAll: (sel: string) => (sel === 'video' ? videos : sel === '*' ? hosts : []),
    },
  };
}

/** Just enough document and window for PageWatcher, driven by hand. */
function page(videos: FakeVideo[], hints?: VideoHints, hosts: unknown[] = []) {
  const changes: Array<[unknown, string]> = [];
  const timers: Array<() => void> = [];
  const doc = {
    documentElement: {},
    querySelectorAll: (sel: string) => (sel === 'video' ? videos : sel === '*' ? hosts : []),
  } as unknown as Document;
  const win = {
    location: { href: 'https://example.test/watch/1' },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;
  const w = new PageWatcher({
    doc, win,
    onChange: (el, href) => { changes.push([el, href]); },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    ...(hints ? { hints: () => hints } : {}),
  });
  return { w, changes };
}

describe('PageWatcher', () => {
  it('keeps the element it already chose through that element\'s own seek', () => {
    // pickVideo only keeps an element it is told about. If the watcher does
    // not pass what it chose last, a seek on the feature (readyState 1) hands
    // the page to an equally large element that happens to be further along
    // in loading -- and the swap resets the detector and swallows the seek.
    const other = video({ paused: false, readyState: 3 });
    const feature = video({ paused: false, readyState: 4 });
    const { w, changes } = page([other, feature]);
    w.start();
    assert.equal(changes.length, 1);
    assert.equal(changes[0]![0], feature, 'setup: the feature is picked first');

    feature.readyState = 1;
    w.check();
    assert.equal(w.current, feature);
    assert.equal(changes.length, 1, 'the element changed during its own seek');

    // Control: the same page with nothing chosen yet picks the other element,
    // so it is the watcher's memory that keeps the feature.
    const fresh = page([other, feature]);
    fresh.w.start();
    assert.equal(fresh.w.current, other);
    w.stop();
    fresh.w.stop();
  });
});

describe('how much larger a picture must be to take over', () => {
  // The bound was a bare constant with no test: 4x. A comparable player
  // stepping from 720p to 1080p is 2.25x and must not trade places; a banner
  // against a feature is 16x and must.
  const quiet = (w: number, h: number) => video({ videoWidth: w, videoHeight: h, paused: true });

  it('is 4x by default, exclusive', () => {
    assert.equal(OUTCLASSED, 4);
    const current = quiet(960, 540);
    assert.equal(pickVideo([current, quiet(1920, 1080)], current), current, 'exactly 4x keeps the current element');
    const bigger = quiet(1921, 1080);
    assert.equal(pickVideo([current, bigger], current), bigger, 'just over 4x takes over');
    const hd = quiet(1280, 720);
    assert.equal(pickVideo([hd, quiet(1920, 1080)], hd), hd, '720p -> 1080p is 2.25x');
  });

  it('can be tuned per provider', () => {
    const current = quiet(1280, 720);
    const other = quiet(1920, 1080);
    assert.equal(pickVideo([current, other], current, 2), other, '2.25x outclasses at factor 2');
    assert.equal(pickVideo([current, other], current, 3), current, 'but not at 3');
  });
});

describe('provider video hints', () => {
  it('drops excluded elements, whatever their size', () => {
    const preview = video({ videoWidth: 3840, videoHeight: 2160, classes: ['preview'] });
    const feature = video({});
    const { w } = page([preview, feature], { exclude: ['.preview'] });
    w.start();
    assert.equal(w.current, feature);
    const control = page([preview, feature]);
    control.w.start();
    assert.equal(control.w.current, preview, 'control: without the hint the bigger one wins');
    w.stop();
    control.w.stop();
  });

  it('considers only included elements, and all of them if the selector finds none', () => {
    const big = video({ videoWidth: 3840, videoHeight: 2160 });
    const player = video({ videoWidth: 640, videoHeight: 360, classes: ['player'] });
    const a = page([big, player], { include: ['.player'] });
    a.w.start();
    assert.equal(a.w.current, player);
    assert.equal(a.w.staleInclude, false);
    // A site redesign that renames the class must degrade to today's
    // behaviour, not to "no video on this page".
    const b = page([big, video({ classes: ['other'] })], { include: ['.player'] });
    b.w.start();
    assert.equal(b.w.current, big);
    assert.equal(b.w.staleInclude, true, 'surfaced for dump()');
    a.w.stop();
    b.w.stop();
  });

  it('ignores a picture below the floor, but not one with no size yet', () => {
    const tiny = video({ videoWidth: 100, videoHeight: 100, paused: false });
    const unsized = video({ videoWidth: 0, videoHeight: 0, readyState: 0 });
    const { w } = page([tiny, unsized], { minIntrinsicArea: 10_800 });
    w.start();
    assert.equal(w.current, unsized, 'the feature before its metadata is not an ad');
    const control = page([tiny, unsized]);
    control.w.start();
    assert.equal(control.w.current, tiny, 'control: the audible tiny element wins without the floor');
    w.stop();
    control.w.stop();
  });

  it('treats a selector the browser rejects as matching nothing', () => {
    const feature = video({});
    const { w } = page([feature], { exclude: ['div >>> video'], include: ['::bogus'] });
    w.start();
    assert.equal(w.current, feature);
    w.stop();
  });

  it('looks inside open shadow roots only when told to, and not without end', () => {
    const inside = video({});
    const host = shadowHost([], [shadowHost([inside])]);
    const pierced = page([], { pierceShadow: true }, [host]);
    pierced.w.start();
    assert.equal(pierced.w.current, inside, 'a player in a nested shadow root was not found');
    const plain = page([], {}, [host]);
    plain.w.start();
    assert.equal(plain.w.current, null, 'control: without the hint the shadow root is not searched');
    // Nine levels down is past the depth bound.
    let deep: unknown = shadowHost([video({})]);
    for (let i = 0; i < 9; i++) deep = shadowHost([], [deep]);
    const bounded = page([], { pierceShadow: true }, [deep]);
    bounded.w.start();
    assert.equal(bounded.w.current, null);
    for (const x of [pierced, plain, bounded]) x.w.stop();
  });

  it('uses the provider\'s factor when keeping the current element', () => {
    const hd = video({ videoWidth: 1280, videoHeight: 720, readyState: 4 });
    const fhd = video({ videoWidth: 1920, videoHeight: 1080, readyState: 1 });
    const all = [hd];
    const { w } = page(all, { outclassedFactor: 2 });
    w.start();
    assert.equal(w.current, hd);
    all.push(fhd);
    w.check();
    assert.equal(w.current, fhd, '2.25x is enough at factor 2');
    w.stop();
  });
});
