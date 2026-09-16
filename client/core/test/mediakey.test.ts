import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { continuesMedia, followableUrl, normalizeMediaKey, providerId, watchUrl } from '../src/adapter/mediakey.ts';
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
      // YouTube's identity is the id and nothing else. A page with no id is
      // not "the media at this path": keying it would take a member watching
      // the room's video in the miniplayer out of the room the moment they
      // open search, and offer to move the whole room onto the search page.
      'https://www.youtube.com/results?search_query=x',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?list=PL1',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/feed/subscriptions',
      'https://youtu.be/',
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
    videoWidth: 0, videoHeight: 0, duration: 0, paused: true, readyState: 0, muted: false, volume: 1, ...o,
  });

  it('prefers what is audibly playing over what is merely bigger', () => {
    const smaller = v({ videoWidth: 320, videoHeight: 180, paused: false, readyState: 4, muted: false });
    const bigger = v({ videoWidth: 1920, videoHeight: 1080, paused: true, readyState: 4 });
    assert.equal(pickVideo([bigger, smaller]), smaller);
  });

  it('never lets a muted autoplaying preview beat the paused feature', () => {
    // A paused room leaves the feature paused. A muted preview that plays on
    // its own is not the user choosing something else -- and picking it moves
    // the room's state onto the preview.
    const feature = v({ videoWidth: 1920, videoHeight: 1080, paused: true, readyState: 4 });
    for (const size of [[320, 180], [1920, 1080]] as const) {
      const preview = v({ videoWidth: size[0], videoHeight: size[1], paused: false, readyState: 4, muted: true });
      assert.equal(pickVideo([feature, preview], feature), feature, `${size.join('x')} preview, feature current`);
      if (size[0] < 1920) {
        assert.equal(pickVideo([preview, feature], null), feature, `${size.join('x')} preview, nothing current`);
      }
    }
    // Nor one that is merely silent.
    const quiet = v({ videoWidth: 320, videoHeight: 180, paused: false, readyState: 4, volume: 0 });
    assert.equal(pickVideo([feature, quiet], feature), feature);
    assert.equal(pickVideo([quiet, feature], null), feature);
  });

  it('keeps the current element through its own seek', () => {
    // A seek drops readyState to 1 while the position loads. Losing the
    // element then resets the detector and swallows the user's seek.
    const feature = v({ videoWidth: 1920, videoHeight: 1080, paused: false, readyState: 1 });
    const other = v({ videoWidth: 1920, videoHeight: 1080, paused: false, readyState: 4, muted: false });
    assert.equal(pickVideo([other, feature], feature), feature);
  });

  it('leaves the current element for one the user started, or when it lost its media', () => {
    const old = v({ videoWidth: 1920, videoHeight: 1080, paused: true, readyState: 4 });
    const next = v({ videoWidth: 1280, videoHeight: 720, paused: false, readyState: 4, muted: false });
    assert.equal(pickVideo([old, next], old), next, 'another element is audibly playing');
    const emptied = v({ paused: true, readyState: 0 });
    const loaded = v({ videoWidth: 1280, videoHeight: 720, paused: true, readyState: 4 });
    assert.equal(pickVideo([emptied, loaded], emptied), loaded, 'the current element has no media any more');
    const gone = v({ videoWidth: 3840, videoHeight: 2160, paused: false, readyState: 4 });
    assert.equal(pickVideo([loaded], gone), loaded, 'the current element left the document');
  });

  it('gives up a wrong first pick for a far larger picture', () => {
    // A banner that was on the page first gets picked first. Holding on to it
    // leaves the feature unwatched until the user presses play with sound --
    // and swapping elements at that moment undoes the play.
    const banner = v({ videoWidth: 320, videoHeight: 180, paused: true, readyState: 4 });
    const paused = v({ videoWidth: 1920, videoHeight: 1080, paused: true, readyState: 4 });
    const mutedPlaying = v({ videoWidth: 1920, videoHeight: 1080, paused: false, readyState: 4, muted: true });
    assert.equal(pickVideo([banner, paused], banner), paused, 'paused feature');
    assert.equal(pickVideo([banner, mutedPlaying], banner), mutedPlaying, 'muted feature');
    const sized0 = v({ paused: true, readyState: 1 });
    assert.equal(pickVideo([sized0, paused], sized0), paused, 'current has no picture at all');
    // Controls: stickiness still holds between comparable pictures, and
    // nothing takes over from an element the user is listening to.
    const hd = v({ videoWidth: 1280, videoHeight: 720, paused: true, readyState: 4 });
    assert.equal(pickVideo([hd, paused], hd), hd, '720p current, 1080p other: not outclassed');
    const listening = v({ videoWidth: 320, videoHeight: 180, paused: false, readyState: 4 });
    assert.equal(pickVideo([listening, paused], listening), listening, 'audible current');
    assert.equal(pickVideo([listening, mutedPlaying], listening), listening, 'audible current, muted feature');
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
    // ...but the start still clamps: a live stream corrected to a negative
    // position lands on 0.
    assert.equal(await settlesWithin(b.seekTo(-5), 500), 'resolved', 'before the start, no finite duration');
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
      // Before metadata, Firefox's "no audio" is only "not loaded yet".
      [{ readyState: 0, mozHasAudio: false }, undefined],
      [{ readyState: 0, audioTracks: { length: 0 } }, undefined],
      // Protected media may be decoded where the audio counter is not kept:
      // no sound counted there is not evidence of no sound.
      [{ mediaKeys: {}, webkitAudioDecodedByteCount: 0, webkitVideoDecodedByteCount: 5000 }, undefined],
      [{ mediaKeys: {}, webkitAudioDecodedByteCount: 800, webkitVideoDecodedByteCount: 5000 }, true],
      [{ mediaKeys: null, webkitAudioDecodedByteCount: 0, webkitVideoDecodedByteCount: 5000 }, false],
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

  it('goes only to the canonical page for the media, whatever URL was sent', () => {
    // The URL comes from another member. Naming the room's media is not
    // enough: any path or host under the provider can carry `?v=`, and any
    // query survives the path rule. Nobody may choose where everyone lands.
    const here = 'https://laftel.net/player/9/9';
    for (const [url, room, want] of [
      ['https://www.youtube.com/logout?v=abc', 'yt:abc', 'https://www.youtube.com/watch?v=abc'],
      ['https://www.youtube.com/redirect?v=abc&q=https://evil.example', 'yt:abc', 'https://www.youtube.com/watch?v=abc'],
      ['https://accounts.youtube.com/x?v=abc', 'yt:abc', 'https://www.youtube.com/watch?v=abc'],
      ['https://www.youtube.com/watch?v=abc&list=PL1&t=90', 'yt:abc', 'https://www.youtube.com/watch?v=abc'],
      ['https://laftel.net/player/1/2?next=https://evil.example', 'laftel:/player/1/2', 'https://laftel.net/player/1/2'],
      ['https://accounts.laftel.net/player/1/2', 'laftel:/player/1/2', 'https://laftel.net/player/1/2'],
      ['https://laftel.net/player/1/2', 'laftel:/player/1/2', 'https://laftel.net/player/1/2'],
    ] as const) {
      assert.equal(followableUrl(url, room, here), want, url);
    }
    // An unknown site, from that same site: origin and path, never the query.
    assert.equal(followableUrl('https://video.example/v/1?next=https://evil.example', 'video.example:/v/1',
      'https://video.example/v/2'), 'https://video.example/v/1');
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

describe('which media continues which (the next episode)', () => {
  const key = (u: string) => normalizeMediaKey(u)!;

  it('is another episode of the same Laftel series', () => {
    assert.equal(continuesMedia(key('https://laftel.net/player/45462/93304'), key('https://laftel.net/player/45462/93305')), true);
  });

  it('is never the same episode, another series, another provider, or nothing', () => {
    const e1 = key('https://laftel.net/player/45462/93304');
    assert.equal(continuesMedia(e1, e1), false);
    assert.equal(continuesMedia(e1, key('https://laftel.net/player/1/2')), false);
    assert.equal(continuesMedia(e1, key('https://laftel.net/item/45462')), false);
    assert.equal(continuesMedia(e1, key('https://www.youtube.com/watch?v=abc')), false);
    assert.equal(continuesMedia(e1, ''), false);
    assert.equal(continuesMedia('', e1), false);
  });

  it('is never anything on YouTube, whose autonav picks an arbitrary video', () => {
    assert.equal(continuesMedia(key('https://www.youtube.com/watch?v=a'), key('https://www.youtube.com/watch?v=b')), false);
  });

  it('is never anything on a site no rule knows', () => {
    assert.equal(continuesMedia(key('http://127.0.0.1:8898/watch/1'), key('http://127.0.0.1:8898/watch/2')), false);
  });
});

describe('an element that goes away', () => {
  it('is announced like a replacement, so nothing keeps judging the old one', () => {
    const vt = new VirtualTime();
    const sw = new SwappableAdapter();
    let fired = 0;
    sw.on('elementreplaced', () => { fired++; });
    sw.setTarget(null);
    assert.equal(fired, 0, 'nothing to nothing is not a change');
    sw.setTarget(new FakePlayer(vt));
    assert.equal(fired, 1);
    sw.setTarget(null);
    assert.equal(fired, 2);
    assert.equal(sw.readState().ended, false);
  });
});
