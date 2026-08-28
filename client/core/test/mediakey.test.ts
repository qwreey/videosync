import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeMediaKey, providerId } from '../src/adapter/mediakey.ts';
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
