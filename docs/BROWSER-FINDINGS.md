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
2. **A hidden muted tab is clamped to 1 Hz** — the feared case, and it is real. But see §5: such a
   tab is also *paused by the browser*, so the 1 Hz clamp matters less than it first appears — the
   client is not behind, it is absent.
3. **Worker timers are not throttled even then.** This is now measured rather than assumed, and it
   makes the local loop implementable as a Worker-driven tick for the muted case.

## 5. RESOLVED — Chrome *pauses* a muted video when its tab is hidden

The round-1 contradiction is settled, and the answer is more consequential than either
alternative. `probe-throttle3` was simply wrong: it never verified that the tab had actually
become hidden. `probe-throttle5` asserts `visibilityState === "hidden"` on every row.

| tab | hidden | `readyState` | buffer | events on hide | on re-show |
|---|---|---|---|---|---|
| **muted** | **`paused` becomes `true`** | 4 | full (11.5 s) | **`pause`** | resumes itself, **`play` + `playing`** |
| audible | keeps playing | 4 | full | none | none |

Identical for MSE (hls.js) and native progressive playback, so this is a media-pipeline policy,
not an MSE/JS-timer effect. Unmuting *while hidden* does not rescue it — it stays paused until the
tab is shown again.

### This is a protocol bug, not a curiosity

The browser emits a **genuine `pause` event**, indistinguishable at the DOM level from the user
pressing pause. A naive client broadcasts it, and:

- **one member backgrounding a muted tab pauses the entire room**;
- when they switch back, the browser emits `play` and **the room resumes** — even if it had been
  deliberately paused by someone else.

Both directions are wrong, and both would ship without this measurement. Note that the stall
detector (§1) is *not* the defence here: it only treats a freeze while `paused === false` as an
anomaly, and this freeze sets `paused === true`, so it passes straight through as user intent.

### The rule

> A `play` or `pause` event that arrives while `document.hidden` is true **and** `video.muted` is
> true is browser-initiated suspension, never user intent. Do not broadcast it. Mark the member
> suspended, and suppress the paired event when the tab is shown again.

`document.hidden` alone is not sufficient: hardware media keys and the Media Session API can
deliver *genuine* user pauses to a hidden tab. The `muted` conjunct is what distinguishes the
browser's own power-saving pause from a real one.

A suspended member is **absent, not buffering** — the readiness gate must not hold the room for
them (§6 of SYNTHESIS assumes buffering is why a member is behind). This is a membership state,
not a timing state.

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
