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

The worker holds no session state: it is a frame relay, plus the provider
bookkeeping that needs its privileges (fetching the server's descriptor index,
reading granted hosts, registering the content script for added sites). The
engine, the detector, the clock and the adapter all live in the content script
beside the `<video>`, sharing `client/core/src/app/bootstrap.ts` verbatim with
the userscript.

That split is deliberate. Putting the engine in the worker would mean the
player's position crossing a message port on every evaluation, and this design
resolves position to tens of milliseconds. Keeping the worker dumb also means
that if Chrome tears it down, the content script's engine simply reconnects —
the same path it already uses for a dropped network.

## Adding a provider

A built-in provider is a descriptor file in the repository's `providers/`
directory. `npm run build` compiles those into the bundle and generates
`content_scripts.matches` from their `pageHosts` -- `manifest.json`'s own list
is empty on purpose, so the host list cannot drift from the descriptors.

Without rebuilding: **Options** (`chrome://extensions` → VideoSync → Extension
options) lists the descriptors in force, lets you paste, import, edit and delete
your own, and shows what the configured server offers
(`videosyncd -providers DIR`). Adopting a server descriptor pins its sha256;
a later change is shown as a difference and never applied silently, and a
change that widens hosts, identity rules, the canonical host or `pathFallback`
always asks, even with "auto-adopt from this server" on. Replacing a built-in
needs its own confirmation.

A site that is not built in needs **"사이트 권한 허용"** on that page: the
extension asks for the host at run time (`optional_host_permissions`) and
registers the same bundled `content.js` for it
(`scripting.registerContentScripts`). No code is ever downloaded -- a
descriptor is data the bundled code reads.

The in-page panel only *mentions* that the server has an update for the
provider you pressed play on; the decision is made on the options page, which a
page cannot overlay.

## The room link is the whole security model

No host, no moderation — the room is for people who already know each other
(D4). Anyone holding the room id and secret can seek, pause and play. Rotating
the secret does not eject anyone; it stops the forwarded link from working, and
you re-share with the people you meant.

## Permissions

`storage`, `scripting`, and the content-script matches. `scripting` and
`optional_host_permissions: ["https://*/*"]` are for sites added from the
options page; optional hosts are not shown at install and each is asked for
when you add a site. **No `host_permissions`** — the
worker reaches your server with an ordinary CORS request, and `videosyncd` sends
`Access-Control-Allow-Origin: *`. Measured both ways
(`harness/browser/results/ext-permissions.json`): room creation and the relayed
socket both work with the permission removed.

The one thing that depends on: if you put the server behind a proxy that strips
CORS headers, the extension will need `host_permissions` for that origin. The
server itself always sends them.

## Firefox

`npm run build` also writes `dist-firefox/`: the same two scripts under a
**Manifest V2** manifest (`optional_permissions` in place of
`optional_host_permissions`). Load it from `about:debugging` → This Firefox →
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

Adding a site at run time is **not yet run in Firefox**. The worker uses
`scripting.registerContentScripts` where Firefox exposes it to MV2 and falls
back to `contentScripts.register`, whose registration lasts only while the
background page lives -- it is redone every time the background starts, so a
page loaded while it sleeps may miss the script. Both need a live check.
