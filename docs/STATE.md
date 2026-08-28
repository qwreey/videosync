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
| Sync server (Go, WebSocket, rooms) | **done except the readiness gate** — `server/cmd/videosyncd` |
| Readiness gate — *enforcement* | **not started** ← next |
| Userscript shim | not started |
| Extension shim | not started (deliberately last) |

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
- `client/core` — `Html5Adapter`, `SeekDetector`, `ServerClock`. Written without TS parameter
  properties so `node --experimental-strip-types` runs it with no build step. 11 unit tests.
- `harness/browser` — pinned container (chromium + ffmpeg + Xvfb), a media server that can starve
  the player on demand, and probes. `mise run probe` runs the end-to-end detector validation.

`mise run test` runs the Go and TS suites.

## The next task, concretely

**Make the readiness gate actually gate.** Today it is announce-only: the server tracks the waiting
set, opens and closes it correctly, expires it on `GATE_TIMEOUT` and releases it when a member
leaves — but `OnCmd` never consults it and no client acts on the frame. The server says who it
would wait for and then does not wait. `docs/PROTOCOL.md` §6 carries the same warning.

1. Decide what "hold" means against the anchor. The room is a pure function of
   `{positionMs, atServerMs, paused}`; holding is a `paused` transition the *server* originates,
   which means a `seq` and a `state` broadcast with `by:"server"`, and a matching resume. Anything
   that stops playback without moving the anchor puts every member into a residual the corrector
   will then try to "fix".
2. Decide when it fires. Jellyfin gates on *every* transition; that turns one member's 200 ms
   rebuffer into a room-wide stutter. The measured alternative is to gate only a `play` or a
   `media` (the transitions where being unready is fatal) and let the corrector handle mid-playback
   buffering, which it already does well.
3. Make the sim's client model act on `gate` — it currently ignores the frame — and measure. The
   gate's *effect* is completely unmeasured; it is the one piece of the design with no number
   attached to it. Add a scenario where one member is chronically slow to buffer, and check the
   gate does not make the room worse than not gating at all.
4. Then wire it into the real server behind the same `room.Room` methods.

After that: the userscript shim (cheaper of the two shipping targets, no MV3 service-worker risk),
then the extension.

## Open questions that block things

- **Is `playbackRate` nudging safe on the providers we target?** The whole servo design leans on
  it. Unmeasured on Laftel/YouTube. If it is not safe there, the correction law needs a seek-only
  fallback path and the strategy comparison must be redone.
- **Laftel** rests on one blog post plus the generic-adapter assumption. Needs a live smoke test
  with a real session.
- **Firefox MV3 holding a WebSocket** — unverified, different lifetime model from Chrome.

## Known gaps in what is built

- **The readiness gate does not gate** (above). This is the only place where a doc describes a
  mechanism the code only half implements, and `PROTOCOL.md` §6 says so too.
- **Client identity does not survive a reconnect.** The server mints a fresh client id per
  connection, so a member who drops and returns is a new member: `Forget` discards their servo
  state and learned clock bias, and they reappear in the roster under a new id. The harness's
  `reconnect` scenario instead keeps identity across the drop, which is how the 115 603 ms → 250 ms
  stale-anchor number was produced. The server's behaviour is arguably the better one — `welcome`
  carries the current anchor, so there is nothing stale to resend — but here "the harness measures
  what ships" is weaker than it is everywhere else. If session resumption is ever added, that gap
  closes on its own.
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
