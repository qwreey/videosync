# Design decisions

Locked with the user on 2026-08-28. These are inputs to the design, not outputs of research —
research may challenge them, but changing one requires an explicit decision.

## D1 — Priority providers: Laftel + YouTube
Netflix is explicitly **deprioritized**. We do not sign up for MSE/DRM internal-player-API pain
in v1. Netflix may be added later as just another adapter if the adapter seam is right.

Implication: the generic HTML5 `<video>` adapter must be excellent, and YouTube gets a dedicated
adapter driving `movie_player` (seekTo/playVideo/pauseVideo/getCurrentTime/getPlayerState).
Laftel is expected to work through the generic adapter or a thin variant — TO BE VERIFIED.

## D2 — Server: Go, single binary
Single static binary, single container, in-memory room state, no external DB required to run.
Optional persistence may be added behind an interface, but the zero-dependency path must stay
the documented default. Self-hosting friendliness is a primary product requirement.

## D3 — Topology: server-authoritative with scheduled commands
The server owns a UTC timebase. Clients measure their offset/RTT against it. Commands are
broadcast with a **future `when` timestamp** plus the target playback position, so every client
executes the same transition at the same wall-clock instant. This is the Jellyfin SyncPlay model.

Chosen specifically because there is **no host (방장)**: with every member holding full control,
a naive relay flaps when two users issue conflicting commands. Server-assigned monotonic
sequence numbers + a single authoritative state resolve this deterministically.

## D4 — No host / egalitarian rooms
Every member can play, pause, seek, and change the media. Rooms are for people who already know
each other. No moderation hierarchy in v1.

Consequences to design for (not optional):
- Server-assigned monotonic sequence number on every state change; clients discard stale state.
- Command rate limiting per member, to contain accidental loops rather than malice.
- A "who did this" attribution in the state so the UI can show `X paused`.

## D5 — Client surfaces: browser extension (Chrome MV3 + Firefox) AND userscript (Tampermonkey)
Both ship. This forces the client to be structured as a **platform-agnostic core** (adapters,
sync engine, protocol client, UI) with thin platform shims:
- extension shim: service worker / content script / MAIN-world bridge
- userscript shim: runs in page world already; `GM_*` for storage

Practical benefit: the userscript is a distribution path that bypasses store review, and it is
the easier of the two for MAIN-world player-API access. It is also a good testbed.

## Non-goals (explicit)
- **No screen capture, no stream relay, no media proxying.** Only URL + position + play state +
  chat cross the wire. Every participant must independently hold legal access to the media.
- No transcoding, no hosting of media files.
