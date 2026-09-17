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
this shim can answer. **13/13.**

| | |
|---|---|
| the page, and the content script, reach the server themselves | **no** — both hang, in the same browser, before the extension is asked |
| the service worker reached `http://127.0.0.1` **from that page** | yes — the whole reason this shim exists |
| two players after 4 s of synced playback, through the relay | **2–40 ms apart** across runs |
| `bestRTT` through the message port | **0.2–1 ms**, uncertainty ±0.1–0.5 ms |
| the page could see `window.VideoSync` | no — the isolated world holds |
| worker terminated mid-session (`Target.closeTarget`, verified gone) | **reconnect 0 → 1, session stayed joined, room still worked** |

That last row is the claim the architecture rests on: the worker holds no
session state, so a teardown is a reconnect and nothing more. An earlier version
of the check evaluated `close()` inside the worker — a no-op there — and passed
while proving nothing. It now closes the target and confirms it is gone before
asserting anything.

> **Correction.** The first row used to be a check whose value was the literal
> `true`, on a test page at `http://127.0.0.1` — which §8's own table shows *can*
> reach loopback. It proved only that a room was created, and a transport moved
> out of the worker into the content script would have passed it too. The probe
> now launches Chromium with `--ip-address-space-overrides=127.0.0.1:8899=public`,
> which puts the test page under the block a real OTT page is under (measured:
> page `fetch` to the server answers 200 without the flag and hangs with it), and
> asserts the page and the content script cannot reach the server before the
> extension does. Without the flag that control fails, so it discriminates.

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

> **Superseded by §14**, which measured all three questions with a probe. Kept for its
> provenance and for the fresh-room bug below.

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

## 14. Laftel, probed (`probe-laftel.mjs`)

The three questions §12 left open, measured on 2026-09-16 through the shipping
extension's own `VideoSync.adapter`, on a logged-in account, series 45462
episode 93304. **8/8.** Raw output: `results/laftel.json`.

The browser is Helium 0.17 (Chromium 153) on the user's own desktop, not the
container: Laftel needs an account and Widevine, and the container has neither.
The probe attaches over CDP to a dedicated profile
(`--user-data-dir=.cache/helium-profile --remote-debugging-port=9222`). A fresh
profile has **no Widevine CDM** — the browser downloads it into the profile as
a component — so `WidevineCdm/` was copied in from the user's main profile;
`requestMediaKeySystemAccess('com.widevine.alpha')` then resolved and playback
worked.

| question | measured | consequence |
|---|---|---|
| does a programmatic `pause()` stick? | **yes.** 20 samples over 5 s, all `paused`, position moved 0.000 s | the reconciler and `media`'s paused landing work on Laftel as designed |
| does Laftel reset `playbackRate`? | **no.** 1.1 held at every one of 20 samples over 10 s; media advanced 10.970 s in 10.004 s of wall clock, **1.096×** | `supportsPlaybackRateNudge` stays true; no seek-only path needed |
| does `mediaKey` differ per episode? | **yes, including across the SPA's own navigation.** Clicking the episode list changed the route without a document load and `mediaKey()` went `laftel:/player/45462/93304` → `laftel:/player/45462/93295`; the adapter followed onto the new `<video>` (readyState 4). A full reload of the first episode gave back the identical key | the generic `host:pathname` rule is right for Laftel; `mediakey.ts` needs no Laftel case |
| does a `currentTime` write stick? | **yes** (re-measured). Seeking to 120 s while playing, every sample for 2.8 s stayed within 0.099 s of the line through the target | confirms §12 |

Also observed, and relevant to the numbers in §15:

- **An in-buffer seek on Laftel costs ~100 ms, not ~20 ms.** Five seeks
  (±0.6 s and +2 s, playing and paused, all well inside 45 s of buffer):
  `seeked` fired after 90–132 ms, and `readyState` sat at **1** for that whole
  time before jumping straight to 4. §2's ~20 ms was measured on unencrypted
  local MSE; a Widevine stream is five times that. "In-buffer seeks are free" is
  still true in the sense that matters — no fetch, no rebuffer — but not free
  in time.
- **Resuming often jumps ~90 ms forward.** Right after `play()` on a paused
  element, the first 10 ms sample reads 81–110 ms ahead of the paused position
  in 10 of 16 plays across both runs. It is the player, not the sync: it happens
  before any command has been sent.
- A paused Laftel player **keeps its buffer**: readyState 4 and 45 s ahead,
  unchanged over 8 s of sampling. A paused member is not a buffering one.

**Not covered:** ads (none were served), autoplay refusal (the profile ran with
`--autoplay-policy=no-user-gesture-required`, so `NotAllowedError` could not
occur), and a second account.

## 15. Two members on Laftel: the `play` jump, and a gate that never let go (`probe-laftel-room.mjs`)

STATE.md's question 1b, which the harness cannot answer by construction
(POC-FINDINGS §40c). Two windows of the same profile, same account, same
episode, both visible; `videosyncd -verbose` on loopback, so the RTT is ~1 ms
and the command lead is the 500 ms floor on every play (read off the server
log: `when − emittedAt = 500` for all 20). Each trial: one member presses play
through the adapter, both players sampled every 10 ms for 4.5 s, the same member
presses pause, sampled 3 s. Presser alternates. Timestamps are
`performance.timeOrigin + performance.now()` so they compare across tabs.
The same account streaming in two windows at once was not refused.

### The first run found a bug

Six trials. **Three of the six plays were held by the readiness gate, and the
last one was held until a member left the room** — the server log shows
`gate waiting:true waitingOn:[a]` and the play firing only on `leave a`, 10 s
later. Meanwhile the presser, already playing locally, was judged against the
still-paused anchor and drew a `free seek` every second: six backward jumps of
0.5–1.2 s in 4.5 s. Nobody was buffering; every report in the log says
`ReadyState:4` with 45–70 s ahead.

The chain:

1. The presser's own play jump is an in-buffer seek, and on Laftel that holds
   `readyState` at 1 for ~100 ms (§14). A report sampled inside it said
   `ReadyState:1, BufferedAheadS:46.6`. The gate rule is `readyState < 3 ||
   bufferedAhead < 1`, so that member became gated. So far only a false alarm.
2. **Only an `ActionNone` decision ever cleared `gated`.** The servo answers
   `nudge` for as long as it holds a rate bias, and a paused member reports zero
   slope, so it never integrates the bias away. Every later report from a fully
   buffered member came back "nudge", never "none", and the flag stayed set.
3. `GateTimeoutMs` did not rescue it: the timeout is only checked on a report
   that is itself unready, and this member never sent another one.
4. The next `play` anyone pressed found a non-empty gated set and was held —
   indefinitely.

The fix (`room.go`, `OnReport`): readiness is a fact about the report, so any
decision other than `ActionGate` clears it. Hub test
`TestAMemberWhoIsReadyAgainLeavesTheGateEvenWhileBeingNudged` reproduces the
exact shape (fails before, passes after). The simulation's servo numbers are
unchanged over 20 seeds (one-slow-client anchorErr 99.1 → 100.1 ms, SkippedMs
4030 → 4030; long-stalls 56.2 → 56.3, 16 559 → 16 558); the `gates` column in
`mise run sim` rises because a member can now leave the gate and re-enter it,
which the old code counted once. The sim could not have shown the Laftel
trigger: it models an in-buffer seek as instantaneous at readyState 4
(`sim/client.go`), so the only unready members it ever has are genuinely
stalled ones, and the stuck flag only matters if a `play` arrives after such a
member has recovered.

### After the fix: the numbers 1b asked for

Ten trials (`results/laftel-room-nohold.json`). **No play was held, no correction
seek was issued in any trial**; the ~100 ms gate still opens during a presser's
seek and closes on the next report.

| | measured (10 trials) |
|---|---|
| the other member starts moving | 524–539 ms after the press (one at 774) |
| the presser's picture jumps **back** | once per play, 432–731 ms, median ~650 ms, landing 517–536 ms after the press |
| presser's net loss vs. an untouched player, 4 s later | 575–908 ms, median ~725 ms |
| presser behind the other member, 4 s later | 63–415 ms, median ~165 ms, **presser behind in 10/10** |
| pause: presser's picture jump | **0 in 10/10** (POC-FINDINGS §40c holds live) |
| pause: the other member stops | 14–109 ms after the press |

What the jump is made of: the 500 ms lead, plus the ~25 ms between the press
and the command leaving, plus whatever in-tolerance offset the presser already
had from the anchor (up to the 500 ms band), plus Laftel's own ~90 ms resume
jump. The **systematic lag** is the seek: the presser seeks back and then pays
~100 ms (§14) before playback resumes, while the other member only has to call
`play()` on a paused element that is already in position. It stays inside the
500 ms tolerance, so nothing corrects it except the servo, slowly.

So on a fast link, pressing play costs the presser roughly three quarters of a
second of picture they watched twice, and leaves them ~0.16 s behind everyone
else. Both are the price of starting the presser early and then seeking; see
STATE.md for what that suggests.

## 16. The presser waits (`holdLocalPlay`), measured on the same rig

§15 made the case; this is the change, measured with the same probe after
rebuilding the extension. The client now re-pauses a locally started player at
the anchor and starts it at `when` (PROTOCOL §3 amendment). Ten trials each,
`results/laftel-room.json` for the final one:

| | §15 (presser left playing) | hold, re-aim > 20 ms | hold, re-aim > 80 ms |
|---|---|---|---|
| presser's backward jump **at landing** | 432–731 ms, every play | **none** | **none** |
| presser starts moving | at once, then rewound at ~527 ms | 507–527 ms (one 677) | 517–518 ms |
| other member starts | 524–539 ms | 529–538 ms (one 692) | 529–539 ms |
| presser behind other, 4 s later (median) | ~165 ms | ~102 ms | ~96 ms |
| correction seeks / reconciles | 0 / 0 | 0 / 0 | 0 / 0 |
| pause: presser's jump | 0 | 0 | 0 |

The only backward movement left happens **while paused, at the press**: 81–203 ms
in 6–8 of 10 trials, which is the hold re-aiming a presser who was already that
far off the anchor. That offset comes from the pause before it — a member within
`seekToleranceMs` of a paused landing is left where it is — and the member
pressing next is exactly that member, because the probe alternates.

**Why the presser is still ~100 ms behind.** Not the schedule: the presser
starts ~13 ms *earlier*. It is how long each element takes to get going, which
depends on its history. Measured on one Laftel tab, as the intercept of the
position line after `play()` (three runs each):

| element was… | effective start |
|---|---|
| playing for 3 s, then paused | **+9 to +22 ms** (immediate) |
| played for 60 ms, then paused | −16 to −60 ms |
| paused, then seeked 50 ms | **−61 to −79 ms** |

The presser's element is always one of the last two; the other member's is the
first. That is also why the re-aim threshold is 80 ms rather than 20: a seek to
fix less than ~70 ms makes the start later, not better. The two settings are
indistinguishable at ten trials (~102 vs ~96 ms); 80 is kept because it is the
one the measurement argues for. The remaining ~100 ms is well inside the 500 ms
band, so nothing corrects it; compensating for a provider's start latency would
be a per-provider constant and is not worth it at this size.

`e2e.test.ts` pins the behaviour against a real `videosyncd` (and fails with the
hold switched off): the presser is held, never steps back, and starts within
100 ms of the other member.

### Through the site's own controls (`PRESS=click`, `PRESS=space`)

Every run above pressed through `VideoSync.adapter`, which bypasses Laftel's UI.
A user presses Laftel's own controls, and the site keeps its own idea of whether
it is playing — which the hold contradicts half a second later. Ten trials each,
pressing by clicking the video and by Space
(`results/laftel-room-click.json`, `-space.json`):

- the presser's element changed state **exactly three times in all 20 plays**
  (play → held → play): Laftel never re-asserted playback against the hold;
- no extra commands (two per trial, play and pause), no correction seeks, no
  reconciles, **0 gate frames**;
- presser starts 517–538 ms after the press, the other member 528–554 ms
  (one trial 696 / 717 ms);
- Laftel's control bar follows the element: ▶ during the hold, ‖ after the
  landing (checked by screenshot).

The presses are synthetic events dispatched inside the page. CDP
`Input.dispatchMouseEvent` was tried first and its clicks landed **3–6 s late**:
on a Wayland desktop a window that is not on screen gets no frame callbacks and
CDP input waits for a frame. Synthetic events reach the same React handlers but
carry no user activation — irrelevant here only because the profile runs with
`--autoplay-policy=no-user-gesture-required`.

### The gate flicker, gone

Every remaining gate frame in the runs above came from a report sent in the
middle of an in-buffer seek the engine itself was applying:
`ReadyState:1, BufferedAheadS:47`. The engine now holds back a report that says
"not ready" while at least 1 s is buffered ahead, for at most 300 ms — a seek's
worth — and sends whatever the player says after that, so a player that is
genuinely stuck is still reported. A further ten trials on the rebuilt
extension: **0 gate frames** on the wire (2–4 per run before), and the play
numbers unchanged — presser 508–518 ms, other member 525–548 ms, no step back
after the hold, median gap ~90 ms.

## 17. The same room on YouTube

`probe-laftel-room.mjs` with `MATCH='youtube\.com/watch' LABEL=youtube-room`,
Big Buck Bunny in two windows of the same profile, after the §16 changes and
the rate-release fix. Six trials for each way of pressing
(`results/youtube-room.json`, `-click.json`, `-space.json`):

| press | presser starts | other starts | gap 4 s later (range) |
|---|---|---|---|
| adapter | 506–508 ms | 515–528 ms | −178 to +15 ms |
| Space | 505–517 ms | 518–522 ms | −194 to +143 ms |
| click on the video | 708–727 ms | 723–730 ms | −141 to +121 ms |

- **No step back after the hold, no correction seeks, no reconciles, 0 gate
  frames**, and exactly two commands per trial, on every path.
- A click starts both members ~200 ms later than Space does. That is YouTube
  delaying a single click until it is sure it is not a double click (which
  means fullscreen); the hold and the lead are unchanged.
- In some trials the presser's element shows one transition, not three: the
  hold finished inside one 10 ms sampling tick. `playsHeld` confirms it ran.
- YouTube reports `readyState < 3` with buffer in hand often enough that
  `reportsDeferred` reached 2–7 per member over a run — every one of which
  would have been a gate frame (§16).
- **After leaving, both players were back at rate 1.** Before the fix, two
  Laftel tabs that had left their room were found playing at 0.997× and
  1.036×: `stop()` never undid the servo's last nudge.

## 18. Joining takes you to the room's video (`probe-follow.mjs`)

The user request from 2026-08-31, built and run end to end on 2026-09-16: a
Laftel creator, a joiner who starts on YouTube, the real extension, the real
server. **11/11** (`results/follow.json`).

| step | measured |
|---|---|
| B, on YouTube, joins by code | taken to the room's Laftel episode **1.6–1.9 s** later (1.5 s of it is the "stay here" grace period) |
| B's page loads | **rejoins the same room unprompted**, 0.3–0.4 s after arriving |
| A moves to another episode in Laftel's SPA and presses "move the room here" | A is not navigated by its own command; B follows **1.7 s** later and rejoins |
| B clicks a different episode itself | stays there (checked 4 s later), still in the room, and is offered "move the room here" |
| B joins again and presses "stay here" | stays on YouTube, still in the room |

The first run found that the rejoin never happened: the extension hydrates
`chrome.storage` for a fixed list of keys, and the new `rejoin` key was written
but never read back on the next page. It is listed now, and the store gained a
`flush()` that the navigation awaits, because `chrome.storage.local.set` is
asynchronous and the page is about to unload.

Also learned on the way: an extension loaded with `--load-extension` does not
survive `chrome.runtime.reload()` — it is removed rather than reloaded, and
open tabs keep an isolated world named `VideoSync` with no `chrome.runtime.id`
and no `window.VideoSync`. Restart the browser instead.

## 19. Firefox (`probe-firefox.mjs`, `bidi.mjs`)

Firefox 156 (flatpak), driven over WebDriver BiDi — it removed CDP in 129 —
in a room with Helium over CDP. Firefox gives no handle on a content script's
realm, so its member is driven through the panel, like a person.

**MV3 cannot reach a plaintext server from the background, in Firefox.** A
minimal extension, three sockets each, sniffed at the listener:

| where the `ws://127.0.0.1` socket is opened | what arrives |
|---|---|
| MV3 background (`background.scripts`) | a **TLS ClientHello** (close 1015 in the page) |
| MV3 content script | plain `GET` |
| MV2 background | plain `GET` |
| an https page's own script (YouTube) | plain `GET` — Firefox does not block public → loopback, unlike Chromium (§8) |

`localhost` is upgraded the same way, the socket's `url` still reads `ws://`,
and adding `content_security_policy.extension_pages` without
`upgrade-insecure-requests` to the MV3 manifest changed nothing. The Firefox
build is therefore **Manifest V2**, same scripts. One more trap from getting
there: after an MV3 build had been installed under the add-on id, an MV2 build
under the same id in the same profile *still* upgraded; the same MV2 build under
a fresh id, or in a fresh profile, did not. Test Firefox changes in a fresh
profile.

**Results, Chromium ↔ Firefox**, on `local-media.mjs` with the `local-ext.mjs`
builds (`results/firefox-local.json`), **10/10**:

- Firefox joins through the panel from another page, is taken to the room's
  video 1.6 s later and rejoins on arrival — the rejoin survives Firefox's
  `storage.local`;
- it conforms to the paused room (30.00 s both);
- play from Chromium: gap −2 ms; pause from Firefox: 9 ms; play from Firefox
  (the hold): 53 ms; a seek from Chromium to 200 s, well past the buffer: 49 ms;
- then 30 s together at **29–81 ms**, and rate 1 after leaving.

**YouTube in an automated Firefox is not usable for this.** With no extension
involved at all, playback runs to ~41 s and then the player resets the element
to 0 and stops, with 60 s buffered. Any seek past the buffer — a raw
`currentTime` write *or* YouTube's own `movie_player.seekTo` — sits at
readyState 1 until that reset. That is YouTube and `navigator.webdriver`, not
this code; the YouTube run (`results/firefox.json`, 8/10) fails exactly the two
checks that need more than that. It also found the bug below.

**The detector swallowed seeks.** A real seek drops `readyState` (~100 ms at 1
on Laftel, §14; seconds on a YouTube out-of-buffer seek), and the stall guard
re-baselined onto the new position on any unready evaluation — so a user's seek
never became a command, and the room corrected them back. The Chromium member's
seek to 120 s was undone this way. Fixed in `detector.ts`: while unready, the
held reference is compared first; a stall leaves the position there, a seek
does not.

Not covered: Laftel in Firefox (needs a login and Widevine in that profile),
autoplay refusal, and Firefox for Android.

## 20. What a page does to a video when a client finds it (`probe-acquire.mjs`)

Measured on 2026-09-17, before building D8 (`docs/design/acquire.md`), to set
its constants. A recorder injected into the page world before any page script
logs every media event at the document (capture phase), trusted input,
navigation, `<video>` insertion/removal, `navigator.userActivation`, and a
10 ms poll for what fires no event. Helium 153 over CDP (the dedicated profile,
logged in to Laftel), Firefox 156 over BiDi, `local-media.mjs` with its new
site variants (autoplay, resume, SPA swaps). Results: `results/acquire-*.json`.

**Input kinds, because they mean different things:** `cdp` = `Input.dispatch*`,
trusted and activating (it arrived 10–39 ms after dispatch in every run here);
`script` = a site-like call (`el.play()`, `__site.go`), no activation;
`mpris` = a D-Bus `PlayPause`/`Play` to the browser's MPRIS service (`busctl`;
`playerctl` is not installed). No activation claim below rests on script input.
Both autoplay policies were run for M6 and L1: with
`--autoplay-policy=no-user-gesture-required` and without it. **On this profile
autoplay was allowed either way** — unmuted, on 127.0.0.1 and on Laftel — so
C1 is not an artefact of the flag the earlier live probes used. That is a fact
about this profile's history, not about Chromium's default policy.

**The load algorithm on the same element (M1)** — Helium and Firefox agree:

| | measured |
|---|---|
| order on a `src` change | `abort` → `emptied` → `ratechange` → `loadstart` → `durationchange` → `loadedmetadata` → `loadeddata` → `canplay` → `canplaythrough`, in 43–107 ms (MSE blob: 107 ms Helium, 534 ms Firefox) |
| a playing element | becomes paused **with no `pause` event** (seen only by the poll), position 0 |
| `playbackRate` 1.5 | reset to 1 (`defaultPlaybackRate`), with a `ratechange` — the engine's "a reused element keeps its rate" comment is wrong for a new `src` |
| `src` swapped, URL changed 300 ms later | every media event of the new load fires before the URL moves |

**The element replaced (M2):** in one task, the new element's `loadstart` and
the old one's `pause` come together; removed first, the page has **no `<video>`**
for the gap. The removed element's `pause` reaches only a listener on the
element itself — a disconnected node's events do not pass through the
document — which is exactly where `Html5Adapter` listens.

**Where autoplay lands (M6):** attribute autoplay fires `play` at
`canplaythrough` (+0 ms); `play()` at `loadedmetadata` 7–12 ms *before* it;
at `canplay`/`canplaythrough` 3–8 ms after. Firefox the same (−40 to +2 ms).

**Media keys (M3, M4):**

| | Helium (MPRIS) | Firefox (MPRIS) |
|---|---|---|
| event after the D-Bus call | 8–11 ms | 7–12 ms |
| input event | none | none |
| `isActive` at the `play`/`pause` | **true** (false before the first press) | **false**, before and after |
| with page `mediaSession` handlers | the same | not run |

So in Chromium a media key shows up as an **activation rise with no input**;
in Firefox it shows up as nothing at all.

**The isolated world (M5):** `navigator.userActivation.isActive` read in the
page and in the `VideoSync` content-script world agreed in 50/50 samples: true
at 0, 0.1, 1 and 3 s after a trusted click, false at 6 s (the 5 s lifespan).
The extension can read it.

**Laftel (L1–L5), logged in:**

| | measured |
|---|---|
| full load (L1, 3 runs × 2 policies) | the element appears 1.2–1.7 s in; **Laftel resumes from its history**: it writes `currentTime` at `loadedmetadata` and again every ~100 ms (12 `seeking` events) until 0.5–0.75 s before `canplaythrough` (resume point: the last position — 813 s; 419 s after watching at 400 s); `canplay` and `canplaythrough` fire together; then **Laftel autoplays 4–11 ms after `canplaythrough`**, `isActive` false |
| in-app episode link, trusted click (L2, 3 runs) | **same element**; `pushState` 113–140 ms after the click, `emptied` 183–213, `loadstart` 217–252, `canplaythrough` 1270–2068, autoplay 3–11 ms later — **1.27–2.08 s after the click, with `isActive` still true** |
| end of an episode (L3, 2 runs) | `pause` with `ended` already true, then `ended`; **5.3–5.6 s later** Laftel routes to the next episode (SPA, same element, 0 s remaining when the URL moved), autoplays 8–9 ms after `canplaythrough`, `isActive` false, rate 1 |
| 300 s of plain playback (L4) | **0** `emptied`/`loadstart`/`abort`, 0 element changes, 0 navigations |
| press → media event (L5, 10 each) | click on the video 24–50 ms, Space 14–32 ms |

**YouTube (Y1, Y2, Y5):**

| | measured |
|---|---|
| recommendation click (Y1, 5 runs; the file keeps the last 2 — the first 3 were read from their timelines before the probe's own summary was fixed) | same element; `pushState` 33–90 ms after the click; `emptied` 749–908 ms; **`play` 1 ms after `emptied`**, before `loadstart` (`readyState` 0), `isActive` true |
| end with autonav on (Y2) | `pause` (`ended` true) → `ended`; routes on **7.6 s later**; again `play` 1 ms after `emptied` |
| press → media event (Y5, 10 each) | click 214–268 ms (it waits out a double click, §17), Space 11–50 ms, `k` 6–28 ms |

The recorder runs in every frame, so its "no `<video>` on the page" reading is
unreliable on pages with iframes; element serials and `dom` events are not.

**What this sets (the constants of `docs/design/acquire.md`):**

- **G = 500 ms.** Above the slowest press measured (268 ms, a YouTube click),
  below the fastest site autoplay after a navigation click (750 ms, YouTube).
  The rule that the gesture must come **after the media epoch began** is
  mandatory, not optional: at every such autoplay `isActive` was still true.
  The epoch bump on `emptied` has to be synchronous: YouTube's `play` follows
  it by 1 ms.
- **T_settle = 1 s.** Every site move measured came before `canplaythrough`
  or within 11 ms of it. The margin is large because exceeding it only
  degrades to the old behaviour; a site that acts later is not covered.
- **endWindow = 1 s.** Neither site navigates before `ended` (Laftel +5.3–5.6 s,
  YouTube +7.6 s), so it only covers a player that stops a hair short. The
  continuation window (how long after its own end a member's navigation may
  still carry the room) is 20 s against those 5.3–7.6 s.
- **Conform at HAVE_FUTURE_DATA, not at metadata.** Laftel's resume writes the
  position for 1.5–1.8 s after `loadedmetadata`; a conform in that window
  would be overwritten and fought. A paused element that never buffers is
  conformed after 5 s at metadata (not measured: both sites buffer).
- **K = 3** is the design's value. No site fought a conform in any run below.
- **Firefox gets no media-key evidence**: a media-key play while acquiring is
  put back once there. Outside that window nothing changes.

**The control: what today's client sends (0f879c2).** Two Helium windows in a
room, `videosyncd -verbose` as the oracle, nobody pressing anything unless the
case says so (`results/acquire-CONTROL.json`, `-CONTROL-laftel.json`,
`-CONTROL-control-new.json`):

| case | commands on the wire |
|---|---|
| A1 follow; site autoplays at `canplay` | none (the autoplay beat the engine's first look; the reconciler paused it) |
| A2 follow; site autoplays 1.5 s after `canplaythrough` | B: **`play`** — the paused room started |
| B1 follow; site resumes to 120 s, autoplays | B: **`play`** |
| D1 `src` swapped for episode 2, URL 400 ms later | B: **`seek 0`** on episode 1, for everyone |
| E1 element removed, new one 300 ms later | B: **`seek 0`** (Path E, reproduced) |
| G1 two members play to the end | A: **`pause@240000`** |
| L1 Laftel: B followed onto an episode; Laftel resumes to 181 s and autoplays | B: **`play@300006`** — the paused room started |
| N1 Laftel: two members play to the end | A: **`pause@1431430`**; Laftel moved A on alone; **B stopped 1 s short of the end, never reached `ended`, and was never moved on** (Path G, exactly as predicted) |
| P1 trusted click pauses a playing B | B: `pause` |
| P2/P3 trusted click / MPRIS play on B right after joining a paused room | B: `play` |

Also seen in the control: a joiner of a *playing* room sat paused for 7.7 s,
because the server's seek corrections (every 2 s) kept resetting the
reconciler's 3 s timer. The conform step now starts such a joiner at once.

## 21. The same cases with D8 built

Same rig, the `local-ext.mjs` build of `feat/acquire` (`NAME=ext-fixed`) and a
`videosyncd` from the same branch (`results/acquire-CONTROL-fixed.json`,
`-fixed-2.json`):

| case | before (§20) | after |
|---|---|---|
| A1 | none | none; B conformed, paused at 30 s |
| A2 (site acts 1.5 s after ready) | `play` | **`play`** — outside T_settle, as designed: past the backstop the old behaviour applies. No measured site acts that late |
| A3 (the same at 0.8 s) | — | **none**; absorbed, B paused at 30 s |
| B1 | `play` | **none**; the resume and autoplay were put back |
| D1 | `seek 0` | **none** (4 media epochs) |
| E1 | `seek 0` | **none** (5 media epochs) |
| G1 | `pause@240000` | **none**; `endsNotSent` 1, the room plays on past the end |
| L1 Laftel follow | `play@300006` | **none**; both paused at 300 s, one site move absorbed |
| N1 Laftel end → next episode | `pause`; members split | **no pause** (both `endsNotSent` 1); B's continuation `media` (conditional on episode 10) won, B sent `play` once conformed, and **both were on episode 11 at 25.98 / 25.92 s** |
| P1 trusted click, steady | `pause` | `pause` |
| P2 trusted click while `guarded` | `play` | **`play`** (`gesturedIntents` 1) |
| P3 MPRIS play while `guarded` | `play` | **`play`** — the activation rise counted |

`fought` was 0 in every run. The existing live probes still hold on this
build: `probe-follow.mjs` **11/11** (B sent no command on either arrival; A's
only commands were its adoption seek, now after its site settled, and the
conditional `media` press); `probe-firefox.mjs LOCAL=1` with the fixed
Firefox build **10/10**; `probe-laftel-room.mjs` (6 trials,
`results/laftel-room-d8.json`) — no jump at landing, 0 correction seeks, 0
reconciles, pause unchanged, presser starting 525–536 ms and the other member
549–572 ms (§16: 517–518 / 529–539), the known re-aim at the press in 3 of 6
trials (91–246 ms; §16: 81–203 ms in 6–8 of 10), gap 4 s later −209 to +12 ms.
The presses there are the adapter's, after both members are `steady`, so
nothing in them passes through the new classification.

Not covered: a site that acts later than T_settle (A2 is the boundary),
YouTube ads (Y3), fullscreen consuming activation (Y4), Laftel in Firefox, a
member who follows by full-page navigation during a continuation (it leaves
the room while its page loads, so the gate is released without it).

## 22. The integrated branch, live (`integrate/d678`)

Run on 2026-09-17 against `integrate/d678` at 161abbf: D6 (auth), D7
(provider descriptors) and D8 (acquisition) together. Helium 153 over CDP on
the dedicated profile (logged in to Laftel), Firefox 156 over BiDi,
`local-media.mjs` on :8898, and a `videosyncd` built from the same commit
with `-verbose`. Both browsers ran the `local-ext.mjs` build
(`NAME=ext-d678`). Every result file carries a `-d678` suffix; the files the
earlier sections cite are unchanged.

**A trap in the rig first: a rebuilt unpacked extension can keep its old
service worker.** Helium was relaunched with `--load-extension` on a
directory the new build had just overwritten. `content.js` was the new one,
but the worker was a much older build: its only handler was a `createRoom`
message (read back with `Debugger.getScriptSource`). Every new
`runtime.sendMessage` (`auth`, `providers.granted`) failed with *"The
message port closed before a response was received"*, so `createRoom`
threw. It looks exactly like a product bug. Calling `chrome.runtime.reload()`
from the worker unloaded the extension and left orphaned content scripts
behind, and it did not come back. What worked was a copy at a **new path**,
which gets a new extension id and so has no cached worker. Before a live
run, check the worker's source against `dist/sw.js`, or load a build from a
fresh path. Also: `Target.createTarget` on a `chrome-extension://` URL is
refused by Helium (`ERR_BLOCKED_BY_CLIENT`), so the options page is opened
from the worker with `chrome.tabs.create`.

**The existing probes, on the integrated build:**

| probe | result | against the last run |
|---|---|---|
| `probe-laftel.mjs` (`laftel-d678.json`) | **8/8**; a seek stays within 0.098 s of its line, rate 1.1 gives 1.097× | §14 8/8 |
| `probe-laftel-room.mjs`, adapter, 6 trials (`laftel-room-d678.json`) | presser starts 525–545 ms, the other member 551–577 ms; **no jump at landing**; the known re-aim at the press in 3 of 6 trials (145–217 ms); 0 correction seeks, 0 reconciles, 0 late applies; the pause moves the presser by 0; gap 4 s later −180 to +17 ms; rate 1 on leaving | §21: 525–536 / 549–572 ms, re-aim 3 of 6 (91–246 ms), gap −209 to +12 ms |
| the same with `PRESS=click`, 4 trials (`laftel-room-click-d678.json`) | presser 576–616 ms, other 605–641 ms; re-aim in 2 of 4 (147, 187 ms); 0 correction seeks; gap −156 to +137 ms | §16, 10 trials: 527–696 / 538–717 ms, re-aim 8 of 10 (91–219 ms), gap −190 to +46 ms |
| `probe-follow.mjs` (`follow-d678.json`) | **11/11**; taken to the room's episode 2.56 s after joining by code, rejoined 0.82 s later; followed the move in 2.40 s. On the wire, B sent **no command**, and A sent only its adoption `seek` and the conditional `media` | §21 11/11, the same commands |
| `probe-firefox.mjs LOCAL=1`, `FF_EXT=…/ext-d678` (`firefox-local-d678.json`) | **10/10**; taken to the video and rejoined in 1.64 s; conformed at 30.00 s; play from Chromium −139 ms, pause from Firefox −128 ms, play from Firefox 170 ms, seek to 200 s 43 ms; 30 s together at −58 to +71 ms; rate 1 on leaving | §19: −2 / 9 / 53 / 49 ms, 29–81 ms |

The three transition gaps in the Firefox run are larger than in §19. This is
one run of each, and the pass bound held. The 30 s hold is no worse. It is
not investigated here.

**D8's cases (`probe-acquire.mjs SCEN=CONTROL`, `acquire-CONTROL-d678.json`),
compared with §21's "after" column:**

| case | §21 | this build |
|---|---|---|
| L1 Laftel follow | none; both paused at 300 s | **none**; both paused at 300 s, one site move absorbed |
| N1 Laftel end → next episode | no pause; B's continuation `media`, then `play`; both on episode 11 | **`media@0`, `play@0` from B, no pause** (`endsNotSent` 1 each, B `continuations` 1); both on episode 11 (`/93305`) at 27.82 s, playing |
| A1 | none | none; B paused at 30 s |
| A2 (1.5 s, past T_settle) | `play` | `play@30000`, as designed |
| A3 (0.8 s) | none | none; one move absorbed |
| B1 | none | none; the resume and autoplay put back |
| D1 | none (4 epochs) | none (4 epochs) |
| E1 | none (5 epochs) | none (5 epochs) |
| G1 | none; `endsNotSent` 1 | none; `endsNotSent` 1 on both |
| P1 trusted click, steady | `pause` | `pause@68219` |
| P2 trusted click while `guarded` | `play` | `play@30000`, `gesturedIntents` 1 |
| P3 MPRIS play while `guarded` | `play` | `play@30000`, `gesturedIntents` 1 |

`fought` was 0 in every case, and no case drew an `error` frame.

**Auth (D6), in Helium** (`auth-smoke.json`, 16/16). `videosyncd -auth token
-auth-tokens-file <one key> -auth-scope create`, driven through the panel by
`results/drivers/auth-smoke.mjs`:

- `POST /api/rooms` without a ticket answers 401. From the panel, "방 만들기"
  (create room) does not create a room. The sign-in box appears ("이 서버는
  로그인이 필요해요", "this server needs sign-in"), with **no key field in the
  page**: the panel's only inputs are server, name, room, secret and chat.
- "브라우저에서 로그인" (sign in in the browser) opens a tab on the server's
  origin (`/auth/login?flow=…`). The tab asks for the access key (a password
  input) and shows the same code as the panel (`RSXH-9B3M` in both).
- A wrong key: the tab says "키나 비밀번호가 맞지 않아요" (the key or
  password is wrong) and offers the form again. The panel keeps waiting, and
  no room is created.
- The right key: the tab says "로그인했어요" (signed in). The panel hides the
  box, shows "서버에 key(으)로 로그인됨" (signed in to the server as key),
  and **the create is retried by itself**. A is in a fresh room. The worker
  now gets a ticket (200).
- Then "로그아웃" (sign out): the device's ticket request answers 401, and A
  stays in the room, as scope `create` intends.
- B, in a new window on the invite link, with the device signed out: the link
  **fills in** room and secret, and B joins by pressing "참가" (join). It is
  never asked to sign in, the room has 2 members, and the server logged the
  join and no error. An invite link does not join by itself; that was
  already the design (`readInviteHash` only pre-fills), and the first
  attempt of the smoke run assumed otherwise.

The run was made with the device signed out, because both windows share one
extension and so one device token. Without the sign-out, B's join would not
have shown anything.

**Provider descriptors (D7), in Helium** (`providers-smoke.json`, 10/10).
`videosyncd -providers <dir>` with one test descriptor
(`results/drivers/localmedia.json`: id `localmedia`, key prefix `local`,
host `127.0.0.1`, `/watch/{n:int}`), driven by
`results/drivers/providers-smoke.mjs` on the extension's own options page:

- The server refused the first draft: `identity[0]: "watch" is required`,
  and a `watch` must be `https://`. **An http-only site cannot be described
  with a working watch URL**, so the descriptor says
  `https://127.0.0.1/watch/{n}` (nothing serves that). Following to such a
  page by descriptor is therefore not possible, and was not tested. The
  directory poll picked up the fixed file within its 5 s.
- The options page, with the server entered and "불러오기" (load) pressed,
  lists the descriptor: name, id, `v1.0.0`, `sha256 ab860a8d9189`, hosts,
  and the tag **"새 설명"** (new description), with "살펴보기" (review) and
  "거절" (decline).
- "살펴보기" shows the difference table and "적용" (apply). "적용"
  succeeds, and the offer now reads "사용 중" (in use). The descriptors in
  force list it as a **서버** (server) one, "사이트 권한 있음" (site access
  granted). That grant comes from the probe build, whose manifest already
  lists `http://127.0.0.1/*`; a shipped build would show "사이트 권한 허용"
  (grant site access) here, which was not exercised.
- The open local-media page keeps `127.0.0.1:/watch/1` until reloaded, as
  the page says. After a reload it keys **`local:/watch/1`**, and a room
  created there carries that key. `dump()` has no provider notes or
  conflicts.
- "사용 중지" (stop using) undoes it: after a reload the page is back on
  `127.0.0.1:/watch/1`. The profile is left as it was.

Not covered here: `-auth password`/`proxy`/`oidc`, scope `all`, the
sign-in path from the userscript, a pinned descriptor whose server copy
changed (the update notice and the diff of an update), auto-adopt,
`replaceBuiltin`, the site-permission prompt, and Firefox for either D6 or
D7.

## 23. Laftel in Firefox, and a room with Chromium on it (2026-09-17)

The Firefox profile (`.cache/firefox-profile`, flatpak Firefox 156) was logged in to Laftel by the
user; Widevine had already been fetched into it.

**Alone** (page world over BiDi, episode 93304): DRM playback works (`mediaKeys` set); a scripted
`pause()` holds for 5 s; `playbackRate` 1.1 holds for 10 s and media advances at **1.0996×**; a seek
600 s away, far outside the buffer, plays on.

**A seek in Firefox + Widevine reads frozen for about a second.** Six in-buffer seeks while
playing: `seeked` after 10–18 ms, but after the first two `currentTime` stopped advancing for
**1010–1037 ms** (readyState dipping to 1), then caught up — 3 s later the element was only
90–156 ms behind the line through the target. So the picture is roughly where it should be, but
any report taken during that second says the member is up to a second behind. That is a way for
a correction seek to earn another one; in the first room run below the Firefox member did draw a
free seek every ~2 s for a while.

**Chromium ↔ Firefox on Laftel** — `LAFTEL=1 probe-firefox.mjs` (Helium on episode 93304 creates
the room; Firefox starts on 93295 and joins through the panel). The probe build now mirrors the
engine's `dump()` onto the panel host (`data-dump`, probe builds only), so the Firefox member's
state can be read — the one thing BiDi could not reach.

| run | result | failing check | 30 s hold, gap every 5 s |
|---|---|---|---|
| 1 (earlier build without the dump; file lost, see below) | 7/10 | not paused 5 s after arriving; Firefox's pause never reached the server; 933/844 ms during the hold | 121, 156, 933, 844, 18, −62 ms |
| 2 (`firefox-laftel-run2.json`) | 9/10 | play from Chromium, gap 355 ms | 55, 113, 47, 57, 45, 29 ms |
| 3 (`firefox-laftel-run3.json`) | 9/10 | play from Firefox, gap 374 ms | 179, 242, 195, 197, 204, 146 ms |
| 4 (not kept) | 9/10 | seek from Chromium, gap 331 ms | 9, −54, 24, −43, −6, −43 ms |

Every run: taken to the room's episode 1.7–1.8 s after joining and rejoined 2.0–2.5 s after
joining, rate 1 after leaving. In runs 2–4 the Firefox member was `steady` by the conform check and
every command crossed; the single failure each time is one transition landing 330–374 ms apart
— over the probe's 300 ms bound, inside the servo's 500 ms band — which the hold then closes or
leaves at ~200 ms. Run 4's dump (quoted from the run; its file was not kept): 5 correction seeks
and 29 deferred reports in a minute, 2 un-gestured changes ignored while acquiring, no reconciles.

**Run 1 is not explained.** Its server log shows the Firefox member playing in a paused room right
after the conform, a `pause` it made never sent, and free seeks every ~2 s for twenty seconds
(reports frozen for a second after each, as above). It did not recur in three runs, and that run
had no dump. A deterministic e2e reproduction with a player that freezes `currentTime` for 1 s
after each seek (scratch only) did not loop either. Kept here as an open observation: if it comes
back, the dump will say which acquisition state swallowed the pause.

**Run 1's results file does not exist.** `probe-firefox.mjs` writes every `LAFTEL=1` run to the
same `results/firefox-laftel.json`, and a later run overwrote run 1 before it was copied aside.
The file this table used to cite as run 1 was byte-identical to `firefox-laftel-run3.json` (run
3's timestamp, 9/10, with a dump), so it has been removed rather than left under a name that
contradicts its row. Run 1's row and the paragraph above are all that is left of it; run 4 has
no file either. A re-run writes `firefox-laftel.json` again: rename it before the next run.

## 24. Review round 3, live (2026-09-17)

`main` at c30c41f (STATE.md "Review round 3"), Helium over CDP on the dedicated profile and Firefox
over BiDi, both on the `local-ext.mjs` build `NAME=ext-r3`, `videosyncd` built from the same
commit. Every result file carries an `-r3` suffix.

**The existing probes did not move:**

| probe | result | against §22/§23 |
|---|---|---|
| `probe-laftel.mjs` (`laftel-r3.json`) | **8/8**; seek within 0.157 s of its line; rate 1.1 gives 1.0975× | 8/8 |
| `probe-laftel-room.mjs`, adapter, 6 trials (`laftel-room-r3.json`) | presser starts 517–518 ms, the other 532–568 ms; re-aim at the press in 4 of 6 (137–182 ms); 0 correction seeks, 0 reconciles, 0 late applies; pause moves the presser by 0; gap 4 s later −137 to +15 ms; rate 1 on leaving | 525–545 / 551–577 ms, re-aim 3 of 6, gap −180 to +17 |
| the same, `PRESS=click`, 4 trials (`laftel-room-r3-click.json`) | presser 536–566 ms, other 552–589 ms; re-aim 1 of 4 (206 ms); 0 correction seeks; gap −316 to +54 ms | 576–616 / 605–641 ms, gap −156 to +137 |
| `probe-follow.mjs` (`follow-r3.json`) | **11/11**; taken to the room's episode 1.97 s after joining by code, rejoined 0.41 s later; followed the move in 1.75 s | 11/11 |
| `probe-acquire.mjs SCEN=CONTROL` (`acquire-CONTROL-r3.json`) | all twelve cases as in §22: L1/A1/A3/B1/D1/E1/G1 send nothing; N1 `media@0`, `play@0`, no pause; A2, P2, P3 `play@30000`; P1 `pause` | same |
| `probe-firefox.mjs LOCAL=1` (`firefox-local-r3.json`) | **10/10**; play from Chromium 61 ms, pause from Firefox 26 ms, play from Firefox 268 ms, seek 58 ms; 30 s at −6 to +67 ms | 10/10 |
| `probe-firefox.mjs LAFTEL=1` (`firefox-laftel-r3.json`) | **9/10**; the seek from Chromium landed 321 ms apart (bound 300); 30 s at 225–299 ms; one correction seek | §23: 9/10 three times, the one miss a 330–374 ms gap |

The Firefox–Laftel run sits where §23 left it: a steady lag of a few hundred milliseconds that the
servo's 500 ms band leaves alone (the sub-tolerance lag STATE.md lists as open), and the known
single extra correction after a seek.

**What the round changed, measured (`probe-round3.mjs`, `probe-round3-firefox.mjs`):**

| check | Helium (`round3.json`) | Helium, **before** the round (`ext-main`, 5ec092e; `round3-control-5ec092e.json`) | Firefox (`round3-firefox.json`) |
|---|---|---|---|
| N37: a rotation rewrites the `#videosync=` fragment | in 17 ms | **no** (5 s, never) | in 2 ms |
| the site untouched: path, `history.length`, `history.state`, no `hashchange`/`popstate` | yes | yes | yes, and a state holding a `Date` and a `Map` came back as a `Date` and a `Map` through the content script's Xray `history` |
| a reload prefills the new secret, and joining works | yes | **no**: the old secret, refused | yes |
| N1: a background tab joined to the room has no media (readyState 0, `detached`) | yes | yes | — |
| A is not waiting on it | `waitingOn` [] | **`waitingOn` [the hidden member]** | — |
| A's `play` starts | after 1.04 s (the hold) | **after 27.2 s** — the gate timeout | — |
| the hidden member is not moved | yes | yes | — |

So both fixes are real in a browser, and the probe tells the builds apart.

**N20, and two bugs it turned up (`probe-offline.mjs`).** Member B reaches `videosyncd` through a
TCP relay inside the probe, which cuts B off (open sockets destroyed, new ones refused) for 8 s; the
server sees B leave, and B reconnects to a fresh `welcome`. B's pause is a trusted CDP click on
Laftel's player. Three cases: (1) the room stays put and B pauses offline — B's pause must reach
the room; (2) A seeks the room 60 s on while B is away and B pauses offline — B must follow the
room and A must not be paused; (3) a cut with nobody doing anything.

- On the round-3 build (`ext-r3`), case 1 passed and case 2 failed: B was moved to the room's
  position but **stayed paused in a playing room**, and never recovered. Its engine had taken
  8 `correct{seek}` in 16 s — one every ~2 s — and **0 reconciles**. A paused member in a playing
  room falls behind, so the servo free-seeks it about every 2 s; every correction is an apply, and
  an apply used to restart the reconciler's `RECONCILE_AFTER` (3 s) wait. The wait never ran out.
  This is not N20's doing: any member left paused against a playing room while the room corrects
  it is stuck the same way. It is very likely §23's unexplained run 1 (a Firefox member playing in
  a paused room, a free seek every ~2 s, never put right) — the mirror image of this, and the same
  starvation. Fixed: an apply in flight neither starts nor ends the wait.
- With that fixed (`ext-r3b`, `offline-r3b.json`), case 3 failed: after the cut B was **660 ms
  ahead** of A. `onClose` kept the servo's last nudge (1.06× here), so B ran fast for the whole
  outage. Fixed: a dropped connection hands the rate back, as leaving does (`releaseRate`). The
  simulation's disconnect now does the same (seed-averaged, `reconnect`/servo unchanged; pll's
  rateTime 620 -> 618 ms).
- On the build with both fixes (`ext-r3c`), two runs (`offline-r3c-1.json`, `offline-r3c-2.json`):
  **4/4 each.** (1) B's offline pause reached the room, gap 0 ms. (2) B sent nothing and followed
  the room, playing, gap −2 / −67 ms; A stayed playing. (3) nothing sent, gap −127 / −155 ms five
  seconds after the reconnect.

The existing probes again on `ext-r3c`: `probe-laftel-room.mjs` (`laftel-room-r3c.json`) presser
509–517 ms, the other 521–548 ms, re-aim in 4 of 6 (84–191 ms), 0 correction seeks, gap −182 to
+168 ms; `probe-acquire.mjs SCEN=CONTROL` (`acquire-CONTROL-r3c.json`) as before in eleven cases.
In N1 both members this time reached the end close enough together that **both** sent the
continuation: A's `media` won, B's was refused `media_stale` (no `seq` taken) and B followed; both
ended on episode 11, playing. That is the compare-and-set doing its job, which §21/§22 had not
happened to exercise live.

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

The Laftel probes (§14, §15) cannot run in the container — they need a logged-in
account and Widevine. They attach over CDP to a browser you start yourself:

```
cp -r ~/.config/<browser>/WidevineCdm .cache/helium-profile/   # a fresh profile has no CDM
helium --user-data-dir=$PWD/.cache/helium-profile --remote-debugging-port=9222 \
  --load-extension=$PWD/client/extension/dist https://laftel.net/player/45462/93304
# log in; for §15 open the same episode in a second, visible window
node harness/browser/probe-laftel.mjs                        # §14
./server/videosyncd -addr 127.0.0.1:8787 -verbose &
TRIALS=10 node harness/browser/probe-laftel-room.mjs          # §15
```

The extension probes need `client/extension/npm run build` as well as the two
artifacts above.

§20–21 (`probe-acquire.mjs`) attach to the dedicated Helium and Firefox the same
way. Build the probe copies with `NAME=ext-control` / `NAME=ext-fixed node
harness/browser/local-ext.mjs` and start Helium on one of them
(`--load-extension=.cache/<name>/chromium`), with `local-media.mjs` on :8898 and
`videosyncd -verbose` logging to `.cache/run/server.log`:

```
SCEN=M6,M1,M2,M3,M5 node harness/browser/probe-acquire.mjs      # local media, Helium
BROWSER=firefox SCEN=FF node harness/browser/probe-acquire.mjs  # M1/M2/M6/M4, Firefox
N=3 SCEN=L1,L2,L3,L5 node harness/browser/probe-acquire.mjs     # Laftel, logged in
SITE=youtube SCEN=L5 node harness/browser/probe-acquire.mjs     # Y5
SCEN=CONTROL BUILD=... LABEL=... CASES='^(A|B|D|E|G|P)' node harness/browser/probe-acquire.mjs
```

§22's smoke runs are driven by the scripts in `harness/browser/results/drivers/`,
against the same Helium with a `local-ext.mjs` build loaded from a path it has
never loaded before (see §22 for why):

```
KEY_FILE=<file with the key> node harness/browser/results/drivers/auth-smoke.mjs  # videosyncd -auth token -auth-tokens-file <same file> -auth-scope create
EXT_ID=<build id> node harness/browser/results/drivers/providers-smoke.mjs         # videosyncd -providers <dir holding drivers/localmedia.json>
```

A driver writes the cited `auth-smoke.json` / `providers-smoke.json` only when
every check passes; a failed or aborted run goes to `<name>-failed.json`, and
`RESULT=<name>` names the file outright. `probe-firefox.mjs` takes `RESULT=`
too, so a new run need not overwrite a cited `firefox-*.json`.

`DOCKER_TTY=-i` runs it without a terminal (for CI or a non-interactive shell).
The container needs `--shm-size=1g`; Chrome's renderer hangs on the default
64 MB `/dev/shm`. Test media regenerates itself on first run via `ffmpeg`;
`media/` and `dist/` are gitignored because both are derived, not source.
