# Risk-B findings — measured against a real browser

Chromium 151.0.7922.173, headless and headful under Xvfb. Harness in `harness/browser/`,
raw outputs in `harness/browser/results/`. Media is locally generated (`ffmpeg`), served by
`server.mjs`, which can starve the player on demand.

> **Environment:** everything runs in a pinned container (`harness/browser/Dockerfile`) — see
> **Reproducing** at the end. The earliest measurements (§1–§4) were taken with chromium/ffmpeg/Xvfb
> installed on the host with `pacman`; that state is not persistent, which is why the harness was
> containerised, and why those sections are the ones most worth re-running if a number ever looks
> wrong.

---

## 1. The stall signature is real — the detector design is validated

`docs/PROTOCOL.md` §4 gates seek detection on a signature that until now existed only in a model I
wrote. Observed on a real MSE player (hls.js), by delaying segment delivery mid-playback:

```
  t= 12940.0ms  ct=113.8639  paused=False rs=4  ahead= 0.156
  t= 13040.0ms  ct=113.9475  paused=False rs=2  ahead= 0.073   <-- freeze begins
  t= 13140.1ms  ct=113.9475  paused=False rs=2  ahead= 0.073
  ...                                                          (980 ms frozen)
```

`paused === false` with `currentTime` frozen, `readyState` dropping 4 → 2, and a `waiting` event.
**Exactly the assumed signature, and both halves of the guard fire.** The stall-inference work in
POC-FINDINGS §5 rests on solid ground.

## 2. Seek cost is entirely about whether the target is buffered

| segment delay | seek kind | `seeked` after | `readyState<3` | playback resumes |
|---|---|---|---|---|
| 0 ms | in-buffer | 1.0 ms | 0 ms | ~20 ms |
| 0 ms | out-of-buffer | 4.7 ms | 0 ms | ~20 ms |
| 50 ms | in-buffer | 1.1 ms | 0 ms | ~20 ms |
| 50 ms | out-of-buffer | 54 ms | 40 ms | 60 ms |
| 150 ms | in-buffer | 0.8 ms | 0 ms | ~20 ms |
| 150 ms | out-of-buffer | 155 ms | 140 ms | 180 ms |
| 400 ms | in-buffer | 1.2 ms | 0 ms | ~20 ms |
| 400 ms | out-of-buffer | 405 ms | 390 ms | 430 ms |

**An in-buffer seek is free (~20 ms) regardless of network conditions. An out-of-buffer seek costs
exactly one segment fetch, and rebuffers for that whole time.**

This reframes a design question. The simulation has been treating "hard seek" as uniformly
expensive and looking for ways to avoid it (POC-FINDINGS §19 flagged that seeks being *free* in the
harness flattered seek-based strategies — the truth is that they are free *sometimes*). The right
rule is not "avoid seeks", it is **"never seek outside the buffered range"**:

> **Superseded — that rule is too absolute** (`docs/POC-FINDINGS.md` §35). Not seeking is not free
> either: the ±10 % rate clamp closes only 100 ms of gap per second, so a gap of *G* costs
> `G / 0.10` of audibly wrong playback to absorb — minutes, for a large one. `tab-suspension`
> falsified it directly: a member returning from a 15 s suspension nudged for 150 s. The shipping
> rule is **which correction is cheaper**, and past `NUDGE_MAX_RESIDUAL` one segment fetch plainly
> is. The measurements in this section are unchanged and are what the cost comparison is built on.

- A correction landing inside `video.buffered` costs nothing and should be preferred over a nudge.
- A correction landing outside it costs a full rebuffer, which makes the client *more* out of sync
  before it gets better, and can start a seek → rebuffer → residual → seek loop.
- The client already reports `bufferedAheadS`. It should report the buffered *range*, and the
  corrector should treat in-range and out-of-range seeks as different actions.

These are the constants that parameterise the harness fix.

## 3. Autoplay rejection, confirmed

With Chrome's default policy, `video.play()` without a user gesture rejects:

```
NotAllowedError: play() failed because the user didn't interact with the document first.
```

Confirmed by accident, and worth the accident: the first measurement run produced nothing but
paused-element numbers because of it. The typed-error + gesture-capture-overlay requirement
(`CLAUDE.md`, Traps) is real, not defensive — it ships as `AutoplayBlockedError`
(`client/core/src/adapter/types.ts`), the engine's `onAutoplayBlocked`, and the panel's
"클릭해서 동기화" overlay.

## 4. Timer throttling: audible playback is the exemption, and Workers are the escape hatch

Headless Chrome **does not throttle at all** — `visibilityState` goes to `hidden` and timers stay at
100 ms even after 70 s. Any throttling measurement taken in headless is worthless. Headful under
Xvfb reproduces the real behaviour:

| tab state | `setInterval` | `setTimeout` chain | **Worker** |
|---|---|---|---|
| visible | 100 ms | 100 ms | 100 ms |
| hidden, **audible** | **100 ms** | 100 ms | 100 ms |
| hidden, muted | **1000 ms** | 1000 ms | **100 ms** |

Three consequences for the client:

1. **A tab playing audible media is exempt from timer throttling.** That is the normal watch-party
   case, so the ~10 Hz local evaluation loop that every client-authority claim depends on
   (POC-FINDINGS §19, third gap) survives in the case that matters most.
2. **A hidden muted tab is clamped to 1 Hz** — the feared case, and it is real. But see §5: a
   *never-audible* hidden tab is also paused outright by the browser, so for that case the client
   is not behind, it is absent. A tab that was audible and is now muted keeps playing **and** is
   throttled, which is the combination the `Worker` tick exists for.
3. **Worker timers are not throttled even then.** This is now measured rather than assumed, and it
   makes the local loop implementable as a Worker-driven tick for the muted case.

## 5. Chrome pauses a hidden tab's video — but only if it has NEVER been audible

**This section corrects an earlier, overstated version of itself.** The first measurement showed a
hidden *muted* tab being paused and concluded the trigger was `hidden && muted`. Building the
detector against that rule produced a test that would not reproduce, which forced a four-condition
experiment (`probe-bgpause2.mjs`):

| condition | result |
|---|---|
| A — muted **before** play, never audible | **paused** by the browser |
| B — played audibly, **then** muted, then hidden | keeps playing |
| C — media with **no audio track at all** | **paused** |
| D — audible throughout | keeps playing |

So the trigger is **"this playback has never produced sound"**, not "it is muted right now".
`hidden && muted` was wrong: it would have suppressed genuine pauses in case B.

The exemption is also **sticky at tab level**: once a tab has played audibly it stays exempt, and
reloading the element does not reset it. Reproducing case A requires a fresh browser.

### Observed behaviour in the vulnerable case

| | value while hidden |
|---|---|
| `paused` | **`true`** (the browser did it) |
| `readyState` | 4 |
| buffered ahead | 10.9 s — full |
| event on hide | **`pause`** |
| on re-show | resumes itself, fires `play` + `playing` |

### Why it is a protocol bug

The browser emits a **genuine `pause` event**, indistinguishable at the DOM level from the user
pressing pause. Broadcast naively:

- one member who started muted and switched tabs **pauses the entire room**;
- switching back emits `play` and **resumes it** — even a room someone deliberately paused.

The stall detector is not the defence: it only treats a freeze while `paused === false` as an
anomaly, and this freeze sets `paused === true`.

### The rule, as implemented

> Track whether the element has **ever been audible** (`!paused && !muted` observed at least once
> this playback). A `pause` while `document.hidden` on a never-audible playback, with
> `readyState >= 3` and a full buffer, is browser suspension. Never broadcast it; mark the member
> **suspended** and suppress the paired `play` on re-show.

`document.hidden` alone cannot be the test — media keys and the Media Session API deliver genuine
user pauses to hidden tabs.

A suspended member is **absent, not buffering**: the readiness gate must not hold the room for
them. The two are distinguishable by exactly the table above — suspension is `paused === true`
with `readyState` 4 and a **full** buffer; buffering is `paused === false` with `readyState < 3`
and a **draining** one.

## 5b. Media does not load at all in a hidden tab

Found while debugging a hang: calling `hls.loadSource()` in a tab that is not visible never
resolves — `loadedmetadata` does not fire. Any client that tries to prepare a stream while
backgrounded will hang rather than fail, so preparation must be deferred to visibility.

## 5c. The shipping detector, validated end to end

`probe-detector.mjs` runs the **actual bundled `client/core` detector** — not a model of it —
against a live `<video>` in the pinned container. All eight assertions pass:

| assertion | result |
|---|---|
| steady playback broadcasts nothing | 40/40 samples `idle` |
| a genuine user seek IS broadcast | one `seek` |
| a server-applied correction is NOT rebroadcast | 0 broadcasts — the two-diff rule works on a real element |
| a buffering stall is detected as a stall | 20 `stall` samples |
| a stall broadcasts nothing | 0 |
| a never-audible hidden tab is detected as suspension | 6 `suspended` samples |
| suspension broadcasts nothing | 0 |
| resuming from suspension broadcasts nothing | 0 |

Run it with `mise run probe`.

## 7. The whole stack, in two real browsers (`probe-userscript.mjs`)

Everything before this validated one layer against a model of the others: the
Go harness simulated clients, the engine tests scripted a transport, the
end-to-end Node test used a fake player. This run has no models left in it —
the shipped userscript bundle, byte for byte as a user would install it, in two
**separate** Chromium processes, on real MSE media, against a real
`videosyncd`.

Separate processes rather than two tabs, on purpose: a background tab is
throttled and — if its playback was never audible — paused outright by the
browser (§5), so two tabs would have re-measured §5 instead of measuring sync.
Non-overlapping windows plus `--disable-renderer-backgrounding` keep both
renderers foreground-live. That is a deliberate blind spot of this probe and
not a claim that backgrounding does not matter.

**17/17 checks pass.** `harness/browser/results/userscript-sync.json`.

| what | measured |
|---|---|
| two players after 4 s of synced playback | **20–50 ms apart** across runs (CDP sampling skew 1 ms) |
| loopback `bestRTT` through the real clock exchange | 0.1–0.6 ms |
| a pause on the element itself reaching the other browser | yes, and **0 commands** echoed back |
| a scrubber drag propagating | yes, other browser landed at 60.00 s |
| the readiness gate holding a `play` for a starved member | held; released on recovery |
| frames the server rejected as malformed | 0 |

### `playbackRate` is safe on a real MSE player — the servo's premise holds

The open question the whole servo design leans on. Asked for **1.1**; the
element **held exactly 1.1** and advanced **5.478 s in 5.0 s of wall clock**
(implied 1.096×) on hls.js/MSE with audio, with no rate reset and no audio
dropout.

Two things about *how* it is measured, both of which produced a wrong number
first:

- **Before joining a room.** The first version measured it while joined and read
  `0.994` for a requested `1.1` — the servo was nudging the rate at the same
  time. It was measuring the corrector, not the player.
- **After playback is confirmed to be advancing.** Starting the window when
  `play()` resolves includes the start-up stall; one run read `1.013` for a
  player that was faithfully doing 1.1. The probe now waits until `currentTime`
  is actually moving and measures over 5 s.

> Scope: this answers the *MSE-level* question, which is the one the design
> depends on. YouTube and Laftel wrap their own player logic around the element
> and could still reset the rate; that needs a real session and is still open.

### A cross-origin `fetch` was the first thing that broke

`POST /api/rooms` from the page failed with a bare `TypeError: Failed to fetch`.
The server had no CORS headers, and a userscript **always** runs on the OTT
site's origin, never on the sync server's — so every API call is cross-origin,
always. The request had actually succeeded; the browser just refused to let the
script read the response.

Only a real browser finds this. Every Go test passed, every Node test passed,
and the failure message named neither CORS nor the origin. Fixed with an
`Access-Control-Allow-Origin` that honours the same allowlist as the WebSocket
upgrade, plus preflight. (The WebSocket handshake itself is not subject to
CORS — it is governed by the `Origin` allowlist instead.)

### The corrector was shouting a rate the client already had

First run: **17 nudges to one member in a 20 s session**. A continuous control
law recomputes a rate on every report, so the server was sending a `correct` at
the report rate forever — and each one fires a `ratechange` on the very element
the detector is watching. Suppressing a rate the client is already holding
(within 0.001, re-stated every 5 s in case the unacknowledged `correct` that set
it was lost) took the same session to **4 and 5 nudges**, with the two players
still 20 ms apart.

## 8. YouTube, for real (`probe-youtube.mjs`, `probe-csp.mjs`)

One public page, driven the way the shipping userscript drives it. No account,
no download, no capture — if this were not allowed, neither would the product be.

### `playbackRate` is safe on YouTube. The servo's premise holds.

This was the largest open question in the project: the servo's frequency term is
half the correction law and it is the half that is immune to clock bias. If
YouTube's own player code reset the rate, that provider would need a measured
seek-only path and the whole strategy comparison would have to be redone.

| | |
|---|---|
| requested | **1.1** |
| immediately after | 1.1 |
| **after 10 s** | **1.1** |
| media advanced in 10 s of wall clock | **10.99 s** (implied **1.099×**) |

Ten seconds and not one, deliberately: a player that resets on its own timer —
a stats ping, a quality switch — would look fine at t+1 s.

### Writing `currentTime` sticks

Seek to 120 s, wait 2.5 s: element at **122.44 s**, `readyState` 4. YouTube does
not fight a raw DOM seek the way Netflix is reported to.

### The generic layer needed no YouTube-specific code

- `normalizeMediaKey` → `yt:aqz-KE-bpKQ` (the id, not the URL).
- `pickVideo` selected the player element on the real watch page.
- `Html5Adapter.play()` was accepted and the element advanced.

So D1's "YouTube via the generic adapter" holds, with no per-site adapter.

### The deployment constraint nobody would guess — and the first explanation was wrong

**What is true:** a page on a public origin cannot reach a server on
**loopback or a private address** at all. Not `http`, not `https`, not `ws`,
not `wss`. The request **never leaves the browser** — a permissive listener that
answers everything, CORS and `Access-Control-Allow-Private-Network` included,
sees **zero requests**, not even a preflight. It presents as an indefinite hang,
with no rejection and nothing naming a reason. It looks exactly like a server
that is down.

| from | to `127.0.0.1` `http` | `ws` | `https` | `wss` | to a public https host |
|---|---|---|---|---|---|
| `http://127.0.0.1:8899` (our test page) | works | opens | works | opens | works |
| `https://www.youtube.com` | **blocked** | **blocked** | **blocked** | **blocked** | **works** |
| the extension's **service worker** | **works** | see §9 | — | — | works |

> **Correction to the first version of this section.** It said the blocker was
> mixed content and concluded "TLS is mandatory". That was an assumption that
> happened to fit the data: only `http`/`ws` had been tested, and mixed content
> explains those. Adding `https`/`wss` to the same target — still blocked — and a
> public https host — reachable — shows the binding constraint is the **target's
> address**, not the scheme. Mixed content is presumably also true for the
> `http`-from-`https` case, but it was never isolated and this section should not
> have claimed it. TLS is still required for any public deployment; it is simply
> not what was being measured.

Consequences:

- **A userscript cannot talk to a server on your own machine or your LAN.** The
  server needs a public address and a real certificate — a domain plus
  Let's Encrypt, or a tunnel that provides one.
- **An extension can**, because its service worker is exempt (measured above).
  That turns the extension from a convenience into the only route to
  self-hosting on a home network, which is what D2 meant by self-hostable — and
  it moves the socket into the service worker, whose lifetime is §9's question.
- `videosyncd` still takes `-tls-cert`/`-tls-key`; the startup warning now names
  the address constraint rather than repeating the wrong explanation.

### What this run does NOT cover

- **No Tampermonkey.** The bundle was injected into the MAIN world via CDP.
  Note that the address block above is not something `@grant` can lift: it is
  enforced on the page's origin, and a userscript sandbox does not change which
  addresses a page may reach.
- **No public-address server of our own.** Mixed content per se is therefore
  still untested for our service; only the address block is measured.
- No Laftel (needs a session), no ads, no two-account room, no live SPA
  navigation between videos.

## 9. What an MV3 content script may do (`probe-ext.mjs`, `ext-probe/`)

Measured before writing any of the extension, because it decides its
architecture rather than its details.

| capability, from a content script on `https://www.youtube.com` | |
|---|---|
| `chrome.storage.local` | works |
| `fetch` to a public https host | works |
| `fetch`/`WebSocket` to `127.0.0.1`, any scheme | **blocked before the request is sent** |
| the same, relayed through the **service worker** | **works** |

The content script has the DOM but cannot reach a self-hosted server; the
service worker can reach it but has no DOM. So the **socket** has to live in the
worker.

> **This section originally continued "…and the player state has to cross a
> message port, which puts the session on MV3's service-worker lifetime". That
> was wrong, and it is worth keeping the retraction visible because the wrong
> reading is the obvious one.**
>
> Only the socket is forced across. Adapter, detector, clock and engine all stay
> beside the `<video>` exactly as in the userscript, and the worker is a dumb
> frame relay — **no position ever crosses the port**, and the worker holds **no
> session state**, so a teardown is a reconnect rather than a lost session.
> The extension is a thin wrapper after all: it differs from the userscript in
> three injected pieces. Measured in §11; the code says so at
> `client/extension/src/sw.ts` ("Deliberately not the engine").

## 10. Does an MV3 service worker hold a WebSocket? (`probe-swlife.mjs`, `ext-life/`)

The question §9 forces, and the reason the extension was sequenced last. If the
worker cannot hold a socket, "self-hostable on your own machine" and "browser
extension" are in tension and the product has to choose.

**It holds it, for ten minutes, with or without traffic.** On a YouTube tab,
against `ws://127.0.0.1`, two arms — one sending a client-shaped heartbeat every
10 s, one holding the socket and sending nothing:

| | traffic | silent |
|---|---|---|
| run length | 600 s | 600 s |
| distinct worker instances | **1** | **1** |
| socket closes | **0** | **0** |
| ticks fired / expected | 60 / 60 | 59 / 60 |
| **largest gap between consecutive ticks** | **10 002 ms** | **10 000 ms** |
| `readyState` at the end | 1 (OPEN) | 1 (OPEN) |

The tick interval is 10 s, so a largest gap of 10 000–10 002 ms means the timer
was never once late: the worker was continuously alive for the whole run. A
worker torn down and revived would show a new instance id and a reset module
state; a suspended one would show a gap. Neither happened in either arm.

The silent arm is the stronger result and the one that was not expected: an
**idle** WebSocket alone is enough. The shipping client heartbeats at 1 Hz, so
it is the traffic arm that describes reality — but the design does not depend on
that being true.

### Two things the measurement had to avoid measuring itself

- **Polling the worker keeps it alive.** Every `chrome.runtime.sendMessage` is
  activity and resets the idle timer, so a probe that asks the worker how it is
  doing has already answered its own question. After the initial start message
  the driver never speaks to the worker again: the worker writes its own log to
  `chrome.storage.local` and the content script reads it with
  `chrome.storage.local.get`, which does not wake it.
- **Module state is exactly what a teardown destroys**, so the log lives in
  storage and every entry carries the instance that wrote it.

One methodological bug worth recording because it produced a confident wrong
number: the first run reported `ticks: 0` for a worker that was ticking
perfectly. Two handlers were doing read-modify-write on `chrome.storage` at
once and the tick writes were being clobbered by the message writes they had
themselves caused. Serialising the log fixed it. The socket's own evidence — a
server reply arriving every ten seconds — had been in the log the whole time.

### What this does not settle

Ten minutes is not a film. Nothing here says what happens across a laptop
suspend, a network change, or an hour. It does not need to: the extension's
worker holds **no session state** — it is a frame relay — so a teardown costs a
reconnect, which the engine already does (back off, reconnect, throw the stale
clock estimate away). The measurement says the common case is not even that.


## 11. The extension, end to end (`probe-extension.mjs`, `probe-hop.mjs`, `probe-extperm.mjs`)

The same two-browser run as §7 with the shim swapped, plus the three checks only
this shim can answer. **11/11.**

| | |
|---|---|
| the service worker reached `http://127.0.0.1` **from a page that provably cannot** | yes — the whole reason this shim exists |
| two players after 4 s of synced playback, through the relay | **2–40 ms apart** across runs |
| `bestRTT` through the message port | **0.2–1 ms**, uncertainty ±0.1–0.5 ms |
| the page could see `window.VideoSync` | no — the isolated world holds |
| worker terminated mid-session (`Target.closeTarget`, verified gone) | **reconnect 0 → 1, session stayed joined, room still worked** |

That last row is the claim the architecture rests on: the worker holds no
session state, so a teardown is a reconnect and nothing more. An earlier version
of the check evaluated `close()` inside the worker — a no-op there — and passed
while proving nothing. It now closes the target and confirms it is gone before
asserting anything.

### The message port costs about half a millisecond

The hop sits inside the measured round trip, so it does not distort position —
it just widens `uncertaintyMs` by half of itself.

| | idle page | youtube.com |
|---|---|---|
| port round trip, p50 | **0.5 ms** | **0.4 ms** |
| p95 | 0.6 ms | 0.6 ms |
| p99 / max | 0.6 / 0.7 ms | 9 / **280 ms** |
| one-way (`Date.now()`, 1 ms granularity) | ≤1 ms | ≤1 ms |
| first hop after 15 s of silence | 0.5 ms | 0.5 ms |

Against a 500 ms tolerance band, half a millisecond is nothing. The 280 ms
outlier on a busy YouTube page is real but harmless *by construction*: the clock
takes the **minimum** RTT, so an outlier is discarded rather than averaged in —
which is the property min-RTT was chosen for in the first place (§1 of
PROTOCOL.md).

Two facts recorded because they would otherwise be assumed:

- **`performance.now()` is not comparable across contexts.** Content script and
  worker reported 33 505 ms and 65 526 ms at the same instant — different time
  origins. The design does not need it (the clock lives with the engine, in the
  content script), but a design that moved the clock into the worker would have
  to use `Date.now()`, which is wall clock and can step.
- **No cold-start penalty.** A hop after 15 s of silence costs the same as one
  after 50 ms, which fits §10: the worker is not being torn down.

### It needs no host permissions

The worker's only cross-origin need is `POST /api/rooms`, and `videosyncd` sends
`Access-Control-Allow-Origin: *`, so an ordinary CORS fetch suffices. Measured
both ways with the real build: room creation and the relayed socket both pass
with `host_permissions` removed entirely. The install prompt is `storage` plus
two sites rather than every site you visit.

The dependency is real: a proxy in front of the server that strips CORS headers
would put the permission back.

## 12. Laftel, in the field — NOT a probe measurement

The first real session against Laftel, extension shim, server behind a tunnel,
2026-08-31. **Everything here is an observation from a live session, not a
number from a probe**, so it is weaker evidence than §7–§11 and must not be
cited as if it were the same kind of thing. §12 exists because the session
happened before anyone could run `harness/browser` against Laftel, and losing
what it showed would be worse than recording it with its provenance attached.

| question | what the session showed | status |
|---|---|---|
| does `mediaKey` differ per episode? | `laftel:/player/45462/93304` — the generic `host:pathname` rule picks up both ids from the path | **likely answered**; the episode is not in a query parameter. Two different episodes were not compared side by side |
| does `seekTo` stick? | yes, demonstrably: the room's corrections dragged the player back to ~0 s repeatedly and it went | **answered.** A raw `currentTime` write is not fought |
| does Laftel reset `playbackRate`? | **unanswered.** `stats.correctionsNudge` climbing only proves `setRate` was *called* — nothing observed whether the rate was held | **still open**, needs the 10-second hold from `STATE.md` §1 |

The session also produced a real bug, from `VideoSync.status()` on a member
alone in a room: `cmdsSent: 0`, `expectedMs: 0`, `positionS` sawtoothing between
0.03 s and 0.73 s. See CLAUDE.md's trap on a fresh room's `paused@0` anchor —
`expectedMs` came back `0` rather than `null`, which proves the clock was
settled and made the diagnosis unambiguous.

## 13. The diagnostic path itself (`probe-extension.mjs`)

`VideoSync.dump()` is what a live session hands back instead of somebody reading
`status()` aloud, so it is checked in a real browser through the real extension
shim rather than only in the Node suite: **12/12**, with
`dump() returns parseable JSON with a live wire trace` reporting 17 traced
frames in 3870 bytes at the point it is called.

The trace is always on. Every bug this design has produced in the field was
one-shot — a room that fought its own creator, a pause that jumped — and a trace
that had to be switched on first would have missed all of them. It is bounded at
250 frames, asserted in the e2e suite.

The server half is `videosyncd -verbose`, tested through the real binary on real
stderr, because a diagnostic that silently records nothing is worse than none:
"the server saw no such frame" would look like evidence.

## Reproducing

<!-- Unnumbered on purpose: this is not a finding, and it lives at the end. The
     numbered sections are cited from other documents and from code comments, so
     they never get renumbered -- which is also why there is no §6. -->

Everything runs in the pinned container — the host's package state is not
persistent, so anything installed with `pacman` disappears on a host update and
takes the reproducibility of every number above with it.

```
docker build -t videosync-browser:latest harness/browser
cd harness/browser
./run.sh node probe-detector.mjs        # the detector against a real element
./run.sh node measure.mjs               # stall signature + seek cost
./run.sh node probe-seekcost.mjs        # seek cost vs segment delay
./run.sh node probe-autoplay.mjs        # autoplay policy
./run.sh node probe-throttle4.mjs       # headful: real throttling
./run.sh node probe-bgpause2.mjs        # the four never-audible conditions
```

The full-stack run (§7) needs two artifacts staged into `harness/browser/dist/`
first, because the container has no Go toolchain and does not build the client:

```
cd server && go build -o ../harness/browser/dist/videosyncd ./cmd/videosyncd
cd ../client/userscript && npm run build && cp dist/videosync.user.js ../../harness/browser/dist/
cd ../../harness/browser && ./run.sh node probe-userscript.mjs      # the whole stack, two browsers (§7)
./run.sh node probe-youtube.mjs         # the real YouTube player (§8)
./run.sh node probe-csp.mjs             # the address block, http vs https page (§8)
./run.sh node probe-ext.mjs             # what an MV3 content script may do (§9)
TOTAL_MS=600000 ./run.sh node probe-swlife.mjs          # worker holds a socket (§10)
SILENT=1 TOTAL_MS=600000 ./run.sh node probe-swlife.mjs # ...even an idle one
./run.sh node probe-extension.mjs       # the extension, two browsers (§11)
./run.sh node probe-hop.mjs             # what the message port costs (§11)
./run.sh node probe-extperm.mjs         # are host_permissions needed? (§11)
```

The extension probes need `client/extension/npm run build` as well as the two
artifacts above.

`DOCKER_TTY=-i` runs it without a terminal (for CI or a non-interactive shell).
The container needs `--shm-size=1g`; Chrome's renderer hangs on the default
64 MB `/dev/shm`. Test media regenerates itself on first run via `ffmpeg`;
`media/` and `dist/` are gitignored because both are derived, not source.
