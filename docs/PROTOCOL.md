# Wire protocol (v0, draft)

Derived from `research/SYNTHESIS.md`. Section refs below point there. Transport: one WebSocket per
client, JSON frames, `{"t": "<type>", ...}`. Keep this file and SYNTHESIS consistent.

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
Server → `{"t":"welcome","you":"<clientId>","seq":<n>,"anchor":{...},"members":[...],"serverMs":<n>}`

`mediaKey` is the normalized media identity (provider + content id), not the raw URL — query params and
tracking junk must not fork a room. Mismatch ⇒ server replies `{"t":"media.mismatch", ...}` and the
client shows "everyone else is watching X".

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

Chrome **pauses a muted video when its tab is hidden**, firing a real `pause` event, and fires
`play` again when the tab is shown (measured: `docs/BROWSER-FINDINGS.md` §5). Broadcast naively,
one member switching tabs pauses the whole room, and switching back resumes it.

> A `play`/`pause` arriving while `document.hidden && video.muted` is browser suspension. Never
> broadcast it; mark the member **suspended** and suppress the paired event on re-show.

`document.hidden` alone is not enough — media keys deliver genuine user pauses to hidden tabs.

A suspended member is **absent, not buffering**: the §6 readiness gate must not hold the room for
them. Distinguish by the observable state — buffering is `paused === false`, `readyState < 3`,
draining buffer, with a `waiting` event; suspension is `paused === true`, `readyState === 4`, full
buffer, with a `pause` event.

### Heartbeat

```json
{ "t":"hb",
  "residualMs":     -420,      // signed: localPos - expected(serverNow). negative = behind
  "slopeMsPerS":    -85,       // d(residual)/dt, least-squares over a 3 s window
  "positionMs":     123456,
  "paused":         false,
  "readyState":     4,
  "bufferedAheadS": 12.4,
  "lastAppliedSeq": 91 }
```
`lastAppliedSeq` is what lets the server spot a client stuck on stale state — free to include.
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

Server → `{"t":"correct","mode":"seek","targetPositionMs":<n>,"when":<serverMs>,"seq":<current>}`
**Unicast. Does not change the anchor and does not consume a `seq`** — it is a judgement about one
client, not a room state change. This is the distinction that keeps the feedback loop out (§4c).

## 6. Readiness gate (§6)

Server → `{"t":"gate","waiting":true,"waitingOn":["<clientId>"],"reason":"buffering"}`

Modelled on Jellyfin's dedicated `Waiting` state, including its anti-hang rule: **a member who
leaves while buffering counts as ready**, so a dropped connection cannot freeze the room. We add
what Jellyfin lacks — a `GATE_TIMEOUT` after which a still-buffering member is dropped from the
gate and the room resumes without them.

## 7. Chat & rooms

`{"t":"chat","text":"..."}` → broadcast with `from` and server timestamp. Server-side per-member
rate limiting (§13) — anti-accident, not anti-malice.

Rooms: >=128-bit CSPRNG id, rotatable join secret (the no-host replacement for "kick"), in-memory,
idle-expiry. See SYNTHESIS §13 — the room URL is the *only* access control this design has.

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

## Open, not yet settled

- Background-tab throttling clamps `EVAL_INTERVAL` to ~1 Hz. Web Worker timers are the candidate
  fix but workers are also throttled in some configurations — **verify, do not assume** (Risk B).
- One-way latency asymmetry (see §1 note).
- Whether `playbackRate` nudging is safe on the MSE players we target — per-adapter capability flag
  until measured.
