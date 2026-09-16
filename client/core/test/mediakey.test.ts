import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { followableUrl, normalizeMediaKey, providerId, watchUrl } from '../src/adapter/mediakey.ts';
import { Html5Adapter } from '../src/adapter/html5.ts';
import { pickVideo } from '../src/adapter/resolve.ts';
import { SwappableAdapter } from '../src/adapter/swappable.ts';
import { FakePlayer, VirtualTime } from './fakes.ts';
import type { VideoLike } from '../src/adapter/resolve.ts';

describe('mediaKey normalization', () => {
  it('identifies a YouTube video by its id, whatever the route in', () => {
    // Two people who reached the same video by different routes must agree, or
    // they silently sit in two rooms.
    const want = 'yt:dQw4w9WgXcQ';
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      assert.equal(normalizeMediaKey(url), want, url);
    }
  });

  it('separates different videos', () => {
    assert.notEqual(
      normalizeMediaKey('https://www.youtube.com/watch?v=aaaaaaaaaaa'),
      normalizeMediaKey('https://www.youtube.com/watch?v=bbbbbbbbbbb'),
    );
  });

  it('uses the path for everything else, ignoring query junk', () => {
    assert.equal(
      normalizeMediaKey('https://laftel.net/player/12345/67890?utm_source=x&autoplay=1'),
      'laftel:/player/12345/67890',
    );
    assert.equal(
      normalizeMediaKey('https://laftel.net/player/12345/67890/'),
      'laftel:/player/12345/67890',
    );
    assert.notEqual(
      normalizeMediaKey('https://laftel.net/player/12345/67890'),
      normalizeMediaKey('https://laftel.net/player/12345/67891'),
    );
  });

  it('strips www and lowercases only the host', () => {
    // Path case is NOT noise: content ids are routinely case-sensitive.
    assert.equal(normalizeMediaKey('https://WWW.Example.COM/Watch/AbC'), 'example.com:/Watch/AbC');
  });

  it('returns null where there is no media to key on', () => {
    for (const url of [
      'https://www.youtube.com/',
      'https://laftel.net',
      'about:blank',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      assert.equal(normalizeMediaKey(url), null, url);
    }
  });

  it('names providers stably', () => {
    assert.equal(providerId('www.youtube.com'), 'yt');
    assert.equal(providerId('youtu.be'), 'yt');
    assert.equal(providerId('laftel.net'), 'laftel');
    assert.equal(providerId('www.someothersite.tv'), 'someothersite.tv');
  });

  it('does not match a look-alike host', () => {
    // `notyoutube.com` must not be claimed by the youtube rule.
    assert.equal(providerId('notyoutube.com'), 'notyoutube.com');
    assert.equal(normalizeMediaKey('https://notyoutube.com/watch?v=x'), 'notyoutube.com:/watch');
  });
});

describe('picking the element the user is watching', () => {
  const v = (o: Partial<VideoLike>): VideoLike => ({
    videoWidth: 0, videoHeight: 0, duration: 0, paused: true, readyState: 0, ...o,
  });

  it('prefers what is playing over what is merely bigger', () => {
    const preview = v({ videoWidth: 320, videoHeight: 180, paused: false, readyState: 4 });
    const feature = v({ videoWidth: 1920, videoHeight: 1080, paused: true, readyState: 4 });
    assert.equal(pickVideo([feature, preview]), preview);
  });

  it('prefers the largest picture among elements that are all paused', () => {
    // A hover-preview must never win over the feature presentation.
    const preview = v({ videoWidth: 320, videoHeight: 180, readyState: 4 });
    const feature = v({ videoWidth: 1920, videoHeight: 1080, readyState: 4 });
    assert.equal(pickVideo([preview, feature]), feature);
  });

  it('falls back to readyState when nothing has reported a size yet', () => {
    const cold = v({ readyState: 0 });
    const warm = v({ readyState: 3 });
    assert.equal(pickVideo([cold, warm]), warm);
  });

  it('returns null for a page with no video', () => {
    assert.equal(pickVideo([]), null);
  });
});

describe('an adapter whose element gets replaced', () => {
  it('reports honestly unready with no target, rather than a plausible zero', async () => {
    // Reporting readyState 0 is what makes the readiness gate hold the room for
    // a member whose page has no video at all. A plausible-looking zero state
    // would let the room start without them.
    const s = new SwappableAdapter();
    assert.equal(s.readState().readyState, 0);
    assert.equal(s.readState().paused, true);
    assert.equal(s.capabilities.supportsDirectSeek, false);
    // And every operation is a no-op rather than a crash.
    await s.seekTo(10);
    await s.play();
    await s.pause();
    s.setRate(1.05);
  });

  it('forwards events from whichever element is current', () => {
    const s = new SwappableAdapter();
    let fired = 0;
    s.on('play', () => { fired++; });

    const vt = new VirtualTime();
    const first = new FakePlayer(vt);
    s.setTarget(first);
    first.emit('play');
    assert.equal(fired, 1);

    const second = new FakePlayer(vt);
    s.setTarget(second);
    first.emit('play');   // the old element must be silent
    assert.equal(fired, 1);
    second.emit('play');
    assert.equal(fired, 2);
    assert.equal(s.readState().readyState, 4);
  });

  it('announces the swap', () => {
    const s = new SwappableAdapter();
    let swaps = 0;
    s.on('elementreplaced', () => { swaps++; });
    s.setTarget(new FakePlayer(new VirtualTime()));
    assert.equal(swaps, 1);
  });
});

/**
 * Just enough of an HTMLVideoElement for Html5Adapter. A seek clamps the way
 * the spec says (past the end lands on the duration); `fireSeeked` false models
 * an element torn down mid-seek, which never reports it.
 */
class FakeVideoEl extends EventTarget {
  private pos = 0;
  paused = true;
  playbackRate = 1;
  readyState = 4;
  muted = false;
  volume = 1;
  duration: number;
  fireSeeked = true;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  constructor(duration = 120) { super(); this.duration = duration; }
  get currentTime(): number { return this.pos; }
  set currentTime(t: number) {
    this.pos = Number.isFinite(this.duration) ? Math.min(Math.max(t, 0), this.duration) : Math.max(t, 0);
    if (this.fireSeeked) setTimeout(() => this.dispatchEvent(new Event('seeked')), 5);
  }
}
const asEl = (f: FakeVideoEl) => f as unknown as HTMLVideoElement;

/** 'resolved', 'rejected', or 'pending' if still open after `ms`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    p.then(() => 'resolved', () => 'rejected'),
    new Promise<string>((r) => setTimeout(() => r('pending'), ms)),
  ]);
}

describe('the HTML5 adapter', () => {
  it('confirms a seek the browser clamped to the end', async () => {
    // The spec clamps a seek past the end to the duration. Waiting for the
    // exact target there waits out the whole timeout -- and every play or
    // pause queued behind the seek waits with it.
    const el = new FakeVideoEl(120);
    const a = new Html5Adapter(asEl(el));
    assert.equal(await settlesWithin(a.seekTo(50), 500), 'resolved', 'control: an in-range seek');
    assert.equal(await settlesWithin(a.seekTo(1_000_000), 500), 'resolved', 'past the end');
    assert.equal(await settlesWithin(a.seekTo(-5), 500), 'resolved', 'before the start');
    // An unknown duration gives nothing to clamp to.
    const live = new FakeVideoEl(Infinity);
    const b = new Html5Adapter(asEl(live));
    assert.equal(await settlesWithin(b.seekTo(30), 500), 'resolved', 'no finite duration');
    // And a seek that lands somewhere else is still not ours.
    const p = a.seekTo(60, 150);
    p.catch(() => {});
    (el as unknown as { pos: number }).pos = 0;
    el.dispatchEvent(new Event('seeked')); // somebody else's, at 0
    assert.equal(await settlesWithin(p, 1), 'pending', 'a seeked at another position resolved ours');
    a.destroy();
    b.destroy();
  });

  it('settles a pending seek when it is destroyed', async () => {
    // The page replaced the element mid-seek; the old one will never report
    // it. The engine's apply chain is waiting on this promise.
    const el = new FakeVideoEl(120);
    el.fireSeeked = false;
    const a = new Html5Adapter(asEl(el));
    const p = a.seekTo(50);
    a.destroy();
    assert.equal(await settlesWithin(p, 200), 'rejected');
    // And a destroyed adapter does not start a seek that nothing will settle.
    assert.equal(await settlesWithin(a.seekTo(10), 200), 'rejected');
  });

  it('says whether the media has sound at all, where the browser lets it', () => {
    const cases: Array<[Record<string, unknown>, boolean | undefined]> = [
      [{}, undefined], // nothing exposed: unknown
      [{ mozHasAudio: false }, false],
      [{ mozHasAudio: true }, true],
      [{ audioTracks: { length: 0 } }, false],
      [{ audioTracks: { length: 1 } }, true],
      [{ webkitAudioDecodedByteCount: 0, webkitVideoDecodedByteCount: 0 }, undefined], // nothing decoded yet
      [{ webkitAudioDecodedByteCount: 0, webkitVideoDecodedByteCount: 5000 }, false], // picture, no sound
      [{ webkitAudioDecodedByteCount: 800, webkitVideoDecodedByteCount: 5000 }, true],
    ];
    for (const [props, want] of cases) {
      const el = Object.assign(new FakeVideoEl(), props);
      const a = new Html5Adapter(asEl(el));
      assert.equal(a.readState().hasAudio, want, JSON.stringify(props));
      a.destroy();
    }
  });
});

describe('where a room\'s media can be opened', () => {
  it('is the canonical watch URL, with nothing personal in it', () => {
    assert.equal(watchUrl('https://www.youtube.com/watch?v=abc123&t=90s&list=PL1&si=tracking'),
      'https://www.youtube.com/watch?v=abc123');
    assert.equal(watchUrl('https://youtu.be/abc123?t=4'), 'https://www.youtube.com/watch?v=abc123');
    assert.equal(watchUrl('https://laftel.net/player/45462/93304?token=secret#videosync=room.key'),
      'https://laftel.net/player/45462/93304');
    assert.equal(watchUrl('https://laftel.net/'), null, 'a front page names no media');
  });

  it('round-trips: the URL names the same media as the page it came from', () => {
    for (const href of [
      'https://www.youtube.com/watch?v=abc123&t=90s',
      'https://m.youtube.com/watch?v=abc123',
      'https://laftel.net/player/45462/93304/',
      'https://example.org/videos/42?x=1',
    ]) {
      assert.equal(normalizeMediaKey(watchUrl(href)!), normalizeMediaKey(href), href);
    }
  });

  it('is followed only when it names exactly the room\'s media', () => {
    const here = 'https://laftel.net/player/45462/93295';
    const room = 'laftel:/player/45462/93304';
    assert.equal(followableUrl('https://laftel.net/player/45462/93304', room, here),
      'https://laftel.net/player/45462/93304');
    // Another episode, a lookalike host, and a different provider altogether.
    assert.equal(followableUrl('https://laftel.net/player/45462/99999', room, here), null);
    assert.equal(followableUrl('https://laftel.net.evil.example/player/45462/93304', room, here), null);
    assert.equal(followableUrl('https://www.youtube.com/watch?v=x', room, here), null);
  });

  it('takes a member across known providers, but nowhere unknown', () => {
    // Joining a YouTube room from a Laftel page is the ordinary case.
    assert.equal(followableUrl('https://www.youtube.com/watch?v=abc', 'yt:abc', 'https://laftel.net/'),
      'https://www.youtube.com/watch?v=abc');
    // An unknown site only from that same site: a room cannot send people off to it.
    assert.equal(followableUrl('https://evil.example/v/1', 'evil.example:/v/1', 'https://laftel.net/'), null);
    assert.equal(followableUrl('https://video.example/v/1', 'video.example:/v/1', 'https://video.example/v/2'),
      'https://video.example/v/1');
  });

  it('refuses what no honest member sends', () => {
    const room = 'laftel:/player/1/2';
    const here = 'https://laftel.net/';
    for (const u of [
      undefined, '', 'not a url', 'javascript:alert(1)',
      'http://laftel.net/player/1/2',                 // a known provider is never downgraded
      'https://user:pw@laftel.net/player/1/2',
      'https://laftel.net/player/1/2#videosync=a.b',
    ]) {
      assert.equal(followableUrl(u, room, here), null, String(u));
    }
    assert.equal(followableUrl('https://laftel.net/player/1/2', '', here), null, 'a room with no media');
  });
});
