# Syncplay — protocol reference notes

Clone: `/code/Projects/VideoSync/refs/syncplay` (local working copy, shallow — 1 commit visible: `5618ef2`, dated 2026-08-28, message references PR #803).

## 1. Overview

Syncplay is a Python desktop application (Twisted-based) that synchronizes playback across **local media players** (mpv, VLC, MPC-HC/BE, mplayer, IINA, MPV.net, Memento) over a custom TCP protocol. It is **not** a browser/HTML5-`<video>` tool — there is no DOM, no `<video>` element, no web extension anywhere in this codebase. It is the reference for **protocol/algorithm design** only; the transport (raw TCP + Twisted `LineReceiver`) and player-adapter layer (native player IPC) are not directly reusable for a browser-based system.

- Language/stack: Python 3, Twisted (`reactor`, `LineReceiver`, `zope.interface`), PyQt5 GUI (`syncplay/ui`), optional TLS via pyOpenSSL/`cryptography`.
- Entry points: `syncplay/ep_client.py`, `syncplay/ep_server.py`.
- Version at clone time: `1.7.7`, milestone `"Yoitsu"` (`syncplay/__init__.py:1-4`).
- License: Apache License 2.0 (`LICENSE`).
- Maintenance status: this clone is shallow (`git log` shows a single commit), so full history/issue signal is **ABSENT** from this clone. What is visible: the code is under active feature development — version-gated features up to `SET_OTHERS_READINESS_MIN_VERSION = "1.7.2"` (`syncplay/constants.py:162`), and the single visible commit is a routine bugfix PR (#803) merged the same day, consistent with an actively maintained project (matches syncplay.pl's real-world reputation as the long-running reference implementation in this space).

## 2. Transport & message schema

Not WebSocket, not SSE, not WebRTC. **Raw TCP socket**, framed with Twisted's `LineReceiver` (newline-delimited), payload is a single JSON object per line (`syncplay/protocols.py:19` `class JSONCommandProtocol(LineReceiver)`).

- Send: `json.dumps(dict_)` → `sendLine(line.encode('utf-8'))` (`protocols.py:57-60`).
- Receive: `line.decode('utf-8')` → `json.loads(line)` → dispatch by top-level key (`protocols.py:40-55`).
- Top-level message types, dispatched in `handleMessages` (`protocols.py:20-38`): `Hello`, `Set`, `List`, `State`, `Error`, `Chat`, `TLS`. Any unknown top-level key drops the connection with an error.
- Default port: `8999` (`constants.py:23`).

### Verbatim shapes (sync-relevant)

**Hello, client → server** (`protocols.py:162-174`):
```json
{"Hello": {
  "username": "alice",
  "password": "serverpw",
  "room": {"name": "myroom"},
  "version": "1.2.255",
  "realversion": "1.7.7",
  "features": {"sharedPlaylists": true, "chat": true, "featureList": true, "readiness": true, "managedRooms": true, "persistentRooms": false, "uiMode": "GUI"}
}}
```
(`password`/`room` omitted if unset. `version` is hardcoded to `"1.2.255"` for backward compat, real version goes in `realversion` — `protocols.py:171-172`.)

**Hello, server → client** (`protocols.py:581-596`):
```json
{"Hello": {
  "username": "alice",
  "room": {"name": "myroom"},
  "version": "1.2.255",
  "realversion": "1.7.7",
  "features": {"isolateRooms": false, "readiness": true, "managedRooms": true, "persistentRooms": false, "chat": true, "maxChatMessageLength": 150, "maxUsernameLength": 16, "maxRoomNameLength": 35, "maxFilenameLength": 250, "setOthersReadiness": true},
  "motd": "..."
}}
```

**State** — see §12 below (full field-by-field lifecycle).

**Set/ready, client → server** (`protocols.py:340-355`):
```json
{"Set": {"ready": {"isReady": true, "manuallyInitiated": true, "username": "bob"}}}
```
(`username` present only when setting *another* user's readiness — requires `setOthersReadiness` feature.)

**Set/ready, server → client** (`protocols.py:643-660`):
```json
{"Set": {"ready": {"username": "bob", "isReady": true, "manuallyInitiated": true, "setBy": "alice"}}}
```

**Chat** (`protocols.py:242-243`, `335-338`): `{"Chat": "hello everyone"}` outbound; inbound is `{"Chat": {"username": "alice", "message": "hello everyone"}}` (`server.py:212-215`).

**List** (roster, `protocols.py:245-256`): server replies with `{"List": {"<roomName>": {"<username>": {"position": 0, "file": {...}, "controller": false, "isReady": true, "features": [...]}}}}`.

**Playlist**: `{"Set": {"playlistChange": {"files": [...], "user": "alice"}}}`, `{"Set": {"playlistIndex": {"index": 2, "user": "alice"}}}` (`protocols.py:357-369`, `662-676`).

## 3. Clock synchronization

Server-authoritative timebase for *position*, but RTT/latency estimation is **symmetric bidirectional echo** — not NTP-style offset calculation. Implemented once, shared by both ends: `class PingService` (`protocols.py:816-844`).

Mechanism: each side timestamps its own outgoing message (`newTimestamp()` = `time.time()`) and includes it in the `ping` object; the *other* side echoes that exact timestamp back verbatim (adjusted only for its own processing time) in its own subsequent message. When the timestamp comes back, the sender computes:

```python
# PingService.receiveMessage(timestamp, senderRtt)   protocols.py:826-838
self._rtt = time.time() - timestamp                      # my own RTT for the roundtrip I initiated
if not self._avrRtt:
    self._avrRtt = self._rtt
self._avrRtt = self._avrRtt * 0.85 + self._rtt * 0.15     # PING_MOVING_AVERAGE_WEIGHT = 0.85, constants.py:231
if senderRtt < self._rtt:
    self._fd = self._avrRtt / 2 + (self._rtt - senderRtt) # forward delay when the other side sees a *shorter* RTT than us
else:
    self._fd = self._avrRtt / 2                           # assume symmetric split otherwise
```

`self._fd` ("forward delay" / `messageAge`) is the estimated **one-way** network delay from the remote peer to us, used to age a position value that was true "as of" a moment in the past (see §4/§12). `senderRtt` is the *other side's own last-measured RTT*, sent alongside the echoed timestamp so each peer can detect asymmetric paths.

Concretely, on the wire this is the `latencyCalculation` / `clientLatencyCalculation` / `serverRtt` / `clientRtt` fields — quoted verbatim and explained field-by-field in §12.

No clock offset is ever computed or assumed synchronized; both peers only ever reason in terms of *their own* wall clock deltas plus this one-way-delay estimate. This deliberately sidesteps NTP-style clock-skew correction.

## 4. Drift correction policy

Three independent, layered mechanisms, each gated by its own threshold, evaluated every state update in `_changePlayerStateAccordingToGlobalState` (`client.py:452-483`). `diff = self.getPlayerPosition() - position` (local minus authoritative global position, `client.py:455`).

| Mechanism | Threshold constant | Value | Behavior |
|---|---|---|---|
| Hard seek on explicit remote seek | `doSeek` flag (server-forced) | n/a | `_serverSeeked` → `setPosition(position)` unconditionally (`client.py:422-432`) |
| Hard rewind on desync | `rewindThreshold` (config, default `DEFAULT_REWIND_THRESHOLD`) | **4s** (min allowed: `MINIMUM_REWIND_THRESHOLD` = 3s) | if `diff > rewindThreshold` and not already a `doSeek`: `_rewindPlayerDueToTimeDifference` → `setPosition(position)` (`client.py:463-464`) |
| Playback-rate nudge (slowdown) | `slowdownThreshold` (config, default `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD`) | **1.5s** (min: `MINIMUM_SLOWDOWN_THRESHOLD` = 1.3s) | if `diff > slowdownThreshold`: `setSpeed(SLOWDOWN_RATE)` = **0.95x**; reverts to `1.00x` once `diff < SLOWDOWN_RESET_THRESHOLD` = **0.1s** (`client.py:434-450`) |
| Fast-forward (behind, non-controlling client) | `fastforwardThreshold` (config, default `DEFAULT_FASTFORWARD_THRESHOLD`) | **5s** (min: `MINIMUM_FASTFORWARD_THRESHOLD` = 4s), sustain window uses `FASTFORWARD_BEHIND_THRESHOLD` = 1.75s | only for non-controllers or `dontSlowDownWithMe`: if `diff < -1.75s` a timer starts; fast-forwards (`setPosition(position + FASTFORWARD_EXTRA_TIME)`, extra = **0.25s**) only once sustained behind for `(fastforwardThreshold - 1.75)`s **and** still `diff < -fastforwardThreshold` (`client.py:465-476`) |

Additional gating: `_determinePlayerStateChange` treats any drift under **`SEEK_THRESHOLD` = 1s** (both vs. player position and vs. global position) as noise, not a user seek (`client.py:218-223`, `constants.py:79`). `DO_NOT_RESET_POSITION_THRESHOLD = 1.0` and `LAST_PAUSED_DIFF_THRESHOLD = 2` guard against redundant resets around pause/leave events (`constants.py:91,129`).

So: <1s = ignored; 1–1.5s = ignored (not yet slowdown); ≥1.5s while playing = `playbackRate` nudge to 0.95x; ≥4s = hard seek; falling behind by ≥1.75s sustained ≥3.25s (5 − 1.75) and still ≥5s behind = fast-forward by +0.25s. Pause always hard-syncs position too: `SYNC_ON_PAUSE = True` forces `setPosition(getGlobalPosition())` on remote pause (`constants.py:92`, `client.py:410-414`).

## 5. Echo suppression

Two independent layers.

**(a) Protocol-level counter handshake — `ignoringOnTheFly`.** Every locally-initiated `State` change increments a per-connection counter before sending; the counter is only cleared when the *other side* echoes it back matching:

- Client side (`protocols.py:301-325`): if `stateChange` is true (local pause/seek), `self.clientIgnoringOnTheFly += 1` before sending. Client also forwards `serverIgnoringOnTheFly` back to the server as `ignoringOnTheFly.server` when applicable.
- On receipt (`protocols.py:279-297`), the client checks `ignore['client'] == self.clientIgnoringOnTheFly` to zero it out, and — crucially — **while `self.clientIgnoringOnTheFly` is nonzero, incoming `playstate` from the server is not applied to the player at all** (`if position is not None and paused is not None and not self.clientIgnoringOnTheFly:` — `protocols.py:296`). This is the actual suppression: a client that just changed state locally ignores server echoes of stale state until its own change is acknowledged.
- Server side mirrors this (`protocols.py:730-789`): `serverIgnoringOnTheFly` is incremented on `forced` sends (server-authoritative overrides, e.g. after a room-wide rewind) and gates whether `handleState`'s `updateState()` call is applied (`if self.serverIgnoringOnTheFly == 0:` — `protocols.py:788`).

**(b) Client-level single source of truth for the player.** Syncplay does not use player "seeked"/"pause" DOM-style events for suppression; it **polls** the player (`askForStatus()` → `updatePlayerStatus(paused, position)`, `client.py:250` and `basePlayer.py:11`). Whenever *we* programmatically move the player (`setPosition`/`setPaused`, `client.py:867-884`), the client synchronously updates its own bookkeeping (`self._playerPosition`, `self._playerPaused`, `self._lastPlayerUpdate`) *before* the next poll. `_determinePlayerStateChange` (`client.py:218-223`) then compares the next poll result against this bookkeeping (with `SEEK_THRESHOLD` = 1s slack) — since the values already match what was just set, no "user seek" is (mis-)detected and nothing is rebroadcast. This is effectively an implicit ignore-with-no-timeout, since the expected value is written before the echo can arrive.

## 6. Conflict resolution without a host

There is no "host"/room owner by default (`Room.canControl` always returns `True` — `server.py:653-654`). The **server** is still the single arbiter; conflicts are resolved as follows:

- **Pause is edge-triggered, first-write-wins, immediate:** `Watcher.updateState` (`server.py:875-890`) detects `pauseChanged` per-watcher and, if so, calls `self.getRoom().setPaused(...)` unconditionally — whichever client's message the server processes first for a differing pause state wins, and it is instantly forced out to everyone via `forcePositionUpdate` (`server.py:180-190`, sets `forced=True` on `sendState`). No comparison/voting — pure last-message-processed-wins on the server's single-threaded reactor.
- **Position is aggregated, not raced:** `Room.getPosition()` (`server.py:597-607`) does **not** trust whichever watcher last spoke; instead, at most once per second (`age > 1`), it takes `min(self._watchers.values())` — i.e., the **slowest client's reported position wins** and becomes room-canonical (see §14 for the comparator). This is the tie-break for concurrent divergent positions.
- **`setBy` is attribution, not authority:** every `State`/`playstate` carries `setBy` (username) purely for OSD messages ("X rewound the video") — it plays no role in conflict resolution (`server.py:735-739`, `client.py:381-432`).
- No Lamport clocks, no vector clocks, no message sequence numbers beyond the `ignoringOnTheFly` echo counters (§5), which are per-connection, not global order. Ordering relies entirely on TCP's in-order delivery plus wall-clock timestamps (`_lastUpdatedOn`, `time.time()`), each independently maintained per watcher.
- Controlled rooms (`ControlledRoom`, `server.py:686-724`) are the one true "host" mode — `canControl()` restricted to authenticated controllers (see §9) — but this is opt-in, not the default room type.

## 7. Buffering / readiness gating

Two *separate* mechanisms are easy to conflate — keep them distinct:

**(a) Stall → room pause (automatic, no explicit "ready" needed).** If any client's local player pauses (buffering, user click, EOF, anything), the very next poll-driven `State` reports `paused=true`, the server detects `pauseChanged` and immediately sets `Room` state to paused and force-broadcasts it to the whole room (`server.py:875-890` `Watcher.updateState`, `forcePositionUpdate` at `server.py:180-190`). This is how "the room waits for a stalled client" actually happens — it's a side effect of pause propagation, not a dedicated buffering protocol.

**(b) Manual "ready" flag → autoplay/instaplay gating (client-side policy only).** `isReady` is a user-togglable flag broadcast via `Set/ready` (§2); the server just relays it (`server.py:217-232`) and does **not** use it to gate playback itself (`server.py --disable-ready` can turn the whole feature off). All enforcement is client-side:
- `instaplayConditionsMet()` (`client.py:1060-1075`) decides whether a controller may unpause immediately, controlled by config `unpauseAction` ∈ `{UNPAUSE_IFALREADYREADY_MODE, UNPAUSE_IFOTHERSREADY_MODE, UNPAUSE_IFMINUSERSREADY_MODE, UNPAUSE_ALWAYS_MODE}` (`constants.py:339-342`).
- `autoplayConditionsMet()` (`client.py:1077-1086`) requires `userlist.areAllUsersInRoomReady(...)` plus an optional minimum-user threshold before a countdown (`AUTOPLAY_DELAY` = **3.0s**, `constants.py:90`) auto-unpauses everyone.
- Aggregation of "all ready" happens client-side over the roster the server already broadcasts (`userlist.areAllUsersInRoomReady`, referenced at `client.py:1084`) — the server never itself computes "is everyone ready."

So: buffering/stall handling is server-enforced and automatic; "ready to start" is a convention layered entirely in client policy on top of a dumb relay.

## 8. Provider coupling

**Not applicable in the web sense this brief cares about** — Syncplay has no `<video>` element, no DOM, no browser, no SPA/iframe/shadow-DOM handling anywhere in the codebase (confirmed by absence of any such terms in `syncplay/*.py`). It targets native desktop media players over their own IPC/RC protocols. This whole section is **ABSENT** for the DOM-specific questions.

What *is* structurally analogous and worth noting as a transferable pattern: the player-abstraction seam. `syncplay/players/basePlayer.py:4-112` defines an abstract `BasePlayer` interface (`askForStatus`, `setPaused`, `setPosition`, `setSpeed`, `openFile`, `displayMessage`, `drop`, `run`), and `syncplay/players/playerFactory.py` selects one of the concrete adapters (`mpv.py`, `vlc.py`, `mpc.py`, `mplayer.py`, `iina.py`, `mpvnet.py`, `memento.py`) at runtime. `client.py` talks only to this interface, never to a specific player. This is the same shape a per-site adapter interface (YouTube/Netflix/Laftel) should take, just swap "media player IPC" for "DOM video element + site quirks."

## 9. Room, identity & auth model

- **No accounts.** Identity is just a chosen username, deduplicated on join by appending `_` until unique (`RoomManager.findFreeUsername`, `server.py:504-512`).
- **Rooms are ephemeral by default:** created on first join (`RoomManager._getRoom`, `server.py:475-482`), deleted automatically once empty unless persistent or explicitly permanent (`_deleteRoomIfEmpty`, `server.py:496-502`).
- **Persistence (optional):** `--rooms-db-file` backs rooms with SQLite (`RoomDBManager`, `server.py:379-408`), storing playlist/index/position/last-update so a room survives being empty.
- **Server-wide password (optional):** `--password`, stored MD5-hashed (`SyncFactory.__init__`, `server.py:33-36`), checked at `Hello` (`_checkPassword`, `protocols.py:538-546`). Sent essentially in the clear at `Hello` time unless opportunistic TLS (`startTLS`) already completed — TLS is negotiated *before* `Hello` only if both sides advertise support (`protocols.py:89-102`), otherwise plaintext.
- **Controlled rooms** (closest thing to a "host," opt-in per room): room name syntax `+<name>:<12-hex-hash>` where the hash is `sha1(sha256(roomName + sha256(salt)) + sha256(salt) + password)[:12].upper()` (`RoomPasswordProvider._computeRoomHash`, `syncplay/utils.py:592-599`). Clients that know the (salt-derived) control password can `authRoomController` (`server.py:198-210`) to join `room.getControllers()`; only controllers pass `ControlledRoom.canControl()` (`server.py:718-719`) and can set pause/position/playlist for that room (`server.py:698-716`).
- **Rate limiting / abuse controls: ABSENT.** No throttling, flood control, connection caps, or per-IP limits found anywhere in `server.py` or `protocols.py` (`grep` for `rate.limit|throttle|flood|abuse|maxConnections` returns nothing).

## 10. What's broken / unmaintained / worth NOT copying

- **`Watcher.__lt__` is not a proper total order** (`server.py:838-843`): a watcher with no position/file returns `False` when compared as `self`, but `True` when compared *as* `b` against a valid watcher — i.e. it's asymmetric/inconsistent, relying on Python's `min()` implementation detail (first-encountered-wins on ties) rather than a real ordering. Fragile if ever ported to a language whose sort/min isn't stable the same way.
- **The "slowest wins" sampling interval (`age > 1`) is a bare magic number inline in `Room.getPosition()`** (`server.py:598`), not lifted into `constants.py` despite the file otherwise centralizing every other timing constant — inconsistent style, easy to miss when tuning.
- **`client.py` is a 2697-line god object** — playback state machine, UI notification text selection, playlist/autoplay/watched-history logic, and OSD wiring are all interleaved. Extracting "just the sync core" requires careful picking; don't port the file wholesale.
- **Transport is hand-rolled newline-JSON over raw TCP** (`LineReceiver`), not WebSocket — cannot be reused directly for a browser client; only the message shapes/algorithms port over.
- **TLS is opportunistic, not enforced**, and its error handling is stringly-typed exception matching (`"tlsv1 alert protocol version" in str(reason.value)`, `protocols.py:104-124`) with two explicit "to be deleted when Twisted version X drops" compatibility shims (`protocols.py:387-390`, `protocols.py:396`) — brittle against upstream library changes, and already acknowledged as such in the code.
- **No message-level acks or idempotency beyond the two-counter `ignoringOnTheFly` handshake** — correctness leans entirely on TCP's in-order delivery guarantee; there's no defense against the counters getting out of sync if a message were ever dropped/duplicated above the TCP layer (e.g. through a proxy that re-frames lines).
- **`constants.py` mixes real protocol-tuning constants with Qt stylesheets, OS binary search paths for a dozen media players, and UI regexes** — useful signal (thresholds, ping weight) is diluted; don't import the file, extract only the sync-relevant subset (§13).

## 11. Top 5 ideas worth stealing

1. **Bidirectional echo-based RTT/one-way-delay estimation** (no NTP, no clock-offset assumption) — `PingService`, `syncplay/protocols.py:816-844`. Cheap, symmetric, and gives a `messageAge` figure usable to age a position value in transit. Directly portable to a WebSocket protocol.
2. **Two-counter `ignoringOnTheFly` echo-suppression handshake** — `syncplay/protocols.py:279-325` (client) and `syncplay/protocols.py:730-789` (server). Simple, stateless-per-message, robust way to stop a peer from re-processing its own change reflected back at it, without needing a global sequence number.
3. **Slowest-client-wins position aggregation, sampled at ≤1Hz** — `Room.getPosition`, `syncplay/server.py:597-607`, combined with automatic pause propagation on any client's stall — `Watcher.updateState`, `syncplay/server.py:875-890`. This *is* the host-less readiness/buffering-gate answer: don't build a separate "ready" vote for stalls, just let pause propagate and let position converge to the laggard.
4. **Three/four-tier layered drift correction** (ignore <1s → playbackRate nudge at 1.5s → hard seek at 4s → sustained-fast-forward for laggards) — `syncplay/constants.py:72-84`, `syncplay/client.py:434-483`. Prevents seek-storms from natural jitter while still hard-correcting large drift.
5. **Deterministic, DB-free per-room control auth via salted-hash room naming** (`+roomName:hash`) — `syncplay/utils.py:566-599`, `syncplay/server.py:198-210`. Gives an optional "controller" concept without any account system or persistent auth store — relevant if this project ever wants an *opt-in* semi-host mode while keeping the no-host default.

## 12. The full State message lifecycle

### Client → Server `State`
Built in `SyncClientProtocol.sendState` (`syncplay/protocols.py:301-325`):
```json
{"State": {
  "playstate": {
    "position": 734.21,
    "paused": false,
    "doSeek": true
  },
  "ping": {
    "latencyCalculation": 1756382001.884213,
    "clientLatencyCalculation": 1756382001.912004,
    "clientRtt": 0.041
  },
  "ignoringOnTheFly": {
    "server": 2,
    "client": 1
  }
}}
```
Field meanings:
- `playstate.position` — client's current player position in seconds. Omitted entirely (whole `playstate` key dropped) while the client is still waiting on its own outstanding `clientIgnoringOnTheFly` (unless `serverIgnoringOnTheFly` is nonzero) — `protocols.py:303-310`.
- `playstate.paused` — client's current pause state.
- `playstate.doSeek` — present (and true) only when the local change was detected as a "seek" (`_determinePlayerStateChange`, `client.py:218-223`), not a plain drift.
- `ping.latencyCalculation` — **echo**: the timestamp the *server* sent us last time in its own `ping.latencyCalculation`, copied back verbatim so the server can compute its RTT. Present only if we have one to echo (`protocols.py:312-313`).
- `ping.clientLatencyCalculation` — **new timestamp**: `self._pingService.newTimestamp()` = our own `time.time()` right now, for the *server* to echo back to us next round (`protocols.py:314`).
- `ping.clientRtt` — our own last-computed RTT (`PingService.getRtt()`), sent so the server can detect asymmetric-path delay via the `senderRtt` comparison in §3 (`protocols.py:315`).
- `ignoringOnTheFly.server` / `.client` — the echo-suppression counters (§5). `server` is present when we're forwarding an outstanding server-ignore count back to the server for it to clear; `client` is present when *we* just made a local change and are telling the server "ignore anything you send me until you've acked counter N" (`protocols.py:316-324`).

### Server → Client `State`
Built in `SyncServerProtocol.sendState` (`syncplay/protocols.py:730-762`):
```json
{"State": {
  "ping": {
    "latencyCalculation": 1756382002.001337,
    "serverRtt": 0.038,
    "clientLatencyCalculation": 1756382001.917511
  },
  "playstate": {
    "position": 734.5,
    "paused": false,
    "doSeek": false,
    "setBy": "alice"
  },
  "ignoringOnTheFly": {
    "server": 3
  }
}}
```
Field meanings:
- `ping.latencyCalculation` — **new timestamp**: server's own `time.time()` now, for the client to echo back next round (`protocols.py:742`).
- `ping.serverRtt` — server's own last-computed RTT to this client (`PingService.getRtt()`), the `senderRtt` the client will compare against its own RTT (`protocols.py:743`).
- `ping.clientLatencyCalculation` — **echo**: the `clientLatencyCalculation` timestamp this client sent us, adjusted by `processingTime` (time the server spent holding the value before replying — `time.time() - self._clientLatencyCalculationArrivalTime`), so the client's RTT measurement isn't inflated by server-side queuing (`protocols.py:731-734, 745-747`).
- `playstate.position`/`paused`/`doSeek` — the **room's** authoritative state (from `Room.getPosition()`/`isPaused()`, i.e. the slowest-client-derived value, §6/§14), not necessarily this specific client's own last-reported value.
- `playstate.setBy` — username that caused the current room state (for OSD attribution only, §6).
- `ignoringOnTheFly.server`/`.client` — mirror of the client-side fields; `server` increments on `forced` sends (`protocols.py:752-753`) so the client knows to expect (and not re-flag) this authoritative override.

### `ping`/`latencyCalculation`/`clientLatencyCalculation`/`serverRtt` — precise round-trip
1. Server sends `State` #1 with `ping.latencyCalculation = T_s1` (server's own clock).
2. Client receives it, computes `messageAge` via `_handleStatePing` (`protocols.py:268-277`) using whatever it had cached from the *previous* server round for `getLastForwardDelay()`, then in its reply echoes `ping.latencyCalculation = T_s1` back and stamps its own `ping.clientLatencyCalculation = T_c1`, `ping.clientRtt = <client's last RTT>`.
3. Server receives that reply: `PingService.receiveMessage(timestamp=T_s1, senderRtt=<client's clientRtt>)` computes `serverRtt = now - T_s1` and updates its own forward-delay estimate using the client's reported RTT as `senderRtt` (`protocols.py:826-838`).
4. Server's *next* `State` echoes `ping.clientLatencyCalculation = T_c1 + processingTime` back to the client, alongside a fresh `ping.latencyCalculation = T_s2` and its own `ping.serverRtt`.
5. Client receives that: `PingService.receiveMessage(timestamp=T_c1, senderRtt=<server's serverRtt>)` computes its own RTT and forward-delay estimate the same way.

Both sides thus independently maintain an RTT estimate and a one-way "forward delay" (`messageAge`), each one round-trip lagged from the other, entirely from echoed timestamps — no NTP, no assumed synchronized clocks. `messageAge` is added to a moving/playing (`paused == false`) position before it's applied locally, to compensate for the estimated one-way transit delay of the message that carried it (`client.py:495-496`, `server.py:869-871` `_updatePositionByAge`).

## 13. All timing constants

All from `syncplay/constants.py` unless noted. Config-overridable defaults are marked; hard constants are not.

| Name | Value | Gates |
|---|---|---|
| `SEEK_THRESHOLD` | 1 (s) | Below this, position drift is ignored / not classified as a user seek (`client.py:222`) |
| `DEFAULT_REWIND_THRESHOLD` (config default `rewindThreshold`) | 4 (s) | Hard `setPosition()` when local is *ahead* of global by more than this (`client.py:463`) |
| `MINIMUM_REWIND_THRESHOLD` | 3 (s) | UI-enforced floor on `rewindThreshold` |
| `DEFAULT_FASTFORWARD_THRESHOLD` (config default `fastforwardThreshold`) | 5 (s) | Non-controller/`dontSlowDownWithMe` client fast-forwards once sustained-behind by this much (`client.py:472`) |
| `MINIMUM_FASTFORWARD_THRESHOLD` | 4 (s) | UI-enforced floor |
| `FASTFORWARD_BEHIND_THRESHOLD` | 1.75 (s) | Behind-detection arm threshold + subtracted from `fastforwardThreshold` to get sustain duration (`client.py:466,471`) |
| `FASTFORWARD_EXTRA_TIME` | 0.25 (s) | Extra seek-ahead applied on fast-forward (`client.py:398`) |
| `FASTFORWARD_RESET_THRESHOLD` | 3.0 (s) | Cooldown added to `behindFirstDetected` after a fast-forward fires (`client.py:474`) |
| `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD` (config default `slowdownThreshold`) | 1.5 (s) | Above this while playing, `playbackRate` is nudged (`client.py:437`) |
| `MINIMUM_SLOWDOWN_THRESHOLD` | 1.3 (s) | UI-enforced floor |
| `SLOWDOWN_RATE` | 0.95 (×) | Playback rate applied during slowdown (`client.py:441`) |
| `SLOWDOWN_RESET_THRESHOLD` | 0.1 (s) | Diff below which rate reverts to 1.00x (`client.py:445`) |
| `DIFFERENT_DURATION_THRESHOLD` | 2.5 (s) | Threshold for warning that two clients' files have mismatched durations |
| `DO_NOT_RESET_POSITION_THRESHOLD` | 1.0 (s) | Guards redundant position resets |
| `LAST_PAUSED_DIFF_THRESHOLD` | 2 (s) | Window after a pause-on-leave within which a stale readiness toggle is discarded (`client.py:355-357`) |
| `PROTOCOL_TIMEOUT` | 12.5 (s) | Both ends: connection considered dead / dropped if no state update in this window (`client.py:210`, `server.py:865`) |
| `SERVER_STATE_INTERVAL` | 1 (s) | Server's per-watcher `State` push loop tick (`server.py:838-840`) |
| `PING_MOVING_AVERAGE_WEIGHT` | 0.85 | EMA weight for RTT smoothing: `avgRtt = avgRtt*0.85 + rtt*0.15` (`protocols.py:834`) |
| `AUTOPLAY_DELAY` | 3.0 (s) | Countdown length before auto-unpause once all users ready (`client.py:1093`, `1109`) |
| `RECONNECT_RETRIES` | 999 | Client reconnect attempt cap |
| `WARNING_OSD_MESSAGES_LOOP_INTERVAL` | 1 (s) | OSD warning refresh loop, not sync-relevant |
| `PLAYER_ASK_DELAY` | 0.1 (s) | Delay before starting the player-status poll loop (`client.py:198`) |

No explicit "moving-average window" of N samples exists — the moving average is an unbounded exponential weighted average (`PING_MOVING_AVERAGE_WEIGHT`), not a fixed-size sliding window.

## 14. "Slowest client" / readiness algorithm

File/function: `syncplay/server.py`, class `Room`, method `getPosition` (`server.py:597-607`), fed by per-watcher `Watcher.updateState` (`server.py:875-890`) and `Watcher.__lt__` (`server.py:834-838`).

**How a stalled client pauses the room:**
1. Client's local player pauses (buffering, EOF, manual). Next poll cycle reports `paused=true` in its `State` message.
2. Server's `SyncServerProtocol.handleState` → `Watcher.updateState(position, paused, doSeek, messageAge)` (`server.py:875-890`).
3. `__hasPauseChanged(paused)` (`server.py:869-871`) compares against `self._room.isPaused()`. If different: `self.getRoom().setPaused(Room.STATE_PAUSED if paused else STATE_PLAYING, self)` — the room's authoritative state flips **immediately**, attributed (`setBy`) to this watcher.
4. Because `doSeek or pauseChanged` is true, `self._server.forcePositionUpdate(self, doSeek, paused)` (`server.py:180-190`) is called: it re-sets `room.setPosition(watcher.getPosition(), setBy)` and immediately broadcasts a `forced=True` `State` to **every** watcher in the room via `room.setPosition` iterating `self._watchers.values()` and calling `watcher.setPosition(position)`, then `broadcastRoom`. `forced=True` sets `serverIgnoringOnTheFly += 1` on that watcher's connection (`protocols.py:752-753`) so the resulting client-side echo isn't misread as a new local change.
5. Every other client's next `handleState` applies the paused state via `updateGlobalState` (§4/§5), and `_serverPaused` (`client.py:410-420`) also hard-syncs position (`SYNC_ON_PAUSE`).

**How the room resumes:** resuming is symmetric — whichever client unpauses first (subject to its own `instaplayConditionsMet`/`unpauseAction` gating client-side, §7b) flips `Room.setPaused(STATE_PLAYING, ...)` the same way, force-broadcast the same way. There is no server-side "wait for all clients ready" gate for resuming — the closest thing is the **client-local** autoplay countdown (`autoplayConditionsMet`/`autoplayCountdown`, `client.py:1077-1114`) which requires `userlist.areAllUsersInRoomReady(...)` before a *controller* is even willing to send the unpause, but this is enforced by convention on each client, not by the server.

**Position aggregation ("slowest client wins"):** independent of pause/resume, `Room.getPosition()` runs at most once per second (`age = time.time() - self._lastUpdate; if self._watchers and age > 1:`) and picks `watcher = min(self._watchers.values())` — i.e. the watcher whose `getPosition()` (current reported position, extrapolated forward if playing — `Watcher.getPosition`, `server.py:780-786`) is *smallest* becomes the room's canonical position and `setBy`. `Watcher.__lt__` (`server.py:834-838`) treats a watcher with no position or no loaded file as unconditionally "behind" (`return True` when the *other* watcher has neither), so an idle/no-file client can anchor the room to itself. This is the actual "wait for the slowest client" behavior for ongoing drift, distinct from the discrete pause-propagation above.
