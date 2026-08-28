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
