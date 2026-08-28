# SyncWatch & WatchBear — extension engineering deep dive

Clones:
- `refs/syncwatch` — full source, git history intact. Last commit `263d599b` 2025-05-12. MIT. 177 stars, 12 open issues, 29 forks (GitHub API, fetched live).
- `refs/watchbear` — **this repo contains only the marketing/landing site** (`apps/landing/*`). `Readme.md:16-17` states outright: "This repository hosts the watchbear.deepfeld.com landing page." `git log --all` shows a single commit. There is no `manifest.json`, no content script, no background worker anywhere in the clone. 21 stars, 1 open issue (GitHub API, fetched live), pushed 2026-08-22 (landing-page commit).
  - Because the brief's sections 12-15 are specifically about extension engineering, and the actual shipped extension is a public Chrome Web Store artifact (id `ldegfikaldilbcpgmiopdnnhpkpcnepn`, linked from `Readme.md:11`), I additionally pulled the **live CRX** (`v0.6.3`) via `https://clients2.google.com/service/update2/crx?...&x=id%3Dldegfikaldilbcpgmiopdnnhpkpcnepn%26uc` and unzipped it to `/tmp/.../scratchpad/wb/`. This is **not part of the git clone** — every citation into it is marked `[CRX]` with the path relative to that scratchpad `wb/` directory. Files are Vite-bundled and minified (near-single-line), so "line" is `:1` for most; I locate claims by nearby unique substrings instead. Treat `[CRX]` findings as compiled-artifact-derived, not "the reference clone."
  - Supplementary: `refs/watchbear/apps/landing/privacy.html` (in the clone) is a real, specific technical privacy policy — not boilerplate — and independently corroborates several `[CRX]` findings (permissions list, what's synced, WebSocket use). Cited as `[privacy.html]`.

---

## 1. Overview

### syncwatch
TypeScript monorepo (npm workspaces), built with **wxt** (web extension framework) + React 19 for popup/options UI, `socket.io-client` for transport. `package.json:1-30` (root), `packages/syncwatch-extension/package.json:1-27`. Packages: `syncwatch-extension`, `syncwatch-server` (Node/Express/Socket.IO), `syncwatch-types` (shared types), `syncwatch-locales`. License MIT (`LICENSE.md:1-3`, copyright Semyon Rozhkov 2018-2024). Last commit 2025-05-12; 177 stars / 12 open issues / 29 forks per GitHub API. Generic HTML5 `<video>` extension with one hardcoded special case: Netflix.

### watchbear
No source in the clone — only the landing page (Astro/static HTML, `refs/watchbear/apps/landing/index.html`). License: Apache-2.0 for the landing repo (`refs/watchbear/LICENSE`, `NOTICE`). Author "Halit Sever" (`refs/watchbear/NOTICE:2`). From the live CRX `[CRX] manifest.json`: name "Watchbear: Watch Together & Watch Party Sync", version `0.6.3`, MV3, Vite-bundled (chunk hashes like `main.ts-BYJik54R.js` are Vite/Rollup output naming). Requires Google sign-in on the public server (`privacy.html:223`). 21 stars / 1 open issue per GitHub API; the extension itself (per Chrome Web Store, outside scope of "clone") is separately versioned from the landing repo and evidently under active development (v0.6.3, feature set includes room anchoring/auto-follow not present in syncwatch at all).

---

## 2. Transport & message schema

### syncwatch
`socket.io-client` over WebSocket only (`transports: ['websocket']`, no polling fallback), `packages/syncwatch-extension/entrypoints/background.ts:257-264`. Server: `socket.io` (`packages/syncwatch-server/server.ts:26`).

Verbatim shapes, `packages/syncwatch-types/types.ts`:
```ts
// :42-48
export interface RoomEvent {
  location: string;      // iframe path, e.g. "-1" (top) or "-10" (1st child of top's 0th frame...)
  type: MediaPlayerEvent; // 'play' | 'pause' | 'seeked'
  element: number;        // index into that frame's `nodes` array
  currentTime: number;
  playbackRate: number;
}
// :50-56
export interface ServerToClientsEvents {
  usersList: (msg: { list: UserList }) => void;
  message: (msg: RoomEvent) => void;
  share: (msg: Share) => void;
  afk: () => void;
  error: (msg: ErrorEventSocket) => void;
}
// :58-62
export interface ClientToServerEvents {
  share: ServerToClientsEvents['share'];
  join: (msg: User) => void;   // { name, room }
  message: ServerToClientsEvents['message'];
}
```
Only one client→server event carries sync data (`message`), server rebroadcasts it verbatim to the room (`server.ts:189-197`, `socket.broadcast.to(room.name).emit('message', room.event)`).

### watchbear
`[CRX] assets/server-BV_GEN6f.js:1` — also Socket.IO/engine.io client (raw engine.io packet types `open/close/ping/pong/message/upgrade/noop` visible in the bundle), so also WS-based (with the standard engine.io polling→WS upgrade probe, not restricted to `transports:['websocket']` the way syncwatch is).

Two separate Socket.IO namespaces/connections are opened:
- **Video-sync channel**, built in `Je(e,t,n)` (`[CRX] server-BV_GEN6f.js`, near `video:subscribe`):
```js
// client -> server, on connect:
socket.emit('video:subscribe', { code, anchor, name, key, url, title })
// client -> server, on state push:
socket.emit('video:control', { code, time, paused, rate })
// client -> server, on URL change:
socket.emit('video:content', { key, url, title })
// server -> client:
socket.on('video:control', e => onControl(e))     // { time, paused, rate }
socket.on('reaction:show', e => onReaction(e))     // emoji burst
socket.on('room:content', e => onContent(e))       // peer's { key, url, title }
```
- **Room/chat channel** (side panel), built in `Ye(e,t,n,r)`:
```js
socket.emit('room:join', { code, member })
socket.emit('chat:send', { text, ... })
socket.emit('chat:typing', { typing })
socket.emit('reaction:send', { emoji })
socket.emit('member:update', { member })
socket.emit('room:leave')
socket.on('room:members', e => ...)   // { members }
socket.on('chat:message', ...)
socket.on('chat:typing', ...)
socket.on('room:system', e => ...)    // { text }
socket.on('room:content', ...)
socket.on('room:denied', ...)         // e.g. code taken / invalid
socket.on('room:replaced', ...)       // another tab took over this session
```
`privacy.html:288-300` corroborates: "the extension connects to the sync server over a real-time (WebSocket) connection," listing chat messages, typing indicators, and emoji reactions as transmitted room data.

---

## 3. Clock synchronization

### syncwatch
**NONE on the client.** No `Date.now()`, ping/RTT sampling, or offset math anywhere in `entrypoints/content.ts` or `entrypoints/background.ts` (`rg` for `Date.now|ping|latency|offset` in the extension package returns zero hits). The only clock compensation is **server-side**, applied once, at join time, to extrapolate a paused-vs-playing snapshot forward: `packages/syncwatch-server/server.ts:170-176`
```ts
room.event.currentTime =
  room.event.type === 'play'
    ? room.event.currentTime + (Date.now() - room.timeUpdated) / 1000
    : room.event.currentTime;
// Time is about second earlier then needed   <- verbatim comment, i.e. known-inaccurate
socket.send(room.event);
```
No compensation is applied to the live `message` broadcast path (`server.ts:189-197`) — mid-session sync relies purely on event replay with no RTT/latency correction at all.

### watchbear
Not evidenced. The engine.io "ping" visible in `[CRX] server-BV_GEN6f.js` is the transport-level heartbeat/keepalive (`_pingInterval`/`_pingTimeout`, `onHandshake`), not an application-level clock-offset mechanism. No `Date.now()`-based offset math was found in the client bundle. The actual sync server (`watchbear-server.deepfeld.com`) is not in scope (closed, not in any clone) — whether it does join-time extrapolation like syncwatch's server is **ABSENT/unknown**.

---

## 4. Drift correction policy

### syncwatch
**ABSENT.** There is no periodic drift check at all — sync only happens on discrete events (`play`/`pause`/`seeked`/`ratechange`/`progress`→synthesized `play`/`pause`), each one just does a direct assignment, no deadband:
`entrypoints/content.ts:180-181`
```ts
element.playbackRate = event.playbackRate;
element.currentTime = event.currentTime;
```
Every remote event unconditionally hard-seeks, regardless of how small the delta is. No `playbackRate` nudging for smoothing is used anywhere.

### watchbear
Deadband + hard seek, no rate-nudge smoothing. `[CRX] assets/main.ts-BYJik54R.js:1`, constants declared at module scope (`var d=10800,f=.5,p=400,...`) and applied in the shared `v(video, target)` function:
```js
var f = .5;   // deadband, seconds
function v(video, target) {
  if (Math.abs(video.currentTime - target.time) > f)
    (isNetflix ? postMessageSeek(target.time) : video.currentTime = target.time);
  if (typeof target.rate === 'number' && video.playbackRate !== target.rate)
    video.playbackRate = target.rate;
  if (target.paused && !video.paused) video.pause();
  else if (!target.paused && video.paused) video.play();
}
```
Exact constant: **500ms deadband**. Corrections are event-driven (on receipt of `video:control`), not a periodic drift-check loop — but the deadband itself means small, expected float jitter from event-driven `currentTime` reports doesn't cause seek-thrash. `playbackRate` is only ever *set to match* the peer's rate (e.g. someone changed 1x→1.5x), never used as a gentle drift-correction nudge.

---

## 5. Echo suppression

### syncwatch
Stateful global flag pair, no timeout — `entrypoints/content.ts:20-21,90-104`:
```ts
let recieved = false;
let recievedEvent: RoomEvent['type'];
...
function onEvent(event) {
  if (recieved) {
    if (recievedEvent === 'play') {
      if (event.type === 'progress') { onProgress(event); recieved = false; }
      else if (event.type === 'playing') recieved = false;
    } else if (recievedEvent === 'pause') {
      if (event.type === 'seeked') recieved = false;
    } else if (recievedEvent === event.type) recieved = false;
  } else if (event.type === 'seeked') {
    if (event.target.paused) broadcast(event);
  } else if (event.type === 'progress') { onProgress(event); }
  else broadcast(event);
}
```
`fireEvent` (`content.ts:167-169`) sets `recieved = true; recievedEvent = event.type;` right before applying the remote state. The guard is a single global boolean shared across **all** `<video>` elements on the page/frame (not keyed by element), and it has **no timeout** — see §10 for the stuck-flag bug this causes.

### watchbear
Boolean guard **with a 400ms timeout**, encapsulated per-controller object — `[CRX] assets/main.ts-BYJik54R.js:1`, class `y` (direct-video controller):
```js
class y {
  applyingRemote = false; timer;
  constructor(video){ video.addEventListener('play', this.onEv); /* pause, seeked, ratechange */ }
  onEv = () => { if (!this.applyingRemote) this.cb?.(); };  // only forward if NOT self-applied
  apply(state) {
    this.applyingRemote = true;
    clearTimeout(this.timer);
    v(this.video, state);                    // does the actual seek/rate/play/pause
    this.timer = setTimeout(() => { this.applyingRemote = false; }, 400);
  }
}
```
`p = 400` (ms) declared at module scope, reused identically in the subframe reporter (class-less closure `S()`, function `h(t)`: `r=true; clearTimeout(i); v(e,t); i=setTimeout(()=>{r=false}, p)`). Self-healing: any burst of native events fired synchronously by the seek/pause/play calls is swallowed for a flat 400ms window, then automatically re-armed — no dependency on a specific expected event type arriving.

---

## 6. Conflict resolution without a host

### syncwatch
Server-side **last-write-wins**, no sequencing at all: `server.ts:189-197`
```ts
socket.on('message', (msg) => {
  const room = roomid.get(socket.id);
  if (!room) return;
  room.event = msg;
  room.timeUpdated = Date.now();
  socket.broadcast.to(room.name).emit('message', room.event);
});
```
Whichever client's socket message the server processes last simply overwrites `room.event`; there's no Lamport/vector clock, no monotonic counter, no server timestamp comparison against the previous event. Two clients issuing simultaneous conflicting commands both get broadcast to everyone else in send order — genuinely unhandled, first documented as such by the brief's own taxonomy ("last-write-wins on server receive order," not even server timestamp).

### watchbear
Partially handled via an explicit **"anchor" tab** concept, which is closer to a soft, reassignable host than "no host": `[CRX] assets/service-worker.ts-B_dga-6L.js:1`, keys `anchorTabId`/`watchTabId` in `chrome.storage.local`, and a message type `WB_CLAIM_HOST` that only takes effect `if (anchorTabId is unset)` (`e[a.anchorTabId]??chrome.storage.local.set(...)`  — nullish-coalescing assignment, i.e., first-claimer wins, no contest). The anchor's browser navigation can auto-drag other members' tabs along (the "auto-follow" feature, §13). For pure playback state (`video:control`), no ordering/versioning logic is visible client-side — conflict resolution for simultaneous play/pause/seek is **not evidenced** in the CRX bundle (server-side, out of reach).

---

## 7. Buffering / readiness gating

### syncwatch
No cross-client readiness handshake exists. The closest thing is a **local** stall→pause heuristic that turns a stall into a broadcast `pause`, i.e. it makes *other* clients wait implicitly by pausing them too: `entrypoints/content.ts:78-85`
```ts
function onProgress(event) {
  const prevLoading = loading;
  loading = event.target.readyState < 3;
  if (prevLoading === false && loading === true) broadcast(event); // sends type:'pause'
}
```
There's no "I'm ready" / "everyone ready, resume" aggregation on the server (`Room` class in `server.ts:71-124` tracks only `users`, `event`, `share`, `afkTimer` — no readiness map).

### watchbear
Not evidenced in the client bundle. `readyState` does not appear in `[CRX] assets/main.ts-BYJik54R.js`. No buffering-aggregation logic found.

---

## 8. Provider coupling

### syncwatch
Generic HTML5 `<video>` is the default path; **one hardcoded per-site seam for Netflix**, selected by hostname check.
- Seam: `entrypoints/content.ts:130-133` `isNetflix()` → branches `fireEvent` (`:167-175`) into `fireEventNetflix` (`:135-165`), which `window.postMessage`s `{action, time}` instead of touching `element.currentTime` directly.
- The actual Netflix player control lives in a **separate file injected into the page's MAIN world** via a `<script>` tag appended to `<head>` (`public/js/players/netflix/loadNetflix.js:1-8`), not via `chrome.scripting.executeScript` or a manifest `world: "MAIN"` content script — this predates that MV3 API. That injected script (`public/js/players/netflix/netflix.js:1-34`) reaches into `window.netflix.appContext.state.playerApp.getAPI().videoPlayer` and calls `.play()/.pause()/.seek(ms)/.setPlaybackRate()` on Netflix's internal player object, bypassing the `<video>` element entirely.
- Video discovery: `document.getElementsByTagName('video')` re-run from a `MutationObserver` on `document.documentElement` (`content.ts:116-120, 197-204`) — see §13.

### watchbear
Generic `<video>` is default; Netflix gets the same *kind* of seam but implemented with the modern MV3 primitive: `world: "MAIN"` in the manifest's `content_scripts` entry (`[CRX] manifest.json`, second `content_scripts` block, `matches: ["*://*.netflix.com/*"]`, `world: "MAIN"`), running `netflix-main.ts-DunkIa0k.js` directly in the page context — no `<script>`-tag self-injection needed. That script listens for a namespaced `postMessage` (`__wbnf:1, kind:'seek'`) and calls Netflix's internal `videoPlayer.seek(ms)` API — same pattern as syncwatch (bypass the `<video>` element for seeks on Netflix), but **only for seek**; play/pause is left to the underlying `<video>` element directly (unlike syncwatch, which routes play/pause through Netflix's API too).

---

## 9. Room, identity & auth model

### syncwatch
No auth at all. `join` just validates name/room length server-side (`server.ts:63-69`, 2-24 chars each) and joins a Socket.IO room keyed by the room name string — no password, no room persistence beyond the in-memory `Room` object which is deleted the instant it empties (`server.ts:213-216`). Rate limiting is a flat per-socket token bucket, not identity-based: `rate-limiter-flexible`, 10 points/sec, 15s block, applied via `socket.onAny` (`server.ts:47-53, 148-153`). AFK auto-kick after 60 minutes alone in a room (`server.ts:28, 101-103, 117-123`).

### watchbear
Google OAuth via `chrome.identity.launchWebAuthFlow` is required to start/join a room on the public server: `[CRX] assets/auth-D6Aaolyr.js:1` builds `https://accounts.google.com/o/oauth2/v2/auth?...&response_type=id_token&scope=openid email profile&nonce=...`, then exchanges the id_token with `https://watchbear-server.deepfeld.com`. Confirmed independently by `privacy.html:268-281` ("signing in with Google is required to start or join a watch party on the default public server... your account record stays in the server's database until you ask us to remove it"). Room codes are client-generated, not server-assigned: `[CRX] assets/room-CeaCaYLJ.js:1`, pattern `/^[A-Z]{2,8}-[A-Z0-9]{4,12}$/`, built from a fixed word list (`BEAR/DEN/CUB/PAW/FUR/HONEY/OAK/PINE`) + `crypto.getRandomValues` suffix — collision handling is server-side (`room:denied` event exists, per §2, but the logic isn't in the client). Anonymous local identity (a random "bear" name + fur color, no login) is assigned by default and only escalated to Google auth when the public server is used (`auth-D6Aaolyr.js:1`, function `t()`). Rate limiting: **not evidenced** client-side; server out of scope.

---

## 10. What's broken / unmaintained / worth NOT copying

### syncwatch
- **`recieved` flag can get permanently stuck**, silently dropping all future local events. It's cleared only by specific event types: remote `play` clears on `progress`(loading) or `playing` — but if the video was already playing before `element.play()` is called, the browser fires **no** `playing` event (no-op play), so the flag never clears (`content.ts:90-95`). Same shape for `pause`→cleared only by `seeked` (`:96-98`); a seek to the same position is sometimes a no-op with no `seeked` firing. One global flag, not per-video, not per-frame, no timeout — a single stuck frame silences the whole page's sync forever until reload.
- **`nodes.indexOf(event.target)` as cross-client element identity** (`content.ts:66`) against an array that's fully rebuilt (`Array.from(nodesCollection)`, `:119`) on *every* DOM mutation via an undebounced `MutationObserver({childList:true, subtree:true})` on `document.documentElement` (`:197-204`). Index stability across two different browsers' DOM orderings, or even across a re-run of `init()` on the same client, is not guaranteed.
- **Netflix `setPlaybackRate` is unconditional** on every message (`public/js/players/netflix/netflix.js:18`), but `fireEventNetflix` (`content.ts:135-165`) never includes `playbackRate` in any of the `postMessage` payloads it sends — `event.data.playbackRate` is `undefined` on every Netflix sync message, so every remote event silently sets the Netflix player's rate to `undefined`.
- **No `event.source`/`event.origin` check** in the Netflix injected script's `window.addEventListener('message', ...)` (`netflix.js:15`) — any script on the Netflix page (any ad, any other extension) can drive playback.
- Typo'd but load-bearing identifier (`recieved`/`recievedEvent`) throughout — cosmetic, but signals this file hasn't had a close read/refactor pass.
- No readiness gating (§7) and no drift deadband (§4) — every remote event is a hard seek, so on flaky connections this will visibly stutter/seek-thrash rather than degrade gracefully.

### watchbear
Cannot audit server-side conflict handling, rate limiting, or clock sync — closed source. Client-observed rough edges (from the CRX, caveat as compiled-artifact reading):
- The "anchor"/auto-follow navigation feature (§6, §13) is a real host-like asymmetry despite room language suggesting a peer-to-peer watch party — worth naming explicitly if the goal is genuinely host-free.
- `WB_CLAIM_HOST`'s "first claim wins, no contest" (`??` nullish-assign) means a race between two tabs claiming anchor status at the same instant is resolved by service-worker message-processing order, not by any explicit tie-break rule — same class of problem as syncwatch's last-write-wins, just for navigation-anchor instead of playback state.

---

## 11. Top 5 ideas worth stealing

1. **400ms guarded-boolean echo suppression with per-controller encapsulation, not a global flag.** watchbear `[CRX] assets/main.ts-BYJik54R.js:1`, class `y.apply()` — `applyingRemote=true` + `clearTimeout`/`setTimeout(400)` re-arm on every apply, scoped per video-controller object rather than one page-global flag. Strictly more robust than syncwatch's stuck-flag design (§10) and simpler than tracking specific expected follow-up event types.
2. **Cross-frame video election via `postMessage` "announce/state/gone" handshake, driven from every frame via `all_frames:true`.** watchbear `[CRX] assets/main.ts-BYJik54R.js:1`, functions `x()` (top frame) / `S()` (subframes): every frame in the page independently finds and measures its own largest `<video>`, reports `{area, duration}` up to `window.top` via `postMessage`, and the top frame picks the globally largest-area candidate (`L()`), including a minimum-area floor (`d=10800`) to reject small ad/thumbnail videos. This solves cross-origin iframe video discovery (you can't reach into a cross-origin iframe's DOM directly, but you *can* run a content script inside it and have it self-report) — syncwatch's `iframeFullIndex` scheme (`content.ts:32-54`) only *addresses* a video once selected, it never solves *which* frame/video is the right one when there are several.
3. **Deadband-then-hard-seek with an explicit named constant (`0.5s`) plus separate rate/pause reconciliation**, all three (time/rate/paused) applied idempotently in one small pure function (`v(video,target)`, watchbear `[CRX] main.ts-BYJik54R.js:1`). syncwatch has no deadband and mixes the three concerns into event-type-specific branches (`content.ts:183-192`).
4. **Visibility-gated apply-and-buffer for background/hidden tabs.** watchbear `[CRX] assets/main.ts-BYJik54R.js:1`, functions `H(e)`/`U()`: when a remote `video:control` event arrives while the tab is hidden (`document.visibilityState !== 'visible'`), it's stashed in a pending slot (`f = e`) instead of applied immediately; on `visibilitychange` back to visible, `U()` replays exactly the latest pending command and discards any it superseded. Avoids both wastefully seeking a backgrounded/throttled video repeatedly and applying a stale mid-sequence state — syncwatch applies every event immediately regardless of tab visibility, for every event in the queue. (Weaker alternative considered: syncwatch's server-side join-time `currentTime` extrapolation, `server.ts:170-176` — real but caveated by its own comment as ~1s inaccurate, and, per §3, not applied to the live broadcast path at all, only at join.)
5. **`fullscreenchange` listener that re-parents the sync UI into `document.fullscreenElement`.** watchbear `[CRX] main.ts-BYJik54R.js:1`, `document.addEventListener('fullscreenchange', ...)` moves the `#wb-reactions` div into whatever `F()` (fullscreen-aware container resolver) returns, so emoji reactions keep rendering during native fullscreen. Directly answers the "how do you render UI over fullscreen video" problem from §15 — even though it's solved only for the reaction-burst layer, not full chat (see §15).

---

## 12. Manifest & permissions

### syncwatch
MV2 (Firefox) **and** MV3 (Chrome) generated from a single source file using a custom `{{browser}}.key` prefix convention, not two separate manifest.json files:

`packages/syncwatch-extension/manifest.ts` (full, verbatim):
```ts
const manifest = {
  '{{firefox}}.manifest_version': 2,
  '{{chrome}}.manifest_version': 3,
  name: '__MSG_appName__',
  description: '__MSG_appDesc__',
  default_locale: 'en',
  options_ui: { page: 'options.html', open_in_tab: false },
  '{{firefox}}.background': { persistent: true, scripts: ['js/background.ts'] },
  '{{chrome}}.background': { service_worker: 'js/background.ts' },
  icons: { '16': ..., '32': ..., '48': ..., '96': ..., '128': ... },
  '{{firefox}}.browser_action': { default_icon: ..., default_title: 'SyncWatch', default_popup: 'popup.html' },
  '{{chrome}}.action': { default_icon: {...}, default_title: 'SyncWatch', default_popup: 'popup.html' },
  '{{chrome}}.incognito': 'split',
  '{{firefox}}.permissions': ['<all_urls>', 'tabs', 'storage', 'notifications'],
  '{{chrome}}.permissions': ['tabs', 'storage', 'notifications'],
  '{{chrome}}.host_permissions': ['<all_urls>'],
  content_scripts: [{ matches: ['https://www.netflix.com/*'], js: ['js/players/netflix/loadNetflix.js'] }],
  '{{firefox}}.web_accessible_resources': ['js/players/netflix/netflix.js'],
  '{{chrome}}.web_accessible_resources': [{ resources: ['js/players/netflix/netflix.js'], matches: ['https://www.netflix.com/*'] }],
  '{{firefox}}.browser_specific_settings': { gecko: { id: '{7558bb02-8595-4b93-b3bc-9f34319e9c4a}' } },
} as const;
```
Build: `wxt.config.ts:4-22` — `getBrowserSpecificManifest(browser, manifest)` walks every key, regex-matches `^\{\{(.+)\}\}\.(.+)/` (e.g. `{{chrome}}.permissions`), and for each key keeps it only if the bracketed browser name matches the current target, stripping the prefix; un-prefixed keys (like `name`, `icons`) pass through unchanged for both. `wxt build` / `wxt build -b firefox` (`package.json` scripts `build`/`build:firefox`) each re-run this with `browser` set accordingly, producing genuinely different `manifest.json` per target from one TS source. **`manifest.ts`'s own `content_scripts` array is Netflix-only** (`manifest.ts`, `content_scripts: [{ matches: ['https://www.netflix.com/*'], ... }]`, no generic entry). The generic video-sync content script is instead declared entirely inside `entrypoints/content.ts:4-7` via `defineContentScript({ matches: ['<all_urls>'], allFrames: true, runAt: 'document_end' })` — a separate, wxt-specific declaration site from `manifest.ts`. (How wxt reconciles the two into one final built `manifest.json` is a wxt build-tool behavior I did not directly inspect — not verified here, just the two source declarations.) No `world: "MAIN"` content script; Netflix's page-context script is injected manually (see §8).

### watchbear
`[CRX] manifest.json`, MV3 only (no Firefox variant found or referenced — the Chrome Web Store URL in `Readme.md:11` is the only distribution channel in evidence):
```json
{
  "manifest_version": 3,
  "name": "Watchbear: Watch Together & Watch Party Sync",
  "version": "0.6.3",
  "action": { "default_popup": "src/popup/index.html", ... },
  "side_panel": { "default_path": "src/sidepanel/index.html" },
  "background": { "service_worker": "service-worker-loader.js", "type": "module" },
  "content_scripts": [
    {
      "js": ["assets/main.ts-loader-DHR3TcOC.js"],
      "matches": ["<all_urls>"],
      "css": ["src/content/content.css"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_about_blank": true
    },
    {
      "js": ["assets/netflix-main.ts-DunkIa0k.js"],
      "matches": ["*://*.netflix.com/*"],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ],
  "permissions": ["storage", "activeTab", "scripting", "sidePanel", "identity", "tabGroups"],
  "host_permissions": ["<all_urls>"],
  "web_accessible_resources": [
    { "matches": ["<all_urls>"], "resources": ["assets/auth-D6Aaolyr.js", "assets/room-CeaCaYLJ.js", "assets/server-BV_GEN6f.js", "assets/chunk-QTnfLwEv.js", "assets/main.ts-BYJik54R.js"], "use_dynamic_url": false },
    { "matches": ["*://*.netflix.com/*"], "resources": ["assets/netflix-main.ts-DunkIa0k.js"], "use_dynamic_url": false }
  ]
}
```
`privacy.html:324-329` independently confirms and explains each permission (`storage`: save name/color/server/room; `activeTab`+`scripting`: detect/sync the active tab's video; `sidePanel`: chat+reactions UI; `<all_urls>` host permission: "a watch party can happen on any site with a video player"). `identity` and `tabGroups` aren't mentioned in the privacy copy but are used for `chrome.identity.launchWebAuthFlow` (Google OAuth, §9) and grouping party tabs with a 🐻 emoji label (`[CRX] service-worker.ts-B_dga-6L.js:1`, function `l()`, `chrome.tabs.group`/`chrome.tabGroups.update`). Uses the modern `world: "MAIN"` declarative content script for Netflix (contrast with syncwatch's manual `<script>`-tag injection, §8) plus a small `main.ts-loader` that dynamic-`import()`s the real (web-accessible) content script bundle — i.e. the actual isolated-world logic is loaded as a *web-accessible resource*, not embedded directly as the declared content script, presumably for smaller declared-script parse time / lazy loading.

---

## 13. Video element discovery

### syncwatch
`document.getElementsByTagName('video')`, re-run from scratch on every DOM mutation, no debounce:
```ts
// content.ts:106-120
function addListeners(nodesCollection) {
  for (const node of nodesCollection) { for (const eventType of eventTypes) node.addEventListener(eventType, onEvent, true); }
}
function init() {
  const nodesCollection = document.getElementsByTagName('video');
  addListeners(nodesCollection);
  nodes = Array.from(nodesCollection);
}
init();
const observer = new MutationObserver(() => { init(); });
observer.observe(document.documentElement, { childList: true, subtree: true });
```
- **Multiple videos**: no ranking/filtering at all — every `<video>` on the page gets listeners; whichever one first fires an event wins the broadcast (`element: nodes.indexOf(event.target)`).
- **Ads**: no size/visibility heuristic to exclude small/hidden video elements — an ad `<video>` is treated identically to the main content video.
- **Iframes**: content script runs `allFrames: true` (`content.ts:5-7`), so same-origin *and* cross-origin iframes each get their own independent instance of this logic; cross-frame targeting is done purely by an iframe-path string (`iframeFullIndex`, `:32-54`) embedded in every message, matched against the same computed path in the receiving frame (`:207-212`) — there is no video-quality/size arbitration *across* frames the way watchbear does (see §12 idea #2).
- **Shadow DOM**: not handled — `getElementsByTagName` does not pierce shadow roots.
- **SPA route changes**: not detected explicitly by URL; relies entirely on the DOM `MutationObserver` re-running `init()` whenever any `childList`/`subtree` mutation happens anywhere in `document.documentElement` — works incidentally for SPA video swaps because they mutate the DOM, but is not a deliberate SPA-navigation detector and re-scans on unrelated DOM churn too.
- **Video destroyed/recreated**: implicitly handled the same way — `init()` rebuilds `nodes` from a fresh `getElementsByTagName` call, so a removed-and-re-added `<video>` gets picked up on its next mutation event, but any in-flight `nodes.indexOf` reference from a message already in transit can point at a stale index.

### watchbear
`[CRX] assets/main.ts-BYJik54R.js:1`, function `_()`:
```js
function _() {
  let e = [...document.querySelectorAll('video')];
  return e.length === 0 ? null : e.map(e => ({ v: e, area: e.clientWidth * e.clientHeight })).sort((a,b) => b.area - a.area)[0].v;
}
```
- **Multiple videos**: picks the **largest rendered video by `clientWidth*clientHeight`** — a real heuristic, not "first in DOM order."
- **Ads**: same largest-wins heuristic plus, for cross-frame candidacy, a hard minimum area floor `d = 10800` px² (roughly 120×90) below which a frame's reported video is ignored entirely when picking the room's synced video (`L()` function, `[CRX] main.ts-BYJik54R.js:1`) — directly targets small ad/preview players.
- **Iframes (cross-origin)**: solved via the `postMessage` announce/state/gone protocol described in §11 idea #2 — each frame (content script runs with `all_frames: true`, `manifest.json` content_scripts[0]) independently discovers its own best video and reports up to `window.top`; no direct cross-origin DOM access is needed or attempted.
- **Shadow DOM**: `querySelectorAll('video')` does not pierce shadow roots — same limitation as syncwatch, not handled.
- **SPA route changes**: **polled explicitly**, not MutationObserver-driven — `K()` function compares `location.href` to a stored value every second (`window.setInterval(K, 1000)`) plus a `popstate` listener (`W()`/`G()`, `main.ts-BYJik54R.js:1`); on change it tears down the current video controller, clears reported-frame state, and re-runs discovery. This SPA detection also feeds the "auto-follow" feature (§6/§8): it computes a canonical content key per URL (`c(url)`, strips known tracking params, special-cases YouTube `v=`) and, if the anchor navigated to a materially different video, other room members' tabs can auto-navigate (`P(e)`, sets `window.top.location.href`) or be prompted, governed by `l(...)`'s `navigate`/`prompt`/`none` decision.
- **Video destroyed/recreated**: explicitly checked, not just incidental — the subframe reporter's poll loop (`m()`, interval `a`, 1000ms) calls `document.contains(e)` on the currently-tracked video and, if it's gone, tears down listeners and sends a `gone` postMessage so the top frame re-elects a candidate (`f(true)` inside `m()`); the top frame's own selection loop (`L()`, also on a 1000ms interval `p`) re-runs `_()` from scratch each tick, so a removed/replaced top-frame video is naturally re-discovered too.

---

## 14. Event listener set & echo suppression, verbatim

### syncwatch
```ts
// content.ts:12
const eventTypes = ['playing', 'pause', 'seeked', 'ratechange', 'progress'] as const;
// content.ts:106-114
function addListeners(nodesCollection) {
  for (const node of nodesCollection) {
    for (const eventType of eventTypes) node.addEventListener(eventType, onEvent, true); // capture=true
  }
}
```
Guard (see §5 for full listing): module-scope `let recieved = false; let recievedEvent;`, set `true`/populated in `fireEvent` right before mutating the element (`content.ts:167-169`), cleared inside `onEvent` only on specific matching follow-up events (`:90-98`) — **no timeout fallback**.

### watchbear
```js
// [CRX] main.ts-BYJik54R.js:1 — main-frame direct controller (class y)
video.addEventListener('play', this.onEv);
video.addEventListener('pause', this.onEv);
video.addEventListener('seeked', this.onEv);
video.addEventListener('ratechange', this.onEv);
// subframe reporter (function S/u) registers the identical four events on its local video:
e.addEventListener('play', l); e.addEventListener('pause', l);
e.addEventListener('seeked', l); e.addEventListener('ratechange', l);
```
No `capture: true` (default bubbling phase, unlike syncwatch's explicit capture-phase listeners). No `'progress'`/`readyState` based synthetic-pause detection (contrast §7). Guard (full, see §5): `applyingRemote` boolean + `setTimeout(400)`, re-armed via `clearTimeout`+`setTimeout` on every `apply()` call, encapsulated per controller instance (one instance per elected video, torn down and recreated via `teardown()`/`R()` whenever the elected video changes) rather than a single page-global flag.

---

## 15. UI surface

### syncwatch
- **Popup** (`entrypoints/popup/popup.tsx`, React + `@gravity-ui/uikit`): name/room text inputs, connect/disconnect button, "share" button (broadcasts current tab's URL+title to the room, `:40-42`), a clickable shared-link row with favicon (`:128-137`), and a plain list of user names in the room (`:138-151`). **No chat UI, no message compose box, no reactions** — confirmed absent by reading the entire popup component.
- **Options page** (`entrypoints/options/options.tsx`): single text field for the sync-server URL, saved to `browser.storage.sync`.
- **No injected in-page overlay, no sidepanel.** The extension's only UI surfaces are the toolbar popup and the options page.
- **Fullscreen problem**: **not applicable** — since there is no chat/overlay UI to begin with, there's nothing that needs to render over a fullscreen video. This is a real, if minimal, way to "solve" the problem: syncwatch has no feature that would ever collide with fullscreen video.

### watchbear
Three UI surfaces, per `[CRX] manifest.json`: `action.default_popup` (`src/popup/index.html`), `side_panel.default_path` (`src/sidepanel/index.html`), and a content-script-injected floating layer (`src/content/content.css`, loaded by the `<all_urls>` content script) used specifically for **emoji reaction bursts** (`I(e)` function in `[CRX] main.ts-BYJik54R.js:1`, creates a `div#wb-reactions` with randomly-offset `.wb-reaction` children, positioned relative to the elected video's bounding rect when it's above the `d=10800` area floor, else relative to the full viewport).
- Chat + member list + typing indicators live in the **native Chrome `sidePanel`** (`privacy.html:328`: "sidePanel: to show the chat and reactions panel next to your video"), not an injected overlay — this sidesteps most of the "chat over fullscreen video" problem structurally, since the side panel is native browser chrome, not page content, and isn't fighting the page's own `fullscreen`/z-index stacking.
- The **reaction-burst layer specifically does handle true fullscreen**: `document.addEventListener('fullscreenchange', ...)` re-parents `#wb-reactions` into `document.fullscreenElement` (via helper `F()`, which resolves the fullscreen element or its parent if the fullscreen element is itself the `<video>`) so reaction emoji keep appearing after entering fullscreen (`[CRX] main.ts-BYJik54R.js:1`).
- Whether the native **side panel itself** (chat/typing/roster) remains visible/usable once the tab enters true OS/browser fullscreen (which normally hides all browser chrome including side panels) is **not evidenced** either way in the CRX or the landing copy — the reactions layer's special-cased re-parenting strongly suggests the developer specifically identified this as a problem *for the reactions layer* and did not find (or need) an equivalent fix for the side panel itself, since side panels are Chrome UI outside the page's control entirely.
- Popup (`src/popup/index.html`) contents are not further reverse-engineered here (out of scope relative to the sync-mechanics focus); its badge counter (`chrome.action.setBadgeText`, member count) is set from the service worker (`[CRX] service-worker.ts-B_dga-6L.js:1`, function `d(tabId)`/message handler for `ROOM_STATE`).
