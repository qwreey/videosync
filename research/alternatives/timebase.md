# Alternative timebases — adversarial review of D3 / SYNTHESIS §1–§2

Scope: the timebase only. Server-owned UTC, min-RTT offset estimation, scheduled `when`.
Written against the tree at `1272bf8` (round-3 confidence gating already landed).

**Verdict: the timebase is right and should not be replaced.** Every alternative I could
construct is either provably no better (server-initiated exchange, relative `when`,
server-relayed peer timing), partially applicable at high cost (probe-size sizing, WebRTC
peer Marzullo), or *already in the tree* (offset-as-interval, `UncertaintyMs`).

But the case for it in `docs/POC-FINDINGS.md` is currently built on two measurements that do
not say what they appear to say, and I can demonstrate both:

1. **`command-storm` was measuring a harness bug, not the timebase.** The command *sender*
   never executes its own scheduled command. Fixing that takes `command-storm` from
   **5360 ms mean / 19 seeks to 32 ms mean / 0 seeks**. The clock was never the problem there.
2. **`latency-asymmetry`'s round-3 "0 ms, 0 seeks" is an artifact of that scenario having no
   commands.** Add one scheduled pause/play pair and `step-ramp+conf` goes to
   **944 ms mean / 1180 ms max — still with 0 seeks and 0 bias learned.** The divergence is
   real, permanent, and completely invisible to the residual channel.

And I added the control the repo has never had — **run the same commands with the absolute
clock removed** (`when = now`, execute-on-arrival). Absolute `when` gives **25 ms** worst-case
divergence on mixed links; execute-on-arrival gives **185 ms**, exactly the spread of one-way
downlink delays. That is D3's benefit, measured rather than asserted, for the first time.

All three are reproduced below. Results 1 and 3 are *good* news for D3 — 1 is the strongest
evidence in the repo that scheduled commands work. Result 2 is a genuine hole in round 3's
conclusion.

---

## 0. How to reproduce

Nothing in the repo was modified. Copy `server/` to a scratch dir and apply:

```go
// messages.go — MsgAck gains a When
type MsgAck struct { ReqID int; Seq uint64; When int64; Anchor vsync.Anchor }

// server.go — carry it
MsgAck{ReqID: v.ReqID, Seq: s.seq, When: when, Anchor: s.anchor}

// client.go — the sender schedules its own transition like everyone else
case MsgAck:
    if v.Seq > c.lastAppliedSeq {
        c.pending = append(c.pending, MsgState{Seq: v.Seq, When: v.When, Anchor: v.Anchor})
    }
```

Two further scratch knobs give the controls: `Scenario.OptimisticSender` (sender applies on
gesture, `when` re-aligns it) and `Scenario.NoAbsoluteWhen` (`when = now` in `Server.Deliver`'s
`MsgCmd` case). Scenarios are then a `latency-asymmetry` variant carrying commands, run against
a `noop` corrector where the scheduling path must be measured in isolation.

`go test ./...` still passes with the ack fix in place — `regression_test.go` is unaffected,
which is itself a finding: the existing regression suite does not cover the sender's own path.

---

## 1. Finding A — the sender is exempt from the simultaneity the timebase exists to provide

`docs/PROTOCOL.md` §3: the ack is `{"t":"ack","reqId","seq","anchor"}`. **There is no `when`.**
The doc says the sender "rolls its optimistic apply back to what the ack says" — but with no
`when` on the wire the sender has nothing to roll *forward* to. In the harness this manifests as
`Client.Deliver`'s `MsgAck` case setting `anchor` and `lastAppliedSeq` and never touching
`paused` or `posMs`: the sender simply never applies its own pause.

Trace, symmetric 610/610 links, `noop` corrector, pause@20s + play@23s
(`a` is the sender):

```
t=23500  a pos=23510 pause=false | b pos=21850 pause=true | c pos=21850 pause=true
t=29000  a pos=29010 pause=false | b pos=26010 pause=false | c pos=26010 pause=false
```

`a` never paused. The 3000 ms gap is permanent and accumulates across cycles — 1/2/5 pause-play
cycles gave maxDiv **3570 / 6560 / 15540 ms**, on links with *zero* clock error.

Full harness, before and after the ack fix:

| scenario | metric | as committed | with `ack.When` |
|---|---|---|---|
| command-storm | mean divergence | 5360 ms | **32 ms** |
| command-storm | max divergence | 273940 ms | **50 ms** |
| command-storm | seeks issued | 19 | **0** |
| command-storm | converge | `[0 400 1100 0 150 1000]` | `[0 0 0 0 50 0]` |

Every other scenario is unchanged (they have no commands).

**This is the strongest result in favour of D3 that exists.** Six commands including two
deliberately conflicting ones 50 ms apart, across `good`/`meh`/`bad` links, converge to 32 ms
mean divergence with *zero corrections*. Scheduled absolute-time commands do exactly what §2
claims. The `command-storm` row of POC-FINDINGS §7 should be re-run and its "maxDiv is dominated
by the seek transition" note retired — it was dominated by the sender never transitioning.

In a real client the manifestation differs but the error is the same size: the user's own pause
takes effect on gesture, i.e. `CMD_DELAY` (500–2000 ms) *before* everyone else's. **That is a
larger simultaneity violation than the ~590 ms clock bias this whole document is about, and
unlike the clock bias it is free to fix.** Two viable policies:

- **Schedule the sender too** (add `when` to the ack, sender waits). Correct, costs the sender
  perceived latency on their own click.
- **Optimistic apply + scheduled re-align**: sender acts immediately, then at `when` snaps to
  `anchor.Expected(when)`. Feels responsive; costs the sender one small self-inflicted seek.
  Note this cannot be an *unbounded* optimistic apply — it is only sound because `when` gives a
  bounded re-align point.

**I measured both**, on a pause/play-only command set (so `maxDiv` is not swamped by a
280-second seek transition), `step-ramp+conf`:

| variant | maxDiv | meanDiv | seeks |
|---|---|---|---|
| **sender waits for `when`** | **25 ms** | **13 ms** | **0** |
| optimistic apply + re-align at `when` | 585 ms | 53 ms | 5 |

Optimistic apply is 23× worse on worst-case divergence and inflicts 5 self-corrections the
waiting sender never needs — the sender runs free for the whole `[gesture, when]` window, which
is `CMD_DELAY` = 500–2000 ms wide by construction. **Ship “sender waits”, for every command
kind.** The perceived-latency objection is real, but it is a UX judgement about 500 ms on your
own click and should be argued on those terms rather than assumed away; the correctness argument
runs entirely the other way. (Under `latency-asymmetry` the ordering is the same: 1175 ms vs
1795 ms, 0 seeks vs 13.)

## 2. Finding B — a scheduled command *launders* clock bias into permanent media divergence, and zeroes the residual that would have revealed it

Mechanism. `RunScheduled` fires when `est >= when`, where `est = trueServerMs + B` and `B` is
the client's offset error, then sets `posMs = anchor.Expected(est)`. So the client arrives at the
*right position* at the *wrong real time*, and thereafter dead-reckons at 1.0×. The offset is
permanent. And because `residual = posMs − Expected(est)` uses the same biased `est` on both
sides, it reads **zero**.

With `noop` (no corrections at all), `latency-asymmetry` links, one pause/play pair:

| commands | maxDiv | meanDiv |
|---|---|---|
| 0 pause/play cycles | 0 | 0 |
| 1 cycle | 1180 | 944 |
| 2 cycles | 1185 | 918 |
| 5 cycles | 1185 | 827 |
| 5 cycles, **symmetric** 610/610 control | **0** | **0** |

Three things this establishes:

- It is **asymmetry**, not commands — the symmetric control with identical command load is 0.
- It **does not accumulate**. Each transition re-baselines to the same anchor, so the error is
  `B_i`, not `ΣB_i`. 1180 ms ≈ 2 × 590 ms = the spread between `b` (−590) and `c` (+590).
- It survives every corrector, including confidence gating:

| strategy | asym, no commands | asym + one pause/play |
|---|---|---|
| threshold-2000 | 0 (0 seeks) | 940 (0 seeks) |
| **step-ramp+conf** | **0 (0 seeks)** | **944 mean / 1180 max (0 seeks, 0 bias learned)** |

The residual channel's two opposite-signed failures, measured at two instants of the same run:

```
t=15000 (before any command)     TRUE divergence = 0 ms
   a truePos=15010  reported residual=  +15  uncertainty= 25
   b truePos=15010  reported residual= +600  uncertainty=610
   c truePos=15010  reported residual= -580  uncertainty=610

t=39000 (after the play transition)   TRUE divergence = 1180 ms
   a truePos=36005  reported residual=  +10  uncertainty= 25
   b truePos=35420  reported residual=  +10  uncertainty=610
   c truePos=36600  reported residual=   +5  uncertainty=605
```

**Before a command the channel reports 1180 ms of divergence that does not exist; after one it
reports none while 1180 ms does.** Round 2 documented the first half. The second half is new,
and it is worse, because the round-2 machinery that bounds the first half — failed-seek
detection and bias learning — is structurally blind to it: it needs a non-zero residual to have
anything to learn from, and gets exactly zero.

### The theorem that decides the whole design space

Laundering damage per client is `|B_i|`, and min-RTT bounds `|B_i| ≤ R_min,i / 2`, which is
*precisely* the `UncertaintyMs` the client already reports. So:

> **No passive measurement can detect laundering, because its magnitude is bounded by the
> measurement uncertainty of every channel available.**

I checked this against the most promising alternative channel (§4 below) and it holds: the
server-side arrival-stamped position interval has width `R_min`, and pairwise laundering damage
is `≤ R_min`. The intervals of `b` and `c` at t=39000 are *identical* after projecting to a
common server instant. The channel is sound and blind simultaneously.

The consequence is not "build a better estimator". It is: **`UncertaintyMs` is not a deadband
parameter, it is the room's sync guarantee**, and it should be promoted accordingly (§7).

---

## 3. Alternative 1 — eliminate the absolute clock; compare media timelines only

**Mechanism.** Drop `serverNow`. Clients report `positionMs` with no timestamp; the server
stamps arrival `t_arr` and compares clients pairwise. Corrections are relative
("you are 700 ms behind `a`"), never absolute.

**What it buys.** It removes the *manufactured* residual — the t=15000 row above. The judging
path genuinely does not need wall-clock agreement.

**What breaks: scheduled-command simultaneity, and it is not recoverable.** Position comparison
answers *where people are*; `when` answers *when everyone will act*. A pause with no shared
"now" lands at different media positions on every client — the room *creates* divergence at
every transition, exactly the failure mode §2 was designed to remove, and D4's no-host rooms
make transitions frequent. Concretely: the `command-storm` row above is 32 ms mean *because* of
absolute `when`. Remove it and you are back to relay semantics, which is the cytube/syncwatch
design SYNTHESIS §1 already rejects.

The weaker variant — keep `when` for commands, drop the clock from judging — is not an
alternative timebase, it is §4 below, and it is worth doing.

**Cost.** Protocol simplification on the report path, protocol regression on the command path.

**Fails at.** Everything transition-related. Do not do this.

**Measured.** I added a `NoAbsoluteWhen` mode (`when = now`, execute-on-arrival) and ran the
same pause/play command set with the ack fix in place:

| links | absolute `when` | execute-on-arrival |
|---|---|---|
| good/meh/bad | **25 ms** max, 13 ms mean | 185 ms max, 14 ms mean |
| latency-asymmetry | **1175 ms** max | 1765 ms max |

185 ms is exactly the downlink spread (200 − 25). **That is what the absolute clock buys: it
converts the spread of one-way downlink delays into the spread of clock-offset errors**, which
min-RTT makes 7× smaller on healthy links and still smaller under asymmetry (a 590 ms bias
against a 1200 ms one-way delay, per §8). Note the *mean* barely moves — the cost of dropping
the clock is concentrated entirely in transitions, which is precisely where a user notices it.

**Verdict: reject, and keep this measurement in the harness so it stays rejected.**

## 4. Alternative 2 — arrival-stamped server-side position intervals (the honest observation channel)

**Mechanism.** The client's report already carries `positionMs`. The server stamps arrival
`t_arr` and, using only "one-way delays are non-negative and sum to RTT":

```
pos_i(t_arr) ∈ [positionMs_i, positionMs_i + R_min,i]
```

Project all clients onto a common server instant and intersect (Marzullo). **Disjoint intervals
are proof of divergence; overlapping intervals are proof of nothing.** Correct by the minimum
move that makes the intervals intersect, never to a point estimate.

**What it buys.** A channel that is *never wrong*, only sometimes silent — the exact opposite
failure mode to the residual channel, which is precise and capable of confidently lying. On
healthy links (`good`: R_min = 50) the interval is 50 ms wide and it is as good as the residual.
It is also the only channel that can see divergence a client cannot self-report, which is the
whole class of laundering-adjacent bugs.

**Cost.** ~60 lines server-side. No wire change at all — `Report.PositionMs` and `AtServerMs`
already exist. It composes with `ConfidenceGated` rather than replacing it.

**Fails at.** Precisely the case that motivated it. As shown in §2, laundering damage ≤ R_min, so
the intervals always overlap and it detects nothing. It is a good *second* channel and a bad
*primary* one. Claiming it fixes asymmetry would be wrong.

**How to measure.** Add `res.UndetectedDivergenceMs` to `sim.Result`: at each metric sample,
compare true max-min against the widest disjoint gap the interval method would have found. Run
across all seven scenarios. Expected: near-perfect agreement on `good`/`meh` links, total
blindness on `latency-asymmetry`. That gap *is* the honest statement of what the system can see.

**Verdict: build it, as a cross-check that can veto a seek — not as a replacement.**

## 5. Alternative 3 — asymmetric probe sizes

**Mechanism.** Send clock probes at two payload sizes `s` and `S`. `RTT(x,y) = d_up0 + x/B_up +
d_down0 + y/B_down`. Four combinations `(s,s) (S,s) (s,S) (S,S)` identify `B_up` and `B_down`
separately, so the *serialization* component of the asymmetry becomes observable and can be
subtracted from the offset estimate.

**What it buys.** Real, partial de-biasing. Much real-world asymmetry *is* serialization and
uplink queuing (ADSL, 4G, bufferbloat), not routing.

**Cost.** Binary frames, a few hundred KB of probe traffic on a connection that is already
streaming video, and a tail-latency risk: a large uplink probe on a 20 ms/1200 ms link is
exactly the thing that makes the link worse. Also fragile behind proxies that buffer.

**Fails at.** The constant term. You only ever measure `d_up0 + d_down0`; the propagation split
stays unidentifiable. So this cannot fix routing asymmetry, which is what the harness models.

**How to measure — honestly, it currently cannot be.** `Link{UpMs, DownMs, JitterMs, LossPct}`
has no size dependence, so probe sizes have no effect in the harness by construction. Measuring
this needs `Link` to grow `UpKbps/DownKbps` and `Network.Send` to add `bytes/rate`. That is a
harness change worth ~30 lines, and until it exists any claim about probe sizing is unmeasured.

**Verdict: defer. Note it in SYNTHESIS §11 as the only known handle on real-world asymmetry,
and do not implement it before the harness can score it.**

## 6. Alternative 4 — peer-to-peer Marzullo (the only thing that can beat `R_min`)

**Mechanism.** Clients open WebRTC data channels pairwise and run the same two-timestamp
exchange with each other. Client `b`'s uplink is fast and `c`'s downlink is fast, so the direct
`b↔c` path may have a far smaller `R_min` than either client's path to the server. Intersect the
resulting offset intervals across the peer graph (Marzullo, which is what NTP's selection
algorithm does) to get a bound tighter than any single path allows.

**What it buys.** The only mechanism in this document that can reduce the uncertainty bound
itself, and therefore the only one that can reduce laundering damage rather than merely refuse
to act on it.

**Cost.** WebRTC, STUN/TURN, NAT traversal, N² connections, and a direct conflict with the
zero-dependency self-hosting requirement in D2 — a TURN server is an external dependency. Also a
privacy regression: peer IPs become visible to peers, in a product whose pitch is "only URL +
position + state cross the wire".

**Fails at.** Rooms where all peers are behind symmetric NAT and must relay through TURN — the
relayed path is then no better than the server path.

**How to measure.** `Link` is currently client↔server only. Needs a peer link matrix and a
`sim.Client`-to-`sim.Client` send path. Substantial harness work (~150 lines) for a v2 feature.

**Important negative result to record first:** *relaying the peer exchange through the server
adds exactly zero information.* The composite `b→c` delay is `d_up,b + d_down,c` and `c→b` is
`d_up,c + d_down,b`; their sum is `R_b + R_c`, which is already known. Only a genuinely
different physical path helps.

**Verdict: v2 at the earliest, and only if real-world telemetry shows asymmetry matters.**

## 7. Alternative 5 — promote `UncertaintyMs` from deadband to room sync guarantee (**recommended**)

Confidence-as-a-field already landed at `1272bf8`, and it is the right idea. What it does *not*
yet do is close the loop implied by §2's theorem.

**Mechanism.**

1. The server maintains `roomUncertaintyMs = max_i UncertaintyMs_i`. Every tolerance that
   governs *room-wide* behaviour — `TOLERANCE`, `NUDGE_MAX_RESIDUAL`, `SEEK_THRESHOLD` — is
   floored at it, not just the per-client deadband inside `ConfidenceGated`.
2. It is **surfaced to the user**: "sync accuracy ±0.6 s (one member has a slow connection)".
   Since §2 proves it cannot be measured away, the only honest handling is disclosure. This also
   gives the user the one lever that actually works — the member with the bad link can switch
   networks.
3. It sizes `CMD_DELAY`: `clamp(2 × p95_ping, 500, 2000)` should become
   `clamp(max(2 × p95_ping, 2 × roomUncertaintyMs), 500, 2000)`, because the lead time must
   cover the *uncertainty*, not just the delay.
4. `MinClockSamples` gating stays, with round 3 §12's lesson intact (count completed exchanges,
   not accepted ones).

**Cost.** ~40 lines and one UI string. No new wire fields — `UncertaintyMs` already ships.

**Fails at.** Nothing measurable; it is a strictly-honest restatement of a bound the system
already computes. It does *not* reduce divergence under asymmetry — nothing can (§2).

**How to measure — and the bound must be scoped, or the assertion is false.** The naive
property `TrueDivergence ≤ 2 × RoomUncertainty` does **not** hold in general: `long-stalls`
reaches 6020 ms maxDiv on links whose room uncertainty is 80 ms, and `one-slow-client` reaches
4303 ms. Stalls, intrinsic rate drift and seek transitions are divergence sources the clock
bound says nothing about. It covers **clock-attributable divergence only**.

So scope it: add `res.RoomUncertaintyMs` and assert `TrueDivergence ≤ 2 × RoomUncertainty` over
the zero-stall, unit-rate scenarios — `clock-skew`, `latency-asymmetry`, and the new
`latency-asymmetry+commands` — where the clock is the *only* divergence source and the assertion
therefore means something. On those numbers 1180 ≤ 2 × 610 holds, tightly, which is what makes
it a useful regression: it fails loudly if a future change introduces clock-attributable
divergence the uncertainty bound does not cover.

The more general framing — sample divergence only while no client is stalled and every residual
is inside tolerance — has a moving qualifying set, which makes a failure harder to attribute.
Prefer the scoped version.

## 7b. Three mechanisms the brief named that do not survive contact

**The media element's own progression as an independent clock.** It works, but only for *rate*.
Comparing `currentTime` against a local monotonic clock identifies `IntrinsicRate` directly with
no network involvement — which is exactly why `step-ramp`'s ramp-vs-step split is computable
client-side at high frequency (SYNTHESIS §4c). It carries **no offset information**, because two
clients' media timelines have no shared origin until something establishes one, and establishing
one is the entire problem. It is a rate reference, not a timebase. Worth stating because it
looks like a free second clock and is not.

**Cristian's algorithm.** The interval formulation in §4 *is* Cristian's: a point estimate plus
the ±RTT/2 bound that follows from one-way delays being non-negative and summing to RTT.
`UncertaintyMs = bestRTT/2` at `1272bf8` is already Cristian's error bound, correctly derived.
Naming it anchors the design to the literature and makes clear the bound is **tight** — it is
*attained*, not merely conservative, when a path is fully one-sided, which is exactly the
`latency-asymmetry` case.

**PTP-style separate delay measurement.** PTP does measure the reverse path independently
(`Sync` / `Delay_Req`), and it still cannot recover propagation asymmetry: it handles asymmetry
by letting the operator *configure* a per-port asymmetry correction constant. That is the
protocol which tried hardest — hardware timestamps, controlled networks — conceding §8's
impossibility result and falling back to manual configuration. Over the open internet with no
operator, that escape hatch does not exist. Take it as confirmation to stop looking, not as a
technique to port.

---

## 8. Impossibility results — state them once, stop re-deriving them

- **Server-initiated exchange gains nothing.** The offset bias is `(d_up − d_down)/2` regardless
  of which side initiates; reversing roles reverses the sign in the other frame and cancels.
- **Relative `when` ("execute D ms after receipt") is strictly worse than absolute `when`.** Its
  error is the full one-way downlink `d_down,i`; absolute `when` with min-RTT has error
  `(d_up − d_down)/2`. For `latency-asymmetry` client `b` that is 1200 ms vs 590 ms; for a
  symmetric 25 ms link it is 25 ms vs 0. This is the same argument SYNTHESIS §1 uses to reject
  opentogethertube's local-receipt anchoring, and it applies to scheduling as well as anchoring.
  **min-RTT is provably the best point estimate available from client↔server timing alone.**
- **Server-relayed peer timing adds exactly zero information** (§6).
- **No local computation beats `R_min` as the interval width** under pure propagation asymmetry.
  Any proposal claiming otherwise is wrong; use this as a sanity check.

## 9. Ranking

| # | Proposal | Build? | Cost | Fixes |
|---|---|---|---|---|
| 1 | **Ack carries `when`; sender waits like everyone else** (§1) | **yes, now** | ~10 lines + protocol | a 500–2000 ms simultaneity hole, larger than the clock bias |
| 2 | **`UncertaintyMs` as room sync guarantee** (§7) | **yes** | ~40 lines | makes the unfixable bound honest and user-visible |
| 3 | **Arrival-stamped position intervals** as a veto channel (§4) | yes | ~60 lines | the residual channel's lying mode; blind to laundering, say so |
| 4 | Land the execute-on-arrival control in the harness (§3) | yes | ~10 lines | nothing — it *records* why the clock stays |
| 5 | Asymmetric probe sizes (§5) | defer | harness work first | serialization asymmetry only |
| 6 | Peer-to-peer Marzullo (§6) | v2 | WebRTC + TURN, conflicts with D2 | the only thing that reduces the bound |
| — | Eliminate the absolute clock (§3) | **no** | — | breaks simultaneity irrecoverably |

**What I would actually build: #1, then #2, then #3.** None of them is a new timebase. #1 is a
bug fix that the harness has been hiding and that makes the *existing* timebase look as good as
it actually is; #2 and #3 are the honest framing of a limit that §2 proves cannot be engineered
away.

## 10. What survives untouched

- **D3 and the server-owned UTC timebase.** Vindicated, not merely defended: 32 ms mean
  divergence through six commands including two conflicting ones 50 ms apart, once the sender
  stops being exempt from it.
- **Scheduled `when` with the `clamp(2 × p95_ping, 500, 2000)` cap** (§2 amendment). Only
  addition is the `roomUncertainty` floor in §7.
- **min-RTT offset estimation.** Provably the best point estimate available from client↔server
  timing (§8). Its known bias is not a reason to replace it.
- **The anchor and `Expected()`** as the single source of truth.
- **Judge, do not aggregate** (§4c). Nothing here weakens it — §4's interval channel judges, it
  does not move the room.
- **`seq`/ack collision handling** (§5 amendment) — and note §1 *strengthens* it: the ack needs
  a third field, not a redesign.
- **Three-layer echo suppression, the two-diff test, stall inference** (§4, §4b). Untouched;
  none of them route through the clock.
- **`ConfidenceGated` and `UncertaintyMs`** from round 3. Correct idea, correct place; §7 only
  extends its reach.

## 11. Corrections owed to `docs/POC-FINDINGS.md`

Not applied — this file does not modify the repo — but they should be:

- **§7 / §11 `command-storm` rows are invalid.** They measure the missing `ack.When`, not any
  corrector. Re-run after the fix; all five strategies tie at 32 ms.
- **§11's "latency-asymmetry → 0 ms, 0 seeks" needs a caveat.** It holds only because that
  scenario issues no commands. Add a `latency-asymmetry+commands` scenario; `step-ramp+conf`
  scores 944 ms mean there, with zero seeks and zero bias learned.
- **§14's "unmeasured code" note understates the problem.** Failed-correction detection and bias
  learning are not merely unexercised — they are *structurally incapable* of firing on the
  laundering case, because the residual they key off is exactly zero.
