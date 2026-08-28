# Architecture alternatives — an adversarial review of the server-authoritative anchor

Scope: challenge the top-level topology (server-authoritative anchor + client reports +
server-issued corrections) against structurally different designs. Inputs: `docs/DECISIONS.md`
(D1–D5 locked), `research/SYNTHESIS.md`, `docs/PROTOCOL.md`, `docs/POC-FINDINGS.md`,
`server/internal/{sync,sim}`.

**Verdict up front: the current architecture survives.** None of the four proposed alternatives
addresses a failure mode that has actually been measured, and two of them are the current design
with extra steps. But there is a defect in the correction path that must be fixed *before* any of
this is worth measuring, because it confounds the single result that most motivates
re-architecting.

---

## 0. The confound: corrections are not time-compensated

This is the most important thing in this document, and it is not an architecture issue.

`server/internal/sim/server.go`:

```go
net.Send(now, r.ClientID, "server", r.ClientID, false,
    MsgCorrect{Mode: "seek", TargetMs: d.TargetMs, When: now, Why: d.Why})
```

`d.TargetMs` is `a.Expected(serverMs)` — where the room is **at the instant the server decides**.
`When` is `now`, i.e. already in the past. And `server/internal/sim/client.go` ignores `When`
entirely:

```go
case MsgCorrect:
    if v.Mode == "seek" {
        c.posMs = float64(v.TargetMs)
```

So a seek correction lands `DownMs + jitter` after the target was computed, and the client is
placed **exactly one downlink-delay behind the room, by construction**. Every hard seek
manufactures a residual equal to that client's downlink latency.

Now look at the `latency-asymmetry` scenario. Client `b` has `DownMs: 1200`. Round-2 mean
divergence for `threshold-500` and `step-ramp` is **1184 ms**. `derivative`, which never seeks
there, gets 320 ms.

1184 ≈ 1200. The number that POC §6 attributes to "seeking on a biased clock estimate" is, to
within jitter, client `b`'s downlink delay.

Contrast with the commands path, which does this correctly: `MsgCmd` handling computes
`when := now + s.cmdDelay()` and re-anchors at `when`, so the transition is scheduled into the
future and every client lands on the same point. `MsgCorrect` — the *unicast* path — was never
given the same treatment. `docs/PROTOCOL.md` §5 does declare a `when` field on `correct`; the
implementation just does not honour it on either side.

### What this does to POC §6

POC-FINDINGS round 2, §6 concludes:

> Seeking on a biased clock estimate actively creates divergence that was not there.

**That conclusion is confounded and cannot be accepted as stated.** Two mechanisms are entangled:

1. the clock-offset bias (real, and irreducible — §1 of SYNTHESIS is right that min-RTT cannot
   see one-way asymmetry);
2. the uncompensated correction latency (an implementation defect, entirely fixable).

Their magnitudes differ. For client `b`: the estimator bias is
`offset = ((tRecv − t0) + (tSend − t1))/2 = (20 − 1200)/2 = −590` ms — `b` believes server time is
590 ms *earlier* than it is, so it reads itself as ~590 ms ahead when it is aligned. The
uncompensated-seek error is 1200 ms. **The larger of the two is the bug, not the physics.**

The fix, and the experiment that settles it:

- server: `when := now + estimatedDownlink(client)`, `TargetMs = anchor.Expected(when)`;
- client: on `MsgCorrect{seek}`, apply `TargetMs + (serverNowEst − When)` rather than `TargetMs`.

The client-side form still uses its own biased `serverNowEst`, so for `b` a 1200 ms error becomes
~590 ms, not zero. That residual 590 ms **is** the genuine §1 limit, and it is what the
failed-correction/bias-learning detector should be sized against. Re-run `latency-asymmetry` with
compensation before drawing any conclusion about whether server-issued corrections are the problem.

### Why this poisons the comparison of every proposal below

Every alternative in this document reduces the number of hard seeks — client-side actuation,
confidence gating, a servo/PLL corrector, gate-first. **On the current harness they will all look
good on `latency-asymmetry` for the wrong reason**: they avoid a defective seek, not a defective
architecture. `derivative`'s 320 ms is already an instance of exactly this false positive; POC §7
correctly calls it "best only by the accident of never seeking" but does not identify *why* not
seeking helps so much.

Do not rank correctors on `latency-asymmetry` again until §0 is fixed.

---

## 0b. Two smaller defects found while reading, both feeding the same place

**`p95` is `max` at every realistic room size.** `Server.cmdDelay`:

```go
idx := (len(vals)*95 + 99) / 100
if idx >= len(vals) { idx = len(vals) - 1 }
```

`ceil(n × 0.95)` with 0-based indexing exceeds `n−1` for every `n < 40`, so it clamps to the
maximum. SYNTHESIS §2's amendment — "p95 rather than max, so a single outlier does not dominate" —
is **defeated for every room this product will ever have**. One bad connection sets the command
delay for everybody, which is precisely the no-host failure the amendment was written to prevent.

There is no index arithmetic that repairs this, and it is worth being blunt because the obvious
patch is also wrong: `idx := int(math.Ceil(0.95*float64(n))) - 1` gives `ceil(2.85) − 1 = 2` at
n=3 — the maximum, i.e. the same answer as the bug. **A 95th percentile is meaningless at n=3**,
where no percentile can exclude an outlier without excluding a third of the room. So either state
honestly that the 2000 ms cap is the only real protection and p95 is decoration at these sizes, or
specify a statistic defined for small n: *second-highest for n ≥ 3, max below that*. Whichever is
chosen must be written down, because SYNTHESIS §2's stated rationale is not currently delivered by
any code path. This is a further argument for proposal 2 below, which sidesteps the statistic
entirely.

**The ping estimate is contaminated by the quantity under test.**

```go
s.pings[r.ClientID] = now - r.AtServerMs + 0 // crude one-way estimate
```

`r.AtServerMs` is the client's *estimated* server time. So `ping = true_uplink − clock_bias`. For
client `b` (bias −590, uplink 20) this reads ≈ +610 ms; for `c` (bias +590, uplink 1200) ≈ +610 ms
too, coincidentally. In general a clock-biased client can inflate or deflate the number, and via
the `p95 == max` bug it then sets `when` for the entire room. **A client's clock-estimate error
propagates into every other client's transition timing.** That is a cross-contamination path the
design does not acknowledge, and it is the strongest single argument for proposal 2 below
(readiness-driven transitions instead of ping-derived delay).

---

## 1. What must survive, regardless

Stated before the alternatives, because each is judged on whether it preserves these.

| Component | Why it is load-bearing |
|---|---|
| **Anchor + closed-form `Expected(T)`** | Makes late join, reconnect and "where should I be" a single O(1) evaluation with no history. This is the property every alternative below either duplicates or destroys. |
| **Server-assigned monotonic `seq` under a per-room mutex** | D4 has no host, so the server is the *only* possible tie-breaker. Every alternative still needs this; none removes it. D2's single process makes it trivially correct. |
| **Scheduled future `when`** | The reason no-host works: nobody races to be the timing authority (SYNTHESIS §2). |
| **Judge, don't aggregate** (§4c) | Prevents the room-position/client-position feedback loop that syncplay fights with accumulated guards. |
| **Client-computed residual and slope** | High-rate, zero network noise. The server must never differentiate 1 Hz reports. |
| **Stall inference in the detector** | Proven load-bearing: 13 spurious room-wide rewinds without it (POC §5). |
| **Failed-correction detection + bias learning** | The only way to observe one-way asymmetry (subject to §0 above re-sizing it). |

---

## 2. Proposal 1 — Event-sourced / deterministic replay

**Mechanism.** Replace the mutable anchor with an append-only log
`[]Cmd{Seq, When, Kind, PositionMs, By}`. Room position is `fold(log)` evaluated at `T`. Clients
receive the log tail and replay it. In Go:

```go
type Cmd struct { Seq uint64; When int64; Kind string; PositionMs int64; By string }

func Fold(log []Cmd, upto int64) Anchor {
    a := Anchor{}
    for _, c := range log {
        if c.When > upto { break }
        switch c.Kind {
        case "pause": a = a.Advance(c.When); a.Paused = true
        case "play":  a = a.Advance(c.When); a.Paused = false
        case "seek":  a = a.Reanchor(c.PositionMs, c.When, a.Paused)
        }
    }
    return a
}
```

**The kill argument.** That function is already in the repo. `sim/server.go`'s `MsgCmd` handler
*is* `Fold`, applied incrementally, and `Anchor` is its accumulator. Event sourcing does not add a
capability here; it adds a retention policy. Because `Anchor{positionMs, atServerMs, paused,
mediaKey}` is a **complete, self-describing snapshot** — 4 fields, no history dependence — the log
is compressible to a single element at every instant, and that element is the anchor. Event
sourcing is the anchor with a `[]Cmd` you must now bound.

**What it would genuinely buy, and why that is not enough.** Replay establishes agreement about the
*intended timeline*. But look at what has actually been measured: seek storm (§2/§6), stall
misdetection (§5), clock bias (§6), the confound in §0. **Every one of them lives in the actuation
and estimation layer — the physical `<video>` position versus a timeline both sides already agree
on.** No timeline-layer rearchitecture moves a single number on the POC scoreboard. The room's
idea of where it is has never been in dispute; the players' ability to be there is the whole
problem.

**Costs.** Log growth in a process that D2 says holds everything in memory with no Redis/Postgres —
so you need compaction, and the compacted form is the anchor, so you have built both. Late joiners
need a snapshot + tail (two code paths where there was one). An offline client replaying a long
tail must apply N transitions to reach a state one anchor would have given it.

**Failure modes.** A client that loses one log entry has a *silently wrong derived timeline
forever* and cannot detect it — the exact opposite of shipping absolute state, where the next
`state` frame heals everything. This is a serious regression under D5: MV3 service workers drop
sockets (SYNTHESIS §9) and reconnect is a designed-for event, not an edge case.

**Late join / reconnect.** Snapshot + tail. Strictly worse than "one anchor + `serverNow`".

**Harness measurement.** Cannot be measured today: **no scenario in `simharness/main.go` has a
client joining, leaving or reconnecting.** Add `Joins []int64` / `Leaves [][2]int64` to
`ClientProfile` and a `TimeToInToleranceMs` per join, then compare anchor-snapshot join against
log-replay join. Prediction: **identical**, because the anchor is a complete snapshot. That is the
cheapest way to close this proposal out for good.

**Verdict: reject.** Keep exactly one fragment: the log is worth keeping *as a bounded ring buffer
for UI attribution* ("A paused, then C seeked to 12:04") — SYNTHESIS §5 already wants `who`. That
is a feature, not a topology.

---

## 3. Proposal 2 — No server judgement (server as ordered broadcast bus)

The strongest of the four, and the one worth partially adopting.

**The prompt's framing, tested.** "POC §6 showed the server's judgement can actively create
divergence when its clock estimate is wrong." Two corrections. First, per §0, that result is
confounded and the dominant term is an uncompensated seek, not a judgement error. Second — and this
matters more — **the server has no clock estimate of its own.** It judges on `Report.ResidualMs`,
which the *client* computed using the *client's* offset estimate. The bias is client-side in both
architectures. Moving the judgement to the client does not remove the bias; it removes a round trip.

**What the judge role actually earns.** Three things a client cannot do alone:

1. **Cross-client comparison.** It is the only way to distinguish "B is wrong" from "everyone is
   wrong". A client seeing residual +590 cannot tell whether it drifted or the anchor is stale. The
   server seeing `A: +10, C: −20, B: +590` can. *This signal is currently computed and thrown
   away* — `Decide()` is called per-report with no visibility of the other clients' reports. That
   is a real missed opportunity in the current design, independent of any alternative.
2. **State that survives a sleeping tab.** `corrState{lastSeekAt, failedSeeks, biasMs}` must
   persist across background throttling, tab discard and reconnect. D5's userscript has no
   privileged runtime and no service worker — server-held state is strictly more durable than
   `GM_setValue`.
3. **The readiness gate**, which is inherently a room-level aggregate.

**Pure peer convergence — reject outright.** N² residual gossip, and under D4 there is no
tie-breaker for "whose position wins" other than the server. The prompt is right that ordered
broadcast is the hard part and the server already solves it; but peers converging *among
themselves* is precisely an aggregation, which §4c rejected for the feedback-loop reason, and D4
removes the only other arbiter.

**The variant worth building — split actuation timing from judgement.**

> The server keeps the judgement and the anti-storm state. The client keeps the *timing* of
> actuation and a veto.

Concretely:

- `Report` gains `ClockConfidence` (min-RTT sample count, `bestRTT` stability, spread of recent
  offset estimates). The server refuses to issue a seek to a client whose estimate has not settled
  — this implements POC §8 item 4 ("gate corrections on clock-estimate confidence") using data only
  the client has.
- `MsgCorrect` becomes advisory-with-deadline: `{targetPositionMs, when, deadline}`. The client
  actuates at `when` using its own high-rate loop rather than at message-arrival time. This *is*
  the §0 fix, generalised.
- The client may veto: if it is mid-nudge and converging, or `readyState < 3`, it replies
  `correct.declined{reason}` instead of seeking. The server's failed-seek counter distinguishes
  declined from failed.

This is not "no judgement". It is judgement at the server, actuation at the client, which is the
right seam and preserves all three things the judge earns.

**Late join / reconnect.** A joining client has no settled clock estimate, so `ClockConfidence`
starts at zero and the confidence gate would refuse to correct it — which is backwards, because a
fresh joiner is the client most likely to need a large correction. Resolve it explicitly with an
**acquisition exemption**: on join, the server issues exactly one *scheduled* seek to
`Expected(when)` with `when` far enough out to cover the joiner's first rapid clock-sample burst
(PROTOCOL §1 already specifies 5 rapid samples on connect), and only after that does the client
enter confidence-gated steady state. The exemption is one-shot per connection, so a client that
reconnect-loops cannot use it to reacquire a seek budget. `corrState` is keyed by client identity
and must survive reconnect for the anti-storm counters to mean anything — which is another point
for keeping that state server-side.

**Harness measurement.** Cheap. `Corrector` is already an interface, so:

- add `ConfidenceGate{Inner Corrector}` — a wrapper that downgrades `ActionSeek` to `ActionNudge`
  (or `ActionNone`) while `r.ClockConfidence < k`. ~30 lines, drop-in, directly ablatable against
  POC §8 item 4;
- add `ClockConfidence` to `vsync.Report` and populate it in `sim/client.go` from `bestRTT`
  stability (the fields already exist);
- new metric `CorrectionEfficacyMs` = mean `|residual_before| − |residual_after|` per seek. This
  is the number that would have caught §0 immediately, and the harness does not have it.

**Verdict: adopt the split, reject the removal.** Rank 2 of the four, but only the actuation half.

---

## 4. Proposal 3 — Intent-only protocol

**First, a correction to the premise.** The task states intents are "idempotent and order-
independent in ways state is not". Idempotent, yes — applying the same `(clientID, reqId)` twice is
a no-op. **Order-independent, no.** On this anchor, `seek(P)` then `pause` yields
`{P, when, paused}`; `pause` then `seek(P)` yields `{P, when', paused}` with a different `when`,
and for `play`/`pause` around a `seek` the resulting `Expected(T)` genuinely differs. Intents are
*replay-safe*, not *commutative*. The server's total order under the room mutex is still required,
and D4 leaves no alternative source for it. Intent-only removes nothing from §5.

**What it does buy — one real, narrow simplification.** SYNTHESIS §5's amendment exists solely
because §4 layer 1 excludes the sender from the broadcast, which starves the sender's
`lastAppliedSeq`, which forces a second message type (`ack`) carrying the same payload. With
idempotent intents keyed `(clientID, reqId)` plus the server-assigned `seq`, you can **broadcast to
everyone including the sender**: the sender recognises its own `reqId`, learns the assigned `seq`,
and rolls its optimistic apply onto the ordered result. One message type replaces exclude + ack,
and the §5 amendment's collision stops existing rather than being patched.

Cost: the sender must not re-fire the DOM action on receiving its own intent back. But the two-diff
test already handles this structurally — a self-originated apply gives `roomDiff ≈ 0`, so
`seeked == false` and nothing is rebroadcast (§4b). Echo suppression layer 1 was never the
load-bearing layer; §4b's detector is.

**What it does not buy.** Echo suppression layers 2 and 3 are entirely client-internal: layer 2
guards against DOM events fired by *our own actuation*, layer 3 distinguishes user gesture from
programmatic change. Neither has anything to do with what crosses the wire. **An intent-only
protocol makes none of them unnecessary.** The one it touches, layer 1, is the one that costs
nothing and is not load-bearing.

**Cost of dropping state.** Shipping the absolute anchor makes every broadcast self-healing: a
client that missed the previous three frames is correct after the next one. Intent-only makes a
missed frame permanent and undetectable — same objection as proposal 1, and it matters more under
D5's flaky MV3 socket.

**Late join / reconnect.** Needs a state snapshot regardless, so an intent-only wire still carries
anchor state on `welcome`. You end up with both.

**Harness measurement.** Add a `DropRate` on the downlink for `state` frames only, and measure
`SteadyStateResidual` after a burst of drops, anchor-state vs intent-only. Prediction: anchor-state
recovers within one heartbeat, intent-only does not recover at all without an explicit resync.

**Verdict: the current protocol already is the right answer** — it ships state (`anchor`) *annotated
with intent* (`by`, `kind`), which is the combination that gets both self-healing and attribution.
**Adopt the narrow simplification only**: broadcast-to-all with `(clientID, reqId)` idempotence,
retiring exclude+ack. Rank 3. This is a protocol cleanup, not an architecture.

---

## 5. Proposal 4 — Gate-first ("the room advances only while everyone can advance")

**Mechanism.** Make buffering-readiness primary. `expected(T)` becomes not affine in `T` but the
integral of a room-wide "advance" gate: the room accrues media time only while every member is
ready.

**The structural objection.** This destroys the single most valuable property in the design. With a
gate, `Expected(T)` is no longer `positionMs + (T − atServerMs)` — it is
`positionMs + ∫ gate(t) dt`, which means **every client must know the full gate history to compute
where the room is**. That is proposal 1's event log, arrived at from the other direction, and now
with entries generated automatically by network conditions rather than by user actions. Late join
and reconnect stop being O(1).

Worse: the gate transitions are decided from ~1 Hz reports that arrive after network delay, so
clients necessarily disagree about *when* the gate opened and closed. Position now depends on a
quantity clients cannot agree on — a new, continuous divergence source in the place where the
current design has a closed form. And it is a re-entry of the §4c feedback loop: room position
would again depend on client reports.

**The D4 objection.** Slowest-client-wins is syncplay's `min()` semantics. §4c rejected it as
policy; D4 makes it worse. With no host, one member on hotel wifi stops the movie for everyone,
repeatedly, and **no one has the authority to say "keep going without them"** — the very role D4
deleted. SYNTHESIS §6's timeout exists precisely because a gate with no override is a hostage
situation. Making the gate primary maximises exposure to the failure the timeout was invented to
bound. (watchparty's 2-person `Math.max()` inversion in §4c is the same class of trap: emergent
policy from participant count.)

**But the good half is real, and I would build it.** Gate-first is wrong as a *steady-state*
playback discipline and right as a *transition-time* discipline. Every measured stall-related
problem happens at or shortly after a transition (join, seek, resume) — not in the middle of steady
playback, where §5's finding shows a stall becomes a settled step best handled by a seek.

So: **two-phase scheduled commands.**

```
client → cmd{kind, positionMs, reqId}
server → prepare{seq, kind, targetPositionMs, deadline}     (broadcast, all members)
client → ready{seq}          // buffered at target, ready to transition
server → go{seq, when, anchor}                              (broadcast)
         when = serverNow + smallGuard,
         emitted as soon as all ready OR deadline expires
```

`deadline = now + clamp(2 × p95_ping, 500, 2000)` — the current formula becomes the **timeout**
rather than the blind delay. That is strictly better on both axes: a fast room transitions in
~50 ms instead of waiting out a fixed 500 ms floor, and a room with one slow member still bounds
its wait at 2 s. It also **removes the §0b contamination path entirely**: transition timing is
driven by observed readiness, not by a ping number that a clock-biased client can distort.

This composes with everything locked: the anchor stays affine, `seq` still comes from the server,
`when` is still a scheduled future instant, and the §6 anti-hang rule (a member who leaves while
buffering counts as ready) applies unchanged to `ready` collection.

**Late join / reconnect — the symmetric hole, and the design decision it forces.** §6's anti-hang
rule covers a member who *leaves* mid-gate. Two-phase adds the mirror case: a member who *arrives*
between `prepare` and `go`. It must be **excluded from this transition's ready set** — the ready
set is frozen at `prepare` time. Otherwise a join during a slow transition extends the deadline for
everyone, and a reconnect storm (an MV3 socket flapping, SYNTHESIS §9) could hold a transition open
indefinitely: a fresh joiner is never ready, so admitting joiners to an open ready set hands any
unstable client a room-wide stall lever. The joiner instead receives the resulting `go` frame as an
ordinary state frame carrying the winning anchor, and converges through the normal correction path
— exactly as it would today. A client that reconnects mid-transition is treated as a joiner: if its
`ready{seq}` arrives for a `seq` already committed, the server drops it. Reconnect therefore needs
no special handling at all, which is a point in this proposal's favour and follows directly from
the anchor staying a complete snapshot.

**Harness measurement — and this is a hard precondition.** The harness cannot evaluate this today,
for two reasons:

1. **There is no transition-spread metric.** `ConvergeMs` measures how long after a command every
   client is back inside tolerance. It does not measure the *spread of actual transition instants*,
   which is the entire purpose of a scheduled command. Add
   `TransitionSpreadMs = max(applyTime) − min(applyTime)` per command, recorded in
   `Client.RunScheduled`.
2. **Seeks are instantaneous.** `c.posMs = float64(v.TargetMs)` with no cost. `ClientProfile` has
   no `SeekLatencyMs` and no post-seek rebuffer. Two-phase commit's benefit is *invisible* until a
   seek costs something — that is the whole scenario it wins. Add `SeekLatencyMs` plus a
   `PostSeekRebufferMs` window during which `readyState` drops.

Until both exist, any claim about two-phase transitions is unfalsifiable in this harness.

**Late join / reconnect under a true gate-first design — and why it is the kill argument arriving a
second time.** If room position is `∫ gate(t) dt`, a joiner cannot compute where the room is from
any bounded snapshot: it must reconstruct the **entire gate history**, because the integral depends
on every open/close since the last seek. That is proposal 1's event log again, reached from the
other direction, and now with entries generated automatically by other people's network conditions
rather than by user actions — so the log grows without bound in a room that never touches the
controls. Reconnect has the same problem: a client offline for 30 s cannot know how much media time
the room accrued while it was away, and no single frame can tell it. The only repair is to
periodically snapshot the integral back into an anchor — at which point the anchor is back and the
gate is a decoration on it. **Two independent proposals converge on the same conclusion: the
closed-form anchor is the property to protect.**

**Verdict: reject gate-first as the primary abstraction, adopt two-phase transitions** — see §7 for
the overall ranking.

---

## 6. Beyond the four — a servo formulation (top-ranked, and cheapest to test)

The step/ramp classifier is rediscovering, ad hoc, a solved problem. `(residual, slope)` is
`(phase error, frequency error)`. Disciplining a local media clock to a remote timebase is what
NTP/PTP servos and media-clock recovery do, and they have a vocabulary for exactly the states the
POC keeps stumbling into.

**Mechanism.** Treat each client's player as a slave clock:

```go
type PLLCorrector struct{ Kp, Ki float64 }

func (c PLLCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
    // phase = r.ResidualMs, frequency error = r.SlopeMsPerS
    if abs64(r.ResidualMs) > t.PhaseSlewLimitMs { return seek }        // step: re-acquire
    rate := 1.0 - (c.Kp*float64(r.ResidualMs) + c.Ki*r.SlopeMsPerS)/1000.0
    return Decision{Action: ActionNudge, Rate: clampF(rate, t.RateMin, t.RateMax)}
}
```

Why this is better than `StepRampCorrector` rather than merely different:

- **`RampMinSlope` / `RampMaxSlope` become one continuous law** instead of two hand-tuned
  thresholds that POC §7 had to add after the fact to stop a stall being mistaken for a rate
  mismatch. A servo separates step from ramp by construction: phase term dominates a step, integral
  term dominates a ramp.
- **Lock state is a standard concept and it is exactly what POC §8 item 4 asks for.** "Do not seek
  until the clock estimate is trusted" is "do not slew until the loop has acquired lock". You get
  the confidence gate for free instead of bolting one on.
- **The learned clock bias is the loop's integral term.** The current `corrState.biasMs` is an
  ad-hoc reinvention of it with a discrete trigger (`failedSeeks >= 3`).
- A servo cannot storm: continuous output, bounded slew rate. The seek storm is a category error a
  servo does not have.

**Costs / failure modes.** Requires `playbackRate` to be safe on the target players — SYNTHESIS §3
flags it as fragile on MSE and per-adapter (`supportsPlaybackRateNudge`), and Risk B has not tested
it. A servo with no rate authority degrades to threshold-seeking, so it needs an explicit
degraded mode. Loop tuning (Kp/Ki) is two more constants, but they are *principled* constants with
a stability criterion, unlike `RampMinSlope = 1.0` / `RampMaxSlope = 100.0`.

**Late join / reconnect — the servo's sharpest hole, and it must be closed explicitly.** A fresh
joiner has no lock. Under "do not slew until locked", the client most likely to need a large
correction is precisely the one the loop refuses to correct — and the same is true after any
reconnect, because `bestRTT` and the offset estimate restart. Resolve it with an explicit
**acquisition mode**: on join or reconnect, seek once to `Expected(when)` on a scheduled future
`when` (the §3 acquisition exemption, same mechanism), then enter the loop in tracking mode. This
is standard servo practice — coarse acquisition, then fine tracking — and without it the confidence
gate praised in §3 and §6 has a hole exactly at the moment it matters most. Note that the loop's
integral term (the learned clock bias) must be **discarded on reconnect**, not carried over: the
path may have changed, and a stale integral would slew a correctly-synced client off target.

**Harness measurement: zero new plumbing.** It is a drop-in `vsync.Corrector`. Run it against the
existing seven scenarios and the existing scoreboard. Add `RateChurn` (integral of `|rate − 1|` and
count of rate changes) as the UX cost metric — a servo trades seek count for time spent off-nominal
rate, and that trade must be visible, since audible speed change is the cost SYNTHESIS §3 warns
about.

---

## 7. Ranking, and what I would build

| # | Proposal | Verdict | Why |
|---|---|---|---|
| 1 | **Servo/PLL corrector** (§6) | **Build**, behind the existing interface | Principled replacement for two ad-hoc slope thresholds; gives lock-gating and bias-as-integral for free; zero harness plumbing to evaluate |
| 2 | **Two-phase transitions** (good half of gate-first, §5) | **Build after harness gaps closed** | Turns the ping-derived blind delay into a readiness-driven one with the cap as timeout; removes the §0b contamination path; composes with every locked constraint |
| 3 | **Actuation/judgement split + confidence gate** (half of §3) | **Measure, then build** | Implements POC §8 item 4 with data only the client has; keeps anti-storm state server-side where it survives tab sleep |
| 4 | **Intent idempotence, broadcast to all** (§4) | **Adopt as protocol cleanup** | Retires §5's exclude+ack amendment. Small, real, not an architecture |
| 5 | **Event-sourced replay** (§2) | **Reject** | The anchor already *is* the fold; log growth fights D2; no measured failure lives in the timeline layer |
| 6 | **No server judgement / peer convergence** (§3, pure form) | **Reject** | D4 leaves no tie-breaker; re-enters the §4c feedback loop; the bias it claims to avoid is client-side either way |

**The current architecture survives.** The anchor's closed form, server-assigned `seq` under a
per-room mutex, scheduled `when`, judge-don't-aggregate, and client-computed residual/slope are all
correct and all confirmed by the locked constraints rather than merely compatible with them. The
two proposals I would build are *refinements inside* it, not replacements for it.

## 8. What I would need measured before committing to anything

Ordered by what blocks what.

1. **Fix §0, re-run `latency-asymmetry`.** Time-compensate corrections on both sides. Blocking:
   until this runs, the strongest argument for re-architecting is an artifact. Expected outcome:
   `threshold-500` and `step-ramp` drop from ~1184 ms toward ~590 ms, and the residual 590 is the
   real §1 limit the bias-learner should be sized against.
2. **Fix §0b** (`p95` index, ping contamination) and re-run `command-storm`.
3. **New metrics**, all absent today:
   - `TransitionSpreadMs` — simultaneity at the transition instant. Blocks proposal 2.
   - `CorrectionEfficacyMs` — `|residual|` before vs after each seek. Would have caught §0.
   - `RateChurn` — the UX cost a servo trades seeks for. Blocks proposal 1's adoption argument.
4. **New scenario dimensions**, all absent today:
   - `SeekLatencyMs` + `PostSeekRebufferMs` in `ClientProfile`. Blocks proposal 2.
   - join / leave / reconnect. Closes out proposal 5; prediction is "identical", and that
     prediction is the point.
   - a background-throttle profile that clamps `evalIntervalMs` to 1000 for one client. **Every
     client-authority proposal depends on the high-rate local loop surviving, and under D5's
     userscript that is currently asserted, not measured.** This is also the cleanest way to test
     the claim that server-held anti-storm state is more durable than client-held.
5. Only then: `PLLCorrector` against the full scoreboard, and two-phase transitions against
   `TransitionSpreadMs` with non-zero seek latency.

Note on reading the results: with §0 unfixed, **every proposal that reduces seek count will appear
to win `latency-asymmetry`, and none of those wins will mean anything.** Fix the confound first.
