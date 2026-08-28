# Risk-B findings — measured against a real browser

Chromium 151.0.7922.173, headless and headful under Xvfb. Harness in `harness/browser/`,
raw outputs in `harness/browser/results/`. Media is locally generated (`ffmpeg`), served by
`server.mjs`, which can starve the player on demand.

> **Environment caveat:** chromium/ffmpeg/Xvfb were installed with `pacman` on a host whose
> package state is not persistent. Re-installing them is a prerequisite for re-running any of
> this. See §6.

---

## 1. The stall signature is real — the detector design is validated

`docs/PROTOCOL.md` §4 gates seek detection on a signature that until now existed only in a model I
wrote. Observed on a real MSE player (hls.js), by delaying segment delivery mid-playback:

```
  t= 12940.0ms  ct=113.8639  paused=False rs=4  ahead= 0.156
  t= 13040.0ms  ct=113.9475  paused=False rs=2  ahead= 0.073   <-- freeze begins
  t= 13140.1ms  ct=113.9475  paused=False rs=2  ahead= 0.073
  ...                                                          (980 ms frozen)
```

`paused === false` with `currentTime` frozen, `readyState` dropping 4 → 2, and a `waiting` event.
**Exactly the assumed signature, and both halves of the guard fire.** The stall-inference work in
POC-FINDINGS §5 rests on solid ground.

## 2. Seek cost is entirely about whether the target is buffered

| segment delay | seek kind | `seeked` after | `readyState<3` | playback resumes |
|---|---|---|---|---|
| 0 ms | in-buffer | 1.0 ms | 0 ms | ~20 ms |
| 0 ms | out-of-buffer | 4.7 ms | 0 ms | ~20 ms |
| 50 ms | in-buffer | 1.1 ms | 0 ms | ~20 ms |
| 50 ms | out-of-buffer | 54 ms | 40 ms | 60 ms |
| 150 ms | in-buffer | 0.8 ms | 0 ms | ~20 ms |
| 150 ms | out-of-buffer | 155 ms | 140 ms | 180 ms |
| 400 ms | in-buffer | 1.2 ms | 0 ms | ~20 ms |
| 400 ms | out-of-buffer | 405 ms | 390 ms | 430 ms |

**An in-buffer seek is free (~20 ms) regardless of network conditions. An out-of-buffer seek costs
exactly one segment fetch, and rebuffers for that whole time.**

This reframes a design question. The simulation has been treating "hard seek" as uniformly
expensive and looking for ways to avoid it (POC-FINDINGS §19 flagged that seeks being *free* in the
harness flattered seek-based strategies — the truth is that they are free *sometimes*). The right
rule is not "avoid seeks", it is **"never seek outside the buffered range"**:

- A correction landing inside `video.buffered` costs nothing and should be preferred over a nudge.
- A correction landing outside it costs a full rebuffer, which makes the client *more* out of sync
  before it gets better, and can start a seek → rebuffer → residual → seek loop.
- The client already reports `bufferedAheadS`. It should report the buffered *range*, and the
  corrector should treat in-range and out-of-range seeks as different actions.

These are the constants that parameterise the harness fix.

## 3. Autoplay rejection, confirmed

With Chrome's default policy, `video.play()` without a user gesture rejects:

```
NotAllowedError: play() failed because the user didn't interact with the document first.
```

Confirmed by accident, and worth the accident: the first measurement run produced nothing but
paused-element numbers because of it. `docs/PROTOCOL.md` §5's typed-error + gesture-capture overlay
requirement is real, not defensive.

## 4. Timer throttling: audible playback is the exemption, and Workers are the escape hatch

Headless Chrome **does not throttle at all** — `visibilityState` goes to `hidden` and timers stay at
100 ms even after 70 s. Any throttling measurement taken in headless is worthless. Headful under
Xvfb reproduces the real behaviour:

| tab state | `setInterval` | `setTimeout` chain | **Worker** |
|---|---|---|---|
| visible | 100 ms | 100 ms | 100 ms |
| hidden, **audible** | **100 ms** | 100 ms | 100 ms |
| hidden, muted | **1000 ms** | 1000 ms | **100 ms** |

Three consequences for the client:

1. **A tab playing audible media is exempt from timer throttling.** That is the normal watch-party
   case, so the ~10 Hz local evaluation loop that every client-authority claim depends on
   (POC-FINDINGS §19, third gap) survives in the case that matters most.
2. **A hidden muted tab is clamped to 1 Hz** — the feared case, and it is real.
3. **Worker timers are not throttled even then.** This is now measured rather than assumed, and it
   makes the local loop implementable as a Worker-driven tick for the muted case.

## 5. Unresolved: does a hidden *muted* tab keep playing at all?

Two runs disagree and the contradiction is not yet explained.

- `probe-throttle4` (fresh browser per case, sampled from the driver every 5 s): a hidden muted
  HLS tab advanced **0.0 s over 85 s**, ratio 0.00 — while `readyState` stayed **4** and the buffer
  stayed **full at 11 s**. Audible: perfect 1.00.
- `probe-throttle3` (one browser, cases in sequence, 45 s dwell): the same hidden muted HLS case
  advanced **45.0 s over 45 s**, ratio 1.00.

If the `throttle4` result is the real one it matters a great deal, because that freeze is
**not a buffering stall and must not be treated as one**: `readyState` 4 with a full buffer and no
`waiting` event, versus §1's `readyState` 2 with an empty buffer and a `waiting` event. The correct
response differs — a buffering client should gate the room; a hidden suspended client should not,
or the room waits forever for someone who is not watching.

The two are distinguishable by `readyState` and `bufferedAhead`, so the detector can tell them
apart. But **which behaviour is real is not settled**, and no design should be built on either
until it is. Next step: isolate what differs between the two runs (fresh vs reused browser,
dwell length, tab-activation history).

## 6. Reproducing

```
pacman -S --needed chromium ffmpeg xorg-server-xvfb
cd harness/browser && node server.mjs &          # media + stall control
Xvfb :99 -screen 0 1280x800x24 &
DISPLAY=:99 node probe-throttle2.mjs             # headful: real throttling
node measure.mjs                                 # stall signature + seek cost
node probe-seekcost.mjs                          # seek cost vs segment delay
node probe-autoplay.mjs                          # autoplay policy
```

Media regenerates with the two `ffmpeg` commands in the repo history; `media/` is gitignored.
