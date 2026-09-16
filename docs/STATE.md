# Where this project is

Written so a session with no memory of the work can continue without re-deriving anything.
Read this before picking up work, then `CLAUDE.md`'s "Traps" section.

## Status by phase

| phase | state |
|---|---|
| Research (9 reference implementations) | **done** — `research/SYNTHESIS.md` |
| Risk A — does the algorithm converge? | **done** — `server/internal/sim`, 10 rounds in `docs/POC-FINDINGS.md` |
| Risk B — does it survive a real browser? | **done for what we can reach** — `harness/browser/`, `docs/BROWSER-FINDINGS.md` |
| Client core (adapter, detector, clock) | **done and browser-validated** — `client/core/` |
| Sync server (Go, WebSocket, rooms) | **done** — `server/cmd/videosyncd` |
| Readiness gate — *enforcement* | **done and measured** — `docs/POC-FINDINGS.md` §38 |
| Userscript shim | **built and validated end to end** — `client/userscript/`, BROWSER-FINDINGS §7 |
| Live provider smoke test — YouTube | **done** — BROWSER-FINDINGS §8 |
| Live provider smoke test — Laftel | **done** — BROWSER-FINDINGS §14 (8/8): pause, rate, seek and per-episode `mediaKey` all hold |
| Two members, live, on Laftel | **measured and fixed** — BROWSER-FINDINGS §15–16: a gate that never released, and the presser now waits instead of jumping back |
| MV3 capability + service-worker lifetime | **measured** — BROWSER-FINDINGS §9, §10 |
| Extension shim | **built and validated end to end** — `client/extension/`, BROWSER-FINDINGS §11 (12/12) |
| Observability for a live session | **built and browser-validated** — `VideoSync.dump()`, `videosyncd -verbose` |

## What exists and works

- `server/internal/room` — the room: timebase, command serialization, judging, gating, chat.
  **Transport-neutral, and shared verbatim** by the simulation and the real server, so the
  algorithm cannot drift between what we measure and what we ship.
- `server/internal/sim` — deterministic virtual-clock simulation, 12 scenarios, 8 correction
  strategies, driving `room.Room` through a simulated network. `mise run sim`. Runs are
  byte-identical across invocations; keep it that way.
- `server/internal/sim/regression_test.go` — every finding pinned, each with a **control** proving
  the scenario still reproduces the bug it guards against.
- `server/internal/sync` — anchor and correction strategies. `ServoCorrector` is the one we ship.
- `server/internal/ws` — hand-rolled RFC 6455 server + a `wss` client dialer, stdlib only,
  14 frame-level tests.
- `server/internal/wire` — the `{"t":...}` JSON framing. Accepts client-originated types only.
- `server/internal/hub` — rooms, CSPRNG ids and rotatable secrets, cytube-derived rate limiting,
  idle expiry, CORS, the HTTP surface. 40 integration tests that assert **against the wire**,
  because the simulation's tests all passed while the `ack`-has-no-`when` bug was present.
- `server/cmd/videosyncd` — the binary. `mise run server`. `POST /api/rooms`, `GET /ws`,
  `GET /healthz`; `-tls-cert`/`-tls-key` for a real deployment; `-verbose` logs every frame in and
  out plus joins and leaves, which is how a local agent reads the server half of a live session. Three tests run the actual
  binary and ask whether it answers — a refactor once dropped `ListenAndServe` from the
  plaintext path and every handler-level test still passed.
- `client/core` — everything both shims share: `Html5Adapter`, `SeekDetector`, `ServerClock`,
  `SyncEngine` (the protocol client), media-key normalization, element resolution,
  `SwappableAdapter`, the `Panel` (`src/ui/`) and the shared wiring (`src/app/bootstrap.ts`).
  Written without TS parameter properties so `node --experimental-strip-types` runs it with no
  build step. 72 unit tests, plus 14 end-to-end tests that drive real engines over real WebSockets
  against a real `videosyncd` (`mise run test-e2e`). The engine keeps an always-on ring of the last
  250 wire frames; `VideoSync.dump()` returns it with everything else as one JSON object.
- `client/userscript` — the Tampermonkey bundle (`npm run build` → one IIFE, ~64 kB).
- `client/extension` — the Chrome MV3 build (`npm run build` → `dist/`, load unpacked).
  The service worker is a 1.7 kB frame relay; everything else runs in the content script.
  **The two shims differ in exactly three injected pieces** — storage, transport, and how a room
  gets created — and share `bootstrap.ts` verbatim.
- `harness/browser` — pinned container (chromium + ffmpeg + Xvfb), a media server that can starve
  the player on demand, and the probes behind every number in `docs/BROWSER-FINDINGS.md`. Results
  are committed under `harness/browser/results/`.

  | probe | what it answers | last run |
  |---|---|---|
  | `probe-detector.mjs` | the shipping detector against a real `<video>` (`mise run probe`) | 8/8 |
  | `probe-userscript.mjs` | the whole stack, two real browsers | 17/17 |
  | `probe-extension.mjs` | the same with the extension shim, `dump()` included | 12/12 |
  | `probe-youtube.mjs` | the real YouTube player | 9/9 |
  | `probe-laftel.mjs` | the real Laftel player, logged in, attached over CDP (not the container) | 8/8 — §14 |
  | `probe-laftel-room.mjs` | two members on Laftel: the `play` jump, pause, the gate | 10 trials — §15 |
  | `probe-csp.mjs` | can a page reach a private-address server? | no — §8 |
  | `probe-ext.mjs` | what an MV3 content script may do | §9 |
  | `probe-swlife.mjs` | does the worker hold a socket? | 10 min, both arms |
  | `probe-hop.mjs` | what the message port costs | p50 0.5 ms |
  | `probe-extperm.mjs` | are `host_permissions` needed? | no — 4/4 |

  `mise run probe-stack` stages the artifacts the full-stack probes need and runs the two big ones.

`mise run test` runs the Go and TS suites and typechecks both shims. `mise run build` builds them.

## The extension's shape, and why it is not what it looks like

One measurement decides the whole architecture (BROWSER-FINDINGS §9):

| | content script | service worker |
|---|---|---|
| has the DOM / the `<video>` | **yes** | no |
| can reach a server on loopback or your LAN, from an OTT page | **no** — the request never leaves the browser | **yes** |

The first reading of that was "so the engine moves into the worker and player
state crosses a message port on every evaluation". That was unnecessarily bad —
this design resolves position to tens of milliseconds and it would have put a
hop inside the measurement.

The constraint is only that the **socket** must live in the worker. Everything
else — adapter, detector, clock, engine — stays beside the `<video>` exactly as
in the userscript, and the worker is a **dumb frame relay**. No position ever
crosses the port; the hop sits inside the measured round trip, where min-RTT
sampling already accounts for it and it merely widens `uncertaintyMs` by half
the hop (measured: p50 0.5 ms, so ±0.25 ms against a 500 ms band).

It also means the worker holds **no session state**, so a teardown costs a
reconnect and nothing else — which the engine already knows how to do. That is
worth more than §10's measurement saying teardown does not happen, and it is
verified directly: the probe terminates the worker and checks the session
survives.

The extension asks for **no `host_permissions`** — measured, not assumed: the
worker reaches the server with an ordinary CORS request and `videosyncd` sends
`Access-Control-Allow-Origin: *`. The install prompt is `storage` plus the sites in
`content_scripts.matches`. The dependency is real though: a proxy in front of the
server that strips CORS headers would put the permission back.

## The next task, concretely

**Development moved to the user's own machine (2026-09-07)** so that the agent
and a logged-in browser session are on the same host. Relaying observations by
hand — read `status()`, expand it in DevTools, copy the fields, paste them —
was the binding constraint on the last two sessions, and it lost data every
time. Read "Measuring a live session" below before doing anything else; it
exists because of that.

### 0. Start here, locally

```bash
mise run test          # Go + TS + both shims' typecheck
mise run test-e2e      # 14 tests, real engines over real sockets against a real videosyncd

cd server && go build -o videosyncd ./cmd/videosyncd
./videosyncd -addr 127.0.0.1:8787 -verbose -idle-ttl 30m

cd client/extension && npm run build     # -> dist/, then chrome://extensions "Load unpacked"
```

Use the **extension**, not the userscript: its service worker can reach a server
on your own machine, so there is no domain, no certificate and no tunnel to
arrange (BROWSER-FINDINGS §8, §9). `-idle-ttl 30m` stops the room evaporating
three minutes after you close a tab mid-experiment.

The panel appears bottom-right on any page in `manifest.json`'s `matches`
(youtube.com, m.youtube.com, laftel.net). The server URL goes in its first
field; it is only saved once a join succeeds.

### Measuring a live session

Two halves, and the whole point is that neither needs anybody to read numbers
aloud.

**Client — `VideoSync.dump()`.** In DevTools pick the **"VideoSync"** context in
the console's context dropdown (the API lives in the content script's isolated
world; the page context cannot see it, by design), then:

```js
copy(VideoSync.dump())      // straight to the clipboard, paste it into a file
```

One JSON object: status, every `stats` counter, the clock, the current anchor,
the roster, the player's own state and capabilities, and **the last 250 wire
frames in both directions**. The trace is always recording — it is not behind a
flag — because every field bug so far has been one-shot and a trace you have to
enable first would have missed all of them. Validated in a real browser through
the real extension (`probe-extension.mjs`, 12/12).

**Server — `-verbose`.** Every frame in and out, plus joins and leaves, on
stdout, which an agent on the same machine can simply read. Without it the
server records nothing per connection, so "the client never sent it" and "the
server dropped it" are indistinguishable — that ambiguity cost a whole round of
guessing. Note the heartbeat bucket drops excess *silently* while the command
bucket answers `rate_limited`, so a missing `hb` in the log is not proof of
anything; a missing `cmd` is.

### 1. Laftel — answered (2026-09-16)

All three questions were measured with `harness/browser/probe-laftel.mjs`, through the
extension's own adapter, on a logged-in account: **8/8** (BROWSER-FINDINGS §14).
`pause()` sticks, `playbackRate` 1.1 is held (1.096× measured), `currentTime` writes stick, and
`mediaKey` changes per episode including across Laftel's in-app navigation. No Laftel-specific
adapter or `mediakey.ts` case is needed. Two things it showed that matter elsewhere: an in-buffer
seek on Laftel costs **~100 ms** with `readyState` at 1 throughout (not §2's ~20 ms), and a resume
often lands ~90 ms ahead of where it paused.

**How the session was set up, so the next one does not re-derive it.** The agent drives a
dedicated Helium profile over CDP instead of the user's own browser window — a window the agent
opened in the user's browser came up `document.visibilityState === 'hidden'`, and a hidden tab
loads no media at all (§5b). See "Environment notes" below.

### 1b. The `play` jump — measured, and fixed by making the presser wait

`harness/browser/probe-laftel-room.mjs`, two visible windows, same account (not refused), loopback
server so the lead is the 500 ms floor on every play (BROWSER-FINDINGS §15, §16).

Before: the presser's picture jumped **back ~650 ms** when their own play landed, they rewatched
~725 ms, and ended ~165 ms behind. The first run of the probe also found a **gate that never
released** — fixed in `room.go`, see §15.

The user chose (2026-09-16) to make the presser wait. **Built:** `holdLocalPlay` in the engine
re-pauses a locally started player at the anchor in a room of two or more, and it starts at `when`
with everyone (PROTOCOL §3 amendment). Live: no backward jump at landing in 20 trials, presser and
other member start within ~15 ms of each other, no correction seeks, pause unchanged. The presser
still ends ~100 ms behind — Laftel starts a just-seeked or briefly-played element 16–79 ms late
(§16) — which is inside the 500 ms band and deliberately not compensated.

Small things left from this, none blocking:

- ~~The gate flickers open for ~100 ms during every Laftel seek.~~ **Fixed:** an unready report
  with ≥ 1 s buffered is held back for up to 300 ms (`reportsDeferred`); 0 gate frames in the
  next live run (BROWSER-FINDINGS §16).
- A pause leaves any member within `seekToleranceMs` where they are, so the next play starts with
  that offset (the presser is re-aimed; the others are not). Measured 35–200 ms.
- The 500 ms floor itself is now only the length of the wait after pressing play. Whether it can
  come down is a question for a real two-person session over a real network, not for loopback.

### 2. Tampermonkey itself

Every browser measurement injected the bundle via CDP rather than through a real
userscript manager. For the CSP question that is the *pessimistic* side — a pass
there implies a pass in the sandbox — but `@grant`, `GM_setValue` and the panel
inside a real extension have never actually run.

**A userscript needs the server on a public address with a real certificate.**
Measured, not assumed: from a page on a public origin the browser refuses every
request to loopback or a private address, whatever the scheme, and the call
never settles — it looks exactly like a server that is down (§8).
`http://localhost` and `https://192.168.x.y` both fail. Use a domain with a
certificate, or a tunnel that gives you one:
`videosyncd -addr :443 -tls-cert fullchain.pem -tls-key privkey.pem`.

### 3. Then, in rough order of value

- **Joining should take you to the video (user request, 2026-08-31).** Today nothing ever
  navigates anybody: a joiner on a different page gets a mismatch notice whose only button is
  `이 영상으로 방 옮기기` — it moves the *room* to them. The intended flow is the invite link,
  which carries `location.href`; the user's own testing found that fragile ("url 이 낡아") and
  wants the Netflix-Party shape instead: **join by code in the widget, and the room takes you to
  what it is watching, with the link kept in sync as the room's media changes.**
  What makes this more than a button: **`mediaKey` is lossy on purpose** — `yt:abc`,
  `laftel:/player/45462/93304` — so the room cannot reconstruct a watch URL from it. The room
  would have to carry the real URL alongside the key, which touches `hello`, the `media` command,
  the anchor and `PROTOCOL.md`, and it needs a rule for what a *stale* URL means when the room has
  moved on. Deliberately backlogged, not built.
- **Firefox.** Deliberately not claimed: the manifest used to carry a gecko id
  while declaring `background.service_worker`, which Firefox has never shipped —
  the background would not have existed and every session would have died at the
  port. It needs a second manifest using `background.scripts`, and a real run.
- **A second provider adapter**, if Laftel turns out to need one. The seam is
  `ProviderAdapter` in `client/core/src/adapter/types.ts`; `Html5Adapter` is the
  generic implementation and so far it has been enough for YouTube.
- **Ads.** Nothing in the design knows about them. `supportsAdDetection` is a
  capability flag with no implementation, and a mid-roll on one member's stream
  is a divergence the corrector will fight rather than wait out.
- **Persistence**, if rooms outliving a restart ever matters. D2 keeps the
  zero-dependency path as the documented default, so this goes behind an
  interface or not at all.

## Open questions that block things

- ~~**Should the `play` presser wait instead of jump?**~~ **Done** — `holdLocalPlay`,
  BROWSER-FINDINGS §16.
- **Is the 500 ms `CMD_DELAY` floor right?** Now only the length of the wait after pressing
  play: pause carries no lead (POC-FINDINGS §40c), and since `holdLocalPlay` nobody's picture is
  pulled back by it either (BROWSER-FINDINGS §16). It is still a chosen safety margin, not a
  measured one, and the harness is insensitive to it by construction. Lowering it trades
  responsiveness against members on slow links starting late; that needs a real two-person
  session over a real network.

- ~~**Is `playbackRate` nudging safe?**~~ **Answered everywhere we ship.** hls.js held 1.1
  exactly (§7), YouTube held 1.1 for 10 s at 1.099× (§8), Laftel held it for 10 s at 1.096× (§14).
- ~~**Laftel**~~ — **answered**, BROWSER-FINDINGS §14.
- **Tampermonkey itself is unverified.** Everything measured on YouTube injected the bundle into
  the main world via CDP. That is the pessimistic side of the CSP question (a pass there implies a
  pass in the sandbox), but the `@grant` sandbox, `GM_setValue`, and the panel's behaviour inside a
  real extension have never been run.
- **Firefox is not supported at all**, and deliberately does not claim to be. Its MV3 wants
  `background.scripts`; it has never shipped `background.service_worker`, so with the manifest as
  written the background would not exist and every session would die at the port. Supporting it is
  a second manifest and a real run, not a field.

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
- **No licence has been chosen.** There is no `LICENSE` file, so the default is "all rights
  reserved" — probably not the intent for a self-hostable tool. `client/userscript/meta.txt`
  already declares `@license MIT` because a userscript metadata block conventionally has that
  field; that was filled in while writing the header, not decided. Needs the user.
- **`hub` has no persistence and no clustering.** Deliberate (D2): one process, in-memory, idle
  expiry. Two videosyncd processes do not share rooms.

## Claims that were corrected — do not reintroduce them

Four published conclusions turned out to be wrong. All are the kind of thing that gets re-derived
incorrectly:

1. **"Chrome pauses a hidden *muted* tab."** Wrong. It pauses a hidden tab whose playback has
   **never been audible**; a tab that made a sound is exempt for its lifetime, and the exemption
   survives reloading the element. The wrong rule would have suppressed genuine user pauses.
   (`docs/BROWSER-FINDINGS.md` §5.)
2. **"Never seek outside the buffered range."** Too absolute. An out-of-buffer seek costs one
   segment fetch; *not* seeking costs `gap / 0.10` of audibly wrong playback, which is minutes for
   a large gap. The rule is which correction is cheaper. (`docs/POC-FINDINGS.md` §35.)
3. **`MeanDivergenceMs` (inter-client spread) rewards inaction** — a strategy that does nothing
   scores 0 when clients start aligned. Rounds 1–6 were partly scored on it. Its replacement
   `anchorErr` has its own blind spot: it **excludes a stalled client by construction**, so a room
   that leaves a buffering member behind and later yanks them forward scores *well*. Use
   `anchorErr` for alignment and `SkippedMs` for what the room cost somebody
   (`docs/POC-FINDINGS.md` §38).
4. **"An https page cannot reach an http server, so TLS is mandatory."** The conclusion survived;
   the reason was wrong, and the wrong reason gives wrong advice. The binding constraint is the
   target's **address**: a public-origin page cannot reach loopback or a private address by *any*
   scheme, so adding TLS to a `localhost` server does not help. Mixed content was an assumption
   that happened to fit data taken only over `http`/`ws`. (`docs/BROWSER-FINDINGS.md` §8.)

## Stats whose meaning changed, so old numbers are not comparable

- **`lateApplies`** now counts only commands that were actually scheduled ahead
  (`when > emittedAt`). Since some commands deliberately carry no lead, leaving it alone would
  have made the counter read "every pause is late". Any figure quoted for it before 2026-09-07
  is on the old definition.
- **`StaleResends`** dropped sharply for a reason that is not a regression: the resend now waits
  for the command to have had time to arrive (POC-FINDINGS §40a), so the ones it used to emit
  against members that were merely mid-flight are gone. `asymmetry+cmds` 18 → 0.

## Notes on the harness numbers

`mise run sim` is deterministic and byte-identical run to run, and that property is the strongest
oracle available for refactors of the control loop — a behaviour-preserving change must produce an
identical diff. It is also sensitive: any change to *how much traffic crosses the network* re-rolls
every jitter draw, so the absolute numbers shift. That happened once deliberately, when the gate
started being broadcast. The regression tests threshold rather than pin exact values for this
reason.

## Environment notes

- **Local live sessions (2026-09-16).** Helium (`/opt/helium-browser-bin/helium`, Chromium 153)
  is the browser; do not open Chrome. The agent runs its own profile:
  `helium --user-data-dir=$PWD/.cache/helium-profile --remote-debugging-port=9222
  --load-extension=$PWD/client/extension/dist ...` — the user logged Laftel in there once, and
  the profile persists in `.cache/`. A fresh profile has **no Widevine**; copy
  `~/.config/net.imput.helium/WidevineCdm` into it. Helium ships uBlock Origin, which injects its
  own isolated worlds, so CDP code must pick the world named `VideoSync`
  (`Session.isolatedName` in `cdp.mjs`). The claude-in-chrome MCP also reaches the user's main
  Helium window, but a tab it opens there can be `hidden` and then loads no media.

- The host's package manager state is **not persistent**. Anything installed with `pacman`
  disappears on a host update — that is why the browser harness is containerised.
- Toolchain comes from `mise` (`go 1.27.0`, `node 26.8.1`), which does persist.
- `refs/` is 164 MB of gitignored clones, reproducible from the URL table in SYNTHESIS §14.
- Container needs `--shm-size=1g`; Chrome's renderer hangs on the default 64 MB `/dev/shm`.
- The Go server has **no dependencies**: `server/go.mod` has no `require` block and there is no
  `go.sum`. The WebSocket implementation is hand-rolled for that reason. Keep it that way unless
  there is a reason worth writing down.
