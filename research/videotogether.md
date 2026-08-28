# VideoTogether — research notes

Clone: `refs/VideoTogether`. All paths below are relative to that clone root unless stated otherwise.

## 1. Overview

VideoTogether is a browser extension (Chrome MV3, Firefox, Safari, userscript, and a "website" mode) plus a Go relay server that lets multiple browsers watch the *same page's* `<video>` in lockstep. It is explicitly **not** hostless: the server enforces a single per-room "host" (`source/go-server/service.go:130-155`).

- **Stack**: extension = one giant vanilla-JS content script (`source/extension/vt.js`, 3735 lines) built from a template pipeline (`{{{ ... }}}` macros resolved at build time per target: chrome/firefox/safari/userscript/website — see `source/extension/config/*`). Server = Go (`source/go-server`, Go 1.18, `gorilla/websocket`, `unrolled/render`, plain `sync.Map` for storage — no DB).
- **License**: MIT (`LICENSE:1-3`, copyright "VideoTogether" 2025).
- **Maintenance**: the local clone has a single squashed commit, `3c61f12 "set IdleTimeout"`, dated 2026-02-09 (`git log -1`). The `main.go` prod path adds a `certManager` with 24h cert reload and sets `IdleTimeout: 120s` on the prod HTTP server (`source/go-server/main.go:106-113`), consistent with an actively-run production deployment (default host `vt.panghair.com:5000`, `source/extension/config/release_host:1`).
- Default build points the extension at the maintainer's own hosted server; self-hosting requires re-pointing `source/extension/config/release_host` at build time and running `source/go-server` yourself (`source/go-server/config.example.json`). There is no runtime/per-room server picker in the UI.

## 2. Transport & message schema

Primary transport is a single shared **WebSocket** (`wss://<host>/ws`), with an **HTTP GET-polling fallback** used whenever the socket path fails (extension checks `WS.getRoom()` and falls back to `fetch(.../room/update?...)`, `source/extension/vt.js:3585-3600`, `3624-3634`). The client re-triggers its whole sync loop (`ScheduledTask`) every **2 seconds** via `setInterval` (`source/extension/vt.js:1913`), regardless of which transport is active — so even the WS path is effectively poll-driven for outbound state, and push-driven (server broadcast) for inbound.

WS client → server request envelope (`source/extension/vt.js:461-501`):
```js
// method: "/room/update"  (host/master only — server rejects if you are not host)
{
  "method": "/room/update",
  "data": {
    "tempUser": extension.tempUser,
    "password": password,
    "name": name,
    "playbackRate": playbackRate,
    "currentTime": currentTime,
    "paused": paused,
    "url": url,
    "lastUpdateClientTime": localTimestamp,
    "duration": duration,
    "protected": isRoomProtected(),
    "videoTitle": extension.isMain ? document.title : extension.videoTitle,
    "sendLocalTimestamp": Date.now() / 1000,
    "m3u8Url": m3u8Url
  }
}
```
```js
// method: "/room/join"
{ "method": "/room/join", "data": { "password": password, "name": name } }
```
```js
// method: "/room/update_member"  (member heartbeat — no currentTime/paused fields at all)
{
  "method": "/room/update_member",
  "data": {
    "password": password, "roomName": name,
    "sendLocalTimestamp": Date.now()/1000,
    "userId": extension.tempUser, "isLoadding": isLoading, "currentUrl": currentUrl
  }
}
```

Server → all clients broadcast on any accepted `/room/update*` (`source/go-server/ws.go:66-74`, `582-594`):
```go
type WsRoomResponse struct {
    Method string       `json:"method"`
    Data   RoomResponse `json:"data"`   // RoomResponse = *Room + *TimestampResponse
}
```
`Room` (the wire shape members apply) — `source/go-server/service.go:322-354`:
```go
type Room struct {
    Name, Url, VideoTitle, M3u8Url, BackgroundUrl string
    LastUpdateClientTime, LastUpdateServerTime    float64
    PlaybackRate, CurrentTime, Duration           float64
    Paused, Public, Protected                     bool
    Uuid                                          string
    WaitForLoadding                               bool
    BeginLoaddingTimestamp                        float64
    MemberCount                                   int
}
```
Per-RTT timestamp reply used only on the WS path (`source/go-server/ws.go:604-610`, `604`):
```go
type TimestampV2Response struct {
    SendLocalTimestamp     float64 `json:"sendLocalTimestamp"`
    ReceiveServerTimestamp float64 `json:"receiveServerTimestamp"`
    SendServerTimestamp    float64 `json:"sendServerTimestamp"`
}
```
HTTP fallback endpoints mirror the same fields as GET query params: `/room/update`, `/room/get`, `/timestamp` (`source/go-server/http.go:67-70`, handlers at `152-212`).

## 3. Clock synchronization

**Continuous min-RTT NTP-style offset, piggybacked on every request** (not a dedicated ping burst). Every `/room/update` HTTP call and every WS `/room/update`/`/room/update_member` records `startTime`/`endTime` around the request and only *improves* `timeOffset` when the observed round trip is a new minimum:

```js
// source/extension/vt.js:3617-3623
async UpdateTimestampIfneeded(serverTimestamp, startTime, endTime) {
    if (typeof serverTimestamp == 'number' && typeof startTime == 'number' && typeof endTime == 'number') {
        if (endTime - startTime < this.minTrip) {
            this.timeOffset = serverTimestamp - (startTime + endTime) / 2;
            this.minTrip = endTime - startTime;
        }
    }
}
```
`minTrip` starts at `1e9` (`source/extension/vt.js:1873`) so the first sample always wins, and it is monotonically non-increasing thereafter — classic assume-symmetric-latency midpoint estimate, refined opportunistically over the life of the session rather than through an explicit ping phase. All local timestamps used for sync math go through:
```js
// source/extension/vt.js:2903-2905
getLocalTimestamp() { return Date.now() / 1000 + this.timeOffset; }
```
The server is authoritative for "now" (`Room.LastUpdateServerTime = h.vtSrv.Timestamp()`, `source/go-server/ws.go:574`) but the *offset math* happens entirely client-side; the server never adjusts anything based on client clocks.

## 4. Drift correction policy

Both thresholds are **hard `currentTime =` seeks**; there is no `playbackRate` nudging anywhere in the codebase (only `playbackRate` *mirroring* of the master's chosen rate, not drift compensation).

- While **playing**: reseek if predicted-vs-actual delta exceeds **1.0s** (`source/extension/vt.js:3487`):
  ```js
  if (Math.abs(videoDom.currentTime - this.CalculateRealCurrent(room)) > 1) {
      videoDom.currentTime = this.CalculateRealCurrent(room);
  }
  ```
- While **paused**: reseek if delta exceeds **0.1s** (`source/extension/vt.js:3494`):
  ```js
  if (Math.abs(videoDom.currentTime - room["currentTime"]) > 0.1) {
      videoDom.currentTime = room["currentTime"];
  }
  ```
- Members throttle how often they even evaluate this to once per second: `if (this.lastSyncMemberVideo + 1 > Date.now()/1000) return;` (`source/extension/vt.js:3463`).
- Combined with the 2s scheduler tick, real correction cadence is ~1-2s, with up to 1s of allowed drift before a hard jump — coarse but simple.

## 5. Echo suppression

There is **no "ignore next event" flag or event-source tagging**. Echo is avoided structurally by strict role asymmetry:
- Only the **Master/host** reads real DOM state and reports it (`videoDom.currentTime`, `.paused`, `.playbackRate` in `SyncMasterVideo`, `source/extension/vt.js:3292-3358`).
- Only the **Member** ever calls `videoDom.currentTime =`, `.play()`, `.pause()`, `.playbackRate =` (`SyncMemberVideo`, `source/extension/vt.js:3457-3538`).
- The member→server heartbeat (`WsUpdateMemberRequest`) carries no `currentTime`/`paused` fields at all (`source/extension/vt.js:492-501`), so a member's local `play`/`pause`/`seeked` events triggered by the sync code itself have no path back to the server — there is nothing to suppress because members are structurally incapable of writing room state.
- The one client-side listener on `play pause seeked` (`AddVideoListener`, `source/extension/vt.js:2858-2863`) only calls `setActivatedVideoDom` (candidate-video bookkeeping) and `CallScheduledTask` — it never re-broadcasts state, so applying a remote seek to a member's video can at most cause a redundant `ScheduledTask` tick, not a feedback loop.

Caveat: if a user is both host and simultaneously being driven by another source (e.g. two tabs racing to be host), this asymmetry doesn't help — see §6.

## 6. Conflict resolution without a host

Despite the extension UI presenting "Master"/"Member" roles, **the server enforces a literal single host per room**, so this is NOT actually hostless — it's host-election-then-lockout:

```go
// source/go-server/service.go:130-155
func (s *VideoTogetherService) GetAndCheckUpdatePermissionsOfRoom(...) (*Room, error) {
    room := s.QueryRoom(roomName)
    if room == nil { room = s.CreateRoom(...) }
    isNewUser := !room.QueryUser(userId)
    if isNewUser { room.NewUser(userId) }
    if room.password != roomPassword { return nil, errors.New(...HostWrongPassword) }
    if !room.IsHost(userId) {
        if isNewUser {
            room.setHost(userId)          // first-writer-wins: room has no host yet -> you become it
        } else {
            return nil, errors.New(GetErrorMessage(ctx.Language).OtherHostSyncing)  // rejected
        }
    }
    return room, nil
}
```
Confirmed by test `source/go-server/service_test.go:100-108` ("When user is not the host of the room and with correct password" → `returns not host error`, asserting `err.Error() == GetErrorMessage("").OtherHostSyncing`).

So: **first client to successfully call `/room/update` for a never-updated room becomes host for that room's lifetime (or until the room expires, 3 min idle — `main.go:70`)**; every other writer is simply rejected with an error surfaced to the user, not queued/merged/reconciled. There is no Lamport clock, no monotonic sequence, no last-write-wins by timestamp for the *conflicting-master* case — it's binary accept/reject by identity. WS path applies the same check (`source/go-server/ws.go:559-563`) and additionally hard-closes the socket if a client tries to claim two different room names (`ws.go:551-555`, `updatePanic` counter).

Two Master-role clients racing to update the *same already-hosted* room: the losing one gets `OtherHostSyncing` and (per `vt.js:3320-3320`) surfaces it as a red status message — user has to explicitly hand off/relinquish, there's no automatic tie-break beyond "whoever got there first keeps writing."

## 7. Buffering / readiness gating

Yes, the room waits, and "ready" is a **majority-style OR-aggregation of self-reported per-member loading state**, computed server-side:

```go
// source/go-server/service.go:379-400
func (r *Room) UpdateMemberData() {
    count := 0
    waitForLoadding := false
    r.members.Range(func(key, value any) bool {
        member := value.(*Member)
        if member != nil && member.IsJoined() {
            count++
            waitForLoadding = waitForLoadding || member.IsLoadding
        }
        return true
    })
    waitForLoadding = waitForLoadding && r.Duration != r.CurrentTime // ignore false-positive at video end
    ...
    r.WaitForLoadding = waitForLoadding
}
```
A member is "loading" client-side when its just-applied seek target hasn't been reached and `readyState < 3` (`isVideoLoadded`, `source/extension/vt.js:330-337`, threshold `HAVE_FUTURE_DATA`); this is computed in `SyncMemberVideo`'s trailing `setTimeout` and sent up via `/room/update_member`'s `isLoadding` field (`vt.js:3527-3538`). The master, on seeing `room.waitForLoadding == true`, force-pauses its own (already-playing) local video so the room doesn't advance while someone buffers:
```js
// source/extension/vt.js:3301-3306 (SyncMasterVideo)
if (data.waitForLoadding) {
    if (!videoDom.paused) { videoDom.pause(); this.playAfterLoadding = true; }
} else if (this.playAfterLoadding) { videoDom.play(); this.playAfterLoadding = false; }
```
`IsJoined()` gates who counts toward this at all: last heartbeat within 10s **and** same page URL (or easy-share m3u8 match) — `source/go-server/service.go:369-373`. A member who navigated away or went stale silently drops out of the buffering quorum.

## 8. Provider coupling

Hybrid: **generic `<video>`/`<bwp-video>` tag scan by default, with ~10 hard-coded per-site branches** that either (a) pick a specific `<video>` among several, or (b) bypass the DOM entirely and drive a page-internal player object through a uniform adapter shape (`VideoWrapper`). The seam is the `ForEachVideo(func)` method (`source/extension/vt.js:2125-2264`) — see §12 for the full breakdown, since this repo's whole value proposition ("all platforms") lives there.

- Video discovery: `document.getElementsByTagName(tag)` for `tag` in `["video","bwp-video","fake-iframe-video"]` (`vt.js:1861` `video_tag_names`, used at `2245`, `2895`) — **does not pierce shadow DOM** (only VideoTogether's own popup UI uses `attachShadow`, never for locating page videos).
- SPA / element replacement: no History API interception (no `pushState`/`popstate` hooks anywhere in the codebase). Survival is entirely via (1) a `MutationObserver` on `document.body` (`subtree:true`) that re-attaches click/seek listeners to newly-added `<video>`/`<bwp-video>` nodes (`CreateVideoDomObserver`, `vt.js:2864-2900`), and (2) the 2s poll re-running `ForEachVideo` and expiring stale entries from `videoMap` after `VIDEO_EXPIRED_SECOND = 10` (`vt.js:1824`, `3075-3078`). Cross-domain "navigation" (member's room URL differs from local page) is handled by a hard `window.location = data.url` redirect (`MessageType.JumpToNewPage`, `vt.js:2827-2836`), not in-SPA routing.
- iframes: content script is injected with `all_frames: true` (`source/chrome/manifest.json:6-15`). Each frame runs its own extension instance; `isMain = (window.self == window.top)` (`vt.js:1240`, `1881`). Non-top frames `postMessage` directly to `window.top` (`sendMessageToTop`, `vt.js:425-430`); the top (and every intermediate) frame re-broadcasts inbound sync messages to its own `<iframe>` children (`sendMessageToSonWithContext`, `vt.js:2266-2288`), so it cascades through arbitrarily nested iframe trees, not just one level. A self-healing watchdog re-registers the `message` listener if no messages have been observed for 6s (`vt.js:1932-1949`) — defends against Chrome occasionally killing the listener.
- Cross-origin page globals: a MAIN-world script (`preInjected.js`, `source/chrome/manifest.json:27-35`, `world: "MAIN"`) runs before `document_start` so the isolated content script can still reach page globals like `window.netflix` or `window.__PLAYER__` through the DOM/postMessage bridge — this is *how* the Netflix/QQ/Baidu-Pan adapters below can call into the page's own player SDK from an MV3 isolated content script.

## 9. Room, identity & auth model

- **Identity**: purely client-generated, no accounts. `tempUser = generateUUID() + ":" + Date.now()/1000` (`vt.js:1090-1092`), regenerated per session/room-create; server just remembers `userId -> bool` per room (`service.go:204-211`).
- **Room creation/join**: `name` + MD5-hashed `password` (`GetMD5Hash`, used both client `WSUpdateRoomRequest`... server `GetMD5Hash(req.URL.Query().Get("password"))`, `http.go:155`). Room is created lazily by the first `/room/update` (or WS `/room/join` against a nonexistent name fails with `RoomNotExist`, `ws.go:477-481` — you must be the updater to create). `Room.Protected` flag makes password checking optional (`HasAccess`, `service.go:402-404`): unprotected rooms accept any password including empty/wrong.
- **Persistence**: none — pure in-memory `sync.Map` of rooms (`VideoTogetherService.rooms`, `service.go:53`). A restart of the Go process loses every room. Rooms expire after **3 minutes** idle (`roomExpireTime`, `main.go:70`), swept during `/statistics` (`service.go:280-285`) and a 5-minute ticker cleans `Hub.roomClients` for rooms that no longer exist (`ws.go:111-123`).
- **Membership**: `Room.members sync.Map[userId]*Member`; a member only "counts" (`IsJoined`, `service.go:369-373`) if its heartbeat is <10s old and its `currentUrl` matches the room's canonical URL.
- **Rate limiting / abuse controls**: only a **client-side self-throttle**, not server-enforced per-IP/user limiting: `isLimited()` allows at most **15 scheduled-task calls per 5-second sliding window** before it starts silently skipping (`periodSec=5`, `timeLimitation=15`, `vt.js:35-36`, `131-140`). Server side: `CheckOrigin` on the WS upgrader unconditionally returns `true` (`ws.go:214-216`) — **no CORS/origin restriction on WS**. There's a `config.json` `blockDomains` list (e.g. `iqiyi.com`, `qq.com`, `youku.com`, `bilibili.com` in the example config) used only for a statistics counter (`NonBlockDomainUrlCount`), not for actually blocking sync on those domains. No captcha, no per-IP throttling found anywhere in `service.go`/`http.go`/`ws.go`.

## 10. What's broken / unmaintained / worth NOT copying

- **It is not actually hostless**, despite branding — see §6. First writer wins and locks the room; any legitimate "let someone else drive" requires the current host to stop updating (or the room to time out) before another user's writes are accepted. This is the opposite of the "every member has full control" requirement.
- **No shadow-DOM piercing** for host-page video discovery — any site that renders its player inside an open/closed shadow root (increasingly common with web-component player UIs) is invisible to `ForEachVideo`'s generic scan and needs a bespoke branch like the ones in §12.
- **Per-site branches are unstructured `if (hostname.endsWith(...))` chains inline in `ForEachVideo`/`PlayAdNow`/etc.**, not a lookup table or plugin registry (`vt.js:2125-2264`, `3216-3245`). There's no interface/contract enforced beyond convention (`VideoWrapper`'s 8 fields) and no per-site file separation — adding a site means editing the 3735-line monolith in multiple disjoint places (video discovery, ad detection, seek workaround) with no test coverage for any of them.
- **Disney+ adapter fakes seeking by simulating clicks on the ±10s skip buttons** (`vt.js:2144-2166`) — `clickTime = parseInt(d/10)` then loops clicking; this is slow (multiple sequential clicks + timeouts), imprecise (only 10s granularity plus a final direct `currentTime =` correction), and extremely fragile to any UI change on Disney+'s player chrome.
- **Drift correction is a blunt on/off hard-seek** (§4) with no smoothing/nudge path — every correction is a visible jump, and the 1s playing-deadband combined with a 1-2s poll cadence means visible desync of up to ~1s is "normal," not a bug.
- **Hardcoded default server** baked into the extension build (`config/release_host`) rather than configurable at runtime by the user — self-hosting requires rebuilding the extension, not just pointing it at a different URL in settings.
- Large amounts of unrelated feature surface baked into the same content script (M3U8 "easy-share" downloader, Reecho voice-chat proxy/TTS, Kraken WebRTC voice relay, IndexedDB storage bridge for Safari/iOS) — makes the sync-relevant code hard to isolate and increases the attack surface / permissions footprint (`unlimitedStorage`, all-URLs content script, MAIN-world injection) far beyond what pure playback sync needs.
- `invalidBroadcast`, `joinPanic`, `updatePanic` etc. are global mutable counters with no locking (`ws.go:18-21`) — fine for informal stats, not safe/meaningful under real concurrency scrutiny, and there's no persistence of them either (reset on restart).

## 11. Top 5 ideas worth stealing

1. **Continuous min-RTT clock offset piggybacked on every request**, not a separate ping phase — `timeOffset` only improves when a new-minimum RTT is observed, letting sync accuracy passively get better over a session for free. `source/extension/vt.js:3617-3623` (`UpdateTimestampIfneeded`), `vt.js:2903-2905` (`getLocalTimestamp`).
2. **Uniform adapter interface (`VideoWrapper`) that lets a non-`<video>`-element player (Netflix's internal player object, Tencent's `__PLAYER__`, video.js instances) present the exact same `{play, pause, paused, currentTime, duration, playbackRate}` surface as a real `<video>` tag to the rest of the sync engine.** This is the actual mechanism behind "works on all platforms," and it's a clean seam worth copying even though the per-site code that populates it isn't. `source/extension/vt.js:1826-1848` (class def), `2181-2196` (Netflix example).
3. **Structural echo suppression via role asymmetry** rather than ignore-flags: only the host reads-and-reports state, only members write-and-apply it; the member→server heartbeat literally has no `currentTime`/`paused` field, so there's no channel for a feedback loop to travel through. `source/extension/vt.js:492-501` (`WsUpdateMemberRequest` shape), `3292-3358` vs `3457-3538` (`SyncMasterVideo` vs `SyncMemberVideo`).
4. **Server-computed, OR-aggregated buffering gate with an end-of-video false-positive guard**: `waitForLoadding = (OR of joined members' isLoading) && duration != currentTime` — the last clause specifically avoids treating "video ended, so currentTime stalls" as buffering. `source/go-server/service.go:379-400`.
5. **MAIN-world content-script injection paired with an isolated-world sync engine**, used specifically to reach page-internal player globals (`window.netflix`, `window.__PLAYER__`) from an MV3 extension without needing a full custom debugger/CDP bridge. `source/chrome/manifest.json:27-35` (`preInjected.js`, `world: "MAIN"`).

## 12. How does it achieve "all platforms"?

Not a registry/table — it's a sequence of `try { if (hostname.endsWith(...)) {...} } catch {}` blocks inside `ForEachVideo` (`source/extension/vt.js:2125-2264`), each either narrowing which `<video>` tag is "the" video or replacing DOM access with a page-API-backed `VideoWrapper`. Full list found in the codebase:

| Site (hostname match) | What the override does | Location |
|---|---|---|
| `iqiyi.com` | Selects `.iqp-player-videolayer-inner > video` specifically (skips ad/thumbnail videos), marks it `VideoTogetherChoosed = true` (priority) | `vt.js:2125-2131` |
| `disneyplus.com` | No player API access; builds a `VideoWrapper` whose `currentTimeSetter` **simulates clicks** on `.ff-10sec-icon`/`.rwd-10sec-icon` skip buttons in a loop (`d/10` clicks), then a final direct `currentTime =` for the remainder | `vt.js:2135-2172` |
| `netflix.com` | Builds a `VideoWrapper` around `netflix.appContext.state.playerApp.getAPI().videoPlayer`'s active session — uses the page's private player SDK (`play/pause/seek/getCurrentTime/getPlaybackRate` in ms) | `vt.js:2181-2196` |
| `pan.baidu.com` (Baidu Netdisk) | Grabs the video.js player instance off `.vjs-controls-enabled`, wraps its `player.currentTime()/duration()/playbackRate()` API | `vt.js:2201-2223` |
| `window.__PLAYER__` present (Tencent Video, `v.qq.com`) | Wraps `__PLAYER__.corePlayer`/`currentVideoInfo`; `currentTimeSetter` is a no-op while `videoTogetherPaused` is set (avoids seeking a paused stream) | `vt.js:2225-2241` |
| `bilibili.com` | Generic `<video>` scan, but explicitly **excludes** thumbnail/preview videos inside `.video-page-card-small`/`.feed-card` | `vt.js:2255-2261` |
| `aliyundrive.com` | If `readyState == 0`, throws instead of calling `.play()` (avoids "need to play manually" false starts) | `vt.js:3499-3502` |
| `iqiyi.com` / `v.qq.com` / `youku.com` (`PlayAdNow`) | Detects an in-progress ad overlay via site-specific CSS selectors and makes the **member** throw/skip syncing while an ad plays, so the room doesn't try to seek into ad time | `vt.js:3216-3245` |
| `yiyan.baidu.com` / `*.cloudflare.com` | Restores the native `Element.prototype.attachShadow` (some pages override it) so VideoTogether's own popup UI can still attach its shadow root | `vt.js:3711-3715` |

**Generic fallback**: yes — `document.getElementsByTagName(tag)` for `tag` of `video`, `bwp-video`, `fake-iframe-video` (`vt.js:1861`, iterated at `2245-2264`), applied to every `<video>`-bearing site without a special case above (the overwhelming majority of "all platforms" in practice).

**Picking the "main" video among several**: priority-first, then closest-duration-match, *not* size/currentTime heuristics:
```js
// source/extension/vt.js:3248-3286 (GetVideoDom)
GetVideoDom() {
    let highPriorityVideo = undefined;
    this.videoMap.forEach(video => { if (video.priority > 0) highPriorityVideo = video; });
    if (highPriorityVideo != undefined) return highPriorityVideo;
    // ...
    // get the longest video for master  (comment in source, but actually: closest duration match)
    const _duration = this.duration == undefined ? 1e9 : this.duration;
    let closest = 1e10, closestVideo = undefined;
    this.videoMap.forEach((video, id) => {
        if (!isFinite(video.duration)) return;
        if (closestVideo == undefined) closestVideo = video;
        if (Math.abs(video.duration - _duration) < closest) { closest = Math.abs(video.duration - _duration); closestVideo = video; }
    });
    return closestVideo;
}
```
`priority` comes from `VideoTogetherChoosed == true` (site override picked it, e.g. iQIYI) or being a `VideoWrapper` instance (any non-native-DOM adapter is automatically priority 1) — set when reporting in `ScheduledTask`: `new VideoModel(id, duration, 0, Date.now()/1000, /*priority*/ 1)` (`vt.js:3064-3072`). Absent a priority hit, it falls back to whichever candidate's `duration` is closest to the room's already-known `duration` (helps when a page has both the real video and short ad/preview `<video>` tags of very different length). There's a separate, unused `activatedVideo` concept (last video the user directly clicked/played/seeked, tracked via `play pause seeked` listeners, `vt.js:2858-2863`, `2840-2843`) that the code computes but never actually returns from `GetVideoDom` — the relevant branch at `vt.js:3258-3263` is commented out (`// return this.activatedVideo;`), so user-click-based selection is effectively **dead code**.

**SPA / element-replacement survival**: no client-side router hooking. A `MutationObserver` on `document.body` (`subtree: true`) re-attaches `play/pause/seeked` listeners to any newly inserted `<video>`/`<bwp-video>` node (`CreateVideoDomObserver`, `vt.js:2864-2900`); the 2-second poll independently re-scans the whole DOM every tick regardless of whether anything changed, and drops any previously-seen video id from `videoMap` once its last report is older than `VIDEO_EXPIRED_SECOND = 10` (`vt.js:1824`, `3075-3078`). So survival is really "poll aggressively and expire stale state," not "detect the SPA transition."

## 13. Server implementation

Go, `source/go-server`. Two endpoint families sharing one `VideoTogetherService`/`Room` core, registered on one `http.ServeMux` (`source/go-server/http.go:66-83`):

- **WebSocket** (`/ws`, `gorilla/websocket`) — primary path, driven by a `Hub` (`ws.go:81-171`) that fans out `Broadcast{RoomName, Type, Message}` to all sockets currently joined to that room (`roomClients sync.Map[name]*RoomClients`). `Type` supports `ALL`/`MEMBERS`/`HOST` filtered delivery (e.g. an `url_req` for an m3u8 real-URL only goes to the host, `ws.go:453-467`). Ping/pong keepalive: 60s `pongWait`, pings every `pongWait*9/10 = 54s` (`ws.go:192-204`); a 5-minute ticker prunes room-client maps for rooms that no longer exist (`ws.go:111-123`).
- **HTTP** (`/room/get`, `/room/update`, `/timestamp`, plus assorted non-sync endpoints: `/statistics`, `/kraken` voice-relay proxy, `/reecho/*` TTS, `/qps*` metrics) — GET-with-query-params style, used as a fallback when WS is unavailable client-side (blocked network, userscript mode, etc.), and unconditionally for `/timestamp`/first room lookups.
- **Storage**: pure **in-memory**, `sync.Map` of `*Room` keyed by name (`VideoTogetherService.rooms`, `service.go:52-56`) and, per room, `sync.Map` of `*Member` and `sync.Map` of known `userId`s (`service.go:346-347`). **Fully stateless across restarts** — nothing is written to disk except a random `admin_password.txt` (`http.go:69` no — `main.go:69`) and the loaded `config.json`. No SQL/Redis/KV store anywhere in the module (`go.mod` has no DB driver).
- **Room lifecycle**: created lazily on first successful `/room/update` / WS `/room/join`+update, expires after **3 minutes** of no `LastUpdateClientTime` update (`roomExpireTime := time.Minute*3`, `main.go:70`; swept in `StatisticsN`, `service.go:280-285`).
- **Not** long-poll: it's a genuine persistent WebSocket for push, with a *separate*, independently-polled (every 2s, client-driven `setInterval`) HTTP GET path used only as a degrade-path, not as the primary transport. The polling interval (2s) is a client-side constant (`vt.js:1913`) with no visible justification comment in the source; it roughly matches the 1-2s drift-correction cadence in §4, i.e. "sync often enough that the 1s hard-seek deadband rarely triggers a visibly large jump" is the implied reasoning, though this is inference, not a stated rationale in the code.

## 14. Timing math, verbatim

Playback-position projection from a remote (host) report to "now," using the client's own clock plus the min-RTT-derived offset from §3 — this is the one formula the whole system's accuracy depends on:

```js
// source/extension/vt.js:3448-3450
CalculateRealCurrent(data) {
    let playbackRate = parseFloat(data["playbackRate"]);
    return data["currentTime"] + (this.getLocalTimestamp() - data["lastUpdateClientTime"]) * (isNaN(playbackRate) ? 1 : playbackRate);
}
```
where
```js
// source/extension/vt.js:2903-2905
getLocalTimestamp() { return Date.now() / 1000 + this.timeOffset; }
```
and `timeOffset`/`minTrip` are updated per §3's `UpdateTimestampIfneeded`. `data["lastUpdateClientTime"]` is the **host's** `getLocalTimestamp()` value at the moment it captured `currentTime` (sent as `localTimestamp` in `WSUpdateRoomRequest`, `vt.js:470`), so both sides of the subtraction are in the same server-anchored timebase — the RTT/latency compensation is entirely absorbed into `timeOffset` before this formula ever runs; `CalculateRealCurrent` itself is just "elapsed wall time since the host's report, times playback rate, added to the reported position." Consumed at the >1s deadband check in §4 (`vt.js:3487`).
