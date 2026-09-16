# Design decisions

Locked with the user on 2026-08-28. These are inputs to the design, not outputs of research —
research may challenge them, but changing one requires an explicit decision.

## D1 — Priority providers: Laftel + YouTube
Netflix is explicitly **deprioritized**. We do not sign up for MSE/DRM internal-player-API pain
in v1. Netflix may be added later as just another adapter if the adapter seam is right.

Implication: the generic HTML5 `<video>` adapter must be excellent, and YouTube gets a dedicated
adapter driving `movie_player` (seekTo/playVideo/pauseVideo/getCurrentTime/getPlayerState).
Laftel is expected to work through the generic adapter or a thin variant — TO BE VERIFIED.

> **Measured (2026-08-31, `docs/BROWSER-FINDINGS.md` §8): YouTube needs no dedicated adapter.**
> The generic `Html5Adapter` drives the real watch page — `play()` accepted, a raw `currentTime`
> write sticks, and `playbackRate` 1.1 is held for ten seconds without the player resetting it.
> The `movie_player` route is still there if something later needs it (ad state, for one), but it
> is not required for sync. **Laftel is still unverified** and is the last open provider question.

## D2 — Server: Go, single binary
Single static binary, single container, in-memory room state, no external DB required to run.
Optional persistence may be added behind an interface, but the zero-dependency path must stay
the documented default. Self-hosting friendliness is a primary product requirement.

> **Measured amendment (`docs/BROWSER-FINDINGS.md` §8, §9): "self-hostable" splits in two.**
> A browser refuses every request from a public-origin page — every OTT site — to a loopback or
> private address, by any scheme, before the request leaves the browser. So the *userscript* needs
> the server on a public name with a real certificate (`-tls-cert`/`-tls-key`, or a reverse proxy
> or tunnel). The *extension* does not: its service worker is exempt, which makes it the only route
> to running the server on your own machine. That is the strongest single argument for D5's "both
> ship", and it was not the one D5 was written for.
>
> The binary stayed dependency-free: `server/go.mod` has no `require` block and no `go.sum`, which
> is why the WebSocket implementation is hand-rolled.

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

> **As built (2026-08-31):** the shims share `client/core/src/app/bootstrap.ts` verbatim and differ
> in exactly three injected pieces — storage, transport, and how a room gets created. The core
> turned out to include the UI panel too, so both shims mount the same one.
>
> **No MAIN-world bridge exists.** It was not needed: the generic adapter drives YouTube from the
> isolated world (§8), and keeping `window.VideoSync` out of the page is a property worth having —
> a page cannot drive the extension. The bridge, and the per-load nonce it would require
> (`CLAUDE.md`), only become relevant if a provider turns out to need its page-context player API.
>
> **Firefox is not supported yet** and no longer claims to be: its MV3 wants `background.scripts`
> and it has never shipped `background.service_worker`, so the manifest's earlier gecko id was a
> promise the build could not keep.

> **Amended (2026-09-16):** Firefox is supported as a Manifest V2 build (`dist-firefox/`),
> because Firefox's MV3 background upgrades `ws://` to TLS (BROWSER-FINDINGS §19).

## D6 — Access control is opt-in and pluggable (2026-09-17)
There is no single right way to close a self-hosted server, so there is not one. Operators range
from "on my tailnet, no auth" to "public, behind Authelia". The server offers several
authenticators that can be enabled **together**, off by default:

- `none` — the default; nothing changes.
- `token` — shared access keys from a file (stored hashed).
- `password` — per-person users from a file, PBKDF2-SHA256 (Go stdlib; bcrypt/argon2 would be a
  dependency, so htpasswd files are not read).
- `proxy` — trust a reverse proxy or forward-auth gateway (Basic at the proxy, tinyauth, Authelia,
  authentik, oauth2-proxy) **only** when the TCP peer is in `-trusted-proxies`.
- `oidc` — the server is the only relying party (confidential code flow); clients never see IdP
  tokens.

Whatever authenticates, the server issues its **own** device token, and a short single-use ticket
per connection. The room id + rotatable secret stays in every mode (D4). What is gated is a
setting: room creation by default, joining too if asked. Design: `docs/design/auth.md`.

## D7 — Provider knowledge is data: descriptor JSON sets (2026-09-17)
Per-site knowledge (what names a video, its canonical URL, which paths are media, which element
is the player, which capabilities to distrust) lives in declarative JSON **provider descriptors**,
in the spirit of VIA's keyboard definitions. The repo ships the supported set; a server can offer
more from a mounted directory; a user can author their own in the extension. Descriptors are data
evaluated by bundled code — never code (MV3). Server-offered descriptors are applied only after
the user adopts them, and a changed one asks again. Design: `docs/design/providers.md`.

## D8 — A newly found video is not trusted; the room names its media once (2026-09-17)
When a client acquires a video (join, navigation, next episode, element swap), the element's
state is the site's doing until shown otherwise: it is conformed to the room, and only gestured
changes are sent until startup has settled. A room may exist before anyone names its media and
stays quiet until then; naming, and moving on to the next episode, use a compare-and-set `media`
command so racing members cannot fight. Built on measurements taken first.
Design: `docs/design/acquire.md`.

## Non-goals (explicit)
- **No screen capture, no stream relay, no media proxying.** Only URL + position + play state +
  chat cross the wire. Every participant must independently hold legal access to the media.
- No transcoding, no hosting of media files.
