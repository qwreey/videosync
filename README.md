# VideoSync

Watch the same video together, on your own accounts, on any site with an HTML5
`<video>`. A self-hostable Go server plus a browser extension and a Tampermonkey
userscript.

**Only the URL, position, play state and chat cross the wire — never the video.**
That is a hard non-goal, not a limitation to be worked around: no screen
capture, no stream relay, no media proxying. Everyone in the room needs their
own legal access to what they are watching, and this tool cannot give it to
them.

There is **no host**. Rooms are for people who already know each other; everyone
can play, pause and seek, and the room link is the entire access control.

## Try it

```bash
mise install                                  # go + node, pinned
cd server && go build -o videosyncd ./cmd/videosyncd
./videosyncd -addr 127.0.0.1:8787

cd ../client/extension && npm install && npm run build
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick
`client/extension/dist` (Firefox: `about:debugging` → Load Temporary Add-on →
`client/extension/dist-firefox/manifest.json`). Open a YouTube video, hit **방 만들기**, and send the
invite link — or just the room ID and key — to a friend. Wherever they join
from, the room takes them to what it is watching, and takes everyone along when
somebody moves it to another video.

> **Use the extension if your server is on your own machine or your LAN.**
> Measured: a page on a public origin — every OTT site — cannot reach a loopback
> or private address by *any* scheme, and the request never leaves the browser,
> so it looks exactly like a server that is down. An extension's service worker
> is exempt; a userscript is not. A userscript needs the server on a public name
> with a real certificate (`videosyncd -tls-cert … -tls-key …`, or a reverse
> proxy or tunnel that gives you one). See `docs/BROWSER-FINDINGS.md` §8.

There is no per-site code: the client finds the largest playing `<video>`,
names the media from the URL, and syncs position and play state. What little a
site needs said about it — which URLs are videos, what the canonical watch page
is, which `<video>` is the player — is a **provider descriptor**, a JSON file
(see below).

## Providers

The sites the bundles support out of the box are the files in `providers/`
(`youtube.json`, `laftel.json`). They are compiled into both builds, and the
extension's `content_scripts.matches` and the userscript's `@match` lines are
generated from them, so adding a built-in provider is adding a file there and
rebuilding. Every descriptor carries `examples` that are run as tests.

A descriptor is **data**, never code: path templates such as
`/player/{series:int}/{episode:int}`, host names, CSS selectors and a few
numbers. There are no regular expressions. See `docs/design/providers.md`.

A server can offer more, and a user can write their own:

```bash
./videosyncd -addr :8787 -providers /srv/videosync/providers
```

| flag | meaning |
|---|---|
| `-providers DIR` | offer every valid `*.json` in `DIR` at `GET /api/providers`. Invalid files are logged and skipped. |
| `-providers-poll 5s` | how often to look for changed files; `0` means only on `SIGHUP`. |

`kill -HUP <pid>` rereads the directory at once. Nothing a server offers is
used until a user **adopts** it in the extension's options page, which pins the
file's hash; a changed file is announced, never applied silently, and a change
that would let a descriptor claim more sites or pages always asks again. A
server descriptor can make a site followable only once the user has granted the
extension that site.

With Docker (the image builds from `server/Dockerfile`):

```bash
cp -r deploy ~/videosync && cp providers/*.json ~/videosync/providers/
cd ~/videosync && docker compose up -d        # mounts ./providers read-only
docker compose kill -s HUP videosyncd         # reload after editing
```

In the extension, **Options** lists the descriptors in force (built-in, server,
yours), imports, edits and deletes your own, and shows what the configured
server offers. In the userscript, the Tampermonkey menu has the same commands;
a userscript cannot add sites to itself, so it tells you which `@match` line to
add.

## How it works, in six lines

1. The server owns a UTC timebase; clients measure their offset by **min-RTT**
   sampling and carry an honest error bound with it.
2. Commands carry a **future `when`**, so everyone transitions at the same
   instant. The delay is `clamp(2 × p95_ping, 500 ms, 2000 ms)` — capped,
   because with no host one bad connection must not make every pause sluggish.
3. Local seek detection is **poll-based with a two-diff test**; DOM events
   trigger the same evaluation rather than broadcasting directly.
4. Position reports **judge clients, they never move the room**. The anchor is
   the only truth — about position *and* about being paused.
5. Which correction to apply is chosen by `(offset, d(offset)/dt)`: ignore /
   rate-nudge / hard-seek / readiness-gate.
6. No host. A server-assigned monotonic `seq` plus a per-room mutex resolve
   conflicting commands.

## Layout

```
server/           Go, no dependencies. The sync server and a deterministic
                  simulation harness that shares its correction core.
client/core/      Platform-agnostic TypeScript: adapters, detector, clock,
                  protocol client, the shared bootstrap and the panel.
client/userscript/  Tampermonkey shim.
client/extension/   Chrome MV3 shim (dist/) and a Firefox MV2 build (dist-firefox/).
harness/browser/  A pinned container with a real Chromium, a media server that
                  can starve the player on demand, and the probes that produced
                  every number in docs/BROWSER-FINDINGS.md.
docs/, research/  See below.
```

## Working on it

```bash
mise run test          # Go + TypeScript
mise run test-e2e      # the TS client against a real videosyncd
mise run sim           # the correction-strategy comparison (no browser)
mise run probe         # the detector against a real <video>, in the container
mise run build         # both shims
```

**Read `docs/STATE.md` first.** It says what is done, what is next, and — more
usefully — which earlier conclusions turned out to be wrong. Then `CLAUDE.md`'s
"Traps" section, which is the list of things that cost a day to discover.

| doc | what it is |
|---|---|
| `docs/STATE.md` | Where the project is. The handover document. |
| `docs/DECISIONS.md` | Locked constraints. Inputs, not open questions. |
| `research/SYNTHESIS.md` | The design, distilled from nine reference implementations, with citations. |
| `docs/PROTOCOL.md` | The wire protocol. |
| `docs/POC-FINDINGS.md` | What the simulation measured, including the hypotheses it killed. |
| `docs/BROWSER-FINDINGS.md` | What a real browser actually does. |

The findings documents are worth more than they look. Most of what is
counter-intuitive in this codebase is there because something was measured and
came out the other way round.

## Licence

**Not chosen yet — this needs a decision.** There is no `LICENSE` file, and
without one the default is "all rights reserved", which is probably not what a
self-hostable tool wants.

One place already asserts an answer: `client/userscript/meta.txt` carries
`@license MIT`, because a userscript metadata block conventionally has that
field and it was filled in while writing the header. That was not a considered
choice. Either add the matching `LICENSE` file or change that line.
