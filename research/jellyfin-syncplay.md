# Jellyfin SyncPlay

Reference clone: `refs/jellyfin-syncplay` (sparse checkout of jellyfin/jellyfin, SyncPlay-relevant paths only).

## 1. Overview

Jellyfin SyncPlay is a module inside the Jellyfin **media server** (C#, ASP.NET Core, .NET). It is not a standalone project — it's a feature of `jellyfin-server`. Language/stack: C# 10.0 SDK per `global.json:3` (`"version": "10.0.0"`). License: GPL-2.0, `LICENSE:1-2`. Maintenance status: extremely active — the sparse checkout's HEAD commit is dated the same day as this research (`git log -1`: commit `6ad1e34`, "Translated using Weblate (Belarusian)", authored 2026-08-28), i.e. this is effectively Jellyfin's `master` branch mainline. Jellyfin is a large, well-staffed fork of Emby (ported to .NET, `README.md:24`), with CI, translation pipelines, and an active donation/feature-request process — no signs of abandonment.

Architecture: a **server-authoritative group state machine** (`MediaBrowser.Controller/SyncPlay/GroupStates/*`), one instance per "group" (`Emby.Server.Implementations/SyncPlay/Group.cs`), managed by a singleton `SyncPlayManager` that maps sessions → groups (`Emby.Server.Implementations/SyncPlay/SyncPlayManager.cs`). Clients talk to it via a REST controller (`Jellyfin.Api/Controllers/SyncPlayController.cs`) that translates HTTP POSTs into typed "playback requests" fed into the state machine; the state machine emits either `SendCommand` (playback command) or `GroupUpdate<T>` (metadata/queue update) messages that are pushed back out through `ISessionManager.SendSyncPlayCommand` / `SendSyncPlayGroupUpdate` (`Emby.Server.Implementations/SyncPlay/Group.cs:404,390`).

Open issue signal: ABSENT — no network access from this environment and no issue-tracker data is present in the sparse checkout; cannot be assessed from local files.

## 2. Transport & message schema

**ABSENT from this checkout** in terms of the wire transport itself: `ISessionManager`, the WebSocket session/message-envelope code, and the `Jellyfin.Api.Models.SyncPlayDtos` request-DTO classes are not part of this sparse checkout (confirmed: `find … -iname "*SessionManager*" -o -iname "*WebSocket*"` and `find … -ipath "*SyncPlayDtos*"` both return nothing). From general Jellyfin knowledge, outbound `SendCommand`/`GroupUpdate` messages are pushed to clients over the existing Jellyfin session WebSocket, but that framing code is not present here, so no message-envelope shape can be cited.

What **is** verifiable: all *inbound* control-plane calls are plain HTTP POST (REST), authorized via `[Authorize(Policy = Policies.SyncPlayIsInGroup)]` (`Jellyfin.Api/Controllers/SyncPlayController.cs:25,90`), one endpoint per action (`/SyncPlay/Ready`, `/SyncPlay/Buffering`, `/SyncPlay/Seek`, `/SyncPlay/Ping`, etc.). The outbound message payload shapes (server → client, serialized as JSON over whatever transport carries them) are fully defined as C# DTOs:

**`SendCommand`** — the playback-command payload (`MediaBrowser.Model/SyncPlay/SendCommand.cs:8-64`):
```csharp
public class SendCommand
{
    public Guid GroupId { get; }
    public Guid PlaylistItemId { get; }
    public DateTime When { get; set; }        // UTC time to execute the command
    public SendCommandType Command { get; }    // Unpause | Pause | Stop | Seek
    public long? PositionTicks { get; }
    public DateTime EmittedAt { get; }          // UTC time the command was created
}
```
`SendCommandType` (`MediaBrowser.Model/SyncPlay/SendCommandType.cs:6-27`): `Unpause=0, Pause=1, Stop=2, Seek=3`.

**`GroupUpdate<T>`** — generic envelope for metadata/queue pushes (`MediaBrowser.Model/SyncPlay/GroupUpdate.cs:9-39`):
```csharp
public abstract class GroupUpdate<T>
{
    public Guid GroupId { get; }
    public T Data { get; }
    public abstract GroupUpdateType Type { get; }
}
```
`GroupUpdateType` values (`MediaBrowser.Model/SyncPlay/GroupUpdateType.cs:6-52`): `UserJoined, UserLeft, GroupJoined, GroupLeft, StateUpdate, PlayQueue, NotInGroup, GroupDoesNotExist, LibraryAccessDenied`.

**`GroupStateUpdate`** — data carried by a `StateUpdate` group update (`MediaBrowser.Model/SyncPlay/GroupStateUpdate.cs:6-30`):
```csharp
public class GroupStateUpdate
{
    public GroupStateType State { get; }        // Idle|Waiting|Paused|Playing
    public PlaybackRequestType Reason { get; }   // which client request caused this
}
```

**`PlayQueueUpdate`** — data carried by a `PlayQueue` group update (`MediaBrowser.Model/SyncPlay/PlayQueueUpdate.cs:9-82`):
```csharp
public class PlayQueueUpdate
{
    public PlayQueueUpdateReason Reason { get; }
    public DateTime LastUpdate { get; }
    public IReadOnlyList<SyncPlayQueueItem> Playlist { get; }
    public int PlayingItemIndex { get; }
    public long StartPositionTicks { get; }
    public bool IsPlaying { get; }
    public GroupShuffleMode ShuffleMode { get; }
    public GroupRepeatMode RepeatMode { get; }
}
```

**`GroupInfoDto`** — group metadata returned from REST `List`/`{id}`/`New` endpoints (`MediaBrowser.Model/SyncPlay/GroupInfoDto.cs:9-58`):
```csharp
public class GroupInfoDto
{
    public Guid GroupId { get; }
    public string GroupName { get; }
    public GroupStateType State { get; }
    public IReadOnlyList<string> Participants { get; }
    public DateTime LastUpdatedAt { get; }
}
```

Inbound request field names (reconstructed from controller + matching `*GroupRequest` constructor args, since the literal `*RequestDto` classes are ABSENT from the checkout): `BufferRequestDto`/`ReadyRequestDto` carry `When` (DateTime), `PositionTicks` (long), `IsPlaying` (bool), `PlaylistItemId` (Guid) — see `SyncPlayController.cs:296-332` and matching `BufferGroupRequest`/`ReadyGroupRequest` (`MediaBrowser.Controller/SyncPlay/PlaybackRequests/BufferGroupRequest.cs:22-52`, `ReadyGroupRequest.cs:22-52`). `PingRequestDto` carries `Ping` (long, ms) — `SyncPlayController.cs:430-439`, `PingGroupRequest.cs:18-27`. `SeekRequestDto` carries `PositionTicks` — `SyncPlayController.cs:281-288`.

## 3. Clock synchronization

**Server-authoritative, one-shot NTP-style round trip via a dedicated `GetUtcTime` endpoint** — `Jellyfin.Api/Controllers/TimeSyncController.cs:20-33`:

```csharp
[HttpGet("GetUtcTime")]
public ActionResult<UtcTimeResponse> GetUtcTime()
{
    // Important to keep the following line at the beginning
    var requestReceptionTime = DateTime.UtcNow;
    // Important to keep the following line at the end
    var responseTransmissionTime = DateTime.UtcNow;
    return new UtcTimeResponse(requestReceptionTime, responseTransmissionTime);
}
```

`UtcTimeResponse` DTO (`MediaBrowser.Model/SyncPlay/UtcTimeResponse.cs:8-32`):
```csharp
public class UtcTimeResponse
{
    public DateTime RequestReceptionTime { get; }   // server UTC clock when request arrived
    public DateTime ResponseTransmissionTime { get; } // server UTC clock when response was sent
}
```

This is a classic simplified-NTP exchange. **NOT IN THIS CHECKOUT** (no client code is in scope): the following t0..t3/offset/RTT formulas are a reconstruction of standard NTP math applied to the two server timestamps, not text found in the repo. Client is expected to record its own `t0` (send time) and `t3` (receive time) around the HTTP call, then combine with the server's `t1`=`RequestReceptionTime` and `t2`=`ResponseTransmissionTime`:
- RTT ≈ `(t3 - t0) - (t2 - t1)` (subtracting server-side processing time, which here is ~0 since both timestamps are captured at the very start/end of the handler — comment explicitly warns "Important to keep the following line at the beginning/end", `TimeSyncController.cs:24,27`).
- offset ≈ `((t1 - t0) + (t2 - t3)) / 2` — the standard NTP offset formula.

The code comment is explicit about the design intent: *"Implementing NTP on such a high level results in this useless information being sent. On the other hand it enables future additions."* (`TimeSyncController.cs:30-31`) — i.e. the server authors themselves consider `RequestReceptionTime`/`ResponseTransmissionTime` as **not currently load-bearing** by the server (processing time is negligible), but expose both fields so a proper client-side NTP-style RTT/offset calculation is possible. The actual client-side accumulation logic (repeated pings, min-RTT sampling, EWMA smoothing) is **ABSENT** from this checkout — the server exposes only the primitive; there's no evidence in the server code of how many samples a client should take or how it should filter outliers. What the client does with the resulting offset: it converts every `DateTime` the server sends (in `SendCommand.When`/`EmittedAt`, `ReadyGroupRequest.When`, etc.) into local wall-clock time by adding/subtracting that offset, so `When` timestamps embedded in commands can be compared against the client's own clock.

Separately, group-internal RTT is tracked via **application-level ping**, not the time-sync endpoint: clients periodically POST their last-measured ping to `/SyncPlay/Ping` (`SyncPlayController.cs:430-439`), which the server stores per-member (`Group.cs:437-443`, `UpdatePing`) and uses via `GetHighestPing()` (`Group.cs:446-455`) to size unpause delays (see §14). This is a self-reported one-number ping (no min/max/N-sample window is done server-side — that averaging, if any, is client-side and ABSENT here).

## 4. Drift correction policy

There is no client-side "nudge via playbackRate" logic visible in this server code (that lives in Jellyfin web/clients, not in this checkout) — the server's job, per its own comment, is only to "maintain a consistent state for clients to reference and notify clients of state changes. The actual syncing of media playback happens client side." (`Emby.Server.Implementations/SyncPlay/Group.cs:335-337`). What the server *does* enforce is a **position-deadband check that decides whether to hard-correct (reissue `Seek`) a client that reports itself "Ready"**, in `WaitingGroupState.HandleRequest(ReadyGroupRequest, …)`:

- `MaxPlaybackOffset` = **500 ms**, the "maximum offset error accepted for position reported by clients" (`Emby.Server.Implementations/SyncPlay/Group.cs:100-103`). Converted to ticks and compared against `delayTicks = context.PositionTicks - clientPosition.Ticks` (`GroupStates/WaitingGroupState.cs:444-445,453,523`). If `Math.Abs(delayTicks) > maxPlaybackOffsetTicks`, the server treats the client as **not actually ready** and issues a hard `SendCommandType.Seek` back to just that session (`WaitingGroupState.cs:453-467` when resuming to Playing; `WaitingGroupState.cs:523-536` when resuming to Paused) rather than trusting it.
- `TimeSyncOffset` = **2000 ms**, the "maximum time offset error accepted for dates reported by clients" (`Group.cs:94-97`). Used to sanity-check the client-reported `When` timestamp on a `Ready`/`Buffer` request: `elapsedTime = currentTime.Subtract(request.When)`; if `Math.Abs(elapsedTime.Ticks) > timeSyncThresholdTicks` the server logs a warning ("is not time syncing properly") and **discards** the client's elapsed-time estimate, treating it as zero (`WaitingGroupState.cs:426-434`). This is a safety clamp against clients with a badly-off transport delay estimate, not a drift-correction constant per se.
- No `playbackRate`-based nudging exists anywhere in the state machine — corrections are always a hard `Seek` command with a `PositionTicks` value, or a `Pause`/`Unpause` scheduled at a future `When` (see §14). This is a **binary "hard seek or nothing"** policy, no soft/gradual catch-up.

## 5. Echo suppression

There is no explicit "echo suppression" mechanism in this server code because the server never re-broadcasts a client's own action back to itself as if it were new — it's structural, not a flag/timeout. The two techniques actually used:

1. **Sender exclusion via `SyncPlayBroadcastType`.** Every outbound command/update names a broadcast filter (`AllGroup`, `CurrentSession`, `AllExceptCurrentSession`, `AllReady`) evaluated in `Group.FilterSessions` (`Emby.Server.Implementations/SyncPlay/Group.cs:171-189`). Most catch-up/recovery paths explicitly use `AllExceptCurrentSession` so the client that reported readiness isn't re-sent its own confirming command (e.g. `WaitingGroupState.cs:485-496`, resuming-others branch). This is a server-side routing filter, not a client-side "ignore my own event" flag, but it accomplishes the same suppression by construction: the origin session's own request never triggers a command echoed back to itself for actions that only need to reach *other* sessions.
2. **`prevState.Equals(Type)` "client got lost" branches.** Several handlers detect that a client re-issued a request that shouldn't cause a group-wide state broadcast (i.e., the group is already in that state) and reply only to `CurrentSession` instead of `AllGroup`, e.g. `IdleGroupState.SendStopCommand` (`GroupStates/IdleGroupState.cs:115-126`), `PausedGroupState.HandleRequest(PauseGroupRequest,…)` (`GroupStates/PausedGroupState.cs:66-93`), `PlayingGroupState.HandleRequest(UnpauseGroupRequest,…)` (`GroupStates/PlayingGroupState.cs:62-87`). This prevents a client's own redundant request from causing a broadcast storm back to the whole group, but it is a **state-comparison guard**, not a sequence-number or ignore-flag mechanism.

There's no echo-suppression `ignore`/`suppress` flag, sequence counter, or event-source token anywhere in this codebase. Verified via `grep -rn -i "ignore\|suppress\|sequence" --include="*.cs" .` over the whole checkout: within `SyncPlay/*` the only `ignore`-related hits are `IgnoreGroupWait`/`IgnoreBuffering`/`IgnoreWaitGroupRequest` (a *different* feature, group-wait opt-out — see §7) plus two unrelated comments about discarding a stale elapsed-time estimate (`WaitingGroupState.cs:425,436`) and an empty-queue/list guard (`Group.cs:492,577`); the few `suppress`/`sequence` hits anywhere in the checkout are `GC.SuppressFinalize` and unrelated HLS/library string-comparison code, nothing SyncPlay-specific. `AbstractPlaybackRequest` (`MediaBrowser.Controller/SyncPlay/PlaybackRequests/AbstractPlaybackRequest.cs:12-30`), the base class for every client request, carries only `Type` (always `RequestType.Playback`) and `Action` — no sequence number or nonce field exists on requests to support echo suppression by ID.

## 6. Conflict resolution without a host

**UNHANDLED in the sense of no host, but fully resolved via server-authoritative single-threaded per-group locking — not a Lamport clock or vector clock.** There is no "host"/room-owner: any session in the group can issue any request (`Jellyfin.Api/Controllers/SyncPlayController.cs`, every endpoint just needs `Policies.SyncPlayIsInGroup`). Concurrent requests are serialized by a **per-`Group` monitor lock** taken in `SyncPlayManager.HandleRequest`:
```csharp
if (_sessionToGroupMap.TryGetValue(session.Id, out var group))
{
    lock (group)   // Emby.Server.Implementations/SyncPlay/SyncPlayManager.cs:333
    {
        ...
        group.HandleRequest(session, request, cancellationToken);
    }
}
```
(`SyncPlayManager.cs:330-351`). Because `Group`/its states are explicitly documented as **not thread-safe, external locking required** (`AbstractGroupState.cs:14-16`, `Group.cs:24-26`), every request to the same group is processed strictly one-at-a-time, in server arrival order — i.e. **last-write-wins on server-received order**, decided implicitly by whichever request acquires the C# `lock` first (no explicit sequence number is attached to messages; the mutex *is* the serialization order). Cross-group operations (`NewGroup`, `JoinGroup`, `LeaveGroup`) additionally take an outer `_groupsLock` (`SyncPlayManager.cs:70,116,155,219,274,299`) documented as having priority over the per-group lock, preventing deadlock/races when a session moves between groups.

Because every command a state emits also carries `EmittedAt`/`When` server timestamps (§14), late-processed requests don't retroactively desync playback — the *effect* (a `Seek`/`Pause`/`Unpause` with an absolute execute time) is still consistent for whichever request won the lock race.

## 7. Buffering / readiness gating

Yes — the room waits, via the dedicated **`Waiting` group state** (`MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs`), and "ready" is tracked per-member and aggregated by simple AND-over-all-non-ignoring-members.

- Per-member readiness: `GroupMember.IsBuffering` (`MediaBrowser.Controller/SyncPlay/GroupMember.cs:52`), toggled via `context.SetBuffering(session, bool)` (`Group.cs:458-464`) and bulk-set via `SetAllBuffering` (`Group.cs:467-473`).
- Aggregation: `Group.IsBuffering()` returns true if **any** member `IsBuffering && !IgnoreGroupWait` (`Group.cs:476-487`) — i.e. group is "not ready" as long as one non-opted-out member is still buffering. This is polled/consulted, not event-driven from a counter — every `Ready`/`Buffer` request re-evaluates it.
- Signalling: clients POST `/SyncPlay/Buffering` (→ `BufferGroupRequest`, includes `When`, `PositionTicks`, `IsPlaying`, `PlaylistItemId`) when they start stalling, and `/SyncPlay/Ready` (→ `ReadyGroupRequest`, same shape) when they catch up (`SyncPlayController.cs:296-332`).
- Opt-out: a member can ask to be excluded from the wait entirely via `/SyncPlay/SetIgnoreWait` → `IgnoreWaitGroupRequest` → `GroupMember.IgnoreGroupWait` (`SyncPlayController.cs:340-350`, `GroupMember.cs:58`, handled in `AbstractGroupState.HandleRequest(IgnoreWaitGroupRequest,…)` at `AbstractGroupState.cs:208-211` and specially in `WaitingGroupState.HandleRequest(IgnoreWaitGroupRequest,…)` at `WaitingGroupState.cs:656-679`, which can immediately flip the group to Playing/Paused if that was the last blocker).

See §12 for the full Waiting-state walkthrough.

## 8. Provider coupling

**N/A / ABSENT.** This checkout is server-side only (playback state machine + clock sync + REST API). There is no `<video>` element handling, no per-site adapter, no SPA/iframe/shadow-DOM logic anywhere in `MediaBrowser.Controller/SyncPlay`, `Emby.Server.Implementations/SyncPlay`, `MediaBrowser.Model/SyncPlay`, or the two controllers — those concerns live entirely in Jellyfin's client apps (jellyfin-web etc.), which are outside this sparse checkout. Nothing to report here; do not infer a design.

## 9. Room, identity & auth model

- **Identity**: tied to Jellyfin's existing authenticated `SessionInfo`/user system (not visible in full here, but every controller action resolves `currentSession` via `RequestHelpers.GetSession(_sessionManager, _userManager, HttpContext)`, e.g. `SyncPlayController.cs:60,77,93`). There is no separate SyncPlay identity — you must already be a logged-in Jellyfin user.
- **Group creation**: `POST /SyncPlay/New` with `{ GroupName }`, gated by `Policies.SyncPlayCreateGroup` (`SyncPlayController.cs:54-63`). `Group.CreateGroup` seeds group state from the creator's current playback if they were already playing something (`Group.cs:251-283`, pulls `session.FullNowPlayingItem`/`session.NowPlayingQueue`/`session.PlayState`).
- **Join**: `POST /SyncPlay/Join` with `{ GroupId }`, gated by `Policies.SyncPlayJoinGroup` (`SyncPlayController.cs:71-81`); server checks library/parental access before admitting (`Group.HasAccessToPlayQueue` → `HasAccessToQueue`/`AllUsersHaveAccessToQueue`, `Group.cs:198-237,367-371`, checked in `SyncPlayManager.JoinGroup` at `SyncPlayManager.cs:171-178`). Rejoining the same group after a drop is treated specially — "Restore session" path (`SyncPlayManager.cs:180-188`).
- **Leave**: `POST /SyncPlay/Leave`, and automatically on session end via `_sessionManager.SessionEnded += OnSessionEnded` (`SyncPlayManager.cs:92,387-396`) — no dangling membership on disconnect.
- **Persistence**: **in-memory only.** Groups live in `ConcurrentDictionary<Guid, Group> _groups` and `ConcurrentDictionary<string, Group> _sessionToGroupMap` on the `SyncPlayManager` singleton (`SyncPlayManager.cs:49-62`); nothing is written to the database. A server restart drops all groups. Empty groups are garbage-collected immediately on last-member-leave (`SyncPlayManager.cs:241-245`).
- **Membership cap**: none observed — no max-participants check anywhere in `Group`/`SyncPlayManager`.
- **Rate limiting / abuse controls**: **ABSENT.** No throttling on `/SyncPlay/Ping`, `/SyncPlay/Seek`, etc. beyond the authorization policies; a malicious authenticated client could spam requests (each just contends the per-group lock).
- **Access control granularity**: enforced at the *content* level, not the group level — a user can only join/see groups whose entire play queue they have library/parental permission for (`Group.cs:198-237`), re-checked on every `ListGroups`/`GetGroup` call too (`SyncPlayManager.cs:274-290,299-315`).

## 10. What's broken / unmaintained / worth NOT copying

- **In-memory-only group state** (§9): any server restart or crash silently drops every active watch party with no recovery/reconnect-with-history story visible in this code. Fine for a single-process deployment, a real liability if you want horizontal scaling / server restarts without disrupting rooms.
- **No rate limiting on any SyncPlay endpoint**, including the high-frequency `/SyncPlay/Ping` and `/SyncPlay/Buffering`/`/SyncPlay/Ready` — a buggy or hostile client can spam these; each acquires the group's C# `lock`, so a flood from one client can add latency for the whole group (`SyncPlayManager.cs:333`).
- **Time-sync is a single-shot, no-history endpoint** — `GetUtcTime` (§3) doesn't itself do any averaging, and the authors' own comment calls the request/response timestamps "useless information" as currently used (`TimeSyncController.cs:30-31`). All the actual RTT-sampling smarts are pushed to the client and are invisible/unverifiable from the server repo — a new implementation copying this pattern must design that client-side logic from scratch; there's no reference algorithm to copy here.
- **`TimeSyncOffset`/`MaxPlaybackOffset` are hardcoded constants** (2000 ms / 500 ms), not configurable per-deployment or adaptive to observed network conditions (`Group.cs:94-103`) — fine on a LAN, likely too tight or too loose depending on real-world client population; worth making configurable rather than copying as magic numbers.
- **Ping is entirely self-reported and unauthenticated-in-content** — `UpdatePing` just stores whatever number the client claims (`Group.cs:437-443`), used directly in unpause-delay math (`GetHighestPing() * 2`, `PlayingGroupState.cs:67`). A client claiming a fake low ping could cause the group to under-compensate for its real latency; no server-side RTT measurement cross-checks it against the `GetUtcTime` endpoint.
- **State machine correctness relies entirely on disciplined external locking** (`AbstractGroupState.cs:14-16` "Class is not thread-safe, external locking is required") — a maintainable but fragile pattern; any future code path that calls into a `Group`/state method without holding the lock reintroduces races silently (no internal assertion/guard enforces it).
- **The Waiting-state `Ready` handler is long and deeply branchy** (`WaitingGroupState.cs:399-561`, ~160 lines of nested `if`s for buffering-vs-not, resuming-vs-not, drift-vs-not) — correct-looking but dense; a rewrite should probably decompose the "recovering/lagging/on-time" cases into named helper methods rather than copying the branch structure verbatim.
- **Genuine unit bug in the "buffering client resumed but didn't tell others in time" fallback path**, `WaitingGroupState.cs:503-504`:
  ```csharp
  delayTicks = context.GetHighestPing() * 2 * TimeSpan.TicksPerMillisecond;
  delayTicks = Math.Max(delayTicks, context.DefaultPing);
  ```
  `delayTicks` is computed in **ticks**, but `context.DefaultPing` is 500 — a value the property doc and every other call site treat as **milliseconds** (`Group.cs:88-91`: "Gets the default ping value used for sessions" = 500; correctly used in milliseconds at `PlayingGroupState.cs:67`, `var delayMillis = Math.Max(context.GetHighestPing() * 2, context.DefaultPing);`). Comparing 500 raw ticks (50 microseconds) against a tick-scale `delayTicks` means the intended "floor the resume delay at 500ms" safety clamp is inert on this specific path — it can never win the `Math.Max` unless ping is measured in negative numbers. Contrast the correct sibling implementation two states over. Worth fixing, not copying verbatim, if this delay-flooring pattern is reused.

## 11. Top 5 ideas worth stealing

1. **The four-state (Idle/Waiting/Playing/Paused) server-authoritative state machine itself**, with `Waiting` as a dedicated buffering-gate state that remembers what state to return to. `MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs:38-52` (InitialState tracking) and the whole class — this cleanly separates "what should happen" from "is everyone ready for it to happen."
2. **Scheduling commands with a future `When` timestamp plus `EmittedAt`**, so all clients execute the same action at the same absolute moment regardless of when each one's message arrives. `MediaBrowser.Model/SyncPlay/SendCommand.cs:19-27`; delay computed via `Math.Max(context.GetHighestPing() * 2, context.DefaultPing)` in `GroupStates/PlayingGroupState.cs:67-73`. This is the single most valuable, directly-portable mechanism in the repo (see §14).
3. **Deadband-gated hard correction on `Ready`**: don't trust a client's self-reported "I'm ready," verify its reported position against server position within `MaxPlaybackOffset` (500ms) before accepting it, else force a `Seek`. `GroupStates/WaitingGroupState.cs:442-467,520-536`, constant at `Group.cs:100-103`.
4. **`GetUtcTime` two-timestamp NTP-lite endpoint**, trivial to implement, gives clients everything they need (t1, t2, plus their own t0/t3) to compute both offset and RTT with the classic NTP formulas. `Jellyfin.Api/Controllers/TimeSyncController.cs:20-33`, `MediaBrowser.Model/SyncPlay/UtcTimeResponse.cs`.
5. **`SyncPlayBroadcastType` filter enum (`AllGroup`/`CurrentSession`/`AllExceptCurrentSession`/`AllReady`) as the sole echo/targeting mechanism**, resolved centrally in one `FilterSessions` method. `Emby.Server.Implementations/SyncPlay/Group.cs:171-189`. Cheap, readable, and structurally prevents most echo-loop bugs without any per-message ignore-flag bookkeeping on the client.

## 12. The group state machine

States, `MediaBrowser.Model/SyncPlay/GroupStateType.cs:6-27`:
- **Idle (0)** — no media loaded/playing.
- **Waiting (1)** — playback paused; group is waiting for all (non-opted-out) clients to report ready before proceeding to Playing or Paused.
- **Paused (2)** — media loaded, playback paused, will resume on an explicit unpause.
- **Playing (3)** — media loaded, playback advancing.

Each state is a class (`IdleGroupState`, `WaitingGroupState`, `PausedGroupState`, `PlayingGroupState`) extending `AbstractGroupState`, holding no group data itself — group data (`PositionTicks`, `LastActivity`, `PlayQueue`, etc.) lives on `Group` (`IGroupStateContext`). Transitions are performed by `context.SetState(newState)` followed immediately by re-dispatching the same request into the new state's handler (a "state re-entry" pattern), e.g. `IdleGroupState.HandleRequest(PlayGroupRequest,…)`:
```csharp
var waitingState = new WaitingGroupState(LoggerFactory);
context.SetState(waitingState);
waitingState.HandleRequest(request, context, Type, session, cancellationToken);
```
(`GroupStates/IdleGroupState.cs:50-56`). This means a single client request can cause a cascading multi-state transition within one call.

**Full transition table** (source: each state file's `HandleRequest` overrides):

| From | Trigger | To | Notes |
|---|---|---|---|
| Idle | `PlayGroupRequest` | Waiting | `IdleGroupState.cs:50-56` |
| Idle | `UnpauseGroupRequest` | Waiting | `IdleGroupState.cs:59-65` |
| Idle | `PauseGroupRequest`/`StopGroupRequest`/`SeekGroupRequest`/`BufferGroupRequest`/`ReadyGroupRequest` | Idle (no-op) | just re-sends `Stop` command, `IdleGroupState.cs:68-95,115-126` |
| Idle | `NextItemGroupRequest`/`PreviousItemGroupRequest` | Waiting | `IdleGroupState.cs:98-113` |
| Paused | `PlayGroupRequest` | Waiting | `PausedGroupState.cs:48-54` |
| Paused | `UnpauseGroupRequest` | Playing | direct, no Waiting gate — `PausedGroupState.cs:57-63` |
| Paused | `PauseGroupRequest` (redundant) | Paused (no-op, re-sends Pause) | `PausedGroupState.cs:66-93` |
| Paused | `StopGroupRequest` | Idle | `PausedGroupState.cs:97-103` |
| Paused | `SeekGroupRequest`/`BufferGroupRequest`/`NextItemGroupRequest`/`PreviousItemGroupRequest` | Waiting | `PausedGroupState.cs:106-159` |
| Paused | `ReadyGroupRequest` | Paused (no-op) or self-correct | `PausedGroupState.cs:124-141` |
| Playing | `PlayGroupRequest` | Waiting | `PlayingGroupState.cs:53-59` |
| Playing | `UnpauseGroupRequest` (redundant) | Playing (no-op, re-sends Unpause) | `PlayingGroupState.cs:62-87` |
| Playing | `PauseGroupRequest` | Paused | `PlayingGroupState.cs:90-96` |
| Playing | `StopGroupRequest` | Idle | `PlayingGroupState.cs:99-105` |
| Playing | `SeekGroupRequest` | Waiting | `PlayingGroupState.cs:108-114` |
| Playing | `BufferGroupRequest` | Waiting (unless `IgnoreBuffering`) | `PlayingGroupState.cs:117-128` |
| Playing | `NextItemGroupRequest`/`PreviousItemGroupRequest` | Waiting | `PlayingGroupState.cs:147-162` |
| Waiting | all members become ready (`ReadyGroupRequest` aggregation) | Playing or Paused | depends on `ResumePlaying` flag, `WaitingGroupState.cs:449-561` |
| Waiting | `StopGroupRequest` | Idle | `WaitingGroupState.cs:273-286` |
| Waiting | last buffering member leaves the group | Playing (if `ResumePlaying`) or Paused | `WaitingGroupState.SessionLeaving`, `WaitingGroupState.cs:92-124` |
| Waiting | `IgnoreWaitGroupRequest` clears the last blocker | Playing or Paused | `WaitingGroupState.cs:656-679` |
| any state | new session joins | Waiting (unless Idle, which just gets a Stop) | `SessionJoined` overrides, e.g. `PlayingGroupState.cs:38-44`, `PausedGroupState.cs:33-39`, `IdleGroupState.cs:38-41` |
| any state | `SetPlaylistItemGroupRequest` | Waiting | default `AbstractGroupState` handler builds a `WaitingGroupState` and re-dispatches into it, `AbstractGroupState.cs:61-66` — this is a real state transition, not a state-agnostic queue op |
| any state | `RemoveFromPlaylistGroupRequest`, and the removed item was the playing item, and the queue is now empty | Idle | default `AbstractGroupState` handler removes the item, then if `playingItemRemoved && !context.PlayQueue.IsItemPlaying()` it builds an `IdleGroupState` and re-dispatches a synthetic `StopGroupRequest` into it, `AbstractGroupState.cs:69-95`; if the queue is still non-empty after removal, no state change occurs |

The remaining queue/metadata requests genuinely are state-agnostic and don't cause a transition — `MovePlaylistItemGroupRequest`, `QueueGroupRequest`, `SetRepeatModeGroupRequest`, `SetShuffleModeGroupRequest`, `PingGroupRequest`, `IgnoreWaitGroupRequest` (`AbstractGroupState.cs:97-211`) — they just mutate group data and/or broadcast an update in place. Requests with no override at all in the current state fall through to `AbstractGroupState`'s catch-all, which just logs `"Unhandled request of type {RequestType} in {StateType} state."` and drops it (`AbstractGroupState.cs:228-231`).

**The `Waiting` state in depth.** `WaitingGroupState` (`MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs`) is the buffering-gate. Key fields:
- `ResumePlaying` (bool) — whether the group should end up Playing (`true`) or Paused (`false`) once everyone is ready.
- `InitialState`/`InitialStateSet` — captures the state the group was in *before* entering Waiting, recorded on the very first event handled (`WaitingGroupState.cs:44-51`, set in every handler's opening `if (!InitialStateSet) { InitialState = prevState; InitialStateSet = true; }` guard). Used later to decide what "returning to previous state" means for stragglers.

Entry paths and what they do:
- **A new session joins** (`SessionJoined`, `WaitingGroupState.cs:54-89`): if the group was Playing, it's provisionally paused and `PositionTicks` advanced by elapsed time so the position stays accurate (`elapsedTime = currentTime - context.LastActivity`, clamped to ≥0 because `LastActivity` can be in the future for scheduled commands — `WaitingGroupState.cs:66-76`). The new session is marked buffering (`context.SetBuffering(session, true)`), and a `Pause` command is sent to everyone already-ready (`SyncPlayBroadcastType.AllReady`) so the group doesn't drift further ahead while the newcomer catches up.
- **A `Seek`/`Buffer`/`NextItem`/etc. request arrives** in Playing/Paused: computed position is frozen, all members are forced back to buffering (`context.SetAllBuffering(true)`), and the appropriate command (`Seek`/`Pause`) is broadcast to everyone (e.g. `WaitingGroupState.cs:289-322` for Seek).

Exit / readiness aggregation, `HandleRequest(BufferGroupRequest,…)` and `HandleRequest(ReadyGroupRequest,…)` (`WaitingGroupState.cs:325-561`):
1. Verify the reporting client is talking about the currently-playing playlist item (`request.PlaylistItemId` vs `context.PlayQueue.GetPlayingItemPlaylistId()`); if mismatched, correct it with a targeted `PlayQueue` update and mark it buffering again (`WaitingGroupState.cs:335-345,409-419`) — protects against stale/racy client reports.
2. Estimate the client's *true current* position by adjusting its self-reported `PositionTicks` for the elapsed network/processing time since it made the report (`elapsedTime = currentTime.Subtract(request.When)`), but only trust that elapsed-time estimate if it's within `TimeSyncOffset` (2000ms) and the client says it's actually playing (`WaitingGroupState.cs:421-440`).
3. Compare against server position (`delayTicks = context.PositionTicks - clientPosition.Ticks`) against `MaxPlaybackOffset` (500ms) to decide accept-vs-reject (§4).
4. Update that member's `IsBuffering` flag and re-check `context.IsBuffering()` (any-member-still-buffering) after every single report — so the moment the last straggler reports ready, the *next* evaluation exits Waiting immediately (no separate "all ready" event, it's re-derived every time).
5. On exit: transitions to `PlayingGroupState` (scheduling an `Unpause` at a computed future time — see §14) or `PausedGroupState` (immediate, since no scheduling is needed to pause).

**A member leaving while Waiting** (`SessionLeaving`, `WaitingGroupState.cs:92-124`): removes their vote from the buffering aggregate; if that was the last buffering member, the group immediately resolves to Playing (if `ResumePlaying`) or Paused, exactly as if they'd reported Ready — leaving counts as becoming ready, so one straggler disconnecting doesn't hang the room forever.

## 13. Clock sync protocol (TimeSyncController)

Covered fully in §3; repeating the operational recipe for clarity. **NOT IN THIS CHECKOUT below the `GET` request/response** — the recipe is standard NTP math reconstructed from the two server timestamps, not repo text:

```
GET /GetUtcTime                      (Jellyfin.Api/Controllers/TimeSyncController.cs:20)
→ 200 OK
{
  "RequestReceptionTime":   "<server UTC ISO8601>",   // t1
  "ResponseTransmissionTime": "<server UTC ISO8601>"  // t2
}
```
Client records `t0` = local UTC just before sending the request, `t3` = local UTC just after receiving the response. Then:
- `offset = ((t1 - t0) + (t2 - t3)) / 2` — how far ahead/behind the client's clock is relative to the server's.
- `rtt = (t3 - t0) - (t2 - t1)` — round-trip network time excluding server think-time.

What the client is expected to do with `offset`: apply it to every server-supplied `DateTime` (`SendCommand.When`, `SendCommand.EmittedAt`, and the `When` it itself reports back in `ReadyGroupRequest`/`BufferGroupRequest`) so that "when the server says execute at `When`" maps to a correct point on the client's own clock. This is what makes the scheduled-command mechanism (§14) work across clients with un-synchronized wall clocks. Because the endpoint is a plain, cheap `GET`, the expected usage pattern (not shown server-side, since it's client logic) is to sample it repeatedly and take a low-RTT/low-jitter estimate rather than trusting a single round trip — the server does nothing to enforce or suggest a sample count; that policy is entirely client-owned and outside this checkout.

## 14. Scheduled commands

This is the mechanism that makes "everyone reacts at the same instant despite different network latencies" work, and it's fully contained in `SendCommand` + the state classes that populate its `When` field.

**The DTO** (repeated from §2 for this section's purposes), `MediaBrowser.Model/SyncPlay/SendCommand.cs:8-64`:
```csharp
public SendCommand(Guid groupId, Guid playlistItemId, DateTime when, SendCommandType command, long? positionTicks, DateTime emittedAt)
```
- `When` — the **UTC instant at which the client should execute** the command (e.g. actually call `play()`/seek). Mutable (`get; set;`) because some code paths patch it after construction (see below).
- `EmittedAt` — the UTC instant the server *created* this command object, always `DateTime.UtcNow` at construction time (`Group.cs:426`). No client code is in scope, so how it's consumed is inference, not repo fact: most plausibly a "how stale is this message" signal, not itself used for scheduling (scheduling is entirely carried by `When`).
- `PositionTicks` — the playback position the command refers to (for `Seek`, the target; for `Pause`/`Unpause`, the position at `When`).

**Construction helper**, `Group.NewSyncPlayCommand` (`Emby.Server.Implementations/SyncPlay/Group.cs:418-427`):
```csharp
public SendCommand NewSyncPlayCommand(SendCommandType type)
{
    return new SendCommand(
        GroupId,
        PlayQueue.GetPlayingItemPlaylistId(),
        LastActivity,      // <-- becomes "When"
        type,
        PositionTicks,
        DateTime.UtcNow);  // <-- becomes "EmittedAt"
}
```
Note `When` is populated from `context.LastActivity`, **not** from `DateTime.UtcNow` — `LastActivity` is a group-level field that gets deliberately set into the *future* before the command is built, which is the actual scheduling trick.

**How the future `When` gets computed — the unpause case**, `PlayingGroupState.HandleRequest(UnpauseGroupRequest,…)` (`GroupStates/PlayingGroupState.cs:62-87`, also mirrored in `WaitingGroupState.cs` recovery branches):
```csharp
var delayMillis = Math.Max(context.GetHighestPing() * 2, context.DefaultPing);
context.LastActivity = DateTime.UtcNow.AddMilliseconds(delayMillis);
var command = context.NewSyncPlayCommand(SendCommandType.Unpause);
context.SendCommand(session, SyncPlayBroadcastType.AllGroup, command, cancellationToken);
```
`GetHighestPing()` (`Group.cs:446-455`) returns the worst self-reported ping across all group members (see §3); doubled to (roughly) approximate a round trip, floored at `DefaultPing` = 500ms (`Group.cs:91`) so even an all-zero-ping group still gets a minimum safety buffer. Every client, however fast or slow its own link is, receives the *same* `When` timestamp and is expected to sit idle until its local clock (corrected by the `GetUtcTime` offset, §13) reaches that instant, then start playback simultaneously. The explicit code comment acknowledges this is best-effort: *"The added delay does not guarantee, of course, that the command will be received in time. Playback synchronization will mainly happen client side."* (`PlayingGroupState.cs:70-72`).

**Position bookkeeping around a scheduled `When` in the future**: because `LastActivity` can be set ahead of "now," several handlers compute `elapsedTime = currentTime - context.LastActivity` and explicitly clamp negative values to zero before adding to `PositionTicks` — e.g. `PausedGroupState.HandleRequest(PauseGroupRequest,…)` (`PausedGroupState.cs:70-80`) and `WaitingGroupState.SessionJoined` (`WaitingGroupState.cs:66-76`), each with the comment *"Elapsed time is negative if event happens during the delay added to account for latency… Seek only if playback actually started."* This is the server protecting its own internal position tracking from going backward when an event (like another Pause) arrives during the window between "Unpause scheduled" and "Unpause's `When` actually elapses."

**How a late-arriving client corrects itself** — this is handled entirely through the `Ready`/`Buffer` report-and-reconcile loop in `WaitingGroupState`, not through any separate "late" flag:
1. A client that fell behind (didn't reach `When` on time, or is still buffering when others are ready) eventually POSTs `/SyncPlay/Ready` with its own `PositionTicks`/`IsPlaying`/`When` (`SyncPlayController.cs:318-332`).
2. Server computes `clientPosition` (its estimated *current* position, elapsed-adjusted per §3/§12) and `delayTicks = context.PositionTicks - clientPosition.Ticks` (`WaitingGroupState.cs:442-447`).
3. If the client is grossly behind (`!request.IsPlaying && |delayTicks| > MaxPlaybackOffset`), server does **not** try to reschedule a synchronized resume for it — it hard-corrects: sends that client alone a `Seek` command and keeps it marked buffering (`WaitingGroupState.cs:453-467`).
4. If the client is close enough to be trusted as "ready" but the *group* is still buffering on someone else, the server sends **that client alone** a `Pause` command with `command.When = currentTime.AddTicks(delayTicks)` (`WaitingGroupState.cs:472-479`) — i.e. it schedules that specific client to pause slightly in the future at exactly the position it should logically reach, rather than pausing it immediately, so its local playback coasts to the mathematically-correct spot before freezing.
5. Once *all* members are ready, the transition back to Playing recomputes one more future `When` for the resume, with two branches (`WaitingGroupState.cs:483-512`): if the last-arriving client's `delayTicks` exceeds `2×highest-ping`, treat it as "still catching up" and give the *other* clients (`AllExceptCurrentSession`) an `Unpause` scheduled at `currentTime + delayTicks` so they wait for it to arrive; otherwise (small delay), treat it as "close enough," clamp the resume delay to `max(2×highestPing, DefaultPing)`, and send `Unpause` to `AllGroup` including the latecomer itself, scheduled that short distance in the future.

In short: **every corrective command is still a scheduled command with a `When`**, computed either as "now" (immediate correction, e.g. hard `Seek`) or as "now + some calculated delay" (synchronized resume) — there's no separate wire message type for "you're late, catch up"; lateness is just folded into how the next `SendCommand.When`/`PositionTicks` pair is computed.
