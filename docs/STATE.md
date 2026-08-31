# Where this project is

Written so a session with no memory of the work can continue without re-deriving anything.
Read this before picking up work, then `CLAUDE.md`'s "Traps" section.

## Status by phase

| phase | state |
|---|---|
| Research (9 reference implementations) | **done** — `research/SYNTHESIS.md` |
| Risk A — does the algorithm converge? | **done** — `server/internal/sim`, 8 rounds in `docs/POC-FINDINGS.md` |
| Risk B — does it survive a real browser? | **partly done** — `harness/browser/`, `docs/BROWSER-FINDINGS.md` |
| Client core (adapter, detector, clock) | **done and browser-validated** — `client/core/` |
| Sync server (Go, WebSocket, rooms) | **done** — `server/cmd/videosyncd` |
| Readiness gate — *enforcement* | **done and measured** — `docs/POC-FINDINGS.md` §38 |
| Userscript shim | **built and validated end to end** — `client/userscript/`, BROWSER-FINDINGS §7 |
| Live provider smoke test — YouTube | **done** — BROWSER-FINDINGS §8 |
| Live provider smoke test — Laftel | **blocked on a real session** ← needs the user |
| MV3 capability + service-worker lifetime | **measured** — BROWSER-FINDINGS §9, §10 |
| Extension shim | **built** — `client/extension/`, validated in two real browsers |

## What exists and works

- `server/internal/room` — the room: timebase, command serialization, judging, gating, chat.
  **Transport-neutral, and shared verbatim** by the simulation and the real server, so the
  algorithm cannot drift between what we measure and what we ship.
- `server/internal/sim` — deterministic virtual-clock simulation, 11 scenarios, 4 strategies,
  driving `room.Room` through a simulated network. `mise run sim`. Runs are byte-identical across
  invocations; keep it that way.
- `server/internal/sim/regression_test.go` — every finding pinned, each with a **control** proving
  the scenario still reproduces the bug it guards against.
- `server/internal/sync` — anchor and correction strategies. `ServoCorrector` is the one we ship.
- `server/internal/ws` — hand-rolled RFC 6455 server + a client dialer, stdlib only, 14 frame-level
  tests.
- `server/internal/wire` — the `{"t":...}` JSON framing. Accepts client-originated types only.
- `server/internal/hub` — rooms, CSPRNG ids and rotatable secrets, cytube-derived rate limiting,
  idle expiry, the HTTP surface. 30 integration tests that assert **against the wire**, because the
  simulation's tests all passed while the `ack`-has-no-`when` bug was present.
- `server/cmd/videosyncd` — the binary. `mise run server`. `POST /api/rooms`, `GET /ws`,
  `GET /healthz`.
- `client/core` — `Html5Adapter`, `SeekDetector`, `ServerClock`, `SyncEngine` (the protocol client),
  media-key normalization, element resolution, `SwappableAdapter`. Written without TS parameter
  properties so `node --experimental-strip-types` runs it with no build step. 51 unit tests, plus
  5 end-to-end tests that drive real engines over real WebSockets against a real `videosyncd`
  (`npm run test:e2e`, or `mise run test-e2e`).
- `client/userscript` — the shipping Tampermonkey bundle (`npm run build` -> 54 kB, one IIFE).
- `harness/browser` — pinned container (chromium + ffmpeg + Xvfb), a media server that can starve
  the player on demand, and probes. `mise run probe` runs the detector validation;
  `probe-userscript.mjs` runs the whole stack in two real browsers (17/17);
  `probe-youtube.mjs` drives the real YouTube player (9/9); `probe-csp.mjs` answers the
  mixed-content question. Results are committed under `harness/browser/results/`.

`mise run test` runs the Go and TS suites.

## The next task, concretely

Everything that can be validated without your accounts has been. The two things
left both need you:

### 1. Laftel — the last unmeasured provider (needs your session)

`research/provider-player-control.md` says the player is a plain scriptable
`<video>` on the strength of one Korean dev blog. Nothing has confirmed it, and
Laftel is a D1 priority provider.

```
cd client/userscript && npm run build     # -> dist/videosync.user.js
```
Install it in Tampermonkey, open a Laftel episode, and check three things in the
console via `window.VideoSync`:

- `VideoSync.mediaKey()` — does it differ per episode? The generic rule is
  `host:pathname`, which is an assumption for Laftel, not a measurement. If the
  episode is in a query parameter, `client/core/src/adapter/mediakey.ts` needs a
  rule the way YouTube has one.
- `VideoSync.adapter.setRate(1.1)`, wait 10 s, `VideoSync.adapter.readState().rate`
  — does Laftel's player reset it? YouTube does not (BROWSER-FINDINGS §8). If
  Laftel does, that provider's `supportsPlaybackRateNudge` goes false and the
  correction law needs a measured seek-only path.
- `VideoSync.adapter.seekTo(120)` — does a raw `currentTime` write stick, or does
  the player fight it the way Netflix reportedly does?

Record each as a number in `docs/BROWSER-FINDINGS.md`, not as an inference from
a capability flag.

### 2. Tampermonkey itself (needs your browser)

Every browser measurement so far injected the bundle into the main world via
CDP. That is the *pessimistic* side of the CSP question — a pass there implies a
pass in the userscript sandbox — but it means `@grant`, `GM_setValue`, and the
panel inside a real extension have never actually run. Install it and open two
profiles on the same YouTube video against a TLS-terminated server.

**Your server needs a public address AND TLS.** Measured, not assumed: from a
page on a public origin the browser refuses every request to loopback or a
private address, whatever the scheme, and the call never settles -- it looks
exactly like a server that is down (BROWSER-FINDINGS §8). `http://localhost` and
`https://192.168.x.y` both fail. Use a domain with a real certificate, or a
tunnel that gives you one. (An extension would not need this; a userscript
does.)

### The extension — built, and it IS a thin wrapper after all

It was sequenced last for platform risk. The measurements moved it from
"convenience" to **the only way to self-host on your own machine**:

| | content script | service worker |
|---|---|---|
| has the DOM / the `<video>` | **yes** | no |
| can reach a server on loopback or your LAN, from an OTT page | **no** — the request never leaves the browser | **yes** |

The first reading of that was "so the engine moves to the worker and player
state crosses a port on every evaluation". That was unnecessarily bad. The
constraint is only that the **socket** must live in the worker; everything else
— adapter, detector, clock, engine — stays beside the `<video>` exactly as in
the userscript, and the worker is a **dumb frame relay (1.7 kB)**. No position
ever crosses the port. The hop sits inside the measured round trip, where
min-RTT sampling already accounts for it and it merely widens `uncertaintyMs`
by half the hop.

It also means the worker holds no session state, so a teardown costs a
**reconnect** and nothing else — the engine already knows how to back off,
reconnect and throw a stale clock estimate away. That is worth more than §10's
measurement saying teardown does not happen.

`client/extension/` — `npm run build` → `dist/`, load unpacked. Two shims now
share `client/core/src/app/bootstrap.ts` verbatim and differ in exactly three
injected pieces: storage, transport, and how a room gets created.

Still to do there:
- **`host_permissions: ["<all_urls>"]`** is the blunt version. The worker needs
  it only to `POST /api/rooms` to whatever server the user configures. A
  store-ready build should use `optional_host_permissions` and request the one
  origin on the "방 만들기" click, which is a user gesture. Worth checking first
  whether it is needed at all: the server sends `Access-Control-Allow-Origin: *`,
  so a plain CORS fetch from the worker may already work with no host permission.
- **Firefox.** The manifest carries a `browser_specific_settings` id, but MV3
  there uses event pages rather than service workers, with a different lifetime
  model. Unverified.
- `content_scripts.matches` ships YouTube + Laftel, same as the userscript.

## Open questions that block things

- ~~**Is `playbackRate` nudging safe?**~~ **Answered for MSE and for YouTube.** hls.js held 1.1
  exactly (§7); the real YouTube player held 1.1 for 10 s and advanced 10.98 s of media in 10 s of
  wall clock (§8). Writing `currentTime` sticks on YouTube too. **Laftel is still unmeasured** and
  needs a session.
- **Laftel** rests on one blog post plus the generic-adapter assumption. Needs a live smoke test
  with a real session — the one open provider question, and it needs the user's account.
- **Tampermonkey itself is unverified.** Everything measured on YouTube injected the bundle into
  the main world via CDP. That is the pessimistic side of the CSP question (a pass there implies a
  pass in the sandbox), but the `@grant` sandbox, `GM_setValue`, and the panel's behaviour inside a
  real extension have never been run.
- **Firefox MV3 holding a WebSocket** — unverified, different lifetime model from Chrome.

## Known gaps in what is built

- **Client identity does not survive a reconnect.** The server mints a fresh client id per
  connection, so a member who drops and returns is a new member: `Forget` discards their servo
  state and learned clock bias, and they reappear in the roster under a new id. The harness's
  `reconnect` scenario instead keeps identity across the drop, which is how the 115 603 ms → 250 ms
  stale-anchor number was produced. The server's behaviour is arguably the better one — `welcome`
  carries the current anchor, so there is nothing stale to resend — but here "the harness measures
  what ships" is weaker than it is everywhere else. If session resumption is ever added, that gap
  closes on its own.
- **A member who has never reported counts as ready.** `Join` sets `ReadyState: 4`, so a `play`
  fired immediately after somebody joins is not gated even though they have buffered nothing. The
  alternative deadlocks: a member who never reports at all would hold the room until
  `GATE_TIMEOUT`. The common case is a friend joining and someone pressing play, so this is a real
  trade and not an oversight — if it turns out to matter, the fix is a short "joined, not yet
  heard from" grace state rather than treating silence as unready.
- **`hub` has no persistence and no clustering.** Deliberate (D2): one process, in-memory, idle
  expiry. Two videosyncd processes do not share rooms.

## Claims that were corrected — do not reintroduce them

Three published conclusions turned out to be wrong. All are the kind of thing that gets re-derived
incorrectly:

1. **"Chrome pauses a hidden *muted* tab."** Wrong. It pauses a hidden tab whose playback has
   **never been audible**; a tab that made a sound is exempt for its lifetime, and the exemption
   survives reloading the element. The wrong rule would have suppressed genuine user pauses.
   (`docs/BROWSER-FINDINGS.md` §5.)
2. **"Never seek outside the buffered range."** Too absolute. An out-of-buffer seek costs one
   segment fetch; *not* seeking costs `gap / 0.10` of audibly wrong playback, which is minutes for
   a large gap. The rule is which correction is cheaper. (`docs/POC-FINDINGS.md` §35.)
3. **`MeanDivergenceMs` (inter-client spread) rewards inaction** — a strategy that does nothing
   scores 0 when clients start aligned. Rank on `anchorErr` (error against true server time), never
   on spread. Rounds 1–6 were partly scored on the wrong metric.

## Notes on the harness numbers

`mise run sim` is deterministic and byte-identical run to run, and that property is the strongest
oracle available for refactors of the control loop — a behaviour-preserving change must produce an
identical diff. It is also sensitive: any change to *how much traffic crosses the network* re-rolls
every jitter draw, so the absolute numbers shift. That happened once deliberately, when the gate
started being broadcast. The regression tests threshold rather than pin exact values for this
reason.

## Environment notes

- The host's package manager state is **not persistent**. Anything installed with `pacman`
  disappears on a host update — that is why the browser harness is containerised.
- Toolchain comes from `mise` (`go 1.27.0`, `node 26.8.1`), which does persist.
- `refs/` is 164 MB of gitignored clones, reproducible from the URL table in SYNTHESIS §14.
- Container needs `--shm-size=1g`; Chrome's renderer hangs on the default 64 MB `/dev/shm`.
- The Go server has **no dependencies**: `server/go.mod` has no `require` block and there is no
  `go.sum`. The WebSocket implementation is hand-rolled for that reason. Keep it that way unless
  there is a reason worth writing down.
