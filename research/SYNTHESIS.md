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
   we deliberately do not have (D4). For "friends who already know each other" the honest answer is
   probably an unguessable room URL and per-member rate limiting, not moderation — but it is an
   open question, not a solved one.
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
