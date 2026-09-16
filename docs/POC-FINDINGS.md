# Risk-A findings (simulation harness)

Run: `mise run sim`. Deterministic virtual clock, no browser, no network — currently **8 correction
strategies across 12 scenarios**, and byte-identical run to run.

**This is a chronological log, not a summary.** Sections are numbered in the order they were
written, across ten rounds, and several of them record a conclusion that a later section overturns.
That is the point: the retractions are worth more than the confirmations, and a reader looking for
"what is true now" should start at `docs/STATE.md` instead.

Round 1's headline, kept because it set the direction: **the derivative classifier, as specified in
SYNTHESIS §4c, does not beat a plain threshold — and every strategy shared a seek-storm failure
mode that no reference implementation documents.** Both are why Risk A ran before any browser code.

The numbers in each section are from the run committed alongside it. Absolute values shift whenever
the amount of traffic on the simulated network changes, because that re-rolls every jitter draw
(see §39); the comparisons are what survive.

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

## 40. Round 11 — the room judged members it had told to wait, and pause meant the wrong thing

Found from a live session, not from the harness: alone in a room, pressing play
or pause moved the picture by the whole `CMD_DELAY`. Three separate causes, and
the obvious one was the least important.

All numbers below are against the round-10 baseline, `servo` (the shipping
strategy), `anchorErr / p95` in ms.

### 40a. A member mid-transition must not be judged

`r.anchor` changes the instant a command is applied, but a member is still on
the previous anchor until it applies the new one. Everything it reports in
between is measured against a different anchor than the server is judging
against, so the residual describes that disagreement and not drift.

Measured directly against `room.Room` — two members, `RTT 1200 ms` so
`CMD_DELAY` sits at its 2 s ceiling, a `play` issued at 600 s, then an honest
report one second later:

```
CmdDelay=2000
anchor after play: pos=600000 paused=false when=12000
expected(at=11000) = 599000     reports say 600000, so residual = +1000
-> Correct{Mode:seek Why:"free seek"}   x2
```

Both members seek-corrected **one second backwards, one second before the
transition they already had scheduled**. The gate for it is `targetBuffered`,
which any member who has been playing satisfies.

The room already had the same fact expressed once, for the stale-anchor resend:
a lagging `lastAppliedSeq` is the only signal that a client is confidently
wrong about what it is syncing to. Both guards now key off that one field:

- lagging **and** the command has had time to arrive → the anchor is stale,
  resend it.
- lagging and it has not → mid-transition, defer judgement.

"Has had time to arrive" needs a grace period, and `CMD_DELAY` used to supply
one implicitly — nothing was due for at least 500 ms. §40c removes the lead for
some commands, so the grace is now explicit and comes from the member's own
measured RTT.

That grace turns out to matter on its own: spurious resends in `asymmetry+cmds`
(a 1200 ms one-way path) go **18 → 0**, and the only resend left anywhere is the
one in `reconnect`, which is the genuine stale anchor the mechanism exists for.

### 40b. A room of one was scheduling against nobody

`CMD_DELAY` buys simultaneity between members. With one member there are none,
and the whole delay is spent making that member's own gesture wrong: the anchor
transitions `CMD_DELAY` after the press and the player is then moved to meet it.

End to end against a real `videosyncd`, one member, on the 500 ms floor:

| | before | after |
|---|---|---|
| pause at 103.20 s | picture jumps to **103.70 s** | stays at 103.23 s |
| then press play | runs to 104.31 s, snaps back to **103.80 s** | monotonic, no rewind |

`CmdDelay()` returns 0 below two members. The clamp is unchanged for everyone
else and keeps its test.

### 40c. The lead time was the wrong thing to argue about

With two or more members the originator was still moved by `CMD_DELAY` when the
transition landed. The obvious lever was the 500 ms floor, so it was swept in
the harness — 500 / 300 / 200 / 100 ms, all twelve scenarios, every strategy —
and it moved **nothing**, to within 1 ms.

That result is not the good news it looks like. The harness applies a command
when its `when` arrives, so it is insensitive *by construction* to how far ahead
`when` is. It can show a second-order cost and it showed none; it cannot measure
the first-order one, which is the only one a person sees. **Recorded because the
sweep looks like evidence and is not.**

The framing was wrong. The size of the jump was never the problem: **pause means
"stop here", and `here` is a position.** The room was scheduling the pause into
the future and anchoring where playback *would* have reached — so the person who
pressed pause stopped on a frame and their own picture then jumped forward into
media they never saw. (That is the quantity `SkippedMs` was introduced to count
in §38; the harness table does not report it, so this is reasoning from its
definition, not a measurement of it.) `positionMs` had always been on the wire
for `pause` and was being discarded.

The rule that falls out: **simultaneity is only worth paying for while the clock
is running.** A command that leaves the room stopped — `pause`, `media`, a
`seek` that finds the room paused — needs no lead, because once everybody is
stationary at the same position there is nothing left to happen at the same
instant. `play`, and a `seek` during playback, keep the full `CMD_DELAY`.
`pause` anchors at the position the sender reported.

### The three together

| scenario | before | after |
|---|---|---|
| steady/rate-drift | 14 / 26 | 14 / 26 |
| transient-hiccup | 12 / 29 | 12 / 29 |
| long-stalls | 54 / 45 | 54 / 45 |
| one-slow-client | 82 / 291 | 82 / 291 |
| clock-skew | 23 / 56 | 23 / 56 |
| latency-asymmetry | 194 / 585 | 194 / 585 |
| asymmetry+cmds | 294 / 593 | 294 / 595 |
| tab-suspension | 30 / 35 | 28 / 40 |
| reconnect | 257 / 68 | 257 / 68 |
| late-join | 12 / 18 | 12 / 18 |
| slow-to-buffer | 14 / 20 | 14 / 20 |
| **command-storm** | 22 / 35 | **8 / 20** |

`command-storm` is the scenario built out of play/pause traffic and it is the
one that moves — `anchorErr` 22 → 8 ms, p95 35 → 20 ms, time at a corrected rate
273 → 237 ms. Convergence in `asymmetry+cmds` improves 1600 → 1300 ms. Nothing
else moves at all, which is the point: this is a change to what commands mean,
not to the control loop.

The cost, stated plainly: a remote member now keeps playing until the pause
reaches them and then rewinds by up to one downlink delay, rather than arriving
exactly on time. `command-storm`'s slowest client converges in 150 ms instead of
50, and the scenario takes 3 → 5 gate events (3 → 6 under every other strategy,
so it is a property of the new timing and not of the corrector): a pause that
lands immediately is followed by a `play` that finds members still settling, and
the readiness gate does its job.

That is the trade — whoever pressed pause is now right, and everybody else
absorbs the difference — and it is the correct way round, because only one of
those members chose the transition.

### What this does NOT fix

Nothing changes for `play`: whoever presses play still has their picture pulled
back by `CMD_DELAY` when the transition lands, because everybody has to start
moving at the same instant from the same position and one of them has to give.
The 500 ms floor still sets the size of that on a fast link, and it remains a
chosen safety margin rather than a measured one (SYNTHESIS §2 amendment). The
harness cannot answer it, for the reason in §40c. It needs two people and a
number.

## 41. Round 12 — the harness was measuring itself in six places, and the servo stalled against its own nudge

A code review found six places where the simulation did not do what the shipped
code does, and one real defect in `ServoCorrector` that the simulation could not
reach. Each harness fix below moves some rows, so this section says which
earlier numbers each one invalidates. The last table is the one to quote now.

`mise run sim` gained two things along the way: a `skipped` column (the table
used to score strategies on `anchorErr` alone, which CLAUDE.md says cannot be
done) and `-seeds N`, which prints every row as a mean over seeds 1..N (§39: one
seed is not evidence). Every "mean over seeds" below is `-seeds 20` unless it
says otherwise.

### 41a. One corrector instance served the whole table

`main.go` built each corrector once and passed the same instance to every
scenario. PLL, FLL, Hybrid and Servo keep per-member state keyed by member id,
every scenario uses the ids a/b/c, and nothing in a finished run makes anyone
leave. So each scenario started with the previous one's integrators already
wound up, and a row depended on which scenarios were listed above it. The real
server builds one corrector per room (`hub.go`), so the table was not measuring
anything that ships. Each run now gets a fresh instance, and a test runs the
table forwards and backwards and requires every row to match.

Rows that were carried-over state (single seed, mean/p95 ms, shared → fresh):

| scenario | strategy | shared | fresh |
|---|---|---|---|
| latency-asymmetry | servo | 194/585 | **5/10** |
| clock-skew | servo | 23/56 | **12/31** |
| one-slow-client | servo | 82/291 | **106/390** |
| command-storm | servo | 8/20 | 11/54 |
| tab-suspension | hybrid | 3772/29990 | **49/147** |
| long-stalls | hybrid | 1004/7490 | **73/145** |
| one-slow-client | hybrid | 410/3718 | **119/466** |
| clock-skew | hybrid | 118/294 | **16/33** |
| clock-skew | fll | 102/285 | **11/23** |
| tab-suspension | pll | 3436/26810 | 285/15 |

**Invalidated:** §25's "`hybrid` loses badly on `long-stalls`, `one-slow-client`
and `clock-skew`" — the losses were mostly state from the scenario before. §40's
"three together" table for `clock-skew`, `latency-asymmetry` and
`one-slow-client`. It went both ways: one-slow-client's servo row was *flattered*
by state from the rows above it. The first stateful correctors entered the
table in round 6 (§24), and the table has shared instances ever since. Treat
every multi-strategy table from §24 on as affected to some unknown degree. Only
the rows above were re-measured.

### 41b. Every scripted pause rewound the room to 0

Since §40c the room anchors a `pause` at the position the sender reports. The
engine always sends one. Scenario commands left `PositionMs` unset, so every
scripted pause reached the room as "pause at 0". In `command-storm` the pause at
60 s undid the seek to 300 s, and `asymmetry+cmds` measured its convergence
through a rewind to the start. A scripted `pause`/`play` now carries the
presser's player position.

- `asymmetry+cmds` convergence: 1300 ms → **100–200 ms** for every strategy.
- `command-storm` gate events: 6 → 3 (5 → 3 for servo).
- `command-storm` servo, mean over seeds: 8/29 → **15/32**.

**Invalidated:** §40's `command-storm` improvement (22 → 8) and its
`asymmetry+cmds` convergence (1600 → 1300). Both were measured through the
rewind. `TestSchedulingLaundersClockBias` also measured through it; it still
passes with the rewind gone.

### 41c. Scheduled commands were applied in arrival order

A `pause` pressed inside a `play`'s `CMD_DELAY` is the newer command and also
the one due first. The sim client walked its pending list in arrival order with
no seq check. The older play therefore landed last, the member played against a
paused room, and its `lastAppliedSeq` went *backwards*, which the room then
reads as a stale anchor. The engine sorts by `when` and drops anything not newer
than what it has applied, and the sim now does the same. No scenario in the
table creates that overlap, so **no row moved**. The tests drive the client
directly.

### 41d. A scheduled seek did not pay for the buffer

A corrective seek charged the buffer model (a segment fetch and a rebuffer), but
a seek ordered by a *command* only moved the playhead. A member sent from 30 s to
300 s kept playing at 1.0x while its buffer end crept up from 41 s at a net
3 s/s. For about 90 s it reported `readyState 2` with nothing buffered, so every
corrector gated on it and the detector assumed a stall. Both kinds of seek now go
through one helper, and a command-ordered out-of-buffer seek counts in `seek/OUT`.

This is the change that moved the table, and what it exposed is real. A member
on a slow link now finishes a user seek **one segment fetch late**: the room
keeps moving while the member rebuffers. On the `bad` link that is ~400 ms, which
is inside `ToleranceMs`, so no corrector touches it and the member stays there:

| command-storm (mean over seeds) | before | after |
|---|---|---|
| threshold-500 | 12/25 | **105/394** |
| servo | 15/32 | **78/327** |
| pll | 18/52 | 13/48 |

Only `pll` closes it, because it is the only law with a phase integrator (the
integrator §30 rejected for clock-bias reasons). `reconnect` moves the same way
(servo 243/25 → 273/94). This is the harness showing a cost it previously hid,
not a regression. Whether a sub-tolerance lag after every user seek is
acceptable is a product question the harness cannot answer.

### 41e. The detector was evaluated twice per second at the same instant

At every whole second, `run.go` called `Evaluate` once for the 10 Hz loop and
again for the heartbeat. `Evaluate` dead-reckoned a fixed 100 ms per call, which
is the CLAUDE.md trap inside the harness that is supposed to measure it. The
second call saw a frozen player and flagged a stall every second. With the stall
guard off, it moved the predicted playhead 100 ms past the real one each second
(2.2 s of phantom lead after 20 s). It also sent two reports per heartbeat. Each
tick now makes one look, the look runs on elapsed time, and anomaly reports keep
the engine's 250 ms spacing.

The stall-guard control still misdetects **13** times, so §5's conclusion
stands on sound data. Most rows move by a few ms. The one worth recording is
servo on `latency-asymmetry`: mean over seeds 15/71 → **27/99**. Per seed it is
not a drift. In 3 of 20 seeds (4, 15, 19) the servo takes a "free seek" onto a
bias that happens to exceed that client's uncertainty band, and each of those
seeds scores 56–188 ms, while the rest score 4–18 ms. The single-seed row
(seed 5, 8/15) cannot show this. It is §39's coin flip again, and a known limit
of a seek gate at `max(tolerance, uncertainty)`, not something this change
introduced.

### 41f. Join, leave and reconnect did not take the shipped path

`Run` joined every member at t=0 regardless of `JoinAtMs`. A disconnect only
dropped frames: no `Leave`, no welcome, no clock reset. That made two numbers in
this log measure things the real system cannot produce:

- **Late join was vacuous.** The joiner's player ran from t=0 while "offline",
  so it arrived already on the anchor, and a corrector that never corrects passed
  `TestLateJoinerConverges` *with a better score than the servo* (10 vs 14 ms).
  It also counted toward `CMD_DELAY` before it existed.
- **Reconnect was a stale anchor.** A real reconnect gets a welcome with the
  current seq and anchor. The engine adopts both and resets its clock and
  detector. It is never stale. It is far out of position against an anchor it
  holds correctly, which the residual channel can see.

Membership now changes when the connection does. A disconnect is a `Leave` (the
corrector forgets the member, the gate releases it). A (re)connect is a `Join`
plus a welcome, with fast clock probes at the start of every session. A joiner's
player starts when it joins.

- `late-join`, servo, mean over seeds: 9/21 → **54/96**, now with one real
  out-of-buffer seek. The no-correction control scores 7496 ms. `threshold-500`
  is 116/225, `hybrid` 611/1048.
- `reconnect`, servo: resends 1.00 → **0.00**. Recovery is now a correction the
  room issues (a gap seek), and anchorErr is unchanged at ~272 ms.
- `reconnect` exposes strategies that cannot recover a returning member:
  `fll` never seeks (**115 514 ms**), and `step-ramp+conf` / `hybrid+conf` score
  979 / 2094 ms (mean over seeds). Why the two confidence-gated laws recover
  slowly was not investigated.

**Invalidated:** §34's headline, *115 603 ms → 250 ms*, which CLAUDE.md and
`room.go` both quote. That number is a member that reconnected and was left on a
stale anchor, and that state does not occur. A stale anchor now needs frames lost
on a connection that stays up (`DropsDown`). A WebSocket does not do that either:
the hub closes a connection whose outbox overflows instead of dropping frames
into it. So the resend is a **backstop**. Re-measured in that model
(`TestStaleAnchorAfterLostFrames`, 2 s of lost frames across a seek): **123 770
ms without the resend → 31 ms with it**, one resend. The mechanism is sound, but
the old figure describes a failure a reconnect cannot cause.

**Caution on `skipped` in these two rows.** `SkippedMs` counts forward
correction seeks, so it charges the returning member 569 s and the joiner 30 s.
Neither is media the room made anyone miss, so do not read those two rows'
`skipped` as a cost.

### 41g. The servo's frequency term wound up against its own phase nudge

This is a real defect in shipped code. The simulation could not reach it.

The slope a client reports is fitted to the *raw* residual, so it already
includes the rate the servo commanded: bias and phase nudge together. The
frequency integrator treated the whole slope as frequency error:

```
rate - 1 = b + p,  p = -e/NudgeCloseMs      (b bias, e excess residual)
e' = 1000(b + p),  b' = -g(b + p)           =>  g·e + 1000·b is conserved
```

That system has a line of equilibria with rate exactly 1.0 and the residual
still outside the band. From a standing start it removes only
`1000/(g·NudgeCloseMs + 1000)` ≈ 26 % of the excess, and once the bias hits its
±0.06 clamp the stuck excess is 480 ms. From then on every report is a nudge to
1.0000, which the room suppresses as already held. Only the free-seek and
`NudgeMaxResidual` escapes could close the gap. The simulation never reached this
state because its players always keep a back buffer and ~11 s ahead, so a free
seek is always available below 3 s.

Driven directly against a player model (`corrector_servo_test.go`), 4 minutes of
nudging:

| member | before | after |
|---|---|---|
| 2000 ms ahead, no back buffer | stuck at **+981 ms**, rate 1.0000 | inside the 500 ms band |
| 800 ms ahead, 0.5 s back buffer | stuck at **+729 ms** | inside the band |
| 2500 ms behind, 1.05 s ahead, unc 600 | stuck at **-1081 ms** | nudged to the buffer edge, then one free seek |
| 2000 ms ahead on a 0.99x decoder | stuck at **+900 ms** (rate 1.0101) | inside the band, rate 1.0101 |

The fix records the phase part of the rate the servo last commanded
(`rate - 1 - bias`, after clamping) and integrates only `slope - phase`. A seek
leaves the client's rate where it was, so the seek hands that remaining rate to
the phase term instead of throwing it away with the bias. Rate-mismatch learning
is unchanged: 0.99x, 0.995x and 1.008x decoders still settle at `1/intrinsic`
within 0.002.

Because this changes the control law, it was held to the §39 standard before
shipping: **neutral or better on `anchorErr` and `SkippedMs`, averaged over
seeds.** Over 60 seeds:

| scenario | anchorErr before → after | skipped before → after | rateTime before → after |
|---|---|---|---|
| steady/rate-drift | 15/29 → 15/29 | 0 → 0 | 2136 → 2134 |
| transient-hiccup | 15/19 → 15/19 | 2300 → 2300 | 40 → 31 |
| long-stalls | 63/53 → **61/53** | 16550 → 16550 | 265 → 207 |
| one-slow-client | 100/334 → 100/334 | 4019 → 4019 | 1224 → 1216 |
| clock-skew | 10/21 → 10/21 | 0 → 0 | 721 → 718 |
| latency-asymmetry | 33/100 → 33/100 | 10 → 10 | 52 → 48 |
| asymmetry+cmds | 300/601 → 300/601 | 10 → 10 | 54 → 45 |
| tab-suspension | 29/41 → 29/41 | 30050 → 30050 | 32 → 26 |
| reconnect | 271/85 → 271/86 | 569472 → 569471 | 120 → 113 |
| late-join | 55/96 → 56/97 | 30001 → 30001 | 356 → 351 |
| slow-to-buffer | 10/16 → 10/16 | 0 → 0 | 11 → 9 |
| command-storm | 75/318 → 76/323 | 0 → 0 | 638 → 640 |

In short: anchorErr is within 2 ms everywhere and `SkippedMs` is identical.
Rate-time is equal or lower everywhere except `command-storm` (+2 ms), which
fits a loop that no longer spends effort fighting itself.
This measurement proves the fix is safe, not that it helps. No scenario in the
simulation reaches the stuck state, and the unit test is the evidence for the
fix. One consequence is reasoned, not measured: a client that cannot apply
rate at all (`nudgesUnsupported`) now accumulates bias against a phase nudge it
never ran. That bias clamps at ±0.06 and should do nothing, since that client is
corrected only by seeks.

### 41h. The gate-timeout test accepted the bug it names

`TestGateTimeoutResumesARoomHeldByAMemberWhoNeverRecovers` says `GATE_TIMEOUT`
runs from when the member entered the gate, not from the held command. It then
accepted any hold between 12 and 32 s. Timing from the held command gives
~30 s, inside that window. Mutating `room.go` to that rule left the whole suite
green (hold 30 050 ms against the correct 21 060 ms). The window is now
`GATE_TIMEOUT − 10 s ± 3 s`, and the same mutation fails it.

### The table now

Servo, single seed (as `mise run sim` prints it), against round 11's published
numbers:

| scenario | round 11 | now | now, mean over seeds |
|---|---|---|---|
| steady/rate-drift | 14/26 | 14/26 | 15/27 |
| transient-hiccup | 12/29 | 16/16 | 15/20 |
| long-stalls | 54/45 | 60/49 | 62/58 |
| one-slow-client | 82/291 | 113/392 | 104/347 |
| clock-skew | 23/56 | 13/34 | 10/19 |
| latency-asymmetry | 194/585 | 9/16 | 27/98 |
| asymmetry+cmds | 294/595 | 293/600 | 298/599 |
| tab-suspension | 28/40 | 29/35 | 28/40 |
| reconnect | 257/68 | 269/80 | 272/87 |
| late-join | 12/18 | 66/135 | 54/96 |
| slow-to-buffer | 14/20 | 11/15 | 10/16 |
| command-storm | 8/20 | 68/287 | 79/328 |

Two rows are worse, and both are now measuring something real. `late-join` has
a joiner that actually needs correcting (§41f). `command-storm` has user seeks
that actually cost a fetch (§41d). Two rows are better only because they no
longer inherit state from an earlier scenario: `latency-asymmetry` and
`clock-skew` (§41a). `one-slow-client` got worse for the same reason: the shared
state had been helping it. The readiness-gate control (§38) is unchanged: gate
on 11 ms / 0 skipped, gate off 77 ms / 14 470 ms skipped.

## 42. Round 13 — review of round 12: one sim regression, one servo defect in the fix itself, and forgotten state

Independent review of §41 mutated each fix. It found three pieces no test pinned,
one regression, and two gaps in the servo change. All numbers below are
`mise run sim` (seed per scenario) or `-seeds 20` means, against the tree §41
left behind.

### 42a. Every transition was charged as a seek

§41d routed scheduled transitions through the buffer model. It did so for *every*
transition, including a `play`. The engine seeks only when the target is more than
`seekToleranceMs` (250 ms) from the playhead (`applyTransition`). While a member
buffers, its buffer end sits on the playhead, so a `play` landing 20 ms ahead
counted as an out-of-buffer seek and added a segment fetch to the stall. The sim
now skips the seek inside the tolerance, as the engine does
(`TestTransitionWithinSeekToleranceDoesNotSeek`).

The rows that move are the ones with transitions (servo, mean over 20 seeds):

| scenario | before | after |
|---|---|---|
| slow-to-buffer | 10/16 | **8/14** |
| asymmetry+cmds | 298/599 | **324/647** |
| command-storm | 78/325 | **104/327** |

Every law moves the same way on those three rows (e.g. threshold-500
command-storm 103 → 132). The readiness-gate control loses a phantom seek:
gate off 77 ms / 14 470 ms skipped / **2** out-of-buffer seeks → 76 ms / 14 475 ms /
**1**. Gate on 11 → 8 ms.

The two worse rows are **not** a regression. They show a cost the snap hid. A
member within 250 ms of a new anchor is no longer moved onto it, and inside
`ToleranceMs` no corrector moves it either. That is what the engine does. It is
the same sub-tolerance question §41d left open, now reached by every
transition and not only by out-of-buffer seeks.

### 42b. The seek hand-over carried the step it was removing

§41g's `dropBias` handed `phaseRate + rateBias` to the phase term on a seek, to
stand for the rate the client keeps running. But the report that triggers a seek
has usually integrated the step's own slope into `rateBias` first: a 1500 ms kick
on the last sample of the 3 s window fits at 47 ms/s, under `RampMaxSlope`. A
0.99x decoder that had learned 1.0101 therefore handed over −0.0066. It was then
told to run ~1.0 and had to learn the mismatch again from the drift that caused.
The hand-over now uses the last *commanded* rate, captured before this report
integrates. `TestServoKeepsTheLearnedRateAcrossAFreeSeek` covers 0.99x, 0.995x and
1.008x, with the kick both on a report and between two reports. It fails with the
hand-over removed (the round-12 reviewer's mutation) and with the round-12 version
of it.

### 42c. An absence left the servo's model of the client stale

The engine resets an absent member's rate to 1.0 (`releaseRate`: suspended,
autoplay-blocked or off-media). The servo's suspended branch returned early and
left `phaseRate` at the last nudge and `lastAt` at the last report before the
absence. On the first report back, the missing nudge read as a frequency error,
integrated over the whole absence. A member nudged at 1.10 and suspended for 8 s
wound the bias from 0 to the +0.06 clamp. The suspended branch now records the
reset (`phaseRate = -rateBias`, the same as the settled branch) and restarts `dt`
(`TestServoAbsenceDoesNotWindUpTheBias`, which fails if either line is removed).

The other case that breaks the "client runs what it was told" assumption is a
provider without `supportsPlaybackRateNudge`. It is now written down beside
`phaseRate` and not guarded, because the report carries no rate to check against.
There the bias winds to its clamp, which only suppresses the "settled" reset. That
member is corrected by seeks, and seek decisions do not read the bias.

42b and 42c together, servo over 60 seeds: anchorErr and `SkippedMs` identical in
every row, rateTime −1 ms in three rows. As in §41g, the sim does not reach
either case, so the unit tests are the evidence.

### 42d. Only the servo forgot a member who left

§41f said a disconnect makes "the corrector forget" the member. Only
`ServoCorrector` had `Forget`, and `ConfidenceGated` did not pass it on. pi, pll,
fll, kalman, step-ramp+lead, hybrid and every `+conf` strategy resumed a departed
member's loop state on reconnect. All of them now forget, wrapped or not
(`TestEveryStatefulCorrectorForgetsALeaver` finds each law's per-client map by
reflection, so a new stateful law cannot skip it). The hub ships the servo, so
only the harness changes:

| reconnect, mean over 20 seeds | before | after |
|---|---|---|
| hybrid | 286/151 | **6934/1046** |
| hybrid+conf | 2094/185 | **7164/1045** |
| every other law | — | unchanged |

The earlier hybrid numbers came from state carried over from before the
disconnect. With fresh state, hybrid does on reconnect what `late-join` already
showed (611/1048). Its 2.5 s warm-up holds, and does not seek, while the member
is 570 s off. It then clamps that intercept to `MaxBias` and adopts 1.5 s of a
*real* gap as clock bias, so the member stays ~1 s out for the rest of the run.
That is a limit of hybrid's baseline learner: it cannot tell a real gap at join
from clock bias.

`step-ramp+conf` (979 ms on reconnect) has no per-client state, so carried state
never explained it. Its slow recovery is still uninvestigated.

### 42e. Pieces now pinned

- The `when`-order sort in `RunScheduled` (§41c). With the seq guard in place, the
  sort only decides which *intermediate* commands touch the player.
  `TestSupersededSeekIsNeverApplied` fails without it: an out-of-buffer seek
  overtaken by a pause is applied anyway, costing two segment fetches.
- The 250 ms spacing of anomaly reports (§41e).
  `TestAnomalyReportsAreSpacedButHeartbeatsAreNot` fails without it: one report
  every 50 ms.

### The table now

Servo against §41's "now" columns: `slow-to-buffer` 11/15 → **8/10** (mean
10/16 → 8/14), `asymmetry+cmds` 293/600 → **320/657** (mean 298/599 → 324/647),
`command-storm` 68/295 → **97/295** (mean 78/325 → 104/327). Every other servo
row keeps its anchorErr and `skipped`.

## 43. Round 14 — a joiner's own site acting on its player (D8)

C1 in STATE.md: a site's autoplay or resume-from-history on a video a client
has just found was broadcast as the member's own `play`/`seek`. The harness had
no model of a site at all, so nothing here could see it. Measured first in a
real browser (BROWSER-FINDINGS §20: Laftel resumes to its history position and
autoplays 4–11 ms after `canplaythrough`), then modelled.

**Model.** `ClientProfile.SiteAfterMs/SiteResumeToMs/SiteAutoplay`: that long
after the member joins — when its player can play — its site seeks to the
resume point and starts playback. With the acquisition guard (the shipped
engine) the member reports `acquiring` until then, and the site's moves are put
back by conforming to the room. `NoAcquireGuard` is the control: the moves are
sent as the member's `seek` and `play`, as the client did before D8.

**Scenario `site-autoplay-join`.** A paused room at 60 s (a, b); c joins at
20 s on a page that resumes to 813 s and autoplays 1.5 s later; a presses play
at 21.2 s, while c is still loading. Servo, seeds 1..10:

| | site commands sent | moves put back | plays held | room at the end |
|---|---|---|---|---|
| guard ON | **0** | 1.0 | 1.0 | **127.4 s** |
| guard OFF (control) | **2.0** | 0 | 0 | **880.9 s** |

Without the guard the room ends up wherever one member's site history pointed,
and the room starts without the member who was still loading. With it nothing
is sent and the play waits ~0.3 s for c. `skipped` is 0 in both: the damage
here is not media skipped past by corrections but the room itself being moved,
which is why the test scores the final anchor. Servo row, mean over seeds
1..10: anchorErr 6 ms, p95 18 ms, 2 out-of-buffer seeks (c's resume and its
conform back), 0 skipped.

`TestAcquireGuardIsLoadBearing` pins it over seeds 1..10 with the control, and
asserts the structural half (0 site commands) on every seed. Every row of the
table that existed before is byte-identical: the new behaviour only engages
for a profile with a site.

Also new on the server side and covered in `room_test.go` rather than here:
`acquiring` reports are gated and not judged, `finished` is absent, a
conditional `media` command refuses without a seq, and after any `media`
command every member is unready until it reports on the new seq.

## 44. Round 15 — the next episode, through the room (D8, integration review)

A review found §43's last paragraph doing more work than it could: nothing in
the simulation sent a `media` command or reported `finished`, so the
compare-and-set, the pre-gate every `media` arms, the integration's exemption
for a backgrounded member, and in-transit gating were never simulated, and
"the pre-gate change does not alter any sim row" was true of a pre-gate no row
reached. The sim client now models the end of the media (stopped, `finished`,
absent — never a `pause`), the site moving on after its countdown and sending
`media` with `ifMediaKey`, the new episode loading (`readyState` 1, acquiring),
the conform, the winner's `play`, `media_stale` for the loser, and "on its way"
for a member that finished what the room just left. `NoMediaCAS` and
`NoTransitGuard` are the controls. A suspended member may report on a
throttled timer (`SuspendedReportEveryMs`, the minute Chrome's intensive
throttling gives a background tab), after reporting the suspension itself at
once.

**Scenario `next-episode`.** A playing room ends "m" at 60 s. a's site moves on
after 5 s with the next episode preloaded (its `play` follows its `media` before
anyone else has reported on the new seq); b's 60 ms after a's, before hearing of
it; c's after 9 s, still on the end screen when the room moves; d is a
throttled background tab, never finished. Servo, seeds 1..10:

| | media applied | refused | plays held | held for | arrived late |
|---|---|---|---|---|---|
| both ON | **1.0** | 1.0 | 1.0 | 6962 ms | **0 ms** |
| no condition (control) | **2.0** | 0 | 2.0 | 4436 ms | 0 ms |
| no in-transit (control) | 1.0 | 1.0 | 1.0 | 2547 ms | **3824 ms** |

Without the condition b's continuation restarts the room under a's, and both
send a `play`. Without "on its way" c is absent when the room moves on, the
play goes as soon as a and b are ready, and c joins an episode 3.8 s in. With
both, the play waits for c — about 7 s, c's countdown and load — and never for
d. Mutations `TestNextEpisodeMovesTheRoomOnceAndWaitsForTheMemberOnItsWay`
catches in `room.go`: the compare-and-set (2 applied per run), the
suspended-not-finished exemption (the hold grows to ~25 s, d's throttled
report), and the pre-gate (a's play goes at once: 8.3 s late). Not caught here,
and pinned in `room_test.go` instead: `finished` implying suspended, and
acquiring-and-suspended not gating — this client never sends a report that
needs either. The acquiring report's own `markGated` is redundant with the
pre-gate in this scenario; each covers the other.

Every row of the table that existed before is unchanged: the new behaviour
only engages for a profile with an episode or a throttle.
