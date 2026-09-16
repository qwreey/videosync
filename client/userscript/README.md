# VideoSync userscript

Watch the same video together on your own accounts. Only the URL, position,
play state and chat cross the wire — **never the video itself**. Everyone in the
room needs their own legal access to what they are watching; this tool cannot
and will not give it to them.

## Install

1. Install Tampermonkey (or Violentmonkey).
2. Build the script and open `dist/videosync.user.js`:
   ```
   npm install && npm run build
   ```
3. Run a server somewhere all of you can reach — see below, it must be **https**.

## Your server must be on a public address, with TLS

Measured in a real browser (`docs/BROWSER-FINDINGS.md` §8), and it is stricter
than it sounds:

- From a page on a **public origin** — every OTT site — the browser refuses
  every request to **loopback or a private address**. Not `http`, not `https`,
  not `ws`, not `wss`. The request never leaves the browser: a listener that
  answers everything permissively sees nothing arrive, not even a preflight.
- Separately, an **https** page cannot reach an **http** server.

Both failures present the same way: the call hangs forever, with no error and
nothing naming a reason. It looks exactly like a server that is down.

So `http://localhost:8787` will not work from YouTube, and neither will
`https://192.168.1.10`. What works is a public name with a real certificate:

```
# a domain you control
videosyncd -addr :443 -tls-cert fullchain.pem -tls-key privkey.pem

# or anything that terminates TLS on a public name for you
caddy reverse-proxy --from sync.example.com --to 127.0.0.1:8787

# or a tunnel, if you do not want to expose a port
#   cloudflared / tailscale funnel / ngrok -- any of them gives you a public https name
```

Plaintext loopback still works for a local `http://` test page, and the server
says so at startup.

> **If you want to run the server on your own machine with no public name, use
> the browser extension instead.** An extension's service worker is not subject
> to the private-address block (measured, §9) — that is the one thing it can do
> that a userscript structurally cannot.

## Adding a provider

There is no per-site code: the script finds the largest playing `<video>`,
names the media from the URL, and syncs position and play state. Confirmed
working on YouTube (`docs/BROWSER-FINDINGS.md` §8). What a site needs said
about it is a provider descriptor (`providers/*.json`, D7).

The built-ins are compiled in, and the `@match` lines are generated from them
at build time (`meta.txt` has a `// @match-providers` placeholder), so the sites
the script runs on and the sites it knows cannot drift.

Without rebuilding, the Tampermonkey menu has three commands:

- **VideoSync: 제공자 설명 추가** — paste a descriptor; it is validated (its
  `examples` run) and saved in the script's storage.
- **VideoSync: 서버 제공자 설명** — what the server you last joined offers
  (`videosyncd -providers DIR`): adopt one (pinned by sha256, with the
  difference shown; replacing a built-in asks separately), and turn
  auto-adopt of non-widening updates on or off for that server.
- **VideoSync: 사용 중인 제공자 설명** — the descriptors in force, and deleting
  your own.

A userscript cannot add sites to itself. After adding a descriptor for a new
site, the menu shows the exact `// @match` line to add to the script's header;
until then the script does not run there, and the room does not send you there
from another site. When the server changes a descriptor you adopted, the panel
mentions it the next time you press play on that site, and the decision is made
from the menu.

If a site turns out to need special handling, that is a
`ProviderAdapter` in `client/core/src/adapter/` — the seam exists for it.

## Why `@grant` is in the metadata block

Not for storage. With `@grant none` a userscript runs in the **page** context,
where the site's Content-Security-Policy governs everything it does — including
opening a WebSocket, and no OTT site's `connect-src` lists your server.
Granting any GM API moves the script into the userscript sandbox, which has its
own CSP. Removing those lines will break the script in a way that looks like a
network problem.

## The room link is the whole security model

There is no host and no moderation — the room is for people who already know
each other (D4). Anyone holding the room id and secret can seek, pause and play.
Rotation ("비밀키 교체") is the only remedy: it does not eject anyone, it stops
the forwarded link from working, and you re-share with the people you meant.
