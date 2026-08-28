# Wire protocol (v0, draft)

Derived from `research/SYNTHESIS.md`. Section refs below point there. Transport: one WebSocket per
client, JSON frames, `{"t": "<type>", ...}`. Keep this file and SYNTHESIS consistent.

> **Every millisecond field is an integer.** The server parses them into `int64`, so a fractional
> value is rejected outright — and rejected *quietly*: the session stays joined and only the
> mechanism that needed that frame stops working. `performance.now()` is fractional, so a browser
> client must round every timestamp it puts on the wire. This cost one debugging session: the
> client sent `{"t":"time","t0":874.47}`, every clock probe came back `bad_frame`, the offset never
> settled, and therefore no correction ever fired. Nothing failed. See §4's field table for the
> same failure mode applied to omitted fields.

## Roles

The server is the **timebase owner and the judge**. It is *not* an aggregator: client position
reports decide who needs correcting and whether the readiness gate fires — they never move the room
(§4c). The room position comes from an anchor the server itself sets.

## Anchor — the single source of truth

```
anchor = { positionMs, atServerMs, paused, mediaKey }
expected(T) = paused ? positionMs : positionMs + (T - atServerMs)
```
Every position question on either side is answered by `expected()`. Nothing else.

## 1. Clock sync (§1)

Client → `{"t":"time","t0":<client ms>}`
Server → `{"t":"time.reply","t0":<echoed>,"tRecv":<server ms>,"tSend":<server ms>}`

Client, on receipt at `t1`:
```
rtt    = (t1 - t0) - (tSend - tRecv)
offset = ((tRecv - t0) + (tSend - t1)) / 2      // add to client clock to get server time
```
**Accept the sample only if `rtt < bestRtt` seen this session** (min-RTT rule, VideoTogether
`vt.js:3617-3623`) — the minimum-RTT sample is the least polluted by queuing delay. Keep an EMA as
a slow sanity band, never as the primary estimate.

Sample every 5 s, plus 5 rapid samples on connect. `serverNow = clientNow + offset`.

> Known limit: this assumes roughly symmetric paths. Asymmetric routes bias `offset` by half the
> difference and **no amount of sampling reveals it**. The sim harness injects asymmetry so we at
> least know our sensitivity.

## 2. Join

Client → `{"t":"hello","room":"<id>","secret":"<join secret>","name":"...","mediaKey":"..."}`
Server → `{"t":"welcome","you":"<clientId>","seq":<n>,"anchor":{...},"members":[...],"serverMs":<n>,"mediaKey":"..."}`

`hello` **must be the first frame**; anything else closes the connection. A second `hello` on a
joined socket is answered with `error{code:"already_joined"}` rather than re-joining.

`mediaKey` is the normalized media identity (provider + content id), not the raw URL — query params and
tracking junk must not fork a room. If the room has no media yet, the first member's `mediaKey`
names it. Otherwise a mismatch ⇒ server sends `{"t":"media.mismatch","roomMediaKey":"...",
"yours":"..."}` and the client shows "everyone else is watching X". **It is a notice, not a
refusal** — the joiner is in the room and can see its state; forcing them out would make the
common case (arriving before anyone has opened the video) unjoinable.

Join is refused with `{"t":"error","code":"join_refused"}` for both an unknown room and a wrong
secret — deliberately the same message, so an unauthenticated peer cannot probe which room ids
exist. A full room is refused with `code:"room_full"`.

Membership changes are broadcast:
`{"t":"members","members":[{"id","name","suspended","ready"}],"joined":"<id>"|"left":"<id>"}`.
The joiner gets the roster in its `welcome` instead, so it is excluded from that broadcast.

## 3. Commands (§2, §5)

Client → `{"t":"cmd","reqId":"<uuid>","kind":"play|pause|seek|media","positionMs":<n>,"mediaKey":"..."}`

Server takes the per-room mutex, assigns a monotonic `seq`, updates the anchor, then:

- **to every other member** → `{"t":"state","seq":<n>,"when":<serverMs>,"emittedAt":<serverMs>,
  "anchor":{...},"by":"<clientId>","kind":"..."}`
- **to the sender** → `{"t":"ack","reqId":"...","seq":<n>,"anchor":{...},"when":<serverMs>,
  "emittedAt":<serverMs>,"kind":"..."}`

The sender is excluded from the broadcast (§4 layer 1) but **must** get the ack, or its
`lastAppliedSeq` never advances (§5 amendment). The ack also carries the *winning* anchor: if the
mutex ordered someone else first, the sender rolls its optimistic apply back to what the ack says.

**The ack must carry `when`, and the sender must schedule against it exactly like everyone else.**
Excluding the sender from the broadcast for echo suppression accidentally excluded it from the
scheduling this whole timebase exists to provide. Measured cost of getting this wrong:
`command-storm` mean divergence **4743 ms → 32 ms**, seeks **19 → 0** (docs/POC-FINDINGS.md §20).
In a real client it appears as your own gesture landing `CMD_DELAY` (500-2000 ms) ahead of
everyone else's — larger than the clock bias we spend so much effort on, and free to fix.

`when = emittedAt + clamp(2 * p95_ping, 500ms, 2000ms)`. Capped because there is no host — one bad
connection must not make every pause in the room sluggish (§2 amendment). A member slower than the
cap is handled by the readiness gate, not by stretching the delay.

Clients discard any `state` with `seq <= lastAppliedSeq`.

A `kind` the server does not implement, or a `media` command with no `mediaKey`, is refused with
`{"t":"error","code":"bad_kind"|"bad_cmd"}` **before a `seq` is taken**. Letting it fall through
would burn a seq and broadcast a `state` that changed nothing — which still advances every client's
`lastAppliedSeq`, so the room would quietly agree it had transitioned to the same place.

`kind:"media"` replaces the anchor outright — position, pause state and identity all change at once
— and lands **paused**, because nobody has loaded the new media yet.

## 4. Local detection and reporting (§4b, §4c)

Three layers, because they answer different questions:

| Layer | Rate | Purpose |
|---|---|---|
| local evaluation | ~10 Hz | two-diff test; decide if this is user intent |
| anomaly report | on event | tell the server something is wrong, immediately |
| heartbeat | ~1 Hz | liveness + trend, so the server can judge and gate |

**Two-diff test** (Syncplay `client.py:218-223`), run by both the poll and any DOM event:
```
playerDiff = |observedPos - lastKnownLocalPos|     // did the player jump?
roomDiff   = |observedPos - expected(serverNow)|   // is that jump also a divergence from the room?
seeked     = playerDiff > SEEK_THRESHOLD && roomDiff > SEEK_THRESHOLD
```
The AND is echo suppression built into detection: a server-driven seek makes `playerDiff` large but
`roomDiff` ~0, so nothing is rebroadcast. No timeout, no flag, cannot get stuck.

DOM events (`seeked`/`play`/`pause`/`ratechange`) **trigger this evaluation, they never broadcast
directly.** One decision path, two input sources.

### Browser-initiated pause is not user intent

Chrome **pauses a hidden tab whose playback has never been audible**, firing a real `pause` event,
and fires `play` again when the tab is shown (measured across four conditions:
`docs/BROWSER-FINDINGS.md` §5). Broadcast naively, one member switching tabs pauses the whole room,
and switching back resumes it.

> A `pause` while `document.hidden`, on a playback that has **never been audible**, with
> `readyState >= 3` and a full buffer, is browser suspension. Never broadcast it; mark the member
> **suspended** and suppress the paired `play` on re-show.

The trigger is "this playback has never made a sound", **not** "is currently muted" — measured
across four conditions (`docs/BROWSER-FINDINGS.md` §5). A tab that was audible is exempt for its
lifetime, and the exemption survives reloading the element.

> The earlier version of this section said "hidden **and muted**". That was measured to be wrong,
> and the wrong rule would have suppressed genuine user pauses in the audible-then-muted case. It is
> on the do-not-reintroduce list in `docs/STATE.md`.

`document.hidden` alone is not enough either: media keys deliver genuine user pauses to hidden tabs.

A suspended member is **absent, not buffering**: the §6 readiness gate must not hold the room for
them. Distinguish by the observable state — buffering is `paused === false`, `readyState < 3`,
draining buffer, with a `waiting` event; suspension is `paused === true`, `readyState === 4`, full
buffer, with a `pause` event.

### Heartbeat

```json
{ "t":"hb",
  "residualMs":      -420,     // signed: localPos - expected(serverNow). negative = behind
  "slopeMsPerS":     -85,      // d(residual)/dt, least-squares over a 3 s window
  "positionMs":      123456,
  "paused":          false,
  "readyState":      4,
  "bufferedAheadS":  12.4,
  "bufferedBehindS": 8.1,
  "lastAppliedSeq":  91,
  "atServerMs":      1712345678901,
  "uncertaintyMs":   30,
  "rttMs":           60,
  "clockSamples":    12,
  "suspended":       false }
```

**Every field is load-bearing.** Omitting one does not degrade gracefully — it silently disables a
mechanism that exists because a measurement demanded it:

| field | what breaks if the client omits it |
|---|---|
| `residualMs`, `positionMs`, `paused`, `readyState`, `bufferedAheadS` | the basics; nothing works |
| `slopeMsPerS` | the servo's frequency term integrates nothing; only the bias-*prone* phase term is left (§4c) |
| `bufferedBehindS` | `targetBuffered()` is false for every backward target, so the free-backward-seek branch is unreachable and §35's cost rule is half-undone |
| `lastAppliedSeq` | the stale-anchor resend never fires. 115 603 ms vs 250 ms (POC-FINDINGS §34) |
| `uncertaintyMs` | the dead-band collapses to `TOLERANCE` and the servo's built-in confidence is inert — the condition where three perfectly aligned clients were pushed 1.2 s apart *by the corrections themselves* (POC-FINDINGS §6) |
| `rttMs` | `CMD_DELAY` is stuck at its 500 ms floor for the whole room, because it is computed from reported RTTs and nothing else |
| `clockSamples` | `ConfidenceGated` cannot tell a settled estimate from a fresh one. (Count *completed* exchanges, not accepted ones — a min-RTT counter stops advancing once it converges, which froze the gate shut for whole sessions) |
| `suspended` | a hidden never-audible tab reports `paused:true, readyState:4`, so it is not gated but **is** judged — the server seeks a member who is not watching (BROWSER-FINDINGS §5) |
| `atServerMs` | nothing in the shipping path. Only the experimental PLL/FLL correctors read it, to min-filter a one-way delay estimate. Send it; it is cheap and it keeps those comparable |

`lastAppliedSeq` is what lets the server spot a client stuck on stale state. **The server MUST act
on it**: when a report's `lastAppliedSeq` lags the current `seq`, resend the state instead of
judging the report. A client on a stale anchor measures its residual *against that stale anchor* and
so reports ≈ 0 while being arbitrarily out of position — measured at 115 603 ms mean error without
the resend and 250 ms with it (POC-FINDINGS §34). This is three lines and reads a field already on
the wire.
`slopeMsPerS` is computed **client-side at high frequency with zero network noise**; the server
must never try to differentiate 1 Hz reports itself (§4c).

Report immediately (don't wait for the heartbeat tick) when `|residualMs|` crosses
`REPORT_THRESHOLD` or when paused-state disagrees with the anchor.

## 5. Correction — the server judges, the client self-heals first

The client **self-corrects silently** inside the band; it does not ask permission and does not
report (OTT's "DOM events self-correct toward store state", `Room.vue:616-628`). The server only
intervenes when the client says it cannot cope, or stops saying anything.

Classifier input is `(residualMs, slopeMsPerS)` — the derivative picks *which* correction, not
merely whether to correct. **No reference implementation does this; all nine threshold on absolute
offset only** (§4c).

| Condition | Reading | Action | Who |
|---|---|---|---|
| `\|res\| < 500ms` | in tolerance | none | — |
| `\|res\| >= 500ms`, sign(slope) opposes sign(res) | transient hiccup, closing | none | client |
| `\|res\| >= 500ms`, diverging, `\|res\| < 3s` | playback-rate mismatch | `playbackRate` nudge, capped [0.95, 1.10] | client |
| `\|res\| >= 3s`, target **inside** `video.buffered` | real divergence, cheap to fix | hard seek | server → `correct` |
| `\|res\| >= 3s`, target **outside** `video.buffered` | seek would rebuffer (measured: costs one segment fetch, ~150-400 ms of `readyState < 3`) | prefer nudge; seek only if the gap exceeds what nudging can close | server → `correct` |
| `readyState < 3` or `bufferedAheadS < 1` | buffering | readiness gate | server → `gate` |
| `suspended` | tab hidden, playback never audible; the browser paused it | nothing — the member is **absent**, not behind | — |

Server → `{"t":"correct","mode":"seek","targetPositionMs":<n>,"when":<serverMs>,"seq":<current>}`
**Unicast. Does not change the anchor and does not consume a `seq`** — it is a judgement about one
client, not a room state change. This is the distinction that keeps the feedback loop out (§4c).

### Which correction, and what it costs

Measured in a real browser (`docs/BROWSER-FINDINGS.md` §2): **an in-buffer seek costs ~20 ms at any
network speed; an out-of-buffer seek costs one full segment fetch (150-400 ms) and rebuffers for
that whole time**, leaving the client further out of position than it started.

So the choice is about price, not magnitude:

| situation | correction |
|---|---|
| target inside `video.buffered`, error above the band | **seek** — it is free |
| target outside, error above `NUDGE_MAX_RESIDUAL` | **seek anyway** — the ±10 % rate clamp closes only 100 ms/s, so a 15 s gap would take 150 s |
| otherwise | **rate** |

`ServoCorrector` (`server/internal/sync/corrector_servo.go`) implements this together with the
timebase constraints:

- the **frequency** term integrates `d(residual)/dt`, which is bias-immune (`= rate - 1` for any
  constant offset error), and freezes above `RAMP_MAX_SLOPE` so a stall's ~1000 ms/s slope is not
  mistaken for a rate error;
- the **phase** term is proportional and dead-banded at `max(TOLERANCE, uncertainty)` — never an
  integrator, because §1's bias and §3's laundering mean phase cannot be resolved finer than
  `uncertainty`, so an integrator would chase a target that does not exist.

## 6. Readiness gate (§6)

Server → `{"t":"gate","waiting":true,"waitingOn":["<clientId>"],"reason":"buffering"}`

Modelled on Jellyfin's dedicated `Waiting` state, including its anti-hang rule: **a member who
leaves while buffering counts as ready**, so a dropped connection cannot freeze the room. We add
what Jellyfin lacks — a `GATE_TIMEOUT` after which a still-buffering member is dropped from the
gate and the room resumes without them.

Sent on **change only**: one frame per report per member would be the room's report rate times its
size. A suspended member is never in `waitingOn` — they are absent, not buffering (§4).

`waiting` and `waitingOn` are **different facts**: `waitingOn` is who is not ready (worth showing
in the UI whenever it is non-empty), `waiting` is whether a command is actually being held.

### What is held, and how

Only **`play`** is held, and the server holds *the command*, not the players. The gate acts before
the anchor moves; since the anchor is the only truth, a held `play` simply never happened. That
means **the gate needs no cooperation from any client** — there is nothing to obey and nothing that
can get stuck if a client ignores the frame. When the last blocker becomes ready, the held command
takes the ordinary path: a fresh `seq`, a fresh `when`, an `ack` to its original sender.

- `media` needs no gate: it lands paused by construction, so the `play` after it is the one that
  waits.
- `pause` and `seek` are never held — making the room unresponsive exactly when somebody wants to
  stop it is the wrong failure.
- At most **one** held command; a later command supersedes it. A queue would let a member who is
  slow to buffer replay a stale burst of user intent at the room minutes later.
- `GATE_TIMEOUT` runs from when the **member** entered the gate, not from when the command was
  held, and the waiver **latches** until they report ready — otherwise a member who never recovers
  holds the room forever in `GATE_TIMEOUT`-sized increments.

Measured (`docs/POC-FINDINGS.md` §38): without the hold, a member who cannot buffer is skipped past
**14 470 ms** of media and pays a rebuffering out-of-buffer seek; with it, nothing is skipped and
everyone waits 16 s. The gate does not make anything faster — it converts one member's loss into
everyone's wait. `anchorErr` cannot see this (it excludes a stalled client by construction), which
is why `SkippedMs` exists.

## 7. Chat & rooms

Client → `{"t":"chat","text":"..."}`
Server → `{"t":"chat","from":"<clientId>","name":"...","text":"...","serverMs":<n>}` to everyone,
**including the sender** — only room *state* is echo-suppressed. `from`, `name` and `serverMs` are
stamped server-side; the frame carries nothing else the sender controls. Text is truncated at
`MAX_CHAT_LEN` on a rune boundary (a split rune would make the text frame invalid UTF-8, which
RFC 6455 forbids).

Rooms: >=128-bit CSPRNG id, rotatable join secret (the no-host replacement for "kick"), in-memory,
idle-expiry. See SYNTHESIS §13 — the room URL is the *only* access control this design has.

Creation is HTTP, not a frame: `POST /api/rooms` with an optional `{"mediaKey":"..."}` returns
`{"roomId","secret"}` (201). `GET /healthz` reports `{"ok","rooms","serverMs"}`.

Rotation:

Client → `{"t":"rotate"}` — **any member may send it.**
Server → `{"t":"secret","secret":"<new>","rotated":"<clientId>"}` to every current member.

Rotation does **not** eject anyone; nothing in a host-less design can. It invalidates the forwarded
link: existing sessions continue, anyone reconnecting with the old secret is refused. You rotate,
then re-share with the people you meant to include.

### Rate limiting (§13.3)

cytube's algorithm — a free burst, then one event per `1000/sustained` ms, reset after `cooldown`
of silence — on **four separate buckets**, because the frame types have completely different
natural rates and starving the clock bucket would degrade the timebase itself.

| bucket | burst | sustained | cooldown | on refusal |
|---|---|---|---|---|
| `cmd` / `rotate` | 10 | 5/s | 4 s | `error{code:"rate_limited"}` |
| `chat` | 4 | 1/s | 4 s | `error{code:"rate_limited"}` |
| `hb` | 40 | 20/s | 2 s | dropped silently — a report is advisory, and answering would add traffic |
| `time` | 10 | 2/s | 10 s | dropped silently |

### Errors

`{"t":"error","code":"<stable machine-readable>","msg":"<for humans>"}`. Codes in use:
`join_refused`, `room_full`, `already_joined`, `bad_frame`, `bad_kind`, `bad_cmd`, `rate_limited`.

An unknown frame type is answered with `bad_frame` and the connection **stays open** — a client
from a newer build must not be able to kill its own session by sending something we have not heard
of. The decoder accepts client-originated types only: a `state`, `ack` or `correct` arriving from a
client is `bad_frame`, because either would move room state without passing the per-room mutex.

## Constants (v0 — all tunable, all to be validated by the sim harness)

| Name | Value | Gates |
|---|---|---|
| `SEEK_THRESHOLD` | 1000 ms | two-diff seek detection |
| `REPORT_THRESHOLD` | 250 ms | immediate anomaly report |
| `TOLERANCE` | 500 ms | do-nothing band |
| `NUDGE_MAX_RESIDUAL` | 3000 ms | above this, seek instead of nudge |
| `NUDGE_RATE_RANGE` | [0.95, 1.10] | playbackRate clamp |
| `CMD_DELAY` | clamp(2*p95_ping, 500, 2000) ms | scheduled-command lead time |
| `HB_INTERVAL` | 1000 ms | heartbeat |
| `EVAL_INTERVAL` | 100 ms | local evaluation loop |
| `TIME_SYNC_INTERVAL` | 5000 ms | clock resync |
| `GATE_TIMEOUT` | 30000 ms | drop a stuck member from the gate |
| `RAMP_MAX_SLOPE` | 100 ms/s | above this the slope is a discontinuity, not a rate error |
| `SEEK_COOLDOWN` | 2000 ms | floor between two seeks for one client |
| `MIN_CLOCK_SAMPLES` | 3 | no position correction before the estimate settles |
| `MAX_CHAT_LEN` | 320 bytes | chat truncation (cytube's value) |
| `ROOM_IDLE_TTL` | 3 min | room deleted this long after its last member leaves |
| `OUTBOX_DEPTH` | 64 frames | a member further behind than this is disconnected |

## Open, not yet settled

- **Whether `playbackRate` nudging is safe on the MSE players we target.** The servo design leans on
  it heavily. Per-adapter capability flag until measured on a real provider.
- One-way latency asymmetry (see §1 note). Bounded and disclosed, not fixable.

### Settled by measurement, kept here so they are not re-derived

- **Background-tab throttling**: an *audible* hidden tab is not throttled at all; a *muted* hidden
  tab is clamped to 1 Hz **and paused outright by the browser**, so the feared "1 Hz eval loop"
  describes a state that does not occur. `Worker` timers are never throttled
  (`docs/BROWSER-FINDINGS.md` §4).
- **Seek cost**: in-buffer free, out-of-buffer one segment fetch (§2 there).
- **Stall signature**: `paused === false`, `readyState` 4→2, draining buffer, `waiting` event —
  confirmed on a real MSE player (§1 there).
