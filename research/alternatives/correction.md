# Alternative control laws for drift correction — measured

Challenge target: `StepRampCorrector` (docs/POC-FINDINGS.md §7-8), the strategy adopted in round 2.

Everything here is from `mise run sim`. Code: `server/internal/sync/corrector_alt.go` (new, 7 new
strategies), harness metric additions in `server/internal/sim/`, registration in
`server/cmd/simharness/main.go`. Runs are deterministic — one determinism bug in the harness was
found and fixed to make that true (§7c).

---

## 0. Headline

**Yes, the baseline is beatable, and by a lot.** `HybridCorrector` ("hybrid") beats
`StepRampCorrector` on mean *and* p95 ground-truth error in **10 of 11 scenarios**, typically by
3-15x, while issuing **fewer or equal** hard seeks:

| | step-ramp | hybrid |
|---|---|---|
| steady/rate-drift | 154 / 471 ms, 3 seeks | **41 / 65 ms, 0 seeks** |
| latency-asymmetry | 398 / 1200 ms, 6 seeks | **10 / 10 ms, 0 seeks** |
| bias+rate-drift (new) | 597 / 1620 ms, 6 seeks | **36 / 60 ms, 0 seeks** |
| long-stalls | 30 / 70 ms, 4 seeks | **20 / 35 ms, 4 seeks** |
| noisy-position (new) | 166 / 466 ms, 2 seeks | **25 / 55 ms, 0 seeks** |
| bias+commands (new) | 514 / 1438 ms, 50 seeks | **286 / 705 ms, 22 seeks** |

(mean / p95 error against the anchor, in ms.)

The remaining scenario, `command-storm`, is a loss on paper (1477 vs 139) and the reason is **not the
control law** — it is two harness/protocol faults that the new metric exposed, one of which is a
real bug in the round-2 design. With either fault removed, hybrid wins there too. §7 documents both;
they are arguably more valuable than the corrector result.

Three ideas were falsified, one of them predicted in advance:

- **PI/PLL on phase is the wrong loop for this plant.** Best-in-class when the clock estimate is
  clean (4 ms mean on steady drift, 38x better than the baseline) and it walks straight into
  POC-FINDINGS §6's trap when it is not — an integrator's *purpose* is to eliminate a constant
  offset, including one that only exists in the estimate.
- **A Kalman filter is not worth it here** — worse than the unfiltered baseline on the very
  scenario built to give it a fair chance.
- **An adaptive dead-band is a no-op at best and self-disabling at worst** — measured.

Two cheap wins are worth taking even if the hybrid is rejected: **seek-with-lead** (one line,
better or equal in 8 of 11 scenarios, never materially worse) and **carrying the rate on the seek
message**.

---

## 1. The organising argument: what is observable

A client's residual is measured *through its own estimate of server time*:

```
res(t) = pos(t) − anchor.Expected(clientClock(t) + estOffset)
```

If `estOffset` is wrong by *b* — one-way latency asymmetry, which min-RTT cannot detect even in
principle (SYNTHESIS §1) — then every residual that client will ever report is wrong by exactly *b*,
forever. **Phase is unobservable up to a constant.** The derivative is not:

```
d/dt res(t) = effectiveRate − 1        for any constant b
```

The slope is bias-immune. That single fact organises every design below and predicts the results:

1. Any **integrator on phase** (PI, PLL, and the seek loop the baseline runs) converges to the bias
   and physically moves the client off position. This is POC-FINDINGS §6 restated: textbook control
   theory does not avoid that trap, it *automates* it.
2. A **frequency-locked loop** — integrate the slope, never the residual — cannot be pulled off
   position by a bad estimate. It also cannot close a phase offset, so phase must be handled
   separately, and gated on evidence that the offset is real.

This is the FLL-aided-PLL structure from GNSS/clock recovery. The novelty for this project is not
the loop, it is the **observability argument that says which loop is allowed to run on which
signal**.

---

## 2. Metric changes (read before the table)

**`MeanDivergenceMs` — the metric round 2 was scored on — is inter-client spread, and it rewards
inaction.** In `latency-asymmetry` all three clients start aligned at exactly 1.0x, so a strategy
that does nothing scores a perfect 0 (`threshold-2000` does exactly this). Spread cannot distinguish
"correctly did nothing" from "was never tested", and it cannot see the whole room drifting away from
the anchor together.

Added, and used as the primary metric here:

- **`anchorErr` = `|clientPos − anchor.Expected(trueServerMs)|`**, sampled at 10 Hz against the
  *true* server clock. This is the quantity a corrector is actually minimising, and it is the only
  metric that shows the self-inflicted divergence of §6. Blanked for 4 s after each injected command
  (the anchor has moved and nobody is meant to be there yet); `ConvergeMs` covers the transition.
- **`rateTimeMs` = ∫|playbackRate − 1| dt**, summed over clients: accumulated ms of time-shift
  bought with speed changes. This is the honest counterpart to seek count, because **`nudges` is not
  comparable across laws** — a continuous controller emits a message per report by construction
  (`derivative` shows 236 in one cell), which says nothing about what the user hears.
- **`maxRateDev`** (worst instantaneous |rate−1|, i.e. audibility) and **`rateChanges`** (distinct
  applied rates, i.e. perceptible transitions).
- **`jumpMaxMs`**: the largest position discontinuity actually applied.

One reading of `rateTimeMs` is essential: in `steady/rate-drift` the two defective clients are 1.0%
slow and 0.8% fast, so **any** law that truly fixes the rate must spend ≈ 0.01·120 s + 0.008·120 s ≈
2160 ms of rate-time. `pi`/`pll`/`fll`/`hybrid` all spend ≈ 2050-2300 ms: that is not overhead, it
*is* the drift being cancelled. `step-ramp`'s 92 ms is the tell that it is not addressing the cause
at all — it lets error accumulate to the dead-band and then seeks.

Two scenarios were added because no existing one could discriminate:

- **`bias+rate-drift`** — a biased clock *and* a real rate error in the same client. This is where a
  phase law and a frequency law must disagree, and nothing in the old set had both.
- **`noisy-position`** — `PosQuantMs` quantises the position the client *observes* (41.7 ms = 24 fps),
  because a real `video.currentTime` is frame-quantised. Without it the harness hands every client a
  perfect sensor, which makes any denoising filter a no-op by construction and the Kalman question
  unanswerable.
- **`step-then-ramp`** — a slow decoder that also stalls, so the classifier must switch modes twice.
- **`bias+commands`** — biased clocks *and* room commands, added last after review pointed out that
  the bias baseline had never met a `pause`/`play`/`seek`. Under D4 (no host) that is the routine
  case, and it is where the baseline goes stale: §5e.

**Reading `p95 < mean`.** Several `pll` cells look like typos (`long-stalls` 115/10, `one-slow-client`
39/29). They are heavy tails: 95% of samples are under 10 ms and the top 5% are in the thousands, so
the mean sits above the p95. It is a distribution worth knowing about — a loop that is usually
excellent and occasionally seconds out is a different product than one that is uniformly mediocre.

---

## 3. Pre-registered win criterion

Stated before the runs, because this repo has already burned one hypothesis on a metric that did not
mean what it looked like:

> A strategy beats `StepRampCorrector` only if it is no worse on mean **and** p95 anchor error in
> every scenario and strictly better in at least one, or equal on error at materially lower
> correction cost — and `latency-asymmetry` must not regress.

`hybrid` satisfies this in 10 of 11 scenarios. It fails on `command-storm` in the default
configuration. That failure is analysed rather than excused in §7, and the honest summary is: with
the stale-state artifact removed, hybrid is 70/85 vs step-ramp 65/210 — better on p95, 5 ms worse on
mean, i.e. a tie.

---

## 4. Results — ground-truth error, mean / p95 ms

Lower is better. Bold = best in row. Full output: `mise run sim`.

| scenario | threshold-500 | threshold-2000 | derivative | **step-ramp** | pi | pll | fll | kalman | step-ramp+lead | hybrid-nobias | **hybrid** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| steady/rate-drift | 152/446 | 363/1010 | 258/501 | 154/471 | 6/23 | **4/9** | 24/42 | 235/575 | 157/472 | 24/42 | 41/65 |
| transient-hiccup | 13/20 | 189/1390 | 159/524 | 13/20 | 39/196 | 34/189 | 437/2290 | 62/452 | **9/10** | **9/10** | **9/10** |
| long-stalls | 30/70 | 30/70 | 214/1325 | 30/70 | 144/1332 | 115/10 | 2667/13490 | 73/180 | **18/25** | 20/35 | 20/35 |
| one-slow-client | 115/468 | 177/893 | 135/525 | 113/510 | **16/37** | 39/29 | 975/4022 | 110/459 | 100/451 | 34/92 | 56/189 |
| clock-skew | 123/333 | 123/333 | 123/333 | 123/333 | 4/12 | **4/9** | 11/23 | 123/333 | 123/333 | 11/23 | 16/33 |
| latency-asymmetry | 401/1200 | **10/10** | 110/175 | 398/1200 | 376/621 | 372/599 | **10/10** | 410/1190 | 388/590 | 392/600 | **10/10** |
| bias+rate-drift *(new)* | 541/1626 | 363/1010 | 440/1064 | 597/1620 | 380/644 | 376/601 | **31/50** | 650/1693 | 639/1094 | 410/633 | 36/60 |
| step-then-ramp *(new)* | 104/297 | 412/1795 | 305/1276 | 104/297 | 130/1013 | 35/14 | 875/3512 | 83/261 | 91/248 | **18/51** | 22/46 |
| noisy-position *(new)* | 150/430 | 263/806 | 218/497 | 166/466 | 27/50 | 21/40 | **15/33** | 219/499 | 162/455 | **15/33** | 25/55 |
| bias+commands *(new)* † | 568/1447 | 491/1402 | 557/1172 | 514/1438 | 465/1117 | 2594/11360 | 46864/268729 | 600/1412 | 416/1805 | 368/639 | **286/705** |
| command-storm † | 1500/14190 | 1489/14190 | 1525/14170 | **139/810** | 1486/14190 | 1837/15250 | 45835/272288 | 480/1640 | 103/765 | 1468/14160 | 1477/14140 |

† both command scenarios are inflated by the stale-state fault of §7b. With the resend enabled
(`-resend`):
`command-storm` — threshold-500 98/270, step-ramp 65/210, step-ramp+lead **25/130**, hybrid 70/85,
kalman 119/429, fll 23775/272204.
`bias+commands` — threshold-500 515/1452, step-ramp 381/1310, step-ramp+lead 333/786,
hybrid-nobias 368/649, **hybrid 257/566** (and the best `maxAnchor` in the row, 750 ms).

### Correction cost — seeks / rateTimeMs / maxRateDev

| scenario | step-ramp | pll | fll | kalman | step-ramp+lead | hybrid |
|---|---|---|---|---|---|---|
| steady/rate-drift | 3 / 92 / 0.062 | 0 / 2298 / 0.013 | 0 / 2107 / 0.010 | 1 / 482 / 0.062 | 3 / 94 / 0.062 | 0 / 2050 / 0.010 |
| transient-hiccup | 3 / 0 / 0 | 0 / 2943 / 0.100 | 0 / 0 / 0 | 2 / 568 / 0.092 | 3 / 0 / 0 | 3 / 75 / 0.001 |
| long-stalls | 4 / 0 / 0 | 4 / 1410 / 0.100 | 0 / 0 / 0 | 5 / 638 / 0.100 | 4 / 0 / 0 | 4 / 54 / 0.001 |
| one-slow-client | 2 / 217 / 0.063 | 1 / 1734 / 0.100 | 0 / 1148 / 0.021 | 3 / 413 / 0.100 | 2 / 109 / 0.063 | 1 / 1168 / 0.021 |
| latency-asymmetry | 6 / 0 / 0 | 0 / 1954 / 0.100 | 0 / 0 / 0 | 7 / 198 / 0.074 | 3 / 0 / 0 | **0 / 0 / 0** |
| bias+rate-drift | 6 / 1302 / 0.084 | 0 / 3387 / 0.100 | 0 / 2073 / 0.012 | 7 / 1277 / 0.073 | 2 / 1285 / 0.064 | **0 / 2066 / 0.012** |
| step-then-ramp | 3 / 0 / 0 | 3 / 2036 / 0.100 | 0 / 1160 / 0.007 | 3 / 494 / 0.100 | 3 / 0 / 0 | 3 / 1112 / 0.007 |
| noisy-position | 2 / 105 / 0.064 | 0 / 2298 / 0.022 | 0 / 1676 / 0.010 | 0 / 573 / 0.062 | 2 / 73 / 0.064 | 0 / 1665 / 0.011 |
| bias+commands | 50 / 389 / 0.100 | 4 / 4708 / 0.100 | 0 / 1333 / 0.021 | 52 / 428 / 0.092 | 32 / 1581 / 0.100 | 22 / **6307** / 0.100 |

The shape of the trade is visible in `maxRateDev`: the baseline's nudges hit **6.2%** speed
deviation, the hybrid's typically **1.0-2.1%**, and it never seeks more often. The hybrid *whispers
continuously* where the baseline *shouts occasionally* — and the whisper is mostly just cancelling
the client's own decoder error, which is a mismatch it is removing rather than adding.

---

## 5. Strategy by strategy

### 5a. PI on phase (`pi`) and the PLL (`pll`) — falsified, as predicted

Both are the same loop: `pi` is Kp/Ki on the residual with anti-windup; `pll` is the same filter
parameterised by loop bandwidth (ωn = 0.30 rad/s, ζ = 0.707 → Kp = 2ζωn, Ki = ωn²) plus a
**cycle-slip detector** that phase-jumps (seeks) when the step exceeds the loop's pull-in range and
**hands the integrator's accumulated frequency to a VCO register that survives the jump**.

Where the clock estimate is clean they are the best strategies measured, by a wide margin:
steady/rate-drift **4 / 9 ms** vs the baseline's 154 / 471, with **zero seeks**. That is not a small
result — it says a continuous law can hold a room inside 10 ms with no visible jumps at all, which
neither the baseline nor any of the nine references gets close to.

And the prediction written before the run held exactly:

| | latency-asymmetry | bias+rate-drift |
|---|---|---|
| do nothing (threshold-2000) | 10 / 10 | 363 / 1010 |
| pi | 376 / 621 | 380 / 644 |
| pll | 372 / 599 | 376 / 601 |
| fll / hybrid | **10 / 10** | **31-36 / 50-60** |

An integrator on phase converges to the bias — 590 ms of it — and *physically moves the client
there*, spending 1622-3387 ms of rate-time at the ±10% clamp to do it. It is not worse than the
baseline (which seeks onto the same bias); it is ~37x worse than a law that cannot be fooled. The
cycle-slip handling is real and useful (`step-then-ramp` p95 14 ms, the best in that row), but it
does not rescue the phase term.

Also note `pll`'s `command-storm` divergence p95 of 239 988 ms and a 4000 ms convergence: with two
conflicting commands 50 ms apart the loop's phase term keeps a client accelerating on a stale
reference. A bang-bang law recovers faster from a discontinuity than a bandwidth-limited loop, which
is the honest counter-argument to "just use a proper controller".

### 5b. Frequency-locked loop (`fll`) — the mechanism that works, alone it is not shippable

Integrates the reported slope only, never the residual. It is exactly as bias-immune as the theory
says: `latency-asymmetry` **10 / 10 ms with zero seeks and zero nudges** — it simply never notices
the 590 ms of estimate error, because that error has no derivative. On `bias+rate-drift` it fixes
both defective decoders and ignores both biases: **31 / 50 ms**.

And it fails exactly where theory says it must — no phase authority:

- `long-stalls` **2667 / 13490 ms**: a stall is a pure step; the FLL sees the slope return to zero
  and concludes everything is fine 4 s out of position.
- `command-storm` **45 835 ms, convergence −1 (never)**: it cannot recover a client that missed a
  state transition.

This is a clean, publishable negative on its own: **frequency lock is necessary and not sufficient;
a corrector must retain the authority to jump the phase.**

### 5c. Kalman filter (`kalman`) — documented negative

Two states (phase, frequency), `H = [1 0]`, `F = [[1,dt],[0,1]]`, StepRamp policy applied to the
filtered estimates, plus a **variance gate** that refuses to seek while `P[0][0]` is high — the
"do not act on an untrusted estimate" requirement of POC-FINDINGS §8.4, expressed as a covariance
instead of a sample count.

It loses to the *unfiltered* baseline on the clean scenarios (steady 235/575 vs 154/471) and — the
result that settles it — loses on `noisy-position`, the scenario built specifically to give it
something to denoise: **219 / 499 vs `fll` 15 / 33 and `step-ramp` 166 / 466.**

Why, stated as the reusable lesson: **the dominant error term here is bias, and a filter that
assumes zero-mean measurement noise cannot see a bias by construction** — it is in the model's null
space. What the filter does contribute is lag: its phase estimate trails a step by design, which
delays precisely the correction that matters. Even the frame quantisation it was meant to smooth is
already handled, because the client's slope is a 3 s least-squares fit and the residual dead-band is
500 ms — 12 ms of sensor noise never reaches the decision.

The variance gate is the one salvageable piece (it suppressed seeks during settling), but the
`hybrid`'s warm-up hold achieves the same thing in four lines.

### 5d. Seek-with-lead (`step-ramp+lead`) — cheap, real, adopt regardless

`StepRampCorrector` with one change: the seek target is `Expected(now + oneWayDelay)` instead of
`Expected(now)`, where the delay is a min-filtered, hard-clamped estimate of `now − report.AtServerMs`
computed inside the corrector (no protocol change). A hard seek is visible partly because it lands
at a position already stale by the downlink delay — on a 200 ms link the baseline plants the client
200 ms behind the anchor at the instant it "corrects" it.

It is better or equal on 8 of 11 scenarios and never materially worse. The exceptions are
`steady/rate-drift` (157/472 vs 154/471 — noise) and the two bias scenarios, where the mean and p95
move in opposite directions (`bias+rate-drift` 597/1620 → 639/1094; `bias+commands` 514/1438 →
416/1805) — leading a seek does nothing about the bias that made the seek wrong in the first place. Its best cells are the seek-heavy ones:
`long-stalls` **18/25 vs 30/70**, `transient-hiccup` **9/10 vs 13/20**, `command-storm` **103/765 vs
139/810** (and 25/130 with the resend fix — the best cell in that row). On `good` links it is a
25 ms effect; do not over-claim from those cells. The min-filter matters: under asymmetry the
estimator is itself biased (610 ms observed where the true downlink is 1200 ms), which is why it is
clamped to 600 ms.

### 5e. `hybrid` — the proposal

Four separable pieces, ablated below:

1. **FLL on the reported slope** (bias-immune) removes the *cause* of ramps and keeps running
   underneath every other action.
2. **Phase judged against a baseline learned at join.** A client that has just joined positioned
   itself *from the anchor*, so its true position error is ~0 by construction and whatever residual
   it reports is its clock bias. Absorbing that up front is the same conclusion the round-2
   failed-seek detector reaches after several damaging seeks — reached before the damage. Bounded to
   ±1500 ms, and **only absorbed if it exceeds the dead-band** (below that it cannot cause a
   persistent correction anyway, and learning it would bake in a permanent offset equal to the
   estimate's own error). Seeks are suppressed until the baseline exists. This is a *proxy* for the
   confidence gate POC-FINDINGS §8.4 asked for, not the thing itself: §8.4 wanted gating on
   clock-estimate confidence (min-RTT sample count, stable `bestRTT`), and `Report` carries neither,
   so this gates on elapsed time instead. Carrying `bestRtt` and a sample count in the heartbeat
   would let it be done properly and costs two integers.
3. **Seek carries the rate** (§5d lead + combined action), and the frequency estimate survives the
   jump.
4. **Hysteretic dead-band** (enter 500 ms, leave at half) with dead-time suppression.

Ablation (mean ms):

| | step-ramp | +lead only | fll only | fll+phase, no baseline | hybrid |
|---|---|---|---|---|---|
| steady/rate-drift | 154 | 157 | 24 | 24 | 41 |
| long-stalls | 30 | 18 | 2667 | 20 | 20 |
| latency-asymmetry | 398 | 388 | 10 | 392 | **10** |
| bias+rate-drift | 597 | 639 | 31 | 410 | **36** |
| step-then-ramp | 104 | 91 | 875 | 18 | 22 |

Each column is load-bearing: the lead alone is a modest win, the FLL alone collapses on steps,
FLL+phase without the baseline collapses under bias (392/410), and only the full combination is good
everywhere. The baseline learning costs a little in the clean scenarios (41 vs 24 on steady drift)
for a fully understood reason: during the 2.5 s warm-up hold a 1%-slow client accrues ~25 ms of real
offset, and an FLL has no phase memory to remove an offset that sits inside the dead-band.

**Known limitation, found by review and then measured: the learned baseline goes stale on every
room command.** When a client applies a scheduled command it jumps to `Expected(est)` using *its
own* biased estimate, so it lands `bias` ms off the true position while its measured residual reads
~0 — the error is invisible on the channel the corrector reads. `bias+commands` was added to test
exactly this. Hybrid still wins there (286/705 vs step-ramp 514/1438; 257/566 vs 381/1310 with the
resend fix, with the best `maxAnchor` in the row) — but **it pays for the stale baseline in rate
work**: 6307 ms of rate-time and 246 rate changes at the ±10% clamp, against step-ramp's 389 ms. It
is accurate but it is working hard, and that cost lands directly on the Risk-B question of whether
continuous `playbackRate` manipulation is acceptable.

The obvious fix — one corrective seek, in true server time, whenever a known-biased client applies a
command — was implemented and measured. **It made things worse**: 286/705 → 290/805 ms and 16 → 29
seeks, with the resend fix 257/566 → 310/595. Reverted, and left as a comment in the code so nobody
re-derives it. The real fix is probably to re-estimate the baseline continuously with an uncertainty
bound rather than once at join; that is unbuilt and unmeasured.

**Design rule that came out of this and must not be split up:** the phase dead-band must be ≥ the
largest bias we decline to learn. Both are 500 ms. Tightening the dead-band without also tightening
the learn threshold re-creates the seek storm on sub-threshold asymmetry.

---

## 6. Two bugs the traces caught in my own strategies (both instructive)

**Adaptive dead-bands are self-disabling if fed their own signal.** First version widened the band to
3σ of *all* observed residuals. One genuine 270 s step inflated σ to tens of thousands, the band
opened wider than the error, and the corrector silently stopped correcting: measured as 22 164 ms
mean anchor error on `command-storm`. Fixed by feeding the estimator only quiet samples (|res| inside
the fixed tolerance) and capping the band at 1.5x tolerance. **Then it never fires**: even with
frame-quantised positions, σ ≈ 12 ms, so 3σ never approaches 500 ms. Verdict: **an adaptive
dead-band buys nothing here and is dangerous done naively — keep the fixed 500 ms.** The hysteresis
is retained (it is free), but note it has its own cost: with a proportional phase term the error
parks at the exit band rather than at zero.

**Transport dead time.** After issuing a seek, the next 10 Hz report still describes the world
*before* it landed. Acting on that is how a delayed loop oscillates: the trace showed a 4 s stall
corrected to +45 ms and then pushed to +100 ms by a 1.10x nudge nobody had cancelled, where it parked
inside the hysteresis band. Two fixes, both measurable: ignore reports for `2·lead + 250 ms` after an
actuation (`long-stalls` 47 → 20 mean), and **send the rate with the seek** so the two are one
action. The baseline escapes this only by ordering luck — its `|res| ≥ 3000 → seek` branch shadows
its nudge branch, and the server's cooldown suppresses the duplicate *seek* while nothing suppressed
the duplicate *nudge*.

---

## 7. Findings outside the corrector (more important than the corrector result)

### 7a. The round-2 clock-bias learner is unsound without a bound — real bug

`corrState` absorbs a residual that survives N seeks as "clock bias". **A lost correction message is
indistinguishable from a biased clock** — both show a residual that repeated seeks do not move. In
`command-storm` a client on a 2% loss link had a **240 second** step absorbed as bias; its effective
residual then read zero and it was stranded for the remaining 90 s of the session
(`maxAnchorErr` 272 s for threshold-500 *and* step-ramp).

Fix applied in the harness: only absorb residuals ≤ 2000 ms — a clock bias is bounded by the
asymmetry that produced it, anything larger is a real position error and must keep being corrected.
Effect on the baseline, `command-storm` mean anchor error: **1391 → 139 ms.**

**This changes a published number.** POC-FINDINGS §7's table gives `command-storm` step-ramp a mean
*divergence* of 4390 ms; with the bound in place `mise run sim` now reports 1061 for that cell. The
authority doc no longer reproduces, and that is the bound doing its job, not drift. Update §7 or
annotate the row.

This bug was invisible to the round-2 metric (spread), and it is in the *shipped* design, not in any
of my strategies. It should be fixed before Risk B.

### 7b. The residual channel is structurally blind to a stale-anchor client

`command-storm`'s remaining error, for every strategy, is one client that ends up in the wrong
play/pause state relative to the room. Instrumenting it: **that client reports `residualMs = 0`
while being 29 s out of position** — it is perfectly aligned with the stale anchor it still
believes in. No control law can fix this, because the fault is invisible on the channel the law
reads.

`lastAppliedSeq` is in the heartbeat for exactly this (PROTOCOL §4: "what lets the server spot a
client stuck on stale state") and **no corrector, ours or any of the nine references, looks at it**.
A 3-line server-side resend (`-resend`, off by default) collapses `command-storm` for everyone:

| | default | with resend |
|---|---|---|
| threshold-500 | 1500 / 14190 | **98 / 270** |
| step-ramp | 139 / 810 | 65 / 210 |
| step-ramp+lead | 103 / 765 | **25 / 130** |
| hybrid | 1477 / 14140 | **70 / 85** |

Note what this exposes about the default column: `step-ramp`'s apparent 139 ms win there is an
**accident**. Traced: the server learned a spurious −1547 ms "bias" for that client during the
early pause/play churn, so a report of `res = 0` reads as `eff = +1547` and triggers a seek every
2 s — 45 seeks and 337 suppressed. It keeps the client positionally close by hammering it, for the
wrong reason, driven by a bug. Recommend `state.resync` as a protocol action, and treat that cell as
uninformative until then.

### 7c. The harness was not deterministic

`Server.Deliver` broadcast state by ranging a Go map, so network sequence numbers — and therefore
delivery tie-breaks — were assigned in a per-process random order. Command scenarios varied run to
run (`step-ramp+lead` mean 103 vs 113). Fixed by iterating sorted client IDs. The harness's
determinism claim is now true; every number in this document is reproducible.

### 7d. Stateful correctors need per-run construction

`main.go` now registers **factories**, not instances. Integrators, learned baselines and Kalman
covariances would otherwise leak across scenarios and silently destroy reproducibility.

---

## 8. Recommendations

Adopt, in ascending order of risk:

1. **Bound bias absorption at ~2 s** (§7a). Bug fix, no design change.
2. **Deterministic broadcast ordering** (§7c). Bug fix.
3. **Seek-with-lead** (§5d). One line in the corrector, no protocol change, better or equal in
   8 of 11 and never materially worse.
4. **Rate travels with the seek** — `correct` gains an optional `rate` field (§6). Removes a class of
   post-seek overshoot.
5. **Dead-time suppression** after any correction (§6).
6. **Stale-state resync on `lastAppliedSeq`** (§7b). Protocol addition; fixes a fault no control law
   can reach.
7. **`HybridCorrector`** (§5e) as the default policy. Server-side only — with the caveat that its
   baseline goes stale on every room command (§5e). It still wins the command scenarios, but its
   rate-time cost there is 16x the baseline's, and the obvious repair was measured and rejected.
   If that cost is judged unacceptable before Risk B answers the `playbackRate` question, adopt
   1-6 and hold 7.

Reject:

- **PI/PLL on the residual** (§5a) — best-in-class only when the clock estimate is trustworthy,
  which is exactly the condition we cannot verify.
- **Kalman filtering** (§5c) — measurable loss, real complexity.
- **Adaptive dead-band** (§6) — never fires, and self-disabling when implemented naively.
- **FLL alone** (§5b) — necessary mechanism, insufficient policy.

## 9. What this is still not evidence about

Unchanged from POC-FINDINGS §9, and the hybrid *increases* the exposure: it holds a small non-unity
`playbackRate` almost continuously (typically 1.0-2.1% deviation) where the baseline is at 1.0x
except during nudges. If `playbackRate` turns out to be unsafe on Laftel or YouTube's player, the
hybrid loses its frequency term and degrades to roughly `step-ramp+lead` plus the bias baseline —
measured only as its parts (§5d, and the `hybrid-nobias` column for what the baseline is worth), not
as that combination. The headline result depends on a capability Risk B has not yet confirmed. A 1% rate offset is ~17 cents of pitch shift and browsers preserve pitch by default, so
the expected audibility is low; that is a hypothesis, not a measurement.

The harness still has no `setInterval` clamp, its seeks are instantaneous, and it models neither MSE
buffered-range stalls nor background-tab throttling.
