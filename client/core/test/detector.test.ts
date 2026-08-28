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
    const d = new SeekDetector(visible);
    // Frozen currentTime at the duration: the stall signature minus the reason.
    // Gating the room on this would hold it for a member who has finished.
    const frames = Array.from({ length: 30 }, (_, i) => ({
      positionS: 600, durationS: 600, paused: true, expectedS: 600 + i * 0.1,
    }));
    run(d, frames);
    assert.equal(d.stallDetections, 0, 'the end of the video was reported as buffering');
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
