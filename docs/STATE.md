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
| Userscript shim | **not started** ← next |
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

**The userscript shim** (`client/userscript/`). It is the cheaper of the two shipping targets and
carries no MV3 service-worker risk, so it validates the adapter layer at the lowest cost — it is
also a shipping target in its own right (D5), not a spike.

1. A Tampermonkey bundle that pulls in `client/core` (adapter, detector, clock) and adds the
   protocol client: `hello`, min-RTT `time` sampling, scheduled application of `state`/`ack` at
   `when`, `hb` reporting, and applying `correct`.
2. Point it at a local `videosyncd` and a local page first (`harness/browser/page.html` already
   serves a real `<video>` with a controllable stall), then at YouTube, then at Laftel.
3. **Measure `playbackRate` on both providers while you are there** — it is the open question the
   whole servo design leans on, and the userscript is the cheapest place to answer it.
4. Only then the extension.

Two things the client must get right that the server cannot enforce:

- **Schedule against `ack.when` exactly like `state.when`.** The sender of a command is excluded
  from the broadcast, not from the scheduling. Getting this wrong is invisible to the sender and
  costs `CMD_DELAY` of divergence for everyone else.
- **Never let `applyingRemote` be load-bearing.** Echo suppression is structural (the two-diff
  test); the flag is a backstop only. syncwatch shipped a load-bearing timeout flag and it
  deadlocks silently.

## Open questions that block things

- **Is `playbackRate` nudging safe on the providers we target?** The whole servo design leans on
  it. Unmeasured on Laftel/YouTube. If it is not safe there, the correction law needs a seek-only
  fallback path and the strategy comparison must be redone.
- **Laftel** rests on one blog post plus the generic-adapter assumption. Needs a live smoke test
  with a real session.
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
