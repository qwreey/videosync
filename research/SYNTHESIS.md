# Synthesis — what 9 references teach us, and what we must build ourselves

Inputs: `research/*.md` (each cited `file:line` into `refs/`). Decisions: `docs/DECISIONS.md`.
Every row below names the reference we take the mechanism from, so the choice is auditable.

## 0. Reference scoreboard

| Reference | Stack | Best-in-class at | Trust |
|---|---|---|---|
| syncplay | Python | protocol design, layered drift correction, RTT smoothing | high, maintained |
| jellyfin SyncPlay | C# | server-authoritative state machine, scheduled commands, buffering gate | high, maintained |
| VideoTogether | JS + Go | min-RTT offset, generic video scan, Go WS server shape | medium — secretly host-based |
| watchparty | TS | playbackRate nudging, sender-excluded broadcast | medium |
| cytube | Node | 17 provider adapters, decade of chat/abuse hardening | high for chat, dated for sync |
| opentogethertube | TS + Rust | anchor+elapsed position, egalitarian permission model, balancer | high, maintained |
| SyncTube | Haxe | zero-dependency single-container deploy (9/10 self-host) | small, readable |
| syncwatch | TS | MV3 extension shape | low — has a real echo-suppression bug |
| watchbear | CRX only | cross-frame video election, echo flag with timeout | low — **no source in repo**, findings from decompiled CRX |

**Caveat to carry forward:** `refs/watchbear` contains only a landing page. Its findings come from the
published Chrome Web Store CRX v0.6.3, tagged `[CRX]` in the doc. Compiled artifact, not source.

---

## 1. Clock synchronization → build from parts, no single reference is enough

| Reference | Approach | Verdict |
|---|---|---|
| jellyfin | `GET /GetUtcTime` → `{RequestReceptionTime, ResponseTransmissionTime}`, client does all math | **take the wire shape** |
| VideoTogether | offset piggybacked on every request; updates *only on a new minimum RTT* (`vt.js:3617-3623`) | **take the update rule** |
| syncplay | RTT = `now - echoedTimestamp`, EMA weight 0.85, one-way delay by comparing both sides' RTTs | take EMA as fallback |
| cytube | trusts leader's raw `Date.now()` (`src/channel/playlist.js:869`) | reject — no compensation |
| watchparty | median of 1Hz client self-reports (`App.tsx:1954-1959`) | reject — no RTT at all |
| opentogethertube | anchor+elapsed, but client re-anchors on **local receipt time** (`common/timestamp.ts:4-12`) | reject — absorbs one-way latency as silent error |

**Decision.** Jellyfin's two-timestamp exchange, carried over our WebSocket (not a separate HTTP
endpoint), sampled continuously. Adopt VideoTogether's min-RTT rule: only accept an offset sample
when it comes from a new-minimum RTT — the minimum-RTT sample is the one least polluted by queuing
delay. Keep an EMA as a slow-moving sanity band, not as the primary estimate.

**OTT's bug is the thing to specifically not repeat:** re-anchoring on local receipt time makes
every client silently wrong by its own one-way latency. Anchor on server-stamped time only.

## 2. Command scheduling → Jellyfin, near-verbatim

`SendCommand{ When, EmittedAt, PositionTicks, Command }` with
`delay = max(2 × highestReportedPing, 500ms)` (`SendCommand.cs:19-27`,
`PlayingGroupState.cs:62-87`). Every client executes the same transition at the same wall-clock
instant instead of "as soon as the message lands".

This is the single most portable idea in the entire corpus and it is exactly what D3 committed to.
It is also **what makes no-host work**: nobody is racing to be the timing authority.

Bug to avoid, found in Jellyfin itself: `WaitingGroupState.cs:503-504` compares ticks against a
millisecond constant, silently defeating a 500 ms safety floor. The correct sibling is
`PlayingGroupState.cs:67`. Unit-test our tick/ms boundary.

### Amendment: the delay formula must be capped, because D4 has no host

Jellyfin sizes the delay from pings its own clients report. In a **no-host** room where any member
can issue a command, that formula lets **one member on a bad connection set the delay for the whole
room** — every pause becomes sluggish because of one person. Jellyfin has the same exposure but a
different tolerance for it.

**Decision:** `delay = clamp(2 x p95_ping, 500ms, 2000ms)`.
- p95 rather than max, so a single outlier does not dominate.
- Hard 2 s ceiling: past that, responsiveness matters more than perfect simultaneity.
- A member whose ping exceeds the cap is **not** excluded from the room and **not** allowed to
  stretch the delay. They are handled by the §6 `Waiting` state instead: they will simply be
  behind, report not-ready, and gate the room through the readiness path, which already has a
  timeout. One mechanism for slow members, not two.

Rationale for writing this down now: it is one paragraph today and a wire-protocol rewrite if
discovered mid-implementation.

## 3. Drift correction → layered, Syncplay's shape with watchparty's nudge

Nobody but Syncplay layers this, and everybody who hard-seeks produces visible jumps.

| Reference | Deadband | Correction |
|---|---|---|
| watchbear `[CRX]` | 500 ms | hard seek |
| watchparty | 500 ms | `rate = 1 + delta/10`, cap 1.1×, laggards only (`App.tsx:762-781`) |
| jellyfin | 500 ms (`MaxPlaybackOffset`) | hard seek only |
| VideoTogether | 1 s playing / 0.1 s paused | hard seek only |
| opentogethertube | ~1 s | hard seek |
| SyncTube | ~2 s, **coupled to poll interval** | hard seek |
| cytube | 2 s | hard seek |
| syncwatch | none | unconditional hard seek on every event |
| syncplay | 1 s ignore → 1.5 s nudge 0.95× → 4 s hard seek → 5 s catch-up | layered |

**Decision.** Three bands: ignore < 500 ms; `playbackRate` nudge (capped 1.1× / 0.95×, laggards
accelerate) from 500 ms to ~3 s; hard seek beyond. Do **not** couple the deadband to the poll
interval the way SyncTube does.

**Constraint on the nudge from the provider research:** `playbackRate` on MSE players is fragile
enough that Syncplay ships it user-disableable. Treat it as capped best-effort with a hard-seek
fallback, and make it a per-adapter capability flag, not a global assumption.

## 4. Echo suppression → three independent layers, because one always fails

The failure this prevents: applying remote state fires local `play`/`pause`/`seeked`, which we
rebroadcast, which the room applies, forever.

- **Layer 1 — server excludes the sender from the broadcast** (watchparty, `server/room.ts:752,763,778`).
  Removes the feedback path structurally. Costs nothing. Works with no host.
- **Layer 2 — per-adapter `applyingRemote` flag with a re-armed ~400 ms timeout**
  (watchbear `[CRX]`). Instance-scoped, never global.
- **Layer 3 — outbound intent is explicit, not inferred from DOM events** (OTT,
  `Room.vue:616-628`): a DOM event self-corrects toward store state; only a real user gesture
  produces an outbound command.

**Why all three:** syncwatch proves layer 2 alone is not enough. Its global boolean has no timeout
and clears only on specific follow-up events, so a remote `play` on an already-playing video fires
no `playing` event, the flag never clears, and **all future sync dies silently**
(`content.ts:90-104`). VideoTogether's elegant alternative — members' heartbeats literally have no
`currentTime` field (`vt.js:492-501`) — is unusable for us because it depends entirely on the
host/member asymmetry D4 rejects.

## 5. Conflict resolution with no host → Jellyfin + one thing nobody has

Of nine references, **exactly one** genuinely resolves simultaneous conflicting commands:
Jellyfin takes a per-group mutex before applying any request
(`SyncPlayManager.cs:333`), serializing by arrival order, with no sequence number on the wire.
OTT ships egalitarian-by-default (`common/permissions.ts:163-174`) and simply **accepts** the
races. SyncTube's entire exclusive-`leader` gate exists specifically to *avoid* the concurrency we
want. syncwatch is bare last-write-wins (`server.ts:189-197`). Everyone else has a host.

**Decision.** Jellyfin's mutex (trivially a per-room goroutine/mutex in Go, and it works because
D2 is a single process) **plus a server-assigned monotonic sequence number on every state change**
— which no reference does. We need it because clients apply optimistically (§4 layer 1); without a
sequence they cannot tell a stale in-flight update from a fresh one. Clients discard any state with
`seq` ≤ last applied.

Also carry attribution (`who`) in the state so the UI can say "X paused" — with everyone holding
control, unexplained jumps are the main UX failure mode.

### Amendment: layer 1 and the sequence number collide on the sender's own path

§4 layer 1 excludes the sender from the broadcast. §5 has clients discard state with
`seq <= lastApplied`. Composed naively these are **broken**: the sender never receives the broadcast
carrying the `seq` assigned to its own change, so its `lastApplied` never advances. The next
broadcast it receives from another member then looks fresh when it is in fact racing the sender's
own uncommitted optimistic state.

**Decision: the server excludes the sender from the state *broadcast*, but always sends that sender
a direct `ack{seq, appliedState}`.** The sender advances `lastApplied` on the ack.

- Keeps layer 1's property (no echo of your own command as a command).
- Restores a single monotonic `seq` timeline for every client including the originator.
- The ack doubles as the "your command was accepted/rejected" signal — if the per-room mutex
  ordered someone else's command first, the ack carries the *winning* state, and the sender rolls
  its optimistic apply back to it. This is the rollback path optimistic apply requires and that no
  reference implementation has.

Rejected alternative: include the sender in the broadcast and rely on layer 2's `applyingRemote`
flag to swallow it. That makes correctness depend on a timeout-based flag — exactly the mechanism
syncwatch proved fragile (§4).

---

## 4b. How a local seek is *detected* — events vs. polling (four references, four answers)

Upstream of echo suppression sits a question §4 skipped: how do you notice the local user seeked?

| Reference | Mechanism | Evidence |
|---|---|---|
| syncplay | **poll only**, two-diff discontinuity test | `client.py:218-223` |
| VideoTogether | hybrid — DOM events wake it, a 2 s poll decides | `vt.js:2863` + `vt.js:3483` |
| syncwatch | **DOM events only** | `content.ts:87-104` |
| opentogethertube | **neither** — zero `seeked` listeners; seeks are explicit UI intent | grep: 1 match, a chat string |
| jellyfin | ABSENT — client is outside the sparse checkout | — |

### Syncplay's two-diff test is the best mechanism in the corpus

```python
def _determinePlayerStateChange(self, paused, position):
    pauseChange = self.getPlayerPaused() != paused and self.getGlobalPaused() != paused
    _playerDiff = abs(self.getPlayerPosition() - position)
    _globalDiff = abs(self.getGlobalPosition() - position)
    seeked = _playerDiff > constants.SEEK_THRESHOLD and _globalDiff > constants.SEEK_THRESHOLD
    return pauseChange, seeked
```
`SEEK_THRESHOLD = 1` s. Both accessors dead-reckon (last known value + elapsed time when not
paused), so the comparison holds during playback (`client.py:521-550`).

- `_playerDiff` — new position vs. **last known local** position: "did the player jump?"
- `_globalDiff` — new position vs. **where the room says we should be**: "is that jump also a
  divergence from the room?"

**The AND is echo suppression built into detection.** Remote-driven seek → `_playerDiff` large,
`_globalDiff` ~0 → `seeked = False`, nothing rebroadcast. Only a local user seek makes both large.
`pauseChange` is ANDed the same way.

This has **no timeout and no flag, so it cannot get stuck** — structurally immune to the syncwatch
failure documented in §4. Syncplay arrived here because it drives external players (mpv/VLC) over
IPC where DOM events do not exist; the constraint produced the better design.

Also noted: syncwatch has a second defect here beyond the stuck flag — `seeked` is only broadcast
when the video is **paused** (`content.ts:100`), so seeks during playback are never sent as seeks.

### Decision: hybrid, with events as trigger and the two-diff test as the sole authority

Polling alone misses a scrub that lands back near its origin (both diffs small), and its detection
latency is bounded by the poll interval. Events alone miss player-internal seeks that fire nothing,
ad-insertion `currentTime` jumps, MSE non-monotonic `currentTime` near buffer boundaries, and
**backgrounded tabs** (§11 item 1).

1. `seeked` / `play` / `pause` / `ratechange` **trigger an immediate evaluation** — they never
   broadcast directly.
2. The evaluation is Syncplay's two-diff test, against last-known-local and expected-room position.
3. A ~1 Hz poll runs **the same evaluation function**, so anything events miss is caught within a
   second.

One code path decides "is this user intent worth broadcasting", fed by two sources. Consequence for
§4: layer 2's `applyingRemote` flag stops being load-bearing and becomes a secondary backstop —
which is what we want after seeing what happens when a timeout flag is the only defence.

---

## 4c. What the server does with position reports — aggregate, or judge?

Three references aggregate client position reports into a room position. They disagree on the
function, and the choice is a **product decision, not a technical one**.

| Reference | Aggregation | Effect on the room |
|---|---|---|
| syncplay | `min()` over watchers (`server.py:597-607`, ordering at `834-838`) | room follows the **slowest** client; nobody misses content, one bad connection drags everyone back |
| watchparty | `calculateMedian()` for >2 participants, **`Math.max()` for <=2** (`App.tsx:1954-1959`) | outlier-robust with a crowd; **policy silently inverts in a 2-person room** — the laggard gets pulled forward and skips content |
| jellyfin | none — server anchor is truth; reports only decide who is out of tolerance (`MaxPlaybackOffset = 500ms`, `Group.cs:103`) | room is deterministic; reports judge clients, never move the room |

### Decision: judge, do not aggregate

Feeding reports back into the room position creates a **feedback loop** — room position depends on
client reports, client positions depend on the room. Syncplay demonstrably fights this loop with
accumulated guards (`age > 1` staleness gate at `server.py:597`, `rewindOnDesync` config,
`DO_NOT_RESET_POSITION_THRESHOLD`), and its `min()` key is a non-total ordering that relies on
CPython's tie-break behaviour (`server.py:834-838`).

It also directly contradicts D3: with a server anchor plus scheduled commands, an aggregated room
position is a **second source of truth**.

**So: position reports decide (a) who needs correcting and (b) whether the readiness gate fires.
They never decide where the room is.** The anchor does. This keeps "server seeks whoever can't keep
up" — it only drops the "compute a centralised value" step.

Note for our own UX policy: watchparty's 2-person `Math.max()` fallback means small rooms behave
opposite to large ones. If we ever want slowest-client-wins semantics, it must be an explicit
room setting, not an emergent consequence of participant count.

### The trend signal — no reference has this

**All nine references threshold on absolute offset only. None looks at the derivative.** That is a
real gap, because seeking is expensive, visible, and on MSE players risks stalling outside the
buffered range (§7).

The derivative should choose **which correction to apply**, not merely whether to correct:

| Observation | Interpretation | Action |
|---|---|---|
| 800 ms behind, gap **closing** | transient hiccup, self-recovering | do nothing |
| 400 ms behind, gap **widening** | effective playback-rate mismatch | `playbackRate` nudge (§3) |
| large step discontinuity | genuine seek, or ad insertion | hard seek |
| persistently unable to keep up | buffering | readiness gate (§6), not a seek |

This unifies §3's three-band drift correction and §6's readiness gate into **one classifier** whose
input is (offset, d(offset)/dt) instead of two independent threshold mechanisms.

### Why the trend is computable, despite 1 Hz reports being noisy

The obvious objection: N clients reporting position at 1 Hz, each carrying its own RTT error, is
too noisy a signal to differentiate server-side.

**The server does not have to reconstruct it.** Per §1 each client already knows its own offset
from the server clock precisely. So each client computes **its own drift and slope locally, at high
frequency, with zero network noise**, and reports the *residual and trend* rather than a raw
position. The server aggregates a small meaningful signal instead of denoising a large one.

Move the computation to the client; leave the server with the judgement.

## 6. Buffering / readiness → Jellyfin's Waiting state, with Syncplay's instinct

Jellyfin makes it a **dedicated state**, not a flag on Playing/Paused: per-member `IsBuffering`,
aggregate = "any non-opted-out member still buffering", and it remembers `InitialState`/
`ResumePlaying` so it knows where to return. Crucially, **a member leaving while buffering counts
as ready**, so one dropped connection cannot hang the room forever (`WaitingGroupState.cs`).

Syncplay reaches the same outcome differently: pause propagates instantly to everyone
(`server.py:875-890`) and position is aggregated at ≤1 Hz via `min()` across watchers
(`server.py:597-607`), so laggards pin the room. No separate stall-vote protocol.

**Decision.** Jellyfin's explicit `Waiting` state (it composes with scheduled commands), including
the leaving-counts-as-ready anti-hang rule. Add a timeout so a member who buffers forever is
dropped from the gate rather than holding the room hostage — neither reference has this.

## 7. Provider adapter seam

Three interface shapes exist. The right one is a merge:

- VideoTogether `VideoWrapper{play, pause, paused, currentTime, duration, playbackRate}` — right
  minimal shape, but implemented as inline `if (hostname.endsWith(...))` chains inside one
  3735-line file (`vt.js:2125-2264`). Copy the interface, never the structure.
- watchparty `Player` (`Player.ts:1-25`) — cleaner: adds buffered ranges, readiness, subtitles.
  Only 2 implementations, because arbitrary sites are offloaded to a cloud VBrowser.
- cytube `player/base.coffee` — thinner, but **17 real implementations** for adapter breadth.

**Decision.** Capability-flagged async interface. Two constraints from the provider research make
this non-negotiable:
1. **Seeks must be confirmed, not assumed.** Seeking outside the MSE buffered range does not throw
   — it stalls into `waiting` until re-buffered. `seekTo()` must be async and resolve on `seeked`.
2. **`play()` can reject with `NotAllowedError`** and no API exposes the Media Engagement Index.
   The adapter must surface a typed autoplay-blocked error and the UI must have a
   "click to sync" gesture-capture overlay. This is universal, not provider-specific.

Capability flags: `supportsDirectSeek`, `supportsDirectPlayPause`, `supportsPlaybackRateNudge`,
`supportsAdDetection`, `volatileVideoElement`.

### Per-provider status (D1: Laftel + YouTube are v1)

- **Laftel — CONFIRMED works plain.** `document.querySelector('video')` + `currentTime`, no special
  handling. The only provider with hands-on primary-source confirmation.
  (My own attempt to confirm independently was inconclusive: laftel.net is Next.js/turbopack and I
  scanned 39 homepage chunks for hls.js/shaka/videojs/EME signatures with zero hits, because the
  player lazy-loads on `/player/*`, which 404s without a session. **Still worth a live smoke test.**)
- **YouTube — works with caveats.** Direct `currentTime` writes are reliable (SponsorBlock
  production code), but playback state and ad detection must come from `#movie_player`
  (`getPlayerState`, `onAdStart`/`onAdFinish`), and the element must be **re-resolved on
  `yt-navigate-finish`**, never cached. → `volatileVideoElement: true`.
- **Netflix — premise confirmed broken.** Raw `currentTime` writes crash its player; requires the
  undocumented `netflix.appContext…videoPlayer.seek()/.play()/.pause()` from MAIN world. Correctly
  out of v1 scope per D1. No 2023–2026 confirmation of that API exists — needs live testing if added.
- **Disney+/Prime/Wavve/TVING — LIKELY fine, unverified.** Widevine gates decryption, not the DOM
  control surface. No primary source for any of the four. Smoke-test before claiming support.

## 8. Video element discovery → watchbear is the only real answer

watchbear `[CRX]` runs in every frame (`all_frames: true`); each frame reports its largest video's
area to `window.top` via `postMessage`; top elects the global best, with a **10800 px² floor to
reject ad videos**. syncwatch cannot solve which cross-origin frame is correct. VideoTogether scans
generically but does not pierce shadow DOM.

**Decision.** Adopt watchbear's per-frame area election. Add shadow-DOM piercing and a
MutationObserver for element replacement — neither reference has those.

## 9. Extension platform (the risk register)

- **MAIN world is no longer the blocker.** `content_scripts[].world: "MAIN"` ships in Chrome 111
  and Firefox 128 — declarative, and CSP-immune because the browser injects it.
- **But the bridge is a security hole by default.** MAIN and ISOLATED share the same `window` and
  origin, so `event.origin` / `event.source` checks **authenticate nothing** — a page script can
  forge messages into our bridge. A per-load nonce is mandatory. (Confirmed against real code in
  `refs/VideoTogether`.)
- **Biggest open risk: MV3 service-worker WebSocket lifetime.** As of Chrome 116 an open-but-silent
  WebSocket does **not** keep the SW alive; messages must be exchanged inside the 30 s idle window
  (Chrome's own sample pings every 20 s). `chrome.alarms` minimum period is 30 s. Firefox MV3 uses
  event pages, not service workers, so the Chrome pattern does not transfer. Design for
  ping + alarms watchdog + reconnect-anywhere; never assume the socket stays open.
- **Fullscreen overlay** is top-layer, so z-index cannot win. Re-parent into
  `document.fullscreenElement` on `fullscreenchange`, in a Shadow DOM to block site CSS.
- **MV3 bans remote code execution** — the sync server may ship JSON only. A design where adapters
  are hot-patched from the server is off the table; adapters ship in the bundle.
- **Store policy:** `<all_urls>` draws review scrutiny on both stores. Prefer
  `optional_host_permissions` + `chrome.permissions.request()` at point of use.

## 10. Server shape

- **Self-host friendliness is a feature.** SyncTube (zero dependencies, single container) rates
  9/10; OTT (hard Redis dependency) rates 5/10. D2 says we follow SyncTube's deployment story.
- **Skip horizontal scaling for v1.** OTT's Rust balancer (gossip over WS, monotonic `load_epoch`
  tiebreak, `crates/ott-balancer/src/balancer.rs:335-408`) is well-designed and irrelevant to us
  until we have more rooms than one process holds. Note it as a future pattern.
- **Room state in memory**, per-room mutex, 3-minute idle expiry is the VideoTogether shape and
  it is fine.

## 11. What no reference solves — we design these from scratch

1. **Background-tab timer throttling.** Backgrounded tabs get `setInterval` clamped to ~1 Hz, which
   degrades the sync loop exactly when a user has the video in another tab. Neither cytube nor
   watchparty handles it. Needs Page Visibility API and/or Web Worker timers.
2. **Monotonic sequence numbers on the wire** (§5) — required by our optimistic apply, absent
   everywhere.
3. **Readiness-gate timeout** (§6) — every reference can be hung by a permanently-buffering member.
4. **Shadow DOM piercing + SPA element-replacement observer** (§8).
5. **Moderation without a host role.** Both OTT and SyncTube gate kick/ban behind an elevated role
   we deliberately do not have (D4). See §13 — this is now a stated v1 server requirement, not a
   deferred question.
6. **RTT-compensated clock sync combined with a host-less room** — each half exists somewhere, the
   combination exists nowhere.

## 12. Verification backlog (things we believe but have not proven)

| Claim | Status | How to settle |
|---|---|---|
| Laftel works via the generic adapter | CONFIRMED by one blog, my own probe inconclusive | headless browser + real session |
| Netflix internal API still exists in 2026 | UNVERIFIED, last evidence ~2020 | out of v1 scope; test if added |
| Disney+/Prime/Wavve/TVING generic-adapter support | LIKELY, no primary source | smoke test each |
| Firefox MV3 background can hold a WebSocket like Chrome | UNVERIFIED — different lifetime model | build a spike, measure |
| watchbear's mechanisms | from decompiled CRX, not source | treat as inspiration, re-derive |

## 13. Room access control is the *only* access control (v1 requirement, not an open question)

With no host and an unguessable room URL, **anyone holding the URL can seek the room at will** —
including someone it was forwarded to. There is no role that can remove them. That makes the room
URL not a convenience but the room's entire security boundary, which makes it a **Go server design
requirement under D2**, not a UX detail to settle later.

v1 assumptions the server model must account for:

1. **Room IDs are unguessable** — >=128 bits of CSPRNG entropy, not sequential, not short codes.
2. **Room URLs are rotatable.** Any member can rotate the room's join secret; existing members keep
   their session, anyone reconnecting with the old secret is refused. This is the no-host
   replacement for "kick": you rotate and re-share with the people you meant to include.
3. **Per-member command rate limiting**, server-side. Not anti-malice — anti-accident: a stuck
   adapter or a reconnect storm must not be able to flood the room. Reuse cytube's constants as a
   starting point (see `research/cytube-watchparty.md` section 12).
4. **Rooms expire.** In-memory, idle-expiry on the VideoTogether model (3 min after last member).
   No persistence means no long-lived leaked URL.

What we explicitly do **not** build in v1: kick, ban, mute, roles, or any moderation hierarchy.
Rotation plus expiry is the honest answer for "friends who already know each other".

## 14. Note on `refs/`

`refs/` is 164 MB of gitignored shallow clones on a filesystem at 91% capacity. **They are not
durable and nothing should assume they persist.** All findings above are cited `file:line` against
them, so re-clone before re-verifying a citation. Reproduce with:

```
git clone --depth=1 --single-branch <url> refs/<name>
```

| dir | url |
|---|---|
| VideoTogether | https://github.com/VideoTogether/VideoTogether |
| syncplay | https://github.com/Syncplay/syncplay |
| syncwatch | https://github.com/Semro/syncwatch |
| opentogethertube | https://github.com/dyc3/opentogethertube |
| cytube | https://github.com/calzoneman/sync |
| watchparty | https://github.com/howardchung/watchparty |
| watchbear | https://github.com/halitsever/watchbear (landing page only — extension source is not published) |
| SyncTube | https://github.com/RblSb/SyncTube |
| jellyfin-syncplay | https://github.com/jellyfin/jellyfin (sparse: `Emby.Server.Implementations/SyncPlay`, `MediaBrowser.Controller/SyncPlay`, `MediaBrowser.Model/SyncPlay`, `Jellyfin.Api/Controllers/SyncPlayController.cs`) |
