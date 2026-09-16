import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { SeekDetector } from '../src/detector/detector.ts';
import type { PlayerState } from '../src/adapter/types.ts';

/** A player state builder with sane defaults, so each test states only what it means. */
function state(p: Partial<PlayerState> & { positionS: number }): PlayerState {
  return {
    paused: false, rate: 1, readyState: 4, muted: false, durationS: 600,
    buffered: [{ start: Math.max(0, p.positionS - 10), end: p.positionS + 11 }],
    bufferedAheadS: 11, bufferedBehindS: 10,
    ...p,
  };
}

/** Drives the detector at 100 ms with the room perfectly tracking the element. */
function run(
  d: SeekDetector,
  frames: Array<Partial<PlayerState> & { positionS: number; expectedS?: number }>,
) {
  const kinds: string[] = [];
  let t = 0;
  for (const f of frames) {
    const { expectedS, ...rest } = f;
    const expectedMs = expectedS === undefined ? f.positionS * 1000 : expectedS * 1000;
    kinds.push(d.evaluate(state(rest), expectedMs, t).observation.kind);
    t += 100;
  }
  return kinds;
}

const visible = () => false;
const hidden = () => true;

describe('SeekDetector', () => {
  test('steady playback produces no user intent', () => {
    const d = new SeekDetector(visible);
    const frames = Array.from({ length: 40 }, (_, i) => ({ positionS: 10 + i * 0.1 }));
    const kinds = run(d, frames);
    assert.equal(d.seekDetections, 0);
    assert.ok(kinds.every((k) => k === 'idle'), `unexpected kinds: ${[...new Set(kinds)]}`);
  });

  test('a local user seek is detected once', () => {
    const d = new SeekDetector(visible);
    // 20 quiet frames, then the element jumps 30 s while the room stays put.
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 42 + i * 0.1, expectedS: 12 + i * 0.1 })),
    ];
    const kinds = run(d, frames);
    assert.equal(kinds.filter((k) => k === 'seek').length, 1);
    assert.equal(d.seekDetections, 1);
  });

  test('a user seek is detected even when the player reports unready while seeking', () => {
    // Found live (BROWSER-FINDINGS §19). A real seek drops readyState: ~100 ms
    // at 1 for an in-buffer seek on a Widevine stream, far longer out of the
    // buffer on YouTube. The stall guard used to take any unready evaluation
    // as a buffering stall and re-baseline onto the new position -- so the
    // jump was absorbed, the seek never reached the room, and the room then
    // "corrected" the user straight back to where they had left.
    for (const unreadyFrames of [1, 8]) {
      const d = new SeekDetector(visible);
      const frames = [
        ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1 })),
        // Jumped to 120 s, frozen there while it loads, the room still at ~12 s.
        ...Array.from({ length: unreadyFrames }, (_, i) => ({ positionS: 120, readyState: 1, bufferedAheadS: 0, expectedS: 12 + i * 0.1 })),
        ...Array.from({ length: 10 }, (_, i) => ({ positionS: 120 + i * 0.1, expectedS: 13 + i * 0.1 })),
      ];
      const kinds = run(d, frames);
      assert.equal(kinds.filter((k) => k === 'seek').length, 1, `${unreadyFrames} unready frame(s): ${kinds.join(',')}`);
    }
  });

  test('a jump the room also made is NOT a seek -- this is the two-diff rule', () => {
    const d = new SeekDetector(visible);
    // The element jumps AND the room jumps with it: a server correction.
    // playerDiff is large, roomDiff is ~0, so it must not be rebroadcast.
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 42 + i * 0.1, expectedS: 42 + i * 0.1 })),
    ];
    const kinds = run(d, frames);
    assert.equal(d.seekDetections, 0, 'a correction was mistaken for user intent');
    assert.ok(!kinds.includes('seek'));
  });

  test('a buffering stall is a stall, never a backward seek', () => {
    const d = new SeekDetector(visible);
    // paused === false with a frozen currentTime and readyState 2: the exact
    // signature measured on a real MSE player.
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1 })),
      // frozen for 4 s while the room keeps moving
      ...Array.from({ length: 40 }, (_, i) => ({
        positionS: 12, readyState: 2, bufferedAheadS: 0, expectedS: 12 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.ok(d.stallDetections > 0, 'stall not detected');
    assert.equal(d.seekDetections, 0, 'a stall was mistaken for a user seek');
    assert.ok(!kinds.includes('seek'));
  });

  test('resuming from a stall does not produce a seek either', () => {
    const d = new SeekDetector(visible);
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1 })),
      ...Array.from({ length: 40 }, (_, i) => ({
        positionS: 12, readyState: 2, bufferedAheadS: 0, expectedS: 12 + i * 0.1,
      })),
      // resumes 4 s behind the room
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 12 + i * 0.1, expectedS: 16 + i * 0.1 })),
    ];
    run(d, frames);
    assert.equal(d.seekDetections, 0, 'the stall gap was rebroadcast as a seek on resume');
  });

  test('hidden + never-audible + paused is browser suspension, not a user pause', () => {
    const d = new SeekDetector(hidden);
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => ({ positionS: 10 + i * 0.1, muted: true })),
      // Chrome pauses it: readyState stays 4 and the buffer stays full, which
      // is what distinguishes this from buffering.
      ...Array.from({ length: 30 }, (_, i) => ({
        positionS: 11, paused: true, muted: true, readyState: 4, expectedS: 11 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.ok(kinds.includes('suspended'), 'suspension not detected');
    assert.ok(!kinds.includes('playstate'), 'a browser pause was reported as user intent');
    assert.equal(d.suspensions, 1);
  });

  test('the same pause while VISIBLE is user intent', () => {
    const d = new SeekDetector(visible);
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => ({ positionS: 10 + i * 0.1, muted: true })),
      ...Array.from({ length: 10 }, (_, i) => ({
        positionS: 11, paused: true, muted: true, expectedS: 11 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.ok(kinds.includes('playstate'), 'a genuine pause was swallowed');
    assert.equal(d.suspensions, 0);
  });

  test('a tab that WAS audible is exempt, so a later pause there is user intent', () => {
    // Measured: Chrome exempts a playback that has produced sound, permanently.
    // Muting afterwards does not bring the exemption back down, so a pause in
    // that state is a real one.
    const d = new SeekDetector(hidden);
    const frames = [
      // audible for a while...
      ...Array.from({ length: 10 }, (_, i) => ({ positionS: 10 + i * 0.1, muted: false })),
      // ...then muted, then paused while hidden
      ...Array.from({ length: 10 }, (_, i) => ({
        positionS: 11, paused: true, muted: true, expectedS: 11 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.equal(d.suspensions, 0, 'an exempt tab was treated as browser-suspended');
    assert.ok(kinds.includes('playstate'), 'a genuine pause was swallowed');
  });

  test('an unmuted hidden pause is user intent -- media keys reach hidden tabs', () => {
    const d = new SeekDetector(hidden);
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => ({ positionS: 10 + i * 0.1, muted: false })),
      ...Array.from({ length: 10 }, (_, i) => ({
        positionS: 11, paused: true, muted: false, expectedS: 11 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.ok(kinds.includes('playstate'),
      'document.hidden alone was used to suppress; media-key pauses would be lost');
  });

  test('a video sitting at its end is not a stall', () => {
    // Frozen currentTime at the duration: the stall signature minus the reason.
    // Gating the room on this would hold it for a member who has finished.
    //
    // The frames have to be ones only the end-of-media guard can decide: a
    // finished element reports readyState 2 with nothing buffered ahead, and
    // may still read `paused: false`. A paused readyState-4 frame is not a
    // stall with or without the guard, so it proves nothing about it.
    for (const paused of [true, false]) {
      const d = new SeekDetector(visible);
      const frames = Array.from({ length: 30 }, (_, i) => ({
        positionS: 600, durationS: 600, paused, readyState: 2, bufferedAheadS: 0,
        expectedS: 600 + i * 0.1,
      }));
      run(d, frames);
      assert.equal(d.stallDetections, 0, `paused=${paused}: the end of the video was reported as buffering`);
    }
    // Control: the same frames short of the end ARE a stall.
    const d = new SeekDetector(visible);
    run(d, Array.from({ length: 30 }, (_, i) => ({
      positionS: 300, durationS: 600, paused: false, readyState: 2, bufferedAheadS: 0,
      expectedS: 300 + i * 0.1,
    })));
    assert.ok(d.stallDetections > 0, 'control: a frozen, unready element mid-video is a stall');
  });

  test('media with no audio track is never audible, so its hidden pause is suspension', () => {
    // BROWSER-FINDINGS §5 condition C: Chrome pauses a hidden tab whose media
    // has no audio track at all, unmuted or not. "Unmuted and playing" is not
    // "made a sound" when there is nothing to hear.
    const d = new SeekDetector(hidden);
    const frames = [
      ...Array.from({ length: 20 }, (_, i) => ({ positionS: 10 + i * 0.1, muted: false, hasAudio: false })),
      ...Array.from({ length: 10 }, (_, i) => ({
        positionS: 12, paused: true, muted: false, hasAudio: false, expectedS: 12 + i * 0.1,
      })),
    ];
    const kinds = run(d, frames);
    assert.ok(!kinds.includes('playstate'), `a browser pause was reported as user intent: ${kinds.join(',')}`);
    assert.equal(d.suspensions, 1);

    // Control: the same playback WITH an audio track is exempt, so the pause is
    // a user's (a media key), and an adapter that cannot tell keeps it that way.
    for (const hasAudio of [true, undefined]) {
      const c = new SeekDetector(hidden);
      const ck = run(c, frames.map((f) => ({ ...f, hasAudio })));
      assert.ok(ck.includes('playstate'), `hasAudio=${hasAudio}: a genuine pause was swallowed`);
      assert.equal(c.suspensions, 0);
    }
  });

  test('pressing play at a slow playback rate is reported, not read as a stall', () => {
    // At 0.25x the position advances a quarter of wall time. A freeze test
    // that ignores the rate reads every such sample as frozen, and the stall
    // branch never reports a play-state change -- so the play never reaches
    // the room, and the room then pauses the member back.
    for (const rate of [0.25, 0.5, 1]) {
      for (let seed = 1; seed <= 5; seed++) {
        const d = new SeekDetector(visible);
        let t = 0;
        let pos = 10_000;
        let rnd = seed;
        const jitter = () => { rnd = (rnd * 16807) % 2147483647; return (rnd / 2147483647 - 0.5) * 40; };
        const kinds: string[] = [];
        for (let i = 0; i < 5; i++) {
          kinds.push(d.evaluate(state({ positionS: pos / 1000, paused: true, rate }), pos, t).observation.kind);
          t += 100;
        }
        const roomStart = pos;
        const playAt = t;
        for (let i = 0; i < 30; i++) {
          const step = 100 + jitter();
          t += step;
          pos += step * rate;
          const expected = roomStart + (t - playAt) * rate;
          kinds.push(d.evaluate(state({ positionS: pos / 1000, rate }), expected, t).observation.kind);
        }
        assert.equal(kinds.filter((k) => k === 'playstate').length, 1, `rate ${rate} seed ${seed}: ${kinds.join(',')}`);
        assert.equal(d.stallDetections, 0, `rate ${rate} seed ${seed}: slow playback read as a stall`);
      }
    }
    // Control: a slow element that genuinely stops moving is still a stall.
    const d = new SeekDetector(visible);
    run(d, [
      ...Array.from({ length: 10 }, (_, i) => ({ positionS: 10 + i * 0.025, rate: 0.25 })),
      ...Array.from({ length: 10 }, () => ({ positionS: 10.25, rate: 0.25, expectedS: 10.25 })),
    ]);
    assert.ok(d.stallDetections > 0, 'control: a frozen slow element is a stall');
  });

  test('a stall caught by a throttled evaluation is not a seek', () => {
    // A hidden, once-audible tab keeps playing but its timer runs at ~1 Hz, so
    // a whole second of playback can lie between the last evaluation and the
    // one the `waiting` event triggers. Being nudged at 1.1x while 1-3 s behind
    // is exactly when the room-diff half of the test is already satisfied. The
    // playback in between is not a jump -- wherever in that second the stall
    // began.
    // Chrome throttles a hidden tab's timers to 1 Hz, and further after a
    // while; the detector caps the gap it will trust at 5 s.
    for (const gap of [1000, 2000, 4000]) {
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const d = new SeekDetector(hidden);
        const rate = 1.1;
        let t = 0;
        let pos = 100_000;
        const behind = 3000;
        for (let i = 0; i < 10; i++) {
          d.evaluate(state({ positionS: pos / 1000, rate }), pos + behind, t);
          t += gap;
          pos += gap * rate;
        }
        // The last evaluation was one gap ago. The stall began `frac` of the
        // way through the interval since then.
        pos -= gap * rate;
        pos += gap * rate * frac;
        const { observation } = d.evaluate(
          state({ positionS: pos / 1000, rate, readyState: 2, bufferedAheadS: 0 }), pos + behind + gap, t,
        );
        assert.equal(observation.kind, 'stall',
          `gap ${gap} ms: stall at ${frac} of the interval read as ${observation.kind}`);
        assert.equal(d.seekDetections, 0);
      }
    }
    // Control: at the same cadence, a real jump while unready is still a seek,
    // forward or back.
    for (const jumpMs of [30_000, -30_000]) {
      const d = new SeekDetector(hidden);
      let t = 0;
      let pos = 100_000;
      for (let i = 0; i < 10; i++) {
        d.evaluate(state({ positionS: pos / 1000 }), pos, t);
        t += 2000;
        pos += 2000;
      }
      pos += jumpMs;
      const { observation } = d.evaluate(
        state({ positionS: pos / 1000, readyState: 1, bufferedAheadS: 0 }), pos - jumpMs, t,
      );
      assert.equal(observation.kind, 'seek', `a ${jumpMs} ms jump at 0.5 Hz was not a seek`);
    }
  });

  test('slope measures the rate error and is immune to a constant offset', () => {
    const d = new SeekDetector(visible);
    // The element runs 1% slow: residual grows by 10 ms per second. A constant
    // 500 ms clock bias is added to every expectation and must not change it.
    let last = 0;
    for (let i = 0; i < 40; i++) {
      const pos = 10 + i * 0.099;              // 0.99x
      const expected = 10 + i * 0.1 + 0.5;     // room + a fixed 500 ms bias
      const { report } = d.evaluate(state({ positionS: pos }), expected * 1000, i * 100);
      if (report) last = report.slopeMsPerS;
    }
    assert.ok(last < -5 && last > -15, `expected about -10 ms/s, got ${last.toFixed(1)}`);
  });
});
