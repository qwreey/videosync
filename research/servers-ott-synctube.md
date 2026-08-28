# Server architecture research: opentogethertube vs SyncTube

Targets:
- `refs/opentogethertube` — dyc3/opentogethertube. Yarn workspaces monorepo: `common/` (shared TS), `server/` (TS/Node monolith), `client/` (Vue 3), `crates/*` (Rust balancer/collector).
- `refs/SyncTube` — RblSb/SyncTube. Single Haxe codebase compiled to a Node.js server target and a browser JS client target.

All citations are `file:line` relative to each repo's root inside `refs/`.

## 1. Overview

### opentogethertube
Monorepo: `common/` shared TS (2,051 LOC), `server/` TS/Node monolith (22,280 LOC), `client/` Vue 3 + Vite (21,816 LOC), `crates/*` Rust balancer/collector (8,803 LOC). `package.json:2-9` requires Node `>=22 <27`, Yarn 4. This is a shallow single-commit clone; the one visible commit is `4e3f7a4 chore: enable Tailwind shorthand lint rule (#2066)`, dated Wed Aug 19 2026 — recent relative to "today" (2026-08-28), consistent with active maintenance, though full history isn't visible. License: AGPL-3.0-or-later (`LICENSE`, `package.json:5`, `server/package.json:3`). Persistence: SQLite by default, Postgres optional (`server/ott-config.ts:84-85`); Redis is mandatory.

### SyncTube
Single Haxe codebase, `build-all.hxml:1-4` compiles two targets: Node.js server (`build-server.hxml`) and browser client (`build-client.hxml`). `package.json:3` version `1.0.0`, license MIT (`LICENSE`, Copyright 2020 Maxim Matyukhin), `engines.node >= 14.17.0`. Latest commit `7b0ea58` "Docker fixes", dated 2026-08-23 — actively maintained, 5 days before "today". LOC: ~10,806 lines of `.hx` under `src/`; server logic specifically: `Main.hx` 1430 lines, `HttpServer.hx` 529, `ServerState.hx` 17, `VideoTimer.hx` 87, `Client.hx` 108. Much smaller and more end-to-end readable than OTT.

## 2. Transport & message schema

### opentogethertube
Single WebSocket per client, connecting to `${base_url}/api/room/<roomName>` (`server/clientmanager.ts:113-119`). Server↔balancer is also WebSocket. Full discriminated-union schema in `common/models/messages.ts`:

```ts
export type ServerMessage =
  | ServerMessageSync | ServerMessageUnload | ServerMessageChat
  | ServerMessageEvent | ServerMessageEventCustom | ServerMessageAnnouncement
  | ServerMessageUser | ServerMessageYou;

export interface ServerMessageSync extends ServerMessageBase {
  action: "sync";
  name?: string; title?: string; description?: string; isTemporary?: boolean;
  visibility?: Visibility; queueMode?: QueueMode;
  isPlaying?: boolean; playbackPosition?: number;
  currentSource?: QueueItem | null; queue?: QueueItem[]; prevQueue?: QueueItem[] | null;
  grants?: [Role, number][]; playbackSpeed?: number;
  voteCounts?: [string, number][]; hasOwner?: boolean;
  enableVoteSkip?: boolean; votesToSkip?: string[];
  autoSkipSegmentCategories?: Category[]; videoSegments?: Segment[];
  restoreQueueBehavior?: BehaviorOption;
}
```
(`common/models/messages.ts:17-55`). All fields optional — `sync` is a **partial diff of dirty state**.

Client→server (`common/models/messages.ts:125-167`):
```ts
export type ClientMessage =
  | ClientMessageKickMe | ClientMessagePlayerStatus | ClientMessageAuthenticate
  | ClientMessageNotify | ClientMessageRoomRequest;
```
Real commands are wrapped: `ClientMessageRoomRequest { action: "req"; request: RoomRequest }`. Sync-relevant `RoomRequest` variants (`common/models/messages.ts:188-345`):
```ts
export interface PlaybackRequest { type: RoomRequestType.PlaybackRequest; state: boolean; }
export interface SeekRequest    { type: RoomRequestType.SeekRequest; value: number; }
export interface SkipRequest    { type: RoomRequestType.SkipRequest; }
export interface PlaybackSpeedRequest { type: RoomRequestType.PlaybackSpeedRequest; speed: number; }
export interface ChatRequest    { type: RoomRequestType.ChatRequest; text: string; }
```
**ABSENT**: no `ClientMessage` ever carries the client's own `currentTime` — the client never reports its position to the server.

### SyncTube
WebSocket only (`js.npm.ws.Server`, `src/server/Main.hx:23,233-234`), served off the same HTTP(S) server as static files (`Main.hx:214-233`). No SSE/polling fallback. Serialization is JSON via `json2object`, with a null-stripping replacer:
```haxe
public static function jsonStringify(data:Any, ?space:String):String {
    return Json.stringify(data, jsonFilterNulls, space);
}
```
(`src/server/Main.hx:1204-1213`). The whole protocol is **one tagged union**: `typedef WsEvent = { type:WsEventType, ... }` (`src/Types.hx:187-290`) with one optional field per message kind, plus `enum abstract WsEventType(String) { ... }` with 33 variants (`Types.hx:291`, e.g. `Pause, Play, GetTime, SetTime, SetRate, Rewind, SetLeader, ...`). Example payloads: `?pause:{time:Float}`, `?play:{time:Float}`, `?getTime:GetTimeEvent`, `?setTime:{time:Float}`, `?setRate:{rate:Float}`, `?rewind:{time:Float}`. `typedef GetTimeEvent = { time:Float, ?paused:Bool, ?pausedByServer:Bool, ?rate:Float }` (`Types.hx:180`). Payloads are minimal: `Pause`/`Play` carry only `{time:Float}`; `Rewind`'s `{time:Float}` is treated as a **delta**, not absolute (§4/§6).

## 3. Clock synchronization

### opentogethertube
No RTT/ping-based clock offset measurement anywhere. Server computes an authoritative absolute position on demand:
```ts
// common/timestamp.ts:4-12
export function calculateCurrentPosition(
  start_time, now_time, offset: number, playbackSpeed: number = 1,
): number {
  const deltaRaw = dayjs(now_time).diff(start_time, "milliseconds") / 1000;
  return offset + deltaRaw * playbackSpeed;
}
```
`Room._playbackStart: Dayjs | null` anchors to the server's own `dayjs()` on play/seek (`server/room.ts:254,1141,1151,1215`); `realPlaybackPosition` (`server/room.ts:721-727`) resolves the absolute number sent in `sync.playbackPosition` (`server/room.ts:841`). The client does **not** treat this as a live value tied to a server timestamp — it re-anchors on **local receipt time**:
```ts
// client/src/stores/room.ts:114-127
if (message.isPlaying) { this.state.room.playbackStartTime = dayjs(); } // client's own clock
```
then re-extrapolates every 250ms with the same formula (`client/src/views/Room.vue:405-424`). This is a systematic, uncorrected error equal to one-way latency of the `sync` message — no NTP-style offset, no ping/pong round-trip used for this purpose (the only ping/pong found is raw WS keepalive: `server/client.ts:129,147-149,168-170`).

### SyncTube
No ping/RTT measurement anywhere. Authoritative timer per room is pure offset arithmetic, `src/server/VideoTimer.hx`:
```haxe
function getTime():Float {
    if (startTime == 0) return 0;
    final time = stamp() - startTime;
    return time - rateTime() + rateTime() * rate - pauseTime();
}
function setTime(secs:Float):Void {
    startTime = stamp() - secs;
    rateStartTime = stamp();
    if (isPaused()) updatePauseTime();
}
```
(`VideoTimer.hx:50-60`, using `haxe.Timer.stamp()`, monotonic seconds). No tick loop — computed on demand. Client sync is **pull-based**: client sends `{type: GetTime}` on connect and every `synchThreshold` seconds (`src/client/Main.hx:167,110,1529-1533`); server replies with `videoTimer.getTime().toFixed()` (`server/Main.hx:942`) taken at face value, no latency compensation. Dead code at `src/client/Player.hx:425-427` (unused `off`/`delta` variables) suggests an abandoned latency-compensation attempt. The 25s `ws.ping()` loop (`Main.hx:238-247`) is liveness-only, never timed.

## 4. Drift correction policy

### opentogethertube
Entirely client-side; server has no drift-detection logic:
```ts
// client/src/views/Room.vue:436-450
watch(truePosition, async newPosition => {
  const currentTime = player.getPosition();
  const diff = Math.abs(newPosition - (await currentTime));
  if (diff > 1 && !mediaPlaybackBlocked.value) { player.setPosition(newPosition); }
});
```
Deadband: hardcoded `diff > 1` (1.0s), no named constant anywhere. Correction is **hard seek only** — `player.setPosition(newPosition)`. **ABSENT**: no `playbackRate` nudging/soft-catchup anywhere. Checked on a 250ms poll (`Room.vue:427`), not every frame.

### SyncTube
One deadband constant, client-side: `synchThreshold`, default **2 seconds** (`src/client/Main.hx:94`, user-adjustable, `Buttons.hx:372-374`). It doubles as both the `GetTime` poll interval and the seek deadband (`Main.hx:669,695,700,707,718`), coupling sync tightness to poll traffic. Correction is **always a hard seek**, never `playbackRate` for catch-up:
```haxe
if (Math.abs(time - newTime) < synchThreshold) return;
if (!data.getTime.paused) player.setTime(newTime + 0.5); // +0.5s buffering bias
else player.setTime(newTime);
```
(`client/Main.hx:707-710`). Same fixed `+0.5` bias on `Rewind` (`client/Main.hx:728`) — a blanket assumed-latency constant, not measured. `Rewind` is resolved server-side as a delta against the server's own time: `data.rewind.time += videoTimer.getTime(); if (data.rewind.time < 0) data.rewind.time = 0;` (`server/Main.hx:977-978`).

## 5. Echo suppression

### opentogethertube
No flags, sequence numbers, or sender-exclusion anywhere — `broadcast()` sends to every client including the originator (`server/clientmanager.ts:407-445`, no `if (client.id !== originatorId)` check). Echoes are structurally impossible by construction, not suppressed after the fact: UI controls call `roomapi.play()/pause()/seek()` only from explicit user actions; the native `<video>`/iframe player's own `playing`/`paused` DOM events are **never** forwarded into outbound requests — they only self-correct the player back to store state:
```ts
// client/src/views/Room.vue:616-628
async function onPlaybackChange(changeTo: boolean) {
  if (changeTo === store.state.room.isPlaying) return; // already matches, no-op
  await applyIsPlaying(store.state.room.isPlaying);      // force back to server truth
}
```
This is a state-sync architecture, not event-sourcing-with-replay, so there's nothing to suppress by ID.

### SyncTube
Two coexisting, non-symmetric mechanisms. Client-local one-shot flags consumed by the DOM/SDK handler the programmatic call triggers:
```haxe
var skipSetTime = false;
public function setTime(time:Float, isLocal = true):Void {
    skipSetTime = isLocal;
    player.setTime(time);
}
```
(`src/client/Player.hx:35-36,698-706,714-722`), consumed at `Player.hx:413-421` (`if (skipSetTime) { skipSetTime = false; return; }`), same pattern for `onRateChange` (`Player.hx:445-452`). Depends on the provider firing its event synchronously. Postmessage-driven providers (`Vk.hx:168`, `Vimeo.hx:221`) add their own noise gate (`if (diff > 1) player.onSetTime();`). Server-side: `SetTime`/`SetRate` use `broadcastExcept(client, ...)` (`server/Main.hx:960,969`), but `Pause`/`Play` use plain `broadcast(...)` including the sender (`Main.hx:903,916`) — client instead self-guards with `if (isLeader()) return;` before applying (`client/Main.hx:657,665`). Inconsistent pattern across message types.

## 6. Conflict resolution without a host

### opentogethertube
No explicit conflict resolution — single-threaded Node event loop means "conflicts" are just request ordering (last message processed wins, no timestamps/version compared). `Room.processRequest()` (`server/room.ts:1059-1119`) checks permission then dispatches synchronously; `play()`/`pause()`/`seek()` mutate state with no interleaving `await` (`server/room.ts:1134-1153,1210-1216`). The actual anti-chaos mechanism is **permission gating, not conflict resolution**: by default, `playback.play-pause`/`seek`/`skip`/`speed` all have `minRole: Role.UnregisteredUser` and are granted to everyone (`common/permissions.ts:50-52,136-139,165-174`) — OTT ships egalitarian-by-default for playback and simply accepts last-write-wins races as an acceptable tradeoff rather than engineering around them.

### SyncTube
Not "natural event-loop ordering" — SyncTube avoids the conflict via an exclusive **leader** gate. `Play`/`Pause`/`SetTime`/`SetRate` are hardcoded `if (!client.isLeader) return;` (`server/Main.hx:897,910,955,967`), bypassing the general permission system. `SetLeader` is exclusive:
```haxe
public static function setLeader(clients, name):Void {
    for (client in clients) {
        if (client.name == name) client.isLeader = true;
        else if (client.isLeader) client.isLeader = false;
    }
}
```
(`src/ClientTools.hx:4-9`) — at most one leader, so at most one client's transport commands ever land; that single-writer-per-field design *is* the conflict resolution. `Rewind` is the exception: it's permission-checked (`checkPermission(client, RewindPerm)`, `Main.hx:976`) and granted to guests by default (`default-config.json:24`), so any guest can nudge time by a delta even without leadership — SyncTube's only approximation of shared control, and it materially diverges from a fully egalitarian model (see §14).

## 7. Buffering / readiness gating

### opentogethertube
Purely cosmetic — the room does **not** wait for a stalled client. `RoomUser.playerStatus` (`server/room.ts:91`) is updated from `ClientMessagePlayerStatus` (`server/room.ts:111-123`) and surfaced per-user (`server/room.ts:491`), but is **never read** in `update()`/`play()`/`pause()` or any playback logic — flows client→server→broadcast one-way, purely for a spinner icon next to a user's name (`client/src/components/UserList.vue:269`). Outbound status is throttled via `client/src/components/WorkaroundPlaybackStatusUpdater.vue:23` (the filename itself signals a late patch). **ABSENT**: no aggregate "everyone ready" gate, no auto-pause-on-buffering.

### SyncTube
Readiness barrier only at video **start/switch**, not mid-playback:
```haxe
function prepareVideoPlayback():Void {
    if (videoTimer.isStarted) return;
    loadedClientsCount++;
    if (loadedClientsCount == 1) restartWaitTimer();
    if (loadedClientsCount >= clients.length) startVideoPlayback();
}
```
(`server/Main.hx:1354-1375`), triggered by each client's `VideoLoaded` (`Player.hx:323-326`), capped at `VIDEO_START_MAX_DELAY = 3000` ms (`Main.hx:41`) so one stuck client can't block the room forever. **ABSENT**: no mid-playback buffering/stall signal — once the timer starts, the server clock runs regardless of any client's `readyState`; a stalled client just drifts and gets hard-seeked on its next `GetTime` poll.

## 8. Provider coupling

### opentogethertube
Clean two-sided seam — server never touches actual playback, only metadata. Abstract `ServiceAdapter` base class (`server/serviceadapter.ts:14-71`): `canHandleURL`, `getVideoId`, `fetchVideoInfo(id, properties?): Promise<Video>`, `isCollectionURL`. Concrete adapters in `server/services/`: `youtube.ts`, `vimeo.ts`, `dash.ts`, `hls.ts`, `direct.ts`, `peertube.ts`, `googledrive.ts`, `invidious.ts`, `odysee.ts`, `pluto.ts`, `reddit.ts`, `tubi.ts` — fetch title/thumbnail/duration/stream-URLs only, never proxy/transcode. `QueueItem` carries `{service, id, title?, length?, thumbnail?, mime?, hls_url?, dash_url?, src_url?, ...}` (`common/models/video.ts:10-31`) — this metadata is what's synced. Client: `OmniPlayer.vue` dispatches to a concrete player component by `currentSource.service` (`YoutubePlayer.vue`, `VimeoPlayer.vue`, `HlsPlayer.vue`, `DashPlayer.vue`, `DirectPlayer.vue`, `PeertubePlayer.vue` under `client/src/components/players/`), each normalizing to common events and a `getPosition()/setPosition()` interface.

### SyncTube
Common interface `src/client/IPlayer.hx:8-25` — 15 methods (`getPlayerType`, `isSupportedLink`, `getVideoData`, `loadVideo`, `removeVideo`, `isVideoLoaded`, `play`, `pause`, `isPaused`, `getTime`, `setTime`, `getPlaybackRate`, `setPlaybackRate`, `getVolume`, `setVolume`, `unmute`), implemented identically by `Raw.hx`, `Youtube.hx`, `Vimeo.hx`, `Vk.hx`, `Peertube.hx`, `Streamable.hx`, `Iframe.hx`. Selection is find-first-match plus fallback:
```haxe
function setSupportedPlayer(url:String, playerType:PlayerType):Void {
    final currentPlayer = players.find(p -> p.isSupportedLink(url));
    if (currentPlayer != null) setPlayer(currentPlayer);
    else if (playerType == IframeType) setPlayer(iframePlayer);
    else setPlayer(rawPlayer);
}
```
(`src/client/Player.hx:274-279`). Native `<video>` (`Raw.hx`) wires DOM events directly (`src/client/players/Raw.hx:160-167`); SDK/iframe providers invoke the same callback names from SDK handlers (`Youtube.hx:241-265`), and postmessage-driven providers debounce/filter periodic time-update messages before forwarding (`Vk.hx:168`). Notable idea: `Iframe.hx` is a deliberate **non-sync opt-out**, not a faked sync — `isSyncActive()` explicitly excludes `IframeType` items (`Player.hx:661-665`): arbitrary uncontrollable embeds simply disable sync machinery for that item rather than pretending to sync them.

## 9. Room, identity & auth model

### opentogethertube
Identity: every WS connection gets an anonymous crypto-random `AuthToken` (512 random bytes, base64, `server/auth/tokens.ts:20-24`), mapped in Redis (`auth:<token>` → `SessionInfo`) with TTL 14 days unregistered / 120 days logged-in (`tokens.ts:6-7,35-38`). Room persistence: three-tier lookup in `roommanager.getRoom()` (`server/roommanager.ts:129-165`) — in-process array, then Redis (`room:<name>`, full serialized state), then SQL (Sequelize, SQLite default/Postgres optional, `server/ott-config.ts:81-133`). Membership/roles: `Room.userRoles: Map<Role, Set<number>>` (`server/room.ts:233`); effective role computed via owner check → admin/mod/trusted lookup → logged-in fallback → `UnregisteredUser` (`server/room.ts:611-630`). Rate limiting: Redis-backed token bucket, 1000 points/hour per IP, 120s block duration (`server/rate-limit.ts:14-30`); temp-room creation costs 50 points, permanent costs 200 (`server/api/room.ts:96-99,127-135`) — max ~20 temp / ~5 permanent room creates per IP/hour by default. Room name validated via Zod schemas + `ROOM_NAME_REGEX` (`common/constants.ts`); creation can be globally disabled via feature flags (`server/ott-config.ts:441-450`).

### SyncTube
**No multi-room concept at all** — grepping for "room" in `src/` returns nothing; the only related concept is a single `channelName` config string (`Types.hx:49`, `default-config.json:2`). One server process = one shared room for everyone connected (see §13). Persistence is flat JSON files under `user/`, no DB: `user/state.json` (full snapshot: videoList, chat messages, timer state, flashbacks, cached files — `server/ServerState.hx:7-17`, written on `exit()`/loaded on boot, `Main.hx:362-407`), `user/users.json` (admin name/password-hash + IP bans + salt, `Types.hx:104-113`), `user/config.json` (override merge onto `default-config.json`, `Main.hx:304-330`). Membership: clients are ephemeral `Guest N` names from an id pool (`Main.hx:513-514,598`), not stable per-user; reconnection is keyed off a client-generated `uuid` in browser `localStorage` used only to kick a stale duplicate session, not to preserve identity (`Main.hx:504-510`). **Rate limiting/abuse controls are ABSENT** — no throttling/flood control anywhere (grepped, zero hits); only mitigations are chat length truncation (`Main.hx:749-751`), playlist size caps (`Main.hx:780-788`), and IP-based bans (`Main.hx:653-677,1322-1340`).

## 10. What's broken / unmaintained / worth NOT copying

### opentogethertube
- `server/room.ts:1346` — **`// HACK: force the client to receive the correct playback position`**: every `joinRoom()` broadcasts an *extra unrequested full-room* `sync` to **all existing clients**, not just the joiner (`server/room.ts:1347`), papering over the fact that dirty-diff `sync` doesn't reliably keep late-joiners correct.
- `server/room.ts:1405` — `// FIXME: room event type definitions suck ass, and needs to be reworked`.
- `server/room.ts:1579` — `// TODO: have clients only send properties that they actually intend to change.`
- `server/room.ts:1471` — `// TODO: throw exceptions for invalid votes instead of ignoring them` — silent failure on bad input.
- `server/usermanager.ts:156,638` — `// HACK: the unique constraint on the model is fucking broken`.
- `server/usermanager.ts:759,766` — `// FIXME: remove when https://github.com/sequelize/sequelize/issues/12415 is fixed` — unresolved upstream dependency workaround.
- `server/services/youtube.ts:293,614` — HACKs around YouTube API limitations.
- Architecturally: the clock-sync gap in §3 (client anchors on local receipt time, never a server-emitted timestamp) is a genuine, *unacknowledged* correctness gap worth fixing rather than copying.
- Full `queue` array is re-sent whenever `"queue"` is dirty (`server/room.ts:161-182`), no item-level diffing — could get expensive for large queues.

### SyncTube
- **Single point of failure by design**: any uncaught exception kills the whole process/room: `process.on("uncaughtException", err -> { logError(...); exit(); })` (`server/Main.hx:107-113`), same for `unhandledRejection` (`Main.hx:114-125`). There's even an admin-gated self-crash command: `case CrashTest: if (!client.isAdmin) return; final arr:Array<Int> = cast null; arr[1]++;` (`Main.hx:1140-1144`).
- Reflection-based, hand-maintained message validation (`noTypeObj`, `Main.hx:546-557`) that can silently desync from the type definitions when new variants are added.
- Name-based identity is fragile: leader assignment, kick/ban, and skip-vote bookkeeping are all keyed by mutable display name; `isBadClientName` rejects duplicates case-insensitively (`Main.hx:1350`) but `ClientTools.getByName` compares case-sensitively (`ClientTools.hx:22-29`) — inconsistent matching. `Logout` derives the new guest number from `clients.indexOf(client)+1` (`Main.hx:731-732`), a separate/inconsistent scheme from the `freeIds` pool used on connect (`Main.hx:513-514`).
- Weak credential hashing: admin passwords are plain `Sha256(password + salt)` (`Main.hx:438-444`), no KDF, single global salt per install.
- Secret committed in source: a live-looking `youtubeApiKey` in `default-config.json:18`.
- Non-reproducible Docker build: `haxelib install all --always && haxe build-all.hxml` at image-build time, no lockfile, pulls latest of several git-based Haxe externs.
- Dead code signaling an abandoned feature: `Player.hx:425-427` (unused `off`/`delta`).

## 11. Top 5 ideas worth stealing

### opentogethertube
1. **Anchor + elapsed authoritative position, not a heartbeat stream.** `_playbackStart` + `playbackPosition` + `calculateCurrentPosition()` (`common/timestamp.ts:4-12`, `server/room.ts:254,721-727`) — cheap, stateless-per-tick, trivially resumable. Steal it, but fix the flaw: include the server's emission timestamp in `sync` and have the client correct for measured latency instead of stamping local receipt time.
2. **Dirty-flag + debounced push.** `markDirty(prop)` → `throttledSync = _.debounce(this.sync, 50, {trailing:true})` (`server/room.ts:499-501,828`) coalesces bursts into one message within ~50ms; idle rooms send nothing; `RoomStateSyncable` is a partial diff of only changed fields (`server/room.ts:882-893`).
3. **State-sync architecture sidesteps echo suppression entirely** (§5) — no sequence numbers or ignore-flags needed by construction. Directly reusable in Go.
4. **Bitmask permission system with a structural `minRole` ceiling** (`common/permissions.ts:36-155,208-337`) — a single `&` check per permission test, role inheritance flattened via `_processInheiritance()`, and `getValidationMask()` makes certain privilege-escalation misconfigurations *impossible*, not just discouraged.
5. **Balancer routes via gossip + monotonic epoch tiebreak**, not sticky sessions or DB locks (full detail §13) — avoids a separate service-discovery dependency while still resolving genuine ownership races deterministically (`crates/ott-balancer/src/balancer.rs:335-408`).

### SyncTube
1. **`VideoTimer` as pure offset arithmetic** (`server/VideoTimer.hx:1-87`) — `getTime()` computed on demand from stored offsets, no ticking loop, correctly composes pause and rate changes. Directly portable to Go (store `time.Time` offsets, compute on read).
2. **Single tagged-union wire schema + null-stripping serializer** (`Types.hx:187-290`, `Main.hx:1204-1213`) — one discriminant, one optional field per kind, trivially versioned by adding variants; maps cleanly to a Go struct with `omitempty` tags.
3. **Provider capability opt-out for unsyncable embeds** (`Player.hx:661-665`) — disables sync for an item rather than faking it. Directly applicable to a pluggable-adapter design.
4. **Minimal 15-method `IPlayer` interface** (`IPlayer.hx:8-25`) unifying native `<video>` and SDK/iframe embeds — good starting shape for an adapter contract.
5. **Grace period before stopping the shared clock on full disconnect**, explicitly to survive transient blips without punishing the room:
   > "Stop video timer after `EMPTY_ROOM_CALLBACK_DELAY` in case if server loses connection to all clients for a moment. This allows seamless reconnection without rewinds to stopped server time."
   (`server/Main.hx:78-85`, wired at `Main.hx:632-639`).

## 12. Deployment & self-hosting story

### opentogethertube
Redis is **mandatory**, no fallback — `server/redisclient.ts:35-41` connects unconditionally at boot; used for room-state cold-start cache, session/token storage, rate limiting. SQL storage is also always used (Sequelize) for permanent-room settings/user accounts/cached metadata, but defaults to file-based SQLite (`server/ott-config.ts:81-86`) so it needs no separate service by default — **Postgres is only required for the Docker-Compose "production" topology or explicit `DB_MODE=postgres`.** Minimum viable setup: one Node process (`server/app.ts`) + one Redis instance; SQLite file auto-created. Reference `docker-compose.yml:1-59` ships app + `redis_db` + `postgres_db` (`postgres:15-bullseye`). `docker/with-balancer.docker-compose.yml` adds the Rust balancer for horizontal scaling. Multi-stage `deploy/monolith.Dockerfile` (build all 3 JS workspaces → prune to `ott-server --production`), separate Dockerfiles for balancer/collector/nginx, plus Fly.io-specific configs. Config format: TOML via `convict` (`server/ott-config.ts:1-27`), minimal example `env/example.toml` covers hostname/log level/api keys/session secret; everything else falls back to schema defaults or env-var overrides.

**Self-host friendliness: 5/10.** Redis is a hard requirement even for a single-room hobby deployment, and the "real" reference compose file pulls in Postgres too, giving it a 2-3 service footprint for what could be a single binary. Offset by genuinely good Docker multi-stage builds, TOML config with env-var overrides, and a health-check endpoint. Complexity scales with the horizontal-scaling story you don't need for a small self-hosted deployment (balancer/collector images exist but are opt-in).

### SyncTube
No external services required at all: no Postgres/Redis/etc. — state is JSON files on local disk (`user/state.json`, `user/users.json`) plus a local video-cache directory. `Dockerfile`: single-stage `haxe:4.3-alpine3.22`, installs `nodejs npm git`, runs `npm ci` + `haxelib install all --always` + `haxe build-all.hxml` at image build time (no lockfile — non-reproducible builds, see §10), entrypoint `node build/server.js`. `docker-compose.yml`: single service, port `4200:4200`, bind-mount `./user:/app/user` — that's the entire persistence story. `default-config.json`: one JSON file (port, channel name, limits, `permissions` block, emotes, chat filters, `ytDlp` settings, optional SSL cert paths — falls back to plain HTTP if absent).

**Self-host friendliness: 9/10.** Genuinely minimum-viable — one container, one bind-mounted directory, zero external services, config is a single JSON file. Loses a point for the non-reproducible/dev-toolchain-in-runtime-image Docker build and the fact that it's fundamentally single-room/single-process (see §13), so "self-hosting for a community with many simultaneous rooms" isn't supported without running multiple containers manually.

## 13. Horizontal scaling & room state

### opentogethertube
Room state is **in-memory per Node.js process** ("monolith") — one `Room` object instance owns all mutation for that room. Redis is used only for (a) cold-start persistence/recovery of a room's state across a monolith restart (`server/room.ts:833-858`, debounced 5s) and (b) a shared cache other monoliths check before loading a room fresh (`server/roommanager.ts:147-155`) — **Redis is not a pub/sub bus keeping multiple monoliths' in-memory copies in sync**; a room is only ever "live" on exactly one monolith.

The Rust balancer (`crates/ott-balancer`) is the routing/ownership authority via a persistent WS protocol to each monolith, not Redis:
- `BalancerContext` (`crates/ott-balancer/src/balancer.rs:190-197`) holds `rooms_to_monoliths: HashMap<RoomName, RoomLocator>` in the balancer's own RAM — single source of truth for room ownership.
- **Discovery**: monoliths connect outbound to the balancer; on connect they send a gossip message listing every room currently loaded, and individually report `Loaded`/`Unloaded` events as rooms come and go (`MsgM2B::Gossip`/`Loaded`/`Unloaded`, `balancer.rs:868-925`) — self-report over the existing WS connection, no separate Redis pub/sub channel.
- **Routing a new client**: `join_client()` (`balancer.rs:505-608`) checks `rooms_to_monoliths`; if the room isn't owned yet, `select_monolith()` (`balancer.rs:446-449`) picks one via a pluggable strategy — `MinRooms` (default), `HashRing` (consistent hashing), or `Random` (`crates/ott-balancer/src/selection.rs:29-40`) — then sends `B2MJoin{room, client, token}` to that monolith; client traffic is proxied client↔balancer↔monolith for the room's lifetime.
- **Ownership race resolution**: each room-load carries a monotonically-increasing `load_epoch` (from `redisClient.incr(LOAD_EPOCH_KEY)`, `server/roommanager.ts:22,36-45`). If the balancer sees the same room reported loaded on two monoliths simultaneously, it compares epochs and unloads the lower one via `B2MUnload` (`balancer.rs:335-408,749-845`) — this is the **only** place Redis participates in balancer logic, as an atomic counter, not as ownership storage.
- Monolith host discovery (separate from room ownership) is pluggable: DNS, Fly.io API, static config, or test harness (`crates/ott-common/src/discovery.rs:24-36`).

**Do we need this?** Only if a single process needs to outgrow one machine's connection/CPU capacity, or you want zero-downtime rolling deploys without dropping rooms. For a Go server, a simpler starting point (single process holding all rooms in memory, horizontally scale later behind a similar gossip+epoch router if actually needed) is likely sufficient — this is a legitimate "steal the idea, defer the implementation" case.

### SyncTube
Confirmed **ABSENT**. Everything (`videoList`, `messages`, `videoTimer`, `clients`, `skipVotes`, `flashbacks`) is a plain instance field on the single `Main` class instance (`server/Main.hx:63-85`), constructed once in `static function main()` (`Main.hx:87-91`). Exactly one `WSServer` bound to one HTTP(S) server on one port (`Main.hx:186-248`); no Redis, database, pub/sub, or cross-process coordination anywhere. Disk persistence on `exit()`/load-on-boot (§9) is a restart-recovery mechanism only, not clustering. This is single-process, single-room, in-memory by design — "another room" means "run another container on another port." A hard limit if a Go server needs multiple concurrent rooms per instance or multi-instance deployment.

## 14. Permission model

### opentogethertube
`Role` enum (`common/models/types.ts:90-97`):
```ts
export enum Role {
  Administrator = 4, Moderator = 3, TrustedUser = 2,
  RegisteredUser = 1, UnregisteredUser = 0, Owner = -1,
}
```
27 discrete `Permission`s as bit flags with a `minRole` floor each (`common/permissions.ts:49-155`). Default grants (`common/permissions.ts:163-185`):
```ts
[Role.UnregisteredUser]: parseIntoGrantMask([
  "playback", "manage-queue", "chat",
  "configure-room.set-title", "configure-room.set-description",
  "configure-room.set-visibility", "configure-room.set-queue-mode",
  "configure-room.other",
]),
[Role.Moderator]: parseIntoGrantMask([
  "manage-users.promote-trusted-user", "manage-users.demote-trusted-user", "manage-users.kick",
]),
[Role.Administrator]: parseIntoGrantMask(["*"]),
[Role.Owner]: parseIntoGrantMask(["*"]),
```
Prefix-matching (`common/permissions.ts:190-203`) means `"playback"` expands to play-pause + skip + seek + speed — **all playback control is granted to anonymous `UnregisteredUser` by default.** This is OTT's fully egalitarian mode, and it's the out-of-the-box default: every anonymous visitor can already play/pause/seek/skip/change speed/manage queue/chat/edit basic room settings, no configuration needed. Role inheritance (`_processInheiritance()`, `common/permissions.ts:313-319`) means grants to lower roles propagate up.

What's gated *above* `UnregisteredUser`, and the abuse each gate prevents:
- `manage-users.kick` (`minRole: TrustedUser`, default-granted only to Moderator+) — plus `canKickUser(yourRole, targetRole)` requires strictly-higher role and the Owner can never be kicked (`common/userutils.ts:3-4`). Prevents anonymous users mass-kicking each other.
- `manage-users.promote-admin`/`demote-admin` (`minRole: Administrator`), `...moderator` (`minRole: Moderator`), `...trusted-user` (`minRole: TrustedUser`) — self-governing promotion ladder, prevents anonymous privilege escalation.
- `configure-room.set-permissions.for-*` tiers (`common/permissions.ts:78-97`) — you can only edit permission grants of roles *below* your own tier, preventing self-escalation via permission editing.
- **Structural ceiling, not just default config**: `getValidationMask(role)` (`common/permissions.ts:208-214`) intersects any attempted grant against permissions whose `minRole` the role actually meets — so even a room admin explicitly trying to grant `manage-users.kick` to `UnregisteredUser` is silently masked out. Certain abuse vectors are made *impossible to misconfigure into existence*, not just discouraged.
- `Administrator`/`Owner` are hardcoded to always have `["*"]` regardless of stored config (`common/permissions.ts:251-253,396-397`, `// HACK: force owner to always have all permissions`) — can't be broken by a bad DB row.

**For a no-host design**: OTT's default *already is* what this project wants for playback (everyone controls it), and its permission system exists almost entirely to gate the things a no-host design must still decide about — kicking, promoting, and editing permissions themselves. Going fully host-less doesn't eliminate the need for those controls; it just means "who has TrustedUser/Moderator" needs a different answer than "the room owner appointed them" (e.g., time-in-room, vote, or simply omit moderation entirely and accept the abuse surface below).

### SyncTube
Two independent gating systems. Declarative permission lists (`Types.hx:68-91`), configured per group (`default-config.json:22-27`):
```json
"permissions": {
    "banned": [],
    "guest": ["writeChat","addVideo","removeVideo","changeOrder","toggleItemType","requestLeader","rewind"],
    "user": ["guest"],
    "leader": ["user"],
    "admin": ["user","clearChat","setLeader","lockPlaylist","banClient"]
}
```
Groups inherit other groups, flattened once at config load (`Main.hx:284-302`), checked via `Client.hasPermission` (`Client.hx:53-60`, banned→admin→leader→user→guest priority). Separately, an **exclusive `isLeader` role** gates `Play`/`Pause`/`SetTime`/`SetRate` directly (`if (!client.isLeader) return;`, §6), outside the permission-list system — at most one client holds it.

Guest default is generous for *metadata* (chat, add/remove video, reorder, request leader, rewind) but **not egalitarian for playback transport** — pause/resume/absolute-seek/rate require holding the single `leader` slot. `requestLeaderOnPause`/`unpauseWithoutLeader` (both `false` by default, `default-config.json:9-10`) only smooth over the single-leader constraint (auto-grant leadership on pause attempt; allow unpausing without becoming leader) rather than removing it. **There is no config mode making playback control genuinely multi-writer.** `isAdmin` is a separate super-role (local-IP or password-based, `Main.hx:516,697-712`) for admin-only actions, orthogonal to both systems above.

**What SyncTube's permission system exists to prevent, and what a no-host design signs up for by not having it**: the leader gate exists specifically to avoid the exact simultaneous-command conflicts this project's design says it wants to embrace (§6). Going leaderless like OTT (rather than SyncTube) means accepting: (1) last-write-wins races on play/pause/seek with no server-side reconciliation beyond message-arrival order: two people seeking near-simultaneously will visibly fight for a moment; (2) no single actor to blame/undo a disruptive action — e.g. a bad-faith participant scrubbing to the end repeatedly is exactly as "authorized" as anyone else, since permission is binary per-action, not rate-limited or reputation-weighted; (3) needing a separate, deliberately-designed answer for moderation actions (kick/ban) that both OTT and SyncTube gate behind an elevated role — a truly no-host design either needs a substitute (majority vote, e.g. OTT's vote-skip pattern generalized) or has to accept it cannot remove a disruptive participant at all.

## 15. Reconnect & state recovery

### opentogethertube
On every successful auth (fresh join or reconnect — same code path), the server sends exactly three messages in sequence, `server/clientmanager.ts:129-181` (`onClientAuth`):
1. **Full state snapshot** — `Object.assign({action:"sync"}, room.syncableState())`, sent before the join is even processed (`clientmanager.ts:139-143`). `syncableState()` (`server/room.ts:839-843`) picks all 19 `syncableProps` (`server/room.ts:161-182`) with `playbackPosition` overwritten to the live-computed `realPlaybackPosition` — a **full snapshot**, unlike the periodic dirty-flag `sync` which only sends changed fields.
2. **Full user roster** — `ServerMessageUser{action:"user", update:{kind:"init", value: room.users}}` (`clientmanager.ts:165-172`).
3. **Own identity** — `ServerMessageYou{action:"you", info:{id: client.id}}` (`clientmanager.ts:174-180`).

Then `room.joinRoom()` (`server/room.ts:1336-1349`) broadcasts a join notification and, per the acknowledged HACK (§10), re-broadcasts *another* `sync{playbackPosition: this.realPlaybackPosition}` to the **whole room**. **No sequence/version numbers exist anywhere** in the sync protocol — `sync` is idempotent/absolute-value-based (never delta-at-version-N), so a client can safely process out-of-order or duplicate `sync` messages; reconnection needs zero reconciliation logic beyond "ask for everything again." (The balancer's `load_epoch`, §13, is version-like but purely internal to backend ownership, never exposed to the browser client.)

### SyncTube
On every new connection the server immediately pushes a full snapshot as the `Connected` event (`server/Main.hx:566-592`):
```haxe
send(client, {
    type: Connected,
    connected: {
        uuid: client.uuid, config: ..., history: messages,
        clientName: client.name, clients: clientList(),
        videoList: videoList.getItems(), isPlaylistOpen: videoList.isOpen,
        itemPos: videoList.pos, globalIp: globalIp, playersCacheSupport: ...,
    }
});
```
Includes chat history (up to `serverChatHistory`, default 50), full client list, full playlist + position, effective config — but **not** current playback time or paused state. The client applies this (`client/Main.hx:791-824`): persists the server-issued `uuid` to `localStorage`, replays chat history, sets playlist items, re-authenticates with stored name/hash. Immediately after, it fires a **second round-trip**, `onTimeGet.run()` (`client/Main.hx:549`) → `GetTime` request, fetching current playback position/pause/rate separately (`server/Main.hx:921-951`) — a deliberate two-phase join (structural snapshot, then live playback state), rather than one combined payload. **No sequence/version numbers anywhere.** Same-session reconnection: `onConnect` looks up an existing client with the same `uuid` and forcibly disconnects it before admitting the new socket (`Main.hx:504-510`), preventing duplicate-session ghosts; client reconnect uses `Timer.delay(openWebSocket, reconnectionDelay)`, `reconnectionDelay = gotInitialConnection ? 1000 : 2000` ms (`client/Main.hx:201-202`). A grace period keeps the shared clock alive briefly after the room empties (§11 item 5), so a lone reconnecting client doesn't get punished with a rewind-to-stopped-time.
