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

---

# Round 3 — clock-confidence gating

Full output: `docs/poc-run-3.txt`. Locked in by `server/internal/sim/regression_test.go`.

## 10. Treat the offset as an interval, not a point

Round 2 left an implied requirement: do not correct until the clock estimate is trusted. The
principled form of that is not a timer or a sample count — it is an **error bound**.

With min-RTT sampling the offset error is bounded by **±bestRTT/2**, reached exactly when the path
is fully asymmetric. That is NTP's "maximum error". A residual smaller than that bound is
**indistinguishable from our own measurement error**, so acting on it is guesswork — and round 2
measured what guesswork costs.

Implemented as a decorator (`ConfidenceGated`) so it composes with any strategy and can be A/B'd:

- fewer than `MinClockSamples` exchanges → no position correction at all (buffering gating stays
  live, since it reads the player directly and needs no clock);
- otherwise widen the dead-band to `max(ToleranceMs, UncertaintyMs)`.

The client reports `UncertaintyMs` and `ClockSamples` alongside the residual, so the server judges
with the client's own error bound in hand.

## 11. Result: strictly free, and it fully fixes the asymmetry case

Mean divergence, seeks in parentheses:

| scenario | threshold-500 | step-ramp | **step-ramp+conf** |
|---|---|---|---|
| steady/rate-drift | 445 (3) | 447 (3) | 447 (3) |
| transient-hiccup | **26** (3) | **26** (3) | **26** (3) |
| long-stalls | **72** (4) | **72** (4) | **72** (4) |
| one-slow-client | 331 (3) | 326 (2) | **326** (2) |
| clock-skew | 360 (0) | 360 (0) | 360 (0) |
| latency-asymmetry | 1184 (6) | 1184 (6) | **0** (0) |
| command-storm | 5360 (19) | 4390 (19) | **4169** (19) |

Gating changes **nothing** on healthy links — identical numbers, cell for cell — and takes
`latency-asymmetry` from 1184 ms mean and 6 seeks to **0 ms and 0 seeks**. It is a strict
improvement, which is rare enough to be worth stating plainly.

`step-ramp+conf` is now the strategy to build.

## 12. A bug worth recording, because the first result looked like a design failure

The first gated run was catastrophic — `long-stalls` mean went 72 → 5946 ms with zero seeks. That
read as "gating is too aggressive". It was not: `ClockSamples` was counting only *accepted*
(new-minimum) samples. The minimum RTT is found within the first few probes and then almost never
improves, so the counter froze at 2, never reached `MinClockSamples`, and corrections stayed
disabled for the whole session.

Counting completed exchanges instead fixed it. The lesson is about the metric, not the design: **a
confidence signal must not be derived from a quantity that stops changing once it converges.**

## 13. Regression tests

`server/internal/sim/regression_test.go` locks in four findings, each with a control where a
control is what makes the assertion meaningful:

- stall guard on → 0 misdetections, **and** guard off → non-zero (a zero alone proves nothing);
- confidence gating → 0 seeks and ~0 divergence on a pure clock bias, **and** ungated → non-zero
  seeks (so the scenario is still stressing the bias);
- gating does not degrade a healthy scenario;
- two conflicting no-host commands 50 ms apart converge without flapping.

`mise run test`.

## 14. What is still open

The failed-correction detector and bias learning (round 2 §6) are now mostly redundant on the
scenarios we have — confidence gating prevents the bad seeks that they existed to bound. They are
kept as a backstop for biases that exceed the error bound (a clock that is *wrong*, not merely
*uncertain*), but that case is not currently exercised by any scenario. **Unmeasured code.**

Everything in "Still not evidence about a browser" from round 2 remains true.

---

# Round 4 — three harness defects, found by adversarial review

An independent review of the architecture found three implementation defects in the harness itself.
All three were verified in the code and fixed. Full output: `docs/poc-run-4.txt`.

## 15. Corrections must not carry an absolute position

`MsgCorrect` carried `TargetMs = anchor.Expected(now)` computed at **send** time, and the client
assigned it verbatim on **arrival**. Every hard seek therefore landed one downlink-delay behind, by
construction. The `When` field was ignored entirely.

Fixed by removing `TargetMs` from the message: a correction now says only *that* the client should
re-sync, and the client re-derives `Expected()` from its own anchor at apply time. This is a
protocol rule, not a harness detail — **never send a position that will be stale on arrival.**

The cost was real and it was not confined to the pathological scenario:

| scenario | mean before | mean after |
|---|---|---|
| transient-hiccup | 26 | **5** |
| long-stalls | 72 | **20** |
| one-slow-client | 331 | **217** |

## 16. `p95` was `max()` for every realistic room size

`idx := (len*95 + 99) / 100`, clamped to `len-1`, selects the maximum for every n below ~40.
SYNTHESIS §2's stated reason for using p95 — "so one outlier cannot dominate" — was therefore
delivered by no code path; the 2000 ms cap was the only protection.

A percentile is meaningless at n=3 and no index arithmetic fixes that. Replaced with
**second-highest for n>=3, max below that**, which is the smallest honest "drop the worst outlier",
and SYNTHESIS §2 should be amended to say so rather than claiming a percentile.

## 17. The command delay was contaminated by one client's clock bias

`s.pings[id] = now - r.AtServerMs` derived the ping from the client's **estimated** server time, so
a client with a biased offset pushed that bias into the scheduling delay for the entire room.
Replaced with the client's own measured `bestRTT`, which is a difference of two same-clock
timestamps and therefore carries no offset error.

## 18. But the round-2 conclusion survives — with a corrected explanation

The review's headline claim was that `latency-asymmetry`'s 1184 ms was client b's 1200 ms downlink
rather than clock bias, making round 2 §6 unproven. **Measured: it moved 1184 → 1150, about 3 %.**
The attribution was wrong; the two numbers were close by coincidence.

The actual mechanism, which the arithmetic confirms exactly:

```
b: up=20, down=1200  -> offset = (20 + (-1200))/2 = -590 ms   (believes it is 590 ms ahead)
c: up=1200, down=20  -> offset = (1200 + (-20))/2 = +590 ms   (believes it is 590 ms behind)
```

Each client is pulled toward its *own* biased notion of correct, in opposite directions. The
separation is **2 x 590 = 1180 ms**, which is what we measure. So round 2 §6 stands as written:
seeking on a biased clock estimate actively creates divergence that was not there. Confidence
gating (round 3) remains the fix, and still takes this scenario to 0.

Recording this because the review's reasoning was sound and its demand for the fix was right — the
bugs were real and worth 3-5x on the healthy scenarios — while its numerical attribution was not.
Fixing a confound is worth doing even when it turns out not to have been the cause.

## 19. Harness gaps that block the next round of comparisons

Named by the same review, all confirmed absent:

- **Seeks are free.** No `SeekLatencyMs` or post-seek rebuffer cost, so any strategy that trades
  seeks for accuracy is being scored on a benefit with no price attached. This flatters hard-seek
  strategies and is the single most misleading gap.
- **No join / leave / reconnect scenario exists at all.** Late joiners, state recovery, and
  reconnect storms are entirely unmeasured.
- **No background-throttle profile.** Every client-side-authority claim rests on a ~10 Hz loop
  that a backgrounded tab clamps to ~1 Hz, and D5's userscript cannot guarantee otherwise.
- Missing metrics: transition spread across clients, correction efficacy (which would have caught
  §15 immediately), and rate churn.

These belong to the next round, before any further strategy comparison is trusted.

---

# Round 5 — two findings from the timebase review, both verified here

Full output: `docs/poc-run-5.txt`. Both were checked against the code before being accepted.

## 20. The command sender was exempt from its own command

`MsgAck` carried `{reqId, seq, anchor}` — no `when`. The client set the anchor from it but never
applied the transition: `paused` and `posMs` were untouched. **The member who pressed pause was the
one member who did not pause.** `docs/PROTOCOL.md` §3 specified it that way, so this was a protocol
defect, not a harness slip.

Adding `when` to the ack and scheduling the sender like everyone else:

| | before | after |
|---|---|---|
| command-storm mean divergence | 4743 ms | **32 ms** |
| seeks issued | 19 | **0** |
| converge after each command | [0 400 1000 0 50 900] | **[0 0 0 0 50 0]** |

**The entire `command-storm` row of every earlier table was measuring this bug**, not any property
of a correction strategy. Round 2 §7 and round 3 §11 should be read with that column struck out.

The existing regression suite passed with the bug present, which is exactly the gap a suite is
supposed to close. `TestSenderAppliesItsOwnCommand` now covers it.

## 21. Scheduled commands launder clock bias into media position, invisibly

This is the more serious finding, and it **scopes round 3's headline result**.

Round 3 reported `latency-asymmetry` going to 0 ms / 0 seeks under confidence gating. That holds
**only because the scenario issues no commands.** A new scenario, identical but with one
pause/play pair:

| scenario | step-ramp+conf mean | max | seeks | bias learned |
|---|---|---|---|---|
| latency-asymmetry (no commands) | 0 | 0 | 0 | 0 |
| **asymmetry+cmds** | **838 ms** | **1180 ms** | **0** | **0** |

The mechanism, confirmed by the arithmetic:

A client with offset bias `B` applies a scheduled command when *its* estimate reaches `when` — that
is `B` off in true time — and derives its position as `Expected(estimated now)`, using the same
biased clock. The two errors do not cancel in media position; they **cancel in the residual**:

```
pos(T)      = Expected(when) + (T - (when + B))  = Expected(T) - B
expected(T) = Expected(T + B_est)                = Expected(T) - B
residual    = 0                                            <-- exactly zero
```

So the error lands in real media position, and the channel we use to detect error reads zero. Note
the seeks and bias-learned columns: **0 and 0**. The corrector does not fail to fix it; it never
sees it. The round-2 failed-seek/bias-learning machinery is structurally blind here — it needs a
non-zero residual and gets exactly zero.

### What this means

`ConfidenceGated` is not a fix for path asymmetry. It fixes the half of the problem that is
*visible in the residual* (steady-state correction), and does nothing for the half that enters
through the scheduling path. That is a real limit and it should be stated plainly rather than left
implied by a scenario that happens not to issue commands.

The bound is the consolation: the laundered error is `|B| <= R_min/2`, which is exactly the
`UncertaintyMs` already on the wire (measured: bias 590 ms, uncertainty 610 ms). **No passive
channel can detect it** — its magnitude is bounded by the uncertainty of every channel available to
measure it. So the honest response is not a better estimator but to *bound and disclose*:

1. Floor `CMD_DELAY` and the tolerance band at the room's worst `UncertaintyMs`.
2. Surface the resulting sync guarantee in the UI, since it cannot be measured away.

`TestSchedulingLaundersClockBias` pins the known-bad numbers so that any future fix shows up as a
failing test rather than passing unnoticed.

## 22. Corrections owed to earlier rounds

- Round 3 §11 "strictly free, and it fully fixes the asymmetry case" — **overstated.** It fixes the
  command-free case. Scope it to steady-state correction.
- Every `command-storm` figure before round 5 measured the §20 bug.
- Round 2 §6's failed-seek detector and bias learning are now known to be blind to the dominant
  asymmetry path, on top of already being unexercised elsewhere (round 3 §14).

---

# Round 6 — control-theoretic correctors, ported and re-measured

An independent review proposed control-loop correctors and reported beating the baseline in 10 of
11 scenarios. Its work was developed in a worktree branched at round 2 — **before** the seek-target
fix (§15), the `ack.When` fix (§20), and confidence gating existed. Its code was ported onto the
current HEAD and re-measured. Full output: `docs/poc-run-6.txt`.

## 23. Primary metric changed: `anchorErr`, not inter-client spread

The review's most valuable contribution is methodological, and it invalidates part of how earlier
rounds were scored.

**`MeanDivergenceMs` is inter-client spread, and it rewards inaction.** In `latency-asymmetry` all
clients start aligned at exactly 1.0x, so a strategy that does nothing scores a perfect **0** —
which is exactly how `threshold-2000` "won" that row in rounds 3-5. Spread cannot distinguish
"correctly did nothing" from "was never tested", and it cannot see the whole room drifting away
from the anchor together.

Replaced as primary by **`anchorErr = |clientPos - anchor.Expected(TRUE server time)|`**, sampled
at 10 Hz against the real clock rather than any client's estimate of it, blanked for 4 s after each
command. Spread is retained for continuity but must not be ranked on.

Under the honest metric `threshold-2000`'s free win disappears: `latency-asymmetry` 0 spread but
**10 ms anchorErr**, and `steady/rate-drift` 364/1011.

## 24. The observability argument is correct and the predictions hold

The review's organizing claim:

```
res(t)      = pos(t) - anchor.Expected(clientClock(t) + estOffset)
d/dt res(t) = effectiveRate - 1          for any constant offset error b
```

**Phase is unobservable up to the clock bias; the slope is not.** Every prediction that follows
from it reproduced on the fixed harness:

- **PLL (integrator on phase)** — best in class when the clock is clean: `steady/rate-drift`
  **4/9 ms** vs the baseline's 160/455, a 40x improvement, and `clock-skew` **4/9** vs 124/333.
  And it walks straight into the §6 trap under asymmetry: **374/599**. An integrator's job is to
  eliminate a constant offset, including a fictitious one.
- **FLL (integrates slope only)** — perfectly bias-immune (`latency-asymmetry` **10/10**) and
  catastrophic on steps (`long-stalls` **2666/13466**, `transient-hiccup` 437/2290). It cannot
  close a phase offset by construction. Necessary, not sufficient.

## 25. But the headline win does not replicate

`HybridCorrector` was reported as beating `StepRampCorrector` in 10 of 11 scenarios. On the fixed
harness it does not. Anchor error, mean/p95 ms:

| scenario | threshold-500 | step-ramp+conf | pll | fll | hybrid |
|---|---|---|---|---|---|
| steady/rate-drift | 160/455 | 163/472 | **4/9** | 24/42 | 41/65 |
| transient-hiccup | **12/15** | **12/15** | 34/185 | 437/2290 | **12/15** |
| long-stalls | **18/15** | **18/15** | 117/32 | 2666/13466 | 954/7490 |
| one-slow-client | **77/345** | 82/469 | 145/79 | 1077/4390 | 465/3679 |
| clock-skew | 124/333 | 124/333 | **4/9** | 103/287 | 262/1279 |
| latency-asymmetry | 390/595 | **10/10** | 374/599 | **10/10** | 16/25 |
| asymmetry+cmds | 389/600 | 295/600 | 373/605 | **294/595** | **294/595** |
| command-storm | 14/25 | 14/25 | 13/46 | **11/35** | 16/35 |

`hybrid` loses badly on `long-stalls` (954 vs 18), `one-slow-client` (465 vs 77) and `clock-skew`
(262 vs 124).

**The explanation is the baseline it was measured against.** Its worktree predates the seek-target
and `ack.When` fixes, both of which improved the hard-seek strategies substantially (§15: hiccup
26→5, stalls 72→20; §20: command-storm 4743→32). It beat a handicapped opponent. This is the second
time in this project that a result turned out to be about the harness rather than the strategy, and
it argues for re-running any comparison after a harness fix, not just the affected row.

## 26. `ConfidenceGated` does not compose with continuous controllers

`pll+conf` scores **373/598** on `latency-asymmetry` — indistinguishable from bare `pll` at
374/599. The gating did nothing.

The decorator works by widening `Tunables.ToleranceMs` to the client's uncertainty. That only has
an effect on a corrector that **consults the dead-band**. A continuous controller acts on every
sample by construction and never reads it, so the decorator is a no-op for it.

This is a structural limit, not a tuning problem: for a control law, confidence has to enter the
**law itself** — the phase branch gated on evidence that the offset is real — rather than being
wrapped around it. `hybrid` does this internally, which is why it gets 16/25 on that row while
`pll` gets 374. Worth stating because `ConfidenceGated` was adopted in round 3 as if it were
universal.

## 27. Also ported

- **The harness was not deterministic.** The broadcast loop iterated a Go map, whose order is
  randomised, perturbing the network queue tie-break and the jitter draws. Now sorted. Every number
  before round 6 carries this noise.
- **Bias learning is unsound unbounded.** A lost correction message is indistinguishable from a
  biased clock, so the learner could absorb a genuine multi-second step and strand a client.
  Bounded — using the principled bound from the timebase analysis rather than an arbitrary
  constant: `|B| <= UncertaintyMs`, since an undetectable offset cannot exceed the error bound.
- **No corrector reads `LastAppliedSeq`** (verified). A client on a stale anchor reports
  `residual = 0` while being arbitrarily far out of position — the same blindness as §21, by a
  different route. The field is on the wire for exactly this and is unused.

## 28. Where this leaves the strategy choice

**No strategy dominates.** `threshold-500` and `step-ramp+conf` are best or tied on five rows;
`pll` is dramatically best on the two clean-clock rows and dangerous on the biased ones; `fll` is
the only law that is bias-immune by construction and it cannot handle steps at all.

The shape this suggests — untested, and the obvious next experiment — is to stop treating this as
one law: **discrete logic for steps** (stalls, seeks, commands: the baseline's seek/gate path,
which is now very good) **plus a frequency-only loop for continuous drift** (the FLL term, which is
bias-immune), with **no phase integrator at all**. That is close to `hybrid` but takes step handling
from the baseline instead of gating it off, which is precisely where `hybrid` loses.

Before running that comparison the harness gaps from §19 should be closed — seeks are still free,
so every seek-based strategy is scored on a benefit with no price attached.

---

# Round 7 — the harness stops lying about seeks, and a strategy finally dominates

Two changes, in this order because the second depends on the first: the simulation now models what
the browser probe measured about seek cost, and a corrector was built from every finding so far.
Full output: `docs/poc-run-7.txt`. Runs verified byte-identical across invocations.

## 29. Seeks are no longer free, and the split matters more than the count

`docs/BROWSER-FINDINGS.md` §2 measured that seek cost is entirely determined by one thing:

- **in-buffer seek: ~20 ms, at every network speed.** Free.
- **out-of-buffer seek: one full segment fetch** (155 ms at 150 ms segment latency, 405 ms at
  400 ms) **and `readyState` below 3 for that whole time.** The client is *more* out of position
  before it is less.

The sim client now carries a buffer model (fill rate, max depth, back buffer) and a seek to an
unbuffered position stalls it for one segment fetch. `SeeksIssued` is replaced by
**`seek/in` and `seek/OUT`** — counting them together was hiding the entire cost structure.

Effect on the existing table: `long-stalls` for `threshold-500` went from 18/15 to **71/145**, and
all four of its seeks turned out to be out-of-buffer. A stall drains the buffer, so the corrective
seek lands outside it, which rebuffers, which is the **seek → rebuffer → residual → seek** loop the
harness previously could not produce.

## 30. `ServoCorrector`

Built from the accumulated findings rather than from a control-theory textbook:

| finding | consequence in the law |
|---|---|
| phase is unobservable up to the clock bias; slope is not (§24) | the term that fixes rate mismatch integrates **slope**, never residual |
| you cannot resolve phase finer than `UncertaintyMs`, and scheduling launders exactly that much (§21) | phase term is **proportional and dead-banded at `max(tolerance, uncertainty)`** — it drives error to the bound and stops. No phase integrator: it would aim at a target that does not exist |
| `ConfidenceGated` is a no-op for continuous laws (§26) | confidence is **inside** the law |
| a stall's slope (~1000 ms/s) is not a rate error (10 ms/s) | the frequency integrator **freezes** above `RampMaxSlope` |
| in-buffer seeks are free, out-of-buffer seeks rebuffer (§29) | seek gate is **cost, not size**: seek whenever the target is buffered and the error exceeds the band; **never** seek outside the buffer |

That last row was the one that took two attempts. The first version kept the inherited "only seek
if the gap exceeds 3 s" rule and lost badly on both stall scenarios — rate-nudging a 900 ms step
takes 9 seconds of audibly wrong playback to fix what a free seek fixes instantly. The correct
question was never *how big* the error is; it is *what the correction costs*.

## 31. Results

Anchor error mean/p95 ms; `OUT` is out-of-buffer seeks, the expensive kind.

| scenario | threshold-500 | step-ramp+conf | **servo** |
|---|---|---|---|
| steady/rate-drift | 160/455 · 0 OUT | 163/472 · 0 OUT | **15/30** · 0 OUT |
| transient-hiccup | **13/10** · 0 OUT | **13/10** · 0 OUT | 12/32 · 0 OUT |
| long-stalls | 71/145 · **4 OUT** | 71/145 · **4 OUT** | 103/**74** · **0 OUT** |
| one-slow-client | 92/448 · 1 OUT | 103/485 · 1 OUT | **36/70** · 0 OUT |
| clock-skew | 124/333 | 124/333 | **23/56** |
| latency-asymmetry | 390/595 | **10/10** | 11/15 |
| asymmetry+cmds | 389/600 | 295/600 | 296/595 |
| command-storm | **12/25** | **12/25** | 14/29 |

- **10x better on rate drift** (15 vs 160), **2.5x on one-slow-client**, **5x on clock skew**.
- **Zero out-of-buffer seeks in every scenario**, against 4 and 1 for the baselines — those are the
  seeks that visibly freeze the picture.
- Ties on the three rows dominated by something other than correction (`command-storm` is
  transitions, `asymmetry+cmds` is laundered bias which nothing can fix, `transient-hiccup` is
  already near zero).
- `long-stalls` is the one real trade: worse mean (103 vs 71), better tail (74 vs 145), and it
  avoids four rebuffers. Given that a rebuffer is a visible freeze and mean error here is
  sub-frame, that trade is worth taking — but it is a trade, not a win.

`rateTimeMs` (integral of `|rate-1| dt`) shows the cost is not overhead: 2128 ms on
`steady/rate-drift`, where cancelling 1.0 % and 0.8 % rate errors over 120 s *necessarily* costs
about 2160 ms of time-shift. On `transient-hiccup` it spends only 66 ms, because there it correctly
uses free seeks instead of rate.

## 32. Regression tests added

- `TestServoNeverSeeksOutOfBuffer` — with a control proving the baseline does take them.
- `TestServoCancelsRateDriftWithoutSeeking` — including a physics bound on rate-time, so a
  "win" that simply stops correcting would fail.
- `TestServoRefusesToChaseAClockBias` — with a control proving a phase integrator still walks into
  the trap, so the scenario has not been weakened.

---

# Round 8 — membership, reconnection, and a rule that was too absolute

Three scenario classes the harness had never modelled, all of which turned out to contain a
correctness bug rather than a tuning question. Full output: `docs/poc-run-8.txt`.

## 33. Browser tab suspension moves the room (measured, then reproduced)

`docs/BROWSER-FINDINGS.md` §5 measured Chrome pausing a **muted, hidden** tab and firing a real
`pause` event. The sim now models it, with a `NoSuspendGuard` control:

```
guarded: 0 spurious commands / 0 room pauses
naive:   4 spurious commands / 2 room pauses
```

Two members' worth of tab-switching pauses the whole room twice in 90 seconds. Nothing in the
existing design catches it: the stall detector only fires on a freeze while `paused === false`, and
this freeze sets `paused === true`, so it passes straight through as user intent.

This also required a piece the harness never had: **clients could not originate commands at all.**
Every command came from scenario injection, so the path where a client's own detector decides to
broadcast had never been exercised. It is now.

A suspended member is also **absent, not buffering** — `Report.Suspended` is on the wire and every
corrector returns `ActionNone` for it, so the readiness gate cannot hold the room for someone who
is not watching.

## 34. A member that misses one command is stranded, invisibly

`reconnect`: one member is offline across a seek. On return it holds a stale anchor — and because
its residual is measured *against that same stale anchor*, it reports **≈ 0** while being minutes
out of position. This is the third blindness of the residual channel, alongside §21 (laundered
bias) and the stall case.

`LastAppliedSeq` has been on the wire since the §5 amendment and **no corrector ever read it.**
Resending state when a client's `lastAppliedSeq` lags the server's is three lines:

| | mean anchor error |
|---|---|
| without the resend | **115 603 ms** |
| with it | **250 ms** |

A 460x improvement from reading a field we were already sending. Note that *max* divergence is
unchanged (569 s in both) — that is the instant of reconnect itself, which no design can avoid;
sustained error is what separates "recovered" from "stranded", and it is the metric this needed.

## 35. "Never seek outside the buffer" was too absolute — the harness caught it

Round 7 concluded that out-of-buffer seeks are never worth their cost. `tab-suspension` falsified
that immediately: a member returning from a 15 s suspension is 15 s behind, and the ±10 % rate
clamp closes at most 100 ms of gap per second, so a rate-only recovery takes **150 seconds**.
Servo scored **3442 ms** mean anchor error against the plain threshold's 28 ms.

The rule is not about the buffer, it is about which correction is cheaper:

- target **buffered** → seek, at any gap above the band. It costs ~20 ms.
- target **unbuffered**, gap above `NudgeMaxResidual` → seek anyway. One segment fetch
  (~150–400 ms) beats minutes of audibly wrong playback.
- otherwise → rate.

With that, servo takes **1 free + 3 costly** seeks on `long-stalls` against the baseline's
**0 + 4**, and scores 52/38 ms against 71/145.

## 36. Full table, all eleven scenarios

Anchor error mean/p95 ms:

| scenario | threshold-500 | **servo** |
|---|---|---|
| steady/rate-drift | 160/455 | **15/30** |
| transient-hiccup | 13/**10** | **12**/32 |
| long-stalls | 71/145 | **52/38** |
| one-slow-client | **92**/448 | 100/**372** |
| clock-skew | 124/333 | **23/56** |
| latency-asymmetry | 390/595 | **11/15** |
| asymmetry+cmds | 389/600 | **294/594** |
| tab-suspension | **28**/45 | 31/45 |
| reconnect | **242**/15 | 249/**45** |
| late-join | 53/224 | **16/42** |
| command-storm | **13/25** | 15/30 |

Servo wins clearly on five, ties on four, and is marginally behind on two (`tab-suspension`,
`command-storm`) where both are already inside a single frame at 25 fps. The wins are large
(10x, 5x, 35x) and the losses are 2–3 ms.

## 37. What is now covered that was not

The §19 harness gaps are closed: seeks cost what the browser says they cost, and join / leave /
reconnect / suspension all exist as scenarios. **Background throttling deliberately does not** —
§4 of the browser findings measured that an audible tab is exempt, and §5 that a muted hidden one
is paused outright rather than throttled, so the "1 Hz eval loop" scenario turned out to describe
a state that does not occur. That gap closed by being measured away rather than by being modelled.

## 38. Round 9 — the readiness gate, finally measured

The gate was the one piece of the design that had a spec, a frame type and a
constant, and no number. `MsgGate` existed in the harness and was never
constructed; §6 of `PROTOCOL.md` described Jellyfin's `Waiting` state and our
`GATE_TIMEOUT` addition, and nothing implemented either. It shipped as a
notification before it was ever a mechanism.

### The metric had to be invented before the gate could be scored

`anchorErr` cannot see what the gate is for. It **excludes a stalled client by
construction** — a client that is legitimately buffering is not counted against
the strategy. So a room that starts without a slow member, lets them fall 14 s
behind, then yanks them forward with a seek, scores *well* on it. Every existing
metric had the same blind spot: seeks are counted but a seek that skips content
costs the same as one that does not, and inter-client spread was already retired
for rewarding inaction (§24).

Added `SkippedMs`: the total **forward** displacement server corrections imposed
on a member. That is media they never saw. It is the only quantity here that
measures the thing a watch-party is for.

### `slow-to-buffer`, gate on vs off

Room paused, one member cannot buffer for the first 25 s, somebody presses play
at 10 s. `ServoCorrector` in both runs.

| | anchorErr | **skipped** | out-of-buffer seeks | commands held |
|---|---|---|---|---|
| gate **ON** | 10 ms | **0 ms** | 0 | 1, for 16 060 ms |
| gate **OFF** | 65 ms | **14 470 ms** | 1 | — |

Without the gate the slow member is skipped past **14.5 seconds of media** and
pays a rebuffering out-of-buffer seek to get there. With it, nobody misses
anything and everybody waits 16 s. That is the trade, stated honestly: the gate
does not make anything faster, it converts one member's loss into everyone's
wait.

Note how close the two `anchorErr` figures are (10 vs 65 ms). Ranking the gate
on the primary metric would have concluded it does almost nothing.

### Design consequences the measurement forced

1. **Hold the command, do not stop the players.** The gate acts *before* the
   anchor moves. The anchor is the only truth, so a held `play` simply never
   happens — which means the gate needs **no cooperation from any client**.
   There is nothing to obey, nothing to time out, and nothing that can get stuck
   if a client ignores the frame. The first sketch had the server pause the room
   and resume it, which puts every member into a residual the corrector then
   tries to "fix".

2. **Only `play` is held.** Gating every transition, which is what Jellyfin
   does, turns one member's 200 ms rebuffer into a room-wide stutter.
   Mid-playback buffering is already handled by correcting that one member —
   the whole judge-don't-aggregate design. `media` needs no gate either: it
   lands paused by construction, so the `play` after it is the one that waits.
   `pause` and `seek` are never held; making the room unresponsive exactly when
   somebody wants to stop it is the wrong failure.

3. **`waiting` and `waitingOn` are different facts.** `waitingOn` is who is not
   ready — worth showing in the UI whenever it is non-empty. `waiting` is
   whether a command is actually being held. Conflating them either hides the
   buffering indicator or stops the room for it.

4. **The timeout waiver must latch.** The first version cleared `gated` when
   `now - gatedAt > GATE_TIMEOUT` and the member's next report re-opened the
   gate at a fresh `gatedAt`. A member who never recovers would hold the room
   forever in 30 s increments. `gateWaived` latches until they report ready.

5. **At most one held command; a later one supersedes it.** A queue would let a
   member who is slow to buffer replay a stale burst of user intent at the room
   minutes later.

6. **The gate is announced on change only.** One frame per report per member is
   the room's report rate times its size.

### What the timeout actually measures from

`GATE_TIMEOUT` runs from when the **member** entered the gate, not from when the
command was held. In `slow-to-buffer` the member starts buffering at t≈0 and the
play arrives at t=10 s, so the play is released at ~30 s having been held for
~20 s. Pinned in `TestGateTimeoutResumesARoomHeldByAMemberWhoNeverRecovers`,
because the natural misreading (restart the clock per command) is exactly the
one that never terminates.

### Harness note

Adding the gate broadcast re-rolled every scenario's jitter draws, because gate
frames are real downlink traffic. Absolute numbers shifted by a few percent
across the table; `servo` moved least (long-stalls 52 → 52, one-slow 100 → 100).
Seeding the gate signature with "nothing held, nobody waiting" removed a
spurious frame at the first report of every healthy room and brought the diff
back to a single line — `reconnect`'s gate count halving, which is the waiver
latch no longer double-counting one continuous buffering episode.

## 39. Round 10 — two regression assertions had been passing on luck

Suppressing redundant rate commands (§7 of BROWSER-FINDINGS) changed how much
traffic crosses the simulated network, which re-rolled every jitter draw, which
turned two regression tests red:

```
TestConfidenceGatingStopsBiasDrivenSeeks: want 0 seeks on a pure clock bias, got 1
TestSchedulingLaundersClockBias:          command-free asymmetry should stay at 0, got 666
```

The obvious reading is that the change broke confidence gating. It did not.
Both tests asserted **exactly zero** against **one seed**, and a scan over 60
seeds showed the property holds in only about two thirds of them:

| | 0 seeks in |
|---|---|
| before the change | 40 / 60 seeds |
| after the change | 35 / 60 seeds |

Statistically indistinguishable (p ≈ 0.46). The assertions had been passing on
seed 5's luck since they were written, and any change that shifted the jitter
sequence could turn them red with nothing wrong.

**Why the property is statistical at all.** `ConfidenceGated` widens the
dead-band to the client's own `UncertaintyMs`, which is `bestRTT/2` — and
`bestRTT` is the *minimum* of a jittered sample. Whether the client happens to
draw a low minimum decides whether the dead-band is narrow enough for the
laundered bias to escape it. That is not a flaw in the gating; it is what
"confidence" means when the confidence is itself measured.

Both tests now average over 20 seeds and assert the **relative** claim they were
always making — gated issues far fewer seeks and creates far less self-inflicted
divergence than ungated — with the ungated arm kept as a control so a low gated
number cannot pass by the scenario going quiet. They pass with and without the
rate-suppression change.

The lesson generalises past these two tests: **in a harness whose numbers move
whenever traffic changes, an exact-value assertion on one seed is a coin flip
wearing a lab coat.** Assert the comparison, average the sample, keep the
control.

### The change itself

A continuous control law recomputes a rate on every report, so the server was
sending a `correct{nudge}` at the report rate forever. Measured in a real
browser: **17 nudges to one member in a 20 s session**, each firing a
`ratechange` on the element the detector is watching. Suppressing a rate the
client already holds (within 0.001, re-stated every 5 s in case the
unacknowledged `correct` that set it was lost) took the same session to **4 and
5** with the two players still 20 ms apart.
