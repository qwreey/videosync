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

## Your server must have TLS. This is not optional.

Measured in a real browser (`docs/BROWSER-FINDINGS.md` §8): from an **https**
page, a script can reach neither `http://your-server` nor `ws://your-server`.
Both are blocked as mixed content, with no useful error — the request simply
never settles. The "localhost is trustworthy" rule you may be thinking of
applies to whether a page *is* a secure context, not to this.

Every provider worth syncing serves https. So:

```
# with a real certificate
videosyncd -addr :443 -tls-cert fullchain.pem -tls-key privkey.pem

# or behind anything that terminates TLS for you
caddy reverse-proxy --from sync.example.com --to 127.0.0.1:8787
```

Plaintext still works for `http://localhost` test pages, and the server says so
loudly at startup.

## Adding a provider

One `@match` line. There is no per-site code: the script finds the largest
playing `<video>`, names the media from the URL, and syncs position and play
state. Confirmed working on YouTube (`docs/BROWSER-FINDINGS.md` §8).

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
