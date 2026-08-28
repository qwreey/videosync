# Risk-A findings (simulation harness)

Run: `mise run sim`. Deterministic virtual clock, no browser, no network.
Four strategies x six scenarios. Numbers below are from the run committed with this doc.

**Headline: the derivative classifier, as specified in SYNTHESIS §4c, does not beat a plain
threshold. And all four strategies share a seek-storm failure mode that no reference implementation
documents.** Both results are why Risk A ran before any browser code.

---

## 1. The hypothesis in §4c is not supported

§4c claimed the derivative would avoid "unnecessary seeks" — seeks issued while the offset was
already closing on its own. **The `waste` counter is 0 in almost every cell.** The case barely
occurs.

Why the reasoning was wrong: a stall does not produce a *transient dip that recovers*. A browser
that stalls for 800 ms resumes at 1.0x and stays **permanently 800 ms behind**. Nothing pulls it
back. So "behind but closing" is not a naturally occurring state — it only exists while a
correction is already running.

Scoreboard on mean divergence (lower better), seeks issued in parentheses:

| scenario | threshold-500 | threshold-2000 | derivative | step-ramp |
|---|---|---|---|---|
| steady/rate-drift | **444** (5) | 1080 (0) | 764 (0) | 447 (3) |
| transient-hiccup | **26** (3) | 549 (1) | 461 (0) | 360 (1) |
| one-slow-client | **303** (13) | 504 (5) | 372 (5) | 342 (7) |
| clock-skew | 360 (0) | 360 (0) | 360 (0) | 360 (0) |
| latency-asymmetry | 1178 (**2598**) | **0** (0) | 320 (0) | 1178 (2569) |
| command-storm | 5038 (66) | 4486 (27) | 4971 (20) | **4564** (20) |

Plain `threshold-500` — hard-seek whenever the offset exceeds 500 ms, which is what jellyfin,
VideoTogether and syncwatch do — wins outright on divergence in three of six scenarios, and is
dramatically better on `transient-hiccup` (mean 26 ms vs 360-549 ms).

**What the nudge strategies actually buy is fewer seeks, not tighter sync.** That is a real
trade — a hard seek is a visible jump, and on MSE players it risks stalling outside the buffered
range (SYNTHESIS §7) — but it is a *UX* judgement, not the correctness win §4c claimed. It must be
argued on those terms or dropped.

### The reformulation that survived

`step-ramp` was written after the first run showed `derivative` losing. The useful distinction is
not "closing vs diverging" but **what shape the error has**:

- **ramp** (rate mismatch, residual growing at a steady small slope) — nudging fixes the *cause*;
  a seek would leave the mismatch in place and the gap would immediately reopen.
- **settled step** (a stall happened; large residual, slope ~ 0) — nudging is bounded by the rate
  clamp. At the 10 % cap it closes only 100 ms of gap per second, so an 800 ms step needs **8
  seconds of audibly fast playback**. Seek it.

`step-ramp` roughly matches `threshold-500` on divergence with far fewer seeks
(steady/rate-drift: 447 vs 444 mean, 3 seeks vs 5). That is a defensible position. `derivative`
as originally specified is not — it should be retired.

## 2. Seek storm under one-way latency asymmetry — new, and serious

`latency-asymmetry` gives one client a 20 ms uplink and a 1200 ms downlink. Min-RTT clock sync
cannot detect this (SYNTHESIS §1 already warned it is undetectable in principle); the offset
estimate ends up biased by roughly half the difference, ~590 ms.

That bias sits permanently outside a 500 ms tolerance, so:

**`threshold-500` issued 2598 seeks in 120 seconds. `step-ramp` issued 2569.**

Every seek "corrects" the client to a position it already believes it is at, the bias remains, and
the next report triggers another seek. A user would see continuous stutter. `threshold-2000`
escapes only because the bias fits inside its wider deadband, and `derivative` escapes only by
accident — it nudges instead of seeking, which does not fix a constant bias either but at least
does not thrash.

**This is not a classifier problem and cannot be fixed in the classifier.** The requirement it
implies:

> A correction that does not reduce the residual must not be reissued. Track per-client
> `residual before` vs `residual after` a seek; if N consecutive seeks fail to move it, stop
> seeking that client, treat its clock estimate as suspect, and re-baseline the residual against
> its own reported position instead of its estimated server time.

No reference implementation has anything like this. It goes on the SYNTHESIS §11 list.

## 3. Scenarios that proved too weak to conclude anything

Reported so a future session does not read them as evidence of safety:

- **clock-skew** — all four strategies identical (360 ms mean, 0 seeks). Min-RTT estimation removes
  a constant skew cleanly, so ±45 s and ±120 s skews are simply absorbed. The scenario tests the
  clock sync, and the clock sync passes; it does not discriminate between correctors.
- **command-storm** `maxDiv` (~272 s) is dominated by the seek-to-300000ms transition itself, not
  by sync error. `ConvergeMs` is the meaningful metric there, and all strategies converge within
  0–1000 ms including the two deliberately conflicting near-simultaneous commands at t=60 s.
  The no-host serialization (arrival order under the room mutex) held — no flapping.

## 4. What this changes

1. **Retire `DerivativeCorrector`.** Keep `StepRampCorrector` and justify it on seek-count, not
   on divergence.
2. **SYNTHESIS §4c's table needs rewriting** — the "behind but closing → do nothing" row is
   near-hypothetical. The real rows are ramp→nudge and step→seek.
3. **Add the failed-correction detector** (§2 above) before any browser work. It is a bigger
   correctness risk than the classifier choice.
4. Tolerance and deadband interact with clock-bias magnitude. A tight deadband is *dangerous*, not
   merely twitchy, when the offset estimate can be biased. This argues for the deadband being
   >= the worst plausible clock bias, or for the bias to be detected and subtracted.

## Still unmeasured (deliberately — these are Risk B)

Background-tab timer throttling, real MSE seek latency and buffered-range stalls, autoplay
rejection, and whether `playbackRate` nudging is even safe on the players we target.
The harness has no `setInterval` clamp and its seeks are instantaneous; **a green run here is not
evidence about a browser.**

---

# Round 2 — after the fixes

Full output: `docs/poc-run-2.txt`. Three changes: stall inference in the client detector,
a failed-correction detector with clock-bias learning on the server, and a `RampMaxSlope` bound
so a stall is not mistaken for a rate mismatch.

## 5. The stall-as-seek bug is real, and it is proven not assumed

A buffering stall reports `paused === false` while `currentTime` freezes. A detector that
dead-reckons the expected position (as syncplay does — `client.py:521-531` adds elapsed time
whenever `not self._playerPaused`, with **no buffering guard**) sees the gap grow past
`SEEK_THRESHOLD` and classifies it as a **backward user seek**, then broadcasts it and drags the
whole room back.

The harness now runs a control with the guard disabled:

```
CONTROL: stall inference DISABLED (= syncplay's behaviour)
  transient-hiccup   guard ON -> 0 misdetections   guard OFF -> 0
  long-stalls        guard ON -> 0 misdetections   guard OFF -> 13
```

13 spurious room-wide rewinds in 120 s from three stalls. `transient-hiccup` shows 0 either way
because its stalls are under 1 s — below `SEEK_THRESHOLD`, so they never trip the test. That is the
honest boundary of the finding: **only stalls longer than the seek threshold misdetect.**

The guard is two-part, and both parts are needed because `readyState` is not always reliable:
`readyState < HAVE_FUTURE_DATA`, **or** position frozen while `paused` is false — the signature is
exactly "not paused but not advancing". While suspected, the seek test is skipped and the reference
position is held; on resume it is re-baselined rather than judged.

**This makes stall inference load-bearing, not decorative.** Any client implementation that omits
it will drag the room backward on every buffer.

## 6. The seek storm is fixed — but the fix arrives too late

`latency-asymmetry`, threshold-500: **2598 seeks -> 6 seeks** (64 suppressed by cooldown, 2 clock
biases learned). The mechanism: track the residual before and after each seek; if N consecutive
seeks fail to cut it by half, stop blaming the player and absorb the residual as a learned bias in
our own clock estimate. It is the only way to observe a one-way asymmetry that min-RTT cannot see.

But divergence did **not** improve — mean stays 1184 ms for threshold-500 and step-ramp, while
`derivative` (which never seeks here) gets 320 ms. The reason matters:

> **Seeking on a biased clock estimate actively creates divergence that was not there.** All three
> clients were playing at exactly 1.0x and perfectly aligned; the only thing that moved them apart
> was our own corrections firing on a bad estimate. The six seeks that ran before the bias was
> learned did the damage, and learning the bias afterwards does not undo it.

**Implied requirement, not yet implemented:** do not issue seeks until the clock estimate is
trusted — require a minimum number of min-RTT samples and a stable `bestRTT` before corrections
are allowed, and prefer nudging while the estimate is still settling. This is cheaper than any
classifier change and it prevents the damage rather than bounding it.

## 7. Strategy scoreboard, round 2

Mean divergence, seeks in parentheses:

| scenario | threshold-500 | threshold-2000 | derivative | step-ramp |
|---|---|---|---|---|
| steady/rate-drift | **445** (3) | 1080 (0) | 764 (0) | 447 (3) |
| transient-hiccup | **26** (3) | 549 (1) | 461 (0) | **26** (3) |
| long-stalls | **72** (4) | **72** (4) | 593 (3) | **72** (4) |
| one-slow-client | 331 (3) | 515 (1) | 390 (1) | **326** (2) |
| clock-skew | 360 (0) | 360 (0) | 360 (0) | 360 (0) |
| latency-asymmetry | 1184 (6) | **0** (0) | 320 (0) | 1184 (6) |
| command-storm | 5360 (19) | 5305 (11) | 4541 (7) | **4390** (19) |

The `RampMaxSlope` bound was what closed the gap: a stall produces a slope near 1000 ms/s while a
1 % rate error produces 10 ms/s, so bounding "ramp" from above stops the classifier from nudging
its way through a discontinuity it should have seeked. **`step-ramp` now matches or beats
`threshold-500` on divergence in every scenario except `latency-asymmetry`, where they tie.**

`derivative` remains retired — it is best only in `latency-asymmetry`, and only by the accident of
never seeking.

## 8. Adopt

1. **Stall inference in the detector** — mandatory, proven load-bearing (§5).
2. **`StepRampCorrector`** — now defensible on divergence, not just on seek count (§7).
3. **Failed-correction detector + clock-bias learning** — bounds the storm (§6).
4. **NEW: gate corrections on clock-estimate confidence** (§6) — prevents the damage instead of
   bounding it. Not yet implemented; do this before Risk B.

## 9. Still not evidence about a browser

`clock-skew` remains non-discriminating across all four strategies — min-RTT absorbs a constant
skew cleanly, so the scenario tests the clock sync (which passes) and not the correctors.
`command-storm`'s `maxDiv` is the seek transition itself; `converge` (0–1100 ms across all
strategies, including the deliberately conflicting commands 50 ms apart) is the meaningful number
there, and the no-host arrival-order serialization held with no flapping.

The harness still has no `setInterval` clamp and its seeks are instantaneous. Background-tab
throttling, MSE seek latency, buffered-range stalls, autoplay rejection, and whether
`playbackRate` nudging is safe at all on the target players remain untested.
