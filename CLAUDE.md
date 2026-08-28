# VideoSync

Self-hostable video sync (Netflix-Party-class) for arbitrary OTT sites. Users watch the *same URL
on their own accounts*; only playback state and chat cross the wire.

**Hard non-goal, never negotiate it away:** no screen capture, no stream relay, no media proxying.
Only URL + position + play state + chat. Every participant must independently hold legal access to
the media. If a request seems to want capture/relay, it is out of scope — say so.

## Authority documents — read before designing anything

| Doc | What it is |
|---|---|
| `docs/DECISIONS.md` | **Locked constraints.** Inputs, not open questions. Changing one needs an explicit decision from the user. |
| `research/SYNTHESIS.md` | **The design.** 9 reference implementations distilled per sub-problem, with the reasoning and citations. The single most useful file in the repo. |
| `docs/PROTOCOL.md` | Wire protocol spec. Derived from SYNTHESIS; keep them consistent. |
| `docs/BROWSER-FINDINGS.md` | What a real browser actually does. §7 is the full-stack run. |
| `research/*.md` | Per-reference deep dives, cited `file:line` into `refs/`. |

Do not re-derive a decision that SYNTHESIS already argued. Do not silently contradict DECISIONS.

## The design in six lines

1. Server owns a UTC timebase; clients measure offset via **min-RTT** sampling (§1).
2. Commands carry a **future `when`** so everyone transitions at the same instant (§2).
   Delay is `clamp(2 x p95_ping, 500ms, 2000ms)` — capped, because there is no host.
3. Local seek detection is **poll-based with a two-diff test** (§4b), events only *trigger* the
   same evaluation. High-Hz local eval → immediate report on anomaly → ~1 Hz heartbeat.
4. Position reports **judge clients, they never move the room** (§4c). The anchor is truth.
5. Correction type is chosen by (offset, d(offset)/dt): ignore / rate-nudge / hard-seek /
   readiness-gate (§3, §4c, §6).
6. No host. Server-assigned monotonic `seq` + per-room mutex resolve conflicts (§5).

**Start here:** `docs/STATE.md` says what is done, what is next, and which earlier claims were
corrected. Read it before picking up work.

## Traps that cost real time to rediscover

- **`seq`/ack collision.** The server excludes the sender from the state *broadcast* but MUST still
  send that sender a direct `ack{seq, appliedState}`. Without it the sender's `lastAppliedSeq`
  never advances and it cannot distinguish stale from fresh. See SYNTHESIS §5 amendment.
- **Echo suppression is layered on purpose** (§4). The two-diff detector makes it structural; the
  `applyingRemote` timeout flag is a *backstop only*. Never make a timeout flag load-bearing —
  syncwatch shipped that and it deadlocks silently (`content.ts:87-104`).
- **Seeks must be confirmed, not assumed.** Seeking outside the MSE buffered range does not throw,
  it stalls into `waiting`. `seekTo()` is async and resolves on `seeked`.
- **`play()` can reject with `NotAllowedError`** and nothing exposes the Media Engagement Index.
  Needs a typed error + a "click to sync" gesture-capture overlay.
- **`refs/watchbear` has no extension source** — its findings come from a decompiled Chrome Web
  Store CRX and are tagged `[CRX]`. Treat as inspiration, re-derive before relying on it.
- **MV3 bans remote code.** Adapters ship in the bundle; the server may send JSON only.
- **MAIN and ISOLATED worlds share `window`/origin**, so `event.origin`/`event.source` authenticate
  nothing in the bridge. Per-load nonce is mandatory.
- **The browser pauses a hidden tab whose playback was never audible**, firing a real `pause`.
  Broadcast naively it pauses the whole room. The trigger is "never made a sound", NOT "currently
  muted" — a tab that was audible is exempt for its lifetime. (`BROWSER-FINDINGS.md` §5.)
- **Media does not load in a hidden tab at all** — `loadedmetadata` never fires, so preparation
  hangs rather than failing.
- **A client on a stale anchor reports `residual == 0`** while arbitrarily out of position, because
  the residual is measured against that same stale anchor. `lastAppliedSeq` is the only signal;
  resend state when it lags. Worth 115 603 ms -> 250 ms.
- **No single metric scores a strategy.** Inter-client spread rewards a strategy that does nothing.
  `anchorErr` fixes that but **excludes a stalled client by construction**, so a room that leaves a
  buffering member behind and later yanks them forward scores *well* on it. Use `anchorErr` for
  alignment and `SkippedMs` (forward displacement imposed on a member = media they never saw) for
  what the room cost somebody. Ranking the readiness gate on `anchorErr` alone would have concluded
  it does nothing (10 ms vs 65 ms) while it was preventing 14.5 s of skipped media.
- **Every millisecond field on the wire is an `int64`.** `performance.now()` is fractional; sending
  `{"t":"time","t0":874.47}` gets `bad_frame` and the session stays joined while the clock never
  settles and no correction ever fires. Round at the wire boundary.
- **The server MUST have TLS.** From an https page a script can reach neither `http://` nor
  `ws://` on your server — both are blocked as mixed content, and the blocked call never settles,
  so it looks exactly like a server that is down. `http://localhost` being "potentially
  trustworthy" governs whether that page IS a secure context; it does not exempt it as a
  subresource of an https page. (`BROWSER-FINDINGS.md` §8.)
- **A userscript or content script is ALWAYS on a different origin from the server**, so every
  `/api/rooms` call is cross-origin and needs CORS. Without it the browser succeeds at the request
  and then refuses to let the script read it — `TypeError: Failed to fetch`, naming nothing.
  The WebSocket upgrade is not subject to CORS; it uses the `Origin` allowlist.
- **`@grant none` puts a userscript in the page context**, where the site's CSP governs its
  WebSocket. No OTT site's `connect-src` lists your self-hosted server. Grant any GM API.
- **Exact-value assertions on one seed are coin flips.** Two regression tests asserted "exactly 0"
  and had been passing on seed 5's luck; the property holds in ~2/3 of seeds either way. Assert the
  comparison, average over seeds, keep the control (POC-FINDINGS §39).
- **A `hello` never changes room state.** Only the first member's `mediaKey` names the media, and
  only while the room is empty. Any later change is a `media` command — it takes a `seq` and
  reaches everyone. Mutating the anchor on a join is invisible to the members already in the room.
- **In-buffer seeks are ~free; out-of-buffer seeks cost a segment fetch and rebuffer.** The choice
  is about price, not about the size of the error.

## Layout

```
server/          Go. Sync server + the Risk-A simulation harness (shares the sync core).
client/core/     Platform-agnostic TS: adapters, detector, sync engine, protocol client.
                 MUST NOT import browser-extension APIs — both shims depend on it.
client/userscript/  Tampermonkey shim. Ships. Also the cheapest way to validate the adapter layer.
client/extension/   Chrome MV3 + Firefox shim. Deliberately last — highest platform risk.
harness/browser/    Risk-B: local page with a real <video> for detector/adapter testing.
refs/            Gitignored shallow clones of the 9 references. NOT durable —
                 reproduce from the URL table in SYNTHESIS §14.
```

## Working here

- `mise` provides the toolchain (go, node), pinned in `mise.toml`. `mise run test`, `mise run sim`.
- Go module/package caches live in `.cache/` inside the project — the host FS runs tight on space.
- The repo is git-tracked; `refs/`, `.cache/`, `node_modules/` are ignored.

## PoC sequencing (why the extension is not first)

Risk is split so the expensive half is validated last:

- **Risk A — does the algorithm converge?** `server/cmd/simharness`: N simulated clients with
  injectable jitter, latency asymmetry, stalls, clock skew. No browser, deterministic. Strategies
  are swappable behind interfaces so competing policies can be *measured*, not argued about.
- **Risk B — does it survive a real browser?** `harness/browser/` then the userscript against
  Laftel/YouTube. The userscript is not a spike — it is the shipping target from D5 with no MV3
  service-worker exposure, so it validates the adapter layer at the lowest cost.

Run A before writing any browser code.
