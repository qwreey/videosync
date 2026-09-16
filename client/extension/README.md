# VideoSync extension (Chrome MV3, Firefox MV2)

Watch the same video together on your own accounts. Only the URL, position,
play state and chat cross the wire — **never the video itself**.

## Why this exists next to the userscript

One measured reason (`docs/BROWSER-FINDINGS.md` §8, §9): **a page on a public
origin cannot reach a server on loopback or your LAN at all.** Not `http`, not
`https`, not `ws`, not `wss` — the request never leaves the browser and hangs
forever with no error. A userscript runs on the page's origin, so it inherits
that: its server needs a public name and a real certificate.

An extension's **service worker is exempt**. So this is the build to use if you
want to run `videosyncd` on your own machine:

```
videosyncd -addr 127.0.0.1:8787          # no TLS needed for this path
```

## Install

```
npm install && npm run build     # -> dist/
```

`chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.

## How it is put together

The worker is ~7 kB and holds no session state: it is a frame relay and an HTTP
relay (see Permissions), and nothing else. The engine, the detector, the clock and the adapter all live in
the content script beside the `<video>`, sharing
`client/core/src/app/bootstrap.ts` verbatim with the userscript.

That split is deliberate. Putting the engine in the worker would mean the
player's position crossing a message port on every evaluation, and this design
resolves position to tens of milliseconds. Keeping the worker dumb also means
that if Chrome tears it down, the content script's engine simply reconnects —
the same path it already uses for a dropped network.

## Adding a provider

One entry in `manifest.json`'s `content_scripts.matches`. There is no per-site
code.

## The room link is the whole security model

No host, no moderation — the room is for people who already know each other
(D4). Anyone holding the room id and secret can seek, pause and play. Rotating
the secret does not eject anyone; it stops the forwarded link from working, and
you re-share with the people you meant.

## Permissions

`storage`, and the content-script matches. **No `host_permissions`** — the
worker reaches your server with an ordinary CORS request, and `videosyncd` sends
`Access-Control-Allow-Origin: *`. Measured both ways
(`harness/browser/results/ext-permissions.json`): room creation and the relayed
socket both work with the permission removed.

The one thing that depends on: if you put the server behind a proxy that strips
CORS headers, the extension will need `host_permissions` for that origin. The
server itself always sends them.

The worker also makes every HTTP call to the server — room creation and, if the
server asks for it, signing in. It takes a path from the content script, never
a URL, builds the address from the server in the settings, and keeps the
sign-in token in its own IndexedDB, where the content script (and so a page
that compromises it) cannot read it. Login tabs are opened with `tabs.create`,
which needs no permission.

## Firefox

`npm run build` also writes `dist-firefox/`: the same two scripts under a
**Manifest V2** manifest. Load it from `about:debugging` → This Firefox →
Load Temporary Add-on → `dist-firefox/manifest.json`.

Why V2, measured (`docs/BROWSER-FINDINGS.md` §19): every MV3 extension page in
Firefox carries `upgrade-insecure-requests`, so the relay's `ws://127.0.0.1`
goes out as a TLS handshake and closes with 1015 — for `localhost` too, and a
manifest `content_security_policy` does not remove it. MV2's background has no
such rule, runs from `background.scripts` (Firefox never shipped
`service_worker`), and Firefox has committed to keeping it.

Validated against a Chromium member in the same room: join, being taken to the
room's video and rejoining, play and pause both ways, seeks, 30 s together
within 81 ms, and the rate handed back on leaving (10/10 on local media).
