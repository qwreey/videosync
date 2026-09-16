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
anchor = { positionMs, atServerMs, paused, mediaKey, mediaUrl? }
expected(T) = paused ? positionMs : positionMs + (T - atServerMs)
```

`mediaUrl` is where a member can open `mediaKey` (see "Amendment: the room says where its media is",
§2). It plays no part in `expected()`.
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

Client → `{"t":"hello","room":"<id>","secret":"<join secret>","name":"...","mediaKey":"...","mediaUrl":"..."}`
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

### Amendment: the room says where its media is

`mediaKey` is lossy on purpose (`yt:abc`, `laftel:/player/45462/93304`), so a room could say *what*
it is watching but not *where*, and a joiner on another page had nothing to follow. The invite
link carried the inviter's URL, which goes stale the moment the room moves on.

The anchor now carries an optional `mediaUrl`, set by the same things that set `mediaKey` and
nothing else: `POST /api/rooms`, the first member's `hello` while the room has no media, and a
`media` command (a `media` command without one clears it, rather than keeping a URL for media the
room has left). A later joiner's `hello.mediaUrl` is ignored, as its `mediaKey` is.

What a client sends is canonical and carries nothing personal: the provider's watch URL
(`https://www.youtube.com/watch?v=<id>`) or origin + path. Never the query string (session tokens,
tracking) and never the fragment (where an invite keeps the room secret). The server drops
anything that is not http(s), has credentials or a fragment, or is over 512 bytes.

`mediaKey` and `name` are bounded too, because both are repeated to every member: the key in every
`state`, `ack` and `welcome`, the name in every roster and chat line. A `mediaKey` over 512 bytes
names nothing when it comes from `POST /api/rooms` or a first `hello` (its `mediaUrl` goes with it),
and a `media` command carrying one is refused with `bad_cmd`. A `name` is truncated to 64 bytes on
a rune boundary, like chat text.

The URL comes from a member, so a client **checks it before following it**: it must normalise to
exactly the anchor's `mediaKey`, and it must be on a provider the client knows or on the site the
member is already on — otherwise anyone in a room could send everyone else to a page of their
choosing. A site added only by a manifest `matches` entry is therefore followable from that same
site, not from another one.

A client that finds the room on other media **because it joined or because the room moved** takes
the member there after a short grace period with a "stay here" button, and carries the session
across the page load so it rejoins on arrival. A member who navigates away **themselves** is never
taken back; they are offered "move the room here", as before.

Membership changes are broadcast:
`{"t":"members","members":[{"id","name","suspended","ready"}],"joined":"<id>"|"left":"<id>"}`.
The joiner gets the roster in its `welcome` instead, so it is excluded from that broadcast.

## 3. Commands (§2, §5)

Client → `{"t":"cmd","reqId":"<uuid>","kind":"play|pause|seek|media","positionMs":<n>,"mediaKey":"...","mediaUrl":"..."}`

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

### Amendment: a command that leaves the room STOPPED carries no lead, and `pause` anchors where the pauser stopped

Simultaneity is only worth paying for while the clock is running. Once every member is stopped at
the same position there is nothing left to happen at the same instant, so `when = emittedAt` for
`pause`, for `media`, and for a `seek` that finds the room paused. `CMD_DELAY` applies to `play`
and to a `seek` during playback, where the instant is the whole point.

`pause` also **anchors at the `positionMs` the sender reported**, rather than advancing the anchor
to where playback would have reached at `when`. The pause and the position it happened at are the
thing being synchronised.

What the old rule cost: the person pressing pause stopped on a frame, and then their own picture
jumped `CMD_DELAY` forward into media they never saw — the displacement `SkippedMs` exists to
count, imposed on the one member who chose the transition. Measured alone in a room on the 500 ms
floor, pausing at 103.20 s put the picture at 103.70 s.

What it costs instead: a remote member keeps playing until the command reaches them and then
rewinds by up to one downlink delay, instead of arriving exactly on time. In `command-storm` that
shows as one client's convergence going 50 ms → 150 ms and the scenario taking 3 → 5 gate events,
against `anchorErr` 22 → 8 ms and p95 35 → 20 ms (POC-FINDINGS §40c).

Because a no-lead command is due the instant it is issued, the stale-anchor resend can no longer
use "is it due yet?" to tell a member that missed a command from one that is still receiving it.
It uses the member's own measured RTT as the grace period instead (§40a).

A room of **one member** schedules nothing at all: `CMD_DELAY` is 0 below two members, because the
delay buys simultaneity with people who are not there.

**Except inside another command's lead.** A `pause` that arrives before the previous command's
`when` anchors at that command's `anchor.positionMs` — where a pending `play` resumes from, or
where a pending seek jumps to — not at the sender's `positionMs`. Nobody applies a transition
before its `when`, so the sender's position is on the timeline the room is about to leave; taking
it let a pause from a member who had not reached a seek's `when` undo that acked seek for the whole
room, although the seek came first in `seq` order. (`Cmd` carries no base `seq`, so "is a
command still pending" is the only thing the server can know about which timeline the position
came from.)

### Amendment: the member who presses `play` waits for `when` too

`play` keeps its full lead, so somebody has to give while it runs out, and until now it was the
presser: their element was already playing, and when their own `ack` landed the transition sought
them back to the anchor. Measured live on Laftel with two members on the 500 ms floor
(`BROWSER-FINDINGS.md` §15): a ~650 ms backward jump on every play, ~725 ms rewatched, and the
presser ending ~165 ms behind because the seek-back itself costs ~100 ms there.

A client that detects a local `play` in a room of two or more therefore sends the command and
**immediately re-pauses its own element at the anchor** (client-side only; `holdLocalPlay` in the
engine). Everyone then starts from the same paused position at `when`, and the presser's landing
needs no seek. The server is unchanged and does not know. What it costs is the lead itself, spent
as a wait before the picture moves instead of as a rewind after it (§16: backward jump gone, both
members starting within ~15 ms of each other).

The re-pause is an applied transition like any other — it runs under the same echo suppression and
ends in `rebaseline(pos, paused)` — and nothing waits for the ack: if the play is held by the gate,
superseded or refused, the member is simply paused in a paused room, which is correct.

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

DOM events (`seeked`/`play`/`pause`/`ratechange`/`waiting`/`playing`) **trigger this evaluation,
they never broadcast directly.** One decision path, two input sources.

> Wiring the second source in requires the evaluation to measure its own elapsed time rather than
> assume `EVAL_INTERVAL`. A detector that dead-reckons a fixed interval per call walks its reference
> away from the player whenever the loop does not run at exactly that rate — an event, a throttled
> tab, a busy page — and eventually manufactures a seek that never happened.

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
on it**: when a report's `lastAppliedSeq` lags the current `seq` **and the command is already due**,
resend the state instead of judging the report.

> The "already due" half is not optional. A client advances `lastAppliedSeq` when it *applies* a
> command, which is `CMD_DELAY` after the broadcast — so for the whole 500–2000 ms scheduling
> window every member reports a lagging seq while being perfectly correct. Resending there does
> real damage: the resend carries `when = now`, the client replaces its correctly-scheduled entry
> with it, and transitions `CMD_DELAY` **early** — destroying exactly the simultaneity this
> timebase exists to provide. With a 1 Hz heartbeat and the 500 ms floor it fired on roughly half
> of all commands, including for the originator, whose `ack` takes the same path. A client on a stale anchor measures its residual *against that stale anchor* and
so reports ≈ 0 while being arbitrarily out of position — measured at 115 603 ms mean error without
the resend and 250 ms with it (POC-FINDINGS §34). This is three lines and reads a field already on
the wire.
`slopeMsPerS` is computed **client-side at high frequency with zero network noise**; the server
must never try to differentiate 1 Hz reports itself (§4c).

Report immediately (don't wait for the heartbeat tick) when `|residualMs|` crosses
`REPORT_THRESHOLD` or when paused-state disagrees with the anchor.

### The anchor is truth about pause state, not only position

A client whose player is paused while the anchor says playing must **re-apply the anchor** after
`RECONCILE_AFTER`. Nothing else will: the correction table below only ever seeks or nudges, so a
member that ends up paused for a reason outside the protocol — a `play()` that failed with
`AbortError`, a transition that lost a race, a site pausing the element for its own reasons — would
sit there reporting a growing residual and being seek-corrected forever.

The delay matters. A genuine local pause also disagrees with the anchor, for exactly as long as it
takes to become a command and come back; reconciling faster than that would fight the user.

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

Server → `{"t":"correct","mode":"seek","when":<serverMs>}` / `{"t":"correct","mode":"nudge","rate":<f>,"when":<serverMs>}`
A `nudge` the client is already holding is **not sent** — a continuous control
law recomputes a rate on every report, and re-stating it would put a `correct`
on the wire at the report rate, each one firing a `ratechange` on the very
element the detector is watching (measured: 17 nudges in a 20 s session, 4 after
the fix). It is re-stated every `RATE_REFRESH` anyway, because `correct` is
unicast and unacknowledged: if the one that set the rate was lost, nothing else
would ever tell the client again.

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
A join changes nothing about the gate, so a member who joins while a `play` is held or someone is
buffering gets the current `gate` frame right after its `welcome` instead; otherwise it would never
hear why its own `play` is not starting.

When the **last** member leaves, a held `play` is dropped rather than released: there is nobody to
start playing for, and the anchor of an empty room would run for the whole idle TTL.

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

Creation is HTTP, not a frame: `POST /api/rooms` with an optional `{"mediaKey":"...","mediaUrl":"..."}` returns
`{"roomId","secret"}` (201). `GET /healthz` reports `{"ok","rooms","serverMs"}`.

Both endpoints send **CORS** headers, and this is not a nicety: a userscript or
a content script always runs on the OTT site's origin and never on the sync
server's, so *every* API call is cross-origin. Without them the browser fetches
the response and then refuses to let the script read it — which surfaces as a
bare `TypeError: Failed to fetch` naming neither CORS nor the origin. With no
`--allowed-origins` configured the header is `*`, which is safe because no
credentials are involved: the room secret travels in the `hello` frame, never in
a cookie. The WebSocket upgrade is **not** subject to CORS; it is governed by
the `Origin` allowlist instead.

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
| `cmd` | 10 | 5/s | 4 s | **coalesced**: the newest refused `cmd` replaces any older one and is applied when the bucket allows; its `ack` arrives then. Nothing is sent on deferral |
| `rotate` | (shares `cmd`'s bucket) | | | `error{code:"rate_limited"}` |
| `chat` | 4 | 1/s | 4 s | `error{code:"rate_limited"}` |
| `hb` | 40 | 20/s | 2 s | dropped silently — a report is advisory, and answering would add traffic |
| `time` | 10 | 2/s | 10 s | dropped silently |

Why `cmd` is coalesced rather than refused: the one burst a person really produces is holding an
arrow key or scrubbing — seeks ~100 ms apart, of which every other one was refused past the burst.
When the *last* one was refused the room stayed on an earlier skip, nothing resent the final
position, and the `ack` for that earlier skip sought the user's own player back to it. Coalescing
keeps the rate (one command per window whatever the sender does) and lets the newest intent win, as
the readiness gate does for the command it holds.

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
| `CMD_DELAY` | clamp(2*p95_ping, 500, 2000) ms | scheduled-command lead time. 0 for a room of one, and 0 for any command that leaves the room stopped (§3 amendment) |
| `HB_INTERVAL` | 1000 ms | heartbeat |
| `EVAL_INTERVAL` | 100 ms | local evaluation loop |
| `TIME_SYNC_INTERVAL` | 5000 ms | clock resync |
| `GATE_TIMEOUT` | 30000 ms | drop a stuck member from the gate |
| `RAMP_MAX_SLOPE` | 100 ms/s | above this the slope is a discontinuity, not a rate error |
| `SEEK_COOLDOWN` | 2000 ms | floor between two seeks for one client |
| `RECONCILE_AFTER` | 3000 ms | player disagreeing with the anchor's pause state this long is re-applied |
| `MIN_CLOCK_SAMPLES` | 3 | no position correction before the estimate settles |
| `MAX_CHAT_LEN` | 320 bytes | chat truncation (cytube's value) |
| `ROOM_IDLE_TTL` | 3 min | room deleted this long after its last member leaves |
| `OUTBOX_DEPTH` | 64 frames | a member further behind than this is disconnected |
| `RATE_REFRESH` | 5000 ms | re-state a rate the client should already hold, in case the `correct` was lost |

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
