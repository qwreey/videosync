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
2. **A hidden muted tab is clamped to 1 Hz** — the feared case, and it is real. But see §5: a
   *never-audible* hidden tab is also paused outright by the browser, so for that case the client
   is not behind, it is absent. A tab that was audible and is now muted keeps playing **and** is
   throttled, which is the combination the `Worker` tick exists for.
3. **Worker timers are not throttled even then.** This is now measured rather than assumed, and it
   makes the local loop implementable as a Worker-driven tick for the muted case.

## 5. Chrome pauses a hidden tab's video — but only if it has NEVER been audible

**This section corrects an earlier, overstated version of itself.** The first measurement showed a
hidden *muted* tab being paused and concluded the trigger was `hidden && muted`. Building the
detector against that rule produced a test that would not reproduce, which forced a four-condition
experiment (`probe-bgpause2.mjs`):

| condition | result |
|---|---|
| A — muted **before** play, never audible | **paused** by the browser |
| B — played audibly, **then** muted, then hidden | keeps playing |
| C — media with **no audio track at all** | **paused** |
| D — audible throughout | keeps playing |

So the trigger is **"this playback has never produced sound"**, not "it is muted right now".
`hidden && muted` was wrong: it would have suppressed genuine pauses in case B.

The exemption is also **sticky at tab level**: once a tab has played audibly it stays exempt, and
reloading the element does not reset it. Reproducing case A requires a fresh browser.

### Observed behaviour in the vulnerable case

| | value while hidden |
|---|---|
| `paused` | **`true`** (the browser did it) |
| `readyState` | 4 |
| buffered ahead | 10.9 s — full |
| event on hide | **`pause`** |
| on re-show | resumes itself, fires `play` + `playing` |

### Why it is a protocol bug

The browser emits a **genuine `pause` event**, indistinguishable at the DOM level from the user
pressing pause. Broadcast naively:

- one member who started muted and switched tabs **pauses the entire room**;
- switching back emits `play` and **resumes it** — even a room someone deliberately paused.

The stall detector is not the defence: it only treats a freeze while `paused === false` as an
anomaly, and this freeze sets `paused === true`.

### The rule, as implemented

> Track whether the element has **ever been audible** (`!paused && !muted` observed at least once
> this playback). A `pause` while `document.hidden` on a never-audible playback, with
> `readyState >= 3` and a full buffer, is browser suspension. Never broadcast it; mark the member
> **suspended** and suppress the paired `play` on re-show.

`document.hidden` alone cannot be the test — media keys and the Media Session API deliver genuine
user pauses to hidden tabs.

A suspended member is **absent, not buffering**: the readiness gate must not hold the room for
them. The two are distinguishable by exactly the table above — suspension is `paused === true`
with `readyState` 4 and a **full** buffer; buffering is `paused === false` with `readyState < 3`
and a **draining** one.

## 5b. Media does not load at all in a hidden tab

Found while debugging a hang: calling `hls.loadSource()` in a tab that is not visible never
resolves — `loadedmetadata` does not fire. Any client that tries to prepare a stream while
backgrounded will hang rather than fail, so preparation must be deferred to visibility.

## 5c. The shipping detector, validated end to end

`probe-detector.mjs` runs the **actual bundled `client/core` detector** — not a model of it —
against a live `<video>` in the pinned container. All eight assertions pass:

| assertion | result |
|---|---|
| steady playback broadcasts nothing | 40/40 samples `idle` |
| a genuine user seek IS broadcast | one `seek` |
| a server-applied correction is NOT rebroadcast | 0 broadcasts — the two-diff rule works on a real element |
| a buffering stall is detected as a stall | 20 `stall` samples |
| a stall broadcasts nothing | 0 |
| a never-audible hidden tab is detected as suspension | 6 `suspended` samples |
| suspension broadcasts nothing | 0 |
| resuming from suspension broadcasts nothing | 0 |

Run it with `mise run probe`.

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
