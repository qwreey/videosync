# VideoSync

Self-hostable video sync (Netflix-Party-class) for arbitrary OTT sites. Users watch the *same URL
on their own accounts*; only playback state and chat cross the wire.

**Hard non-goal, never negotiate it away:** no screen capture, no stream relay, no media proxying.
Only URL + position + play state + chat. Every participant must independently hold legal access to
the media. If a request seems to want capture/relay, it is out of scope — say so.

**Start here: `docs/STATE.md`.** It says what is done, what is next, and which earlier claims were
corrected. Read it before picking up work, then the Traps below.

## Authority documents — read before designing anything

| Doc | What it is |
|---|---|
| `docs/STATE.md` | Where the project is, what is next, and what was retracted. The handover document. |
| `docs/DECISIONS.md` | **Locked constraints.** Inputs, not open questions. Changing one needs an explicit decision from the user. Each carries a note on what measurement later found. |
| `research/SYNTHESIS.md` | **The design's reasoning.** 9 reference implementations distilled per sub-problem, with citations. Read its `### Amendment:` blocks — §4c's classifier table was falsified by measurement and replaced. Where it disagrees with STATE.md, STATE.md wins. |
| `docs/PROTOCOL.md` | Wire protocol spec. Derived from SYNTHESIS; keep them consistent. |
| `docs/POC-FINDINGS.md` | What the simulation measured, in the order it was measured. A log, not a summary — later sections overturn earlier ones. |
| `docs/BROWSER-FINDINGS.md` | What a real browser actually does. §7 and §11 are the full-stack runs (userscript, extension). |
| `research/*.md` | Per-reference deep dives, cited `file:line` into `refs/`. |
| `README.md` | For a person, not an agent: what this is and how to run it. |

Do not re-derive a decision that SYNTHESIS already argued — but check its amendments first, and
check STATE.md's "claims that were corrected". Do not silently contradict DECISIONS.

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
  nothing in the bridge. Per-load nonce is mandatory. *(Not currently load-bearing: the extension
  has no MAIN-world bridge — the generic adapter drives YouTube from the isolated world, and
  keeping `window.VideoSync` out of the page means a page cannot drive the extension. This trap
  applies again the moment a provider needs its page-context player API.)*
- **The browser pauses a hidden tab whose playback was never audible**, firing a real `pause`.
  Broadcast naively it pauses the whole room. The trigger is "never made a sound", NOT "currently
  muted" — a tab that was audible is exempt for its lifetime. (`BROWSER-FINDINGS.md` §5.)
- **Media does not load in a hidden tab at all** — `loadedmetadata` never fires, so preparation
  hangs rather than failing.
- **A client on a stale anchor reports `residual == 0`** while arbitrarily out of position, because
  the residual is measured against that same stale anchor. `lastAppliedSeq` is the only signal;
  resend state when it lags. A backstop, not a headline: a real reconnect gets a fresh `welcome`,
  so a stale anchor needs frames lost on a live connection — 123 770 ms -> 31 ms in that model
  (POC-FINDINGS §41f). The old "115 603 ms -> 250 ms" came from a reconnect that cannot happen.
- **No single metric scores a strategy.** Inter-client spread rewards a strategy that does nothing.
  `anchorErr` fixes that but **excludes a stalled client by construction**, so a room that leaves a
  buffering member behind and later yanks them forward scores *well* on it. Use `anchorErr` for
  alignment and `SkippedMs` (forward displacement imposed on a member = media they never saw) for
  what the room cost somebody. Ranking the readiness gate on `anchorErr` alone would have concluded
  it does nothing (10 ms vs 65 ms) while it was preventing 14.5 s of skipped media.
- **Every millisecond field on the wire is an `int64`.** `performance.now()` is fractional; sending
  `{"t":"time","t0":874.47}` gets `bad_frame` and the session stays joined while the clock never
  settles and no correction ever fires. Round at the wire boundary.
- **In Chromium, a public-origin page cannot reach a loopback or private address AT ALL** — any scheme, http and
  https and ws and wss alike. The request never leaves the browser (a permissive listener sees
  nothing, not even a preflight) and it hangs forever, so it looks exactly like a server that is
  down. The server needs a **public address with a real certificate**. An extension's **service
  worker is exempt**, which is the one thing the extension can do that a userscript structurally
  cannot. (`BROWSER-FINDINGS.md` §8, §9.) An earlier version of that section blamed mixed content;
  that was an assumption that fit the data, not a measurement. **Firefox does not block it** — an
  https page opened `ws://127.0.0.1` (§19; LAN addresses unmeasured).
- **A userscript or content script is ALWAYS on a different origin from the server**, so every
  `/api/rooms` call is cross-origin and needs CORS. Without it the browser succeeds at the request
  and then refuses to let the script read it — `TypeError: Failed to fetch`, naming nothing.
  The WebSocket upgrade is not subject to CORS; it uses the `Origin` allowlist.
- **`@grant none` puts a userscript in the page context**, where the site's CSP governs its
  WebSocket. No OTT site's `connect-src` lists your self-hosted server. Grant any GM API.
- **The anchor is truth about *pause state* too.** Nothing in the correction table can press play,
  so a client that ends up paused against a playing room stays there forever, reporting a growing
  residual and being seek-corrected. The client re-applies the anchor after `RECONCILE_AFTER`.
- **A detector must measure elapsed time, not assume its own interval.** Dead-reckoning a fixed
  `EVAL_INTERVAL` per call breaks the moment the loop runs off-cadence — a DOM event, a throttled
  tab, a busy page — and manufactures a seek that never happened.
- **Exact-value assertions on one seed are coin flips.** Two regression tests asserted "exactly 0"
  and had been passing on seed 5's luck; the property holds in ~2/3 of seeds either way. Assert the
  comparison, average over seeds, keep the control (POC-FINDINGS §39).
- **A `hello` never changes room state — not even the first one.** A room that names nothing is
  named by a `media` command with `ifMediaKey: ""` (compare-and-set, refused as `media_stale`
  without taking a `seq`), sent by the first member on media, who then seeds the room like a
  creator. Moving to the next episode is the same CAS against the old key. Mutating the anchor on a
  join is invisible to the members already in the room.
- **A newly found video's state is the site's, not the member's** (D8, `docs/design/acquire.md`).
  Autoplay, resume-from-history and the load algorithm all move the element without anyone
  pressing anything. Conform it to the room; only a gesture made *after the media epoch began*
  counts as intent — a next-episode click is still `isActive` when that episode autoplays
  0.75–2 s later. Bump the epoch synchronously on `emptied`/`loadstart`: a reused element is
  paused with **no `pause` event** and its `playbackRate` reset, and YouTube plays 1 ms after
  `emptied`. Laftel rewrites its resume position until ~0.5 s before `canplaythrough`, so conform
  at HAVE_FUTURE_DATA.
- **`acquiring` is false in a hidden tab, so a hidden member must be reported absent.** Judged as
  present, an unloaded hidden tab (readyState 0 — media never loads there) gates every `play` for
  30 s, and a hidden seeder is corrected to the placeholder anchor and seeds the room from 0. And
  no correction may move a member that has not acquired, visible or not.
- **The reconciler's wait must survive the room's corrections.** A paused member in a playing room
  is free-seeked about every 2 s — sooner than `RECONCILE_AFTER` — so a wait restarted by every
  apply never ends and the member stays paused forever. And a dropped connection hands back the
  nudge (`releaseRate`), or the player runs fast for the whole outage.
- **The end of media is a `pause` with `ended` set.** Never send it, and never re-apply play to an
  ended element (it restarts from 0).
- **Never collect a secret in the panel.** It lives in the site's DOM and key events are composed:
  a capture listener on `window` reads what is typed into a closed shadow root. Keys and passwords
  go into the server's own `/auth/login` tab.
- **A proxy vouches only where it gates** (D6). `/api/ticket` takes a device token only, because a
  gateway must leave it open; `/api/session` trusts a trusted proxy only with
  `X-VideoSync-Device`, which the preflight admits only for extension origins — otherwise any page
  on a network the gateway admits could mint a device token. And **a gateway's answer is not the
  server's**: only videosyncd's own JSON 401 may drop a device token. A redirect, a page served
  as the answer or a 401/403/407 means "log in in a tab"; a gateway's 5xx or a bare 404 is an
  outage, retried — read as a sign-in it strands every member (`gatewayWantsLogin`). Device tokens never go in `chrome.storage.local`, which content scripts
  read.
- **A provider descriptor is data, and its tier limits what it can do** (D7). Server- and
  user-supplied descriptors restrict only, make a host followable only if the user granted it, and
  replace a built-in (by id, host or `keyPrefix`) only with explicit consent. No regular expressions:
  a room member's `mediaUrl` must not be able to hang anyone's tab. `keyPrefix` and published key
  bodies are frozen — they are on the wire.
- **A member that has not applied the newest `seq` must not be judged.** It is still on the
  previous anchor, so its residual describes that disagreement and not drift — judging it anyway
  issues a "free seek" that yanks the room backwards right before the transition it already had
  scheduled. Lagging `lastAppliedSeq` means one of two things and the *only* thing separating them
  is whether the command has had time to arrive: past that, the anchor is stale and the answer is a
  resend; before it, defer. `CMD_DELAY` used to supply that grace implicitly; since some commands
  now carry no lead it comes from the member's own RTT. Getting the grace wrong is what made every
  pause draw a resend from every member (POC-FINDINGS §40a).
- **Simultaneity is only worth paying for while the clock is running.** A command that leaves the
  room *stopped* — `pause`, `media`, a `seek` onto a paused room — carries **no** `CMD_DELAY`, and
  `pause` anchors at the position the sender reported rather than where playback would have reached
  at `when`. Scheduling a pause into the future makes the person who pressed it jump forward into
  media they never saw, which is what `SkippedMs` counts, imposed on the one member who chose the
  transition. `play` and a seek during playback keep the full lead (POC-FINDINGS §40c,
  PROTOCOL §3 amendment).
- **A room of one schedules against nobody.** `CMD_DELAY` buys simultaneity between members; with
  one member the whole delay is spent making that member's own gesture wrong. `CmdDelay()` returns
  0 below two members (§40b).
- **In-buffer seeks are ~free; out-of-buffer seeks cost a segment fetch and rebuffer.** The choice
  is about price, not about the size of the error. "Free" means no fetch, not no time: on Laftel
  (Widevine) an in-buffer seek takes ~100 ms with `readyState` at 1 throughout
  (`BROWSER-FINDINGS.md` §14), and a report sampled inside it looks exactly like buffering.
- **Readiness is a fact about the report, not about the decision.** The gate used to be cleared
  only when the corrector said "nothing to do"; the servo says "nudge" for as long as it holds a
  rate bias, which a paused member never loses, so one transient unready report held every later
  `play` until that member left the room. Found live on Laftel (`BROWSER-FINDINGS.md` §15).
- **The `play` presser holds; nobody else does.** A local play in a room of two or more is sent and
  the element re-paused at the anchor until `when` (`holdLocalPlay`). Left playing, the presser was
  rewound by the whole lead when their own ack landed (~650 ms on Laftel). The re-pause is an
  applied transition — `applyingRemote` + `rebaseline(pos, paused)` — never a flag waiting for the
  ack, so a play the gate holds or drops just leaves a paused member in a paused room.
- **The extension's store only reads the keys it lists.** `content.ts` hydrates `chrome.storage`
  for a fixed `KEYS` list before anything can await; a key saved but not listed is written and never
  seen again. And its writes are async — anything that must survive a navigation awaits
  `store.flush()` first.
- **`mediaUrl` comes from another member; follow it only through `followableUrl`.** It must
  normalise to the room's `mediaKey` and be on a known provider or the current site. Only the room
  moving (join, `media`) takes a member there — their own navigation never is undone.
- **Firefox's MV3 background cannot open `ws://`.** It goes out as TLS (close 1015), `localhost`
  included, whatever the manifest CSP says. That is why the Firefox build is MV2. And a detector
  that treats "unready" as "stalled" swallows real seeks — a seek drops `readyState` itself;
  compare the held reference before re-baselining.
- **A position is only as good as the timeline it was read on.** `Cmd` carries no base `seq`, so a
  `pause` arriving inside another command's lead is anchored on the room's schedule
  (`Room.committedAt`), not on the sender's `positionMs`. And a `play` on an already-playing room
  writes an anchor projected to its own `when`: anything reading `r.anchor` before then sees a
  position up to `CMD_DELAY` in the future.
- **An empty local `mediaKey` means "this page names no media", never "not resolved yet".** The key
  comes from the URL. Such a page never follows a room, even a room that names nothing, and cannot
  create one.
- **The panel's shadow root is closed.** A room creator's secret sits in its input and is never in
  the URL. Reach it with `VideoSync.panelRoot()` from the isolated world; the Firefox probe uses the
  `local-ext.mjs` build, the only one that opens it.
- **The client assumes acks come back in the order it sent the commands** (`ownAck` drops every
  older unacked command). Whatever the hub does to deferred commands — folding, batching — it must
  apply the survivors in send order.
- **A change made while disconnected is only good against the room it was made in.** Send it after
  the `welcome` only if `seq` and the anchor are what they were at the drop; otherwise the room
  moved and wins.
- **Continuation belongs to the page's descriptor, not to the key's prefix.** A single-label host
  (`http://nas`) mints generic keys under a bare name that looks exactly like a descriptor id.
- **`ws.Conn.ReadTimeout` is per frame.** Use `ReadBefore` for an absolute bound — every ping used to
  restart the wait for `hello`.
- **A fresh room's anchor is `paused@0`, and an already-playing creator never announces itself.**
  The detector reports play-state *transitions* only, so a member who was already playing when the
  room was created emits nothing: `cmdsSent` stays 0 while the room defends a position nobody is
  at, dragging the player back every `RECONCILE_AFTER` and nudging it in between — alone in the
  room. `adoptLocalStateOnJoin` (set only by the creator) seeds the room with `seek` then `play`.
  **Both commands, in that order:** `play` advances the anchor and clears `Paused` but carries no
  position (`room.go:346`), so adopting with `play` alone leaves the anchor at 0 and the fight
  continues in a subtler form.

## Layout

```
server/          Go. Sync server + the Risk-A simulation harness (shares the sync core).
client/core/     Platform-agnostic TS: adapters, detector, sync engine, protocol client.
                 MUST NOT import browser-extension APIs — both shims depend on it.
  src/app/, src/ui/   The wiring and the panel, shared VERBATIM by both shims. The shims
                 differ in three injected pieces: storage, transport, HTTP (`Platform.authFetch`).
client/userscript/  Tampermonkey shim. Ships. Needs the server on a public address (see Traps).
client/extension/   Chrome MV3 shim (dist/) and Firefox MV2 (dist-firefox/). Ships. Its background is
                 a frame relay and nothing else — the only way to reach a server on your own
                 machine from Chromium.
harness/browser/    Risk-B: a pinned container with a real Chromium, a media server that can
                 starve the player on demand, and the probes behind every measured number.
refs/            Gitignored shallow clones of the 9 references. NOT durable —
                 reproduce from the URL table in SYNTHESIS §14.
```

## Working here

- `mise` provides the toolchain (go, node), pinned in `mise.toml`. `mise run test` (Go + TS +
  both shims' typecheck + `local-media.test.mjs`), `sim` (`-- -seeds N` averages every row),
  `build`, `probe`, `probe-stack`, `test-e2e` (fails, not skips, if `videosyncd` will not build).
- Go module/package caches live in `.cache/` inside the project — the host FS runs tight on space.
- The repo is git-tracked; `refs/`, `.cache/`, `node_modules/` are ignored.
- **Live-run setup traps:** a Helium relaunched with `--load-extension` on a rebuilt, overwritten
  folder can keep an old cached service worker — load a probe build from a new folder
  (`NAME=<new> node harness/browser/local-ext.mjs`). Helium refuses CDP targets on
  `chrome-extension://` URLs; open extension pages with `chrome.tabs.create` from the worker. The
  probes write fixed result names; rename a new run instead of overwriting a cited file.
  MPRIS media keys: `busctl --user call org.mpris.MediaPlayer2.chromium.instance<PID>
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlayPause` (no `playerctl` here).

## PoC sequencing (why the extension is not first)

Risk is split so the expensive half is validated last:

- **Risk A — does the algorithm converge?** `server/cmd/simharness`: N simulated clients with
  injectable jitter, latency asymmetry, stalls, clock skew. No browser, deterministic. Strategies
  are swappable behind interfaces so competing policies can be *measured*, not argued about.
- **Risk B — does it survive a real browser?** `harness/browser/` then the userscript against
  Laftel/YouTube. The userscript is not a spike — it is the shipping target from D5 with no MV3
  service-worker exposure, so it validates the adapter layer at the lowest cost.

Run A before writing any browser code.

> **How that came out.** The sequencing held, but the reason for putting the extension last did
> not: MV3's service-worker lifetime turned out not to be the risk (`BROWSER-FINDINGS.md` §10), and
> the extension turned out to be the *only* way to reach a server on your own machine (§8, §9). It
> is now a thin wrapper sharing everything with the userscript. What the ordering actually bought
> was that all of that was discovered against working, measured code.
