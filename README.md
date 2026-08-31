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
`client/extension/dist`. Open a YouTube video, hit **방 만들기**, and send the
invite link to a friend.

> **Use the extension if your server is on your own machine or your LAN.**
> Measured: a page on a public origin — every OTT site — cannot reach a loopback
> or private address by *any* scheme, and the request never leaves the browser,
> so it looks exactly like a server that is down. An extension's service worker
> is exempt; a userscript is not. A userscript needs the server on a public name
> with a real certificate (`videosyncd -tls-cert … -tls-key …`, or a reverse
> proxy or tunnel that gives you one). See `docs/BROWSER-FINDINGS.md` §8.

Adding a provider is one line — a `@match` in the userscript's metadata block or
a `content_scripts.matches` entry in the extension manifest. There is no
per-site code: the client finds the largest playing `<video>`, names the media
from the URL, and syncs position and play state.

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
client/extension/   Chrome MV3 shim. Firefox is not supported yet.
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

MIT.
