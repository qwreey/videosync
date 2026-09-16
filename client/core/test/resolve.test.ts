import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PageWatcher } from '../src/adapter/resolve.ts';
import type { VideoLike } from '../src/adapter/resolve.ts';

type FakeVideo = { -readonly [K in keyof VideoLike]: VideoLike[K] };

const video = (o: Partial<FakeVideo>): FakeVideo => ({
  videoWidth: 1920, videoHeight: 1080, duration: 600, paused: true, readyState: 4, muted: false, volume: 1, ...o,
});

/** Just enough document and window for PageWatcher, driven by hand. */
function page(videos: FakeVideo[]) {
  const changes: Array<[unknown, string]> = [];
  const timers: Array<() => void> = [];
  const doc = {
    documentElement: {},
    querySelectorAll: (sel: string) => (sel === 'video' ? videos : []),
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
