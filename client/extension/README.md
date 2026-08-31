# VideoSync extension (Chrome MV3, Firefox untested)

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

The worker is 1.7 kB and holds no session state: it is a frame relay and
nothing else. The engine, the detector, the clock and the adapter all live in
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

## Firefox is not supported yet

The manifest used to carry a `browser_specific_settings.gecko` id, which was a
claim this build cannot keep: Firefox has never shipped
`background.service_worker`, so the background would simply not exist, the
content script's `chrome.runtime.connect()` would find no receiver, and every
session would die at the port. Firefox MV3 wants `background.scripts` and treats
`host_permissions` as opt-in.

Supporting it is a separate manifest and a real test run, not a field.
