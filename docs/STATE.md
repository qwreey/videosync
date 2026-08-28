# Where this project is

Checkpoint after the research + Risk-A + Risk-B phases. Written so a session with no memory of the
work can continue without re-deriving anything.

## Status by phase

| phase | state |
|---|---|
| Research (9 reference implementations) | **done** — `research/SYNTHESIS.md` |
| Risk A — does the algorithm converge? | **done** — `server/`, 8 rounds in `docs/POC-FINDINGS.md` |
| Risk B — does it survive a real browser? | **partly done** — `harness/browser/`, `docs/BROWSER-FINDINGS.md` |
| Client core (adapter, detector, clock) | **done and browser-validated** — `client/core/` |
| Sync server (Go, WebSocket, rooms) | **not started** ← next |
| Userscript shim | not started |
| Extension shim | not started (deliberately last) |

## What exists and works

- `server/internal/sync` — anchor, correction strategies, `ServoCorrector` (the chosen one).
- `server/internal/sim` — deterministic virtual-clock simulation, 11 scenarios, 4 strategies.
  `mise run sim`. Runs are byte-identical across invocations; keep it that way.
- `server/internal/sim/regression_test.go` — every finding pinned, each with a **control** proving
  the scenario still reproduces the bug it guards against. `mise run test`.
- `client/core` — `Html5Adapter`, `SeekDetector`, `ServerClock`. Written without TS parameter
  properties so `node --experimental-strip-types` runs it with no build step. 11 unit tests.
- `harness/browser` — pinned container (chromium + ffmpeg + Xvfb), a media server that can starve
  the player on demand, and probes. `mise run probe` runs the end-to-end detector validation.

## The next task, concretely

**Build the Go sync server** (`server/cmd/videosyncd`), sharing `internal/sync` with the simulation
so the algorithm cannot drift between them.

1. WebSocket transport + the frame types in `docs/PROTOCOL.md`.
2. Room model per SYNTHESIS §13: ≥128-bit CSPRNG id, **rotatable join secret** (the no-host
   replacement for "kick"), per-member command rate limiting, in-memory with idle expiry.
3. Per-room mutex; server-assigned monotonic `seq`; sender excluded from the broadcast but **always
   acked with `{seq, anchor, when}`** — see the traps below.
4. `GET /GetUtcTime`-equivalent over the same socket (two timestamps; the client does the math).
5. Wire `ServoCorrector` in as the judge, plus the stale-anchor resend.
6. Then point the simulation's transport at the real server so the same core is exercised both ways.

After that: the userscript shim (cheaper of the two shipping targets, no MV3 service-worker risk),
then the extension.

## Open questions that block things

- **Is `playbackRate` nudging safe on the providers we target?** The whole servo design leans on
  it. Unmeasured on Laftel/YouTube. If it is not safe there, the correction law needs a seek-only
  fallback path and the strategy comparison must be redone.
- **Laftel** rests on one blog post plus the generic-adapter assumption. Needs a live smoke test
  with a real session.
- **Firefox MV3 holding a WebSocket** — unverified, different lifetime model from Chrome.

## Claims that were corrected — do not reintroduce them

Two published conclusions turned out to be wrong and were fixed. Both are the kind of thing that
gets re-derived incorrectly:

1. **"Chrome pauses a hidden *muted* tab."** Wrong. It pauses a hidden tab whose playback has
   **never been audible**; a tab that made a sound is exempt for its lifetime, and the exemption
   survives reloading the element. The wrong rule would have suppressed genuine user pauses.
   (`docs/BROWSER-FINDINGS.md` §5.)
2. **"Never seek outside the buffered range."** Too absolute. An out-of-buffer seek costs one
   segment fetch; *not* seeking costs `gap / 0.10` of audibly wrong playback, which is minutes for
   a large gap. The rule is which correction is cheaper. (`docs/POC-FINDINGS.md` §35.)

Also: `MeanDivergenceMs` (inter-client spread) **rewards inaction** — a strategy that does nothing
scores 0 when clients start aligned. Rank on `anchorErr` (error against true server time), never on
spread. Rounds 1–6 were partly scored on the wrong metric.

## Environment notes

- The host's package manager state is **not persistent**. Anything installed with `pacman`
  disappears on a host update — that is why the browser harness is containerised.
- Toolchain comes from `mise` (`go 1.27.0`, `node 26.8.1`), which does persist.
- `refs/` is 164 MB of gitignored clones, reproducible from the URL table in SYNTHESIS §14.
- Container needs `--shm-size=1g`; Chrome's renderer hangs on the default 64 MB `/dev/shm`.
