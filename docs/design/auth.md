# Access control (D6)

Research behind this: `research/design-auth-selfhost.md`, `research/design-auth-oidc.md`,
`research/design-auth-code-docker.md`. Everything below stays inside D2: Go standard library only.

## Two layers

| layer | question | mechanism | always on? |
|---|---|---|---|
| server access | may this person use this server? | authenticators below → device token → ticket | opt-in |
| room access | may this person be in this room? | room id + rotatable secret in `hello` | yes (D4) |

## Authenticators

Enabled with `-auth <list>`, comma-separated; `none` (or empty) is the default and changes
nothing. Several may be enabled at once; any one of them succeeding is enough.

| name | flags | the client proves | notes |
|---|---|---|---|
| `token` | `-auth-tokens-file` (one key per line, or `sha256:<hex>`) | `Authorization: Bearer <key>`, or Basic with the key as the password | the simplest public setup: share one key |
| `password` | `-auth-users-file` (`user:$pbkdf2-sha256$i=<n>$<salt>$<hash>`); `videosyncd hash-password` writes a line | `Authorization: Basic user:pass` | per-person accounts; PBKDF2 runs once per device, not per connection |
| `proxy` | `-trusted-proxies <CIDR,...>`, optional `-auth-user-header` (e.g. `Remote-User`) | nothing: the request came through a trusted proxy that already authenticated it | Basic at Caddy/nginx, tinyauth, Authelia, authentik, oauth2-proxy. A header from an untrusted peer is ignored, never believed |
| `oidc` | `-oidc-issuer`, `-oidc-client-id`, `-oidc-client-secret-file`, `-public-url`, optional `-oidc-allow` (sub/email/group list) | a login in a browser tab | server is the confidential RP (code flow + PKCE). The ID token is taken from the token endpoint over TLS and its claims are checked (iss, aud, exp, nonce); JWKS signature checking is a later hardening |

`-auth-scope create` (default once any authenticator is on) gates room creation and provider
listing; `-auth-scope all` also requires a ticket in `hello`. With `create`, a friend with an invite
link still joins without an account — the room secret is their credential.

## Tokens

- **Device token**: stateless, `base64(payload).base64(HMAC-SHA256)` over `{sub, via, iat, exp}`,
  default 30 days (`-auth-token-ttl`). Key from `-auth-key-file`; if absent, a random key per
  process — every device logs in again after a restart, and the startup log says so. Rotating the
  key file revokes every device.
- **Ticket**: random, single use, 60 s, held in memory. Obtained with a device token (or directly
  through a trusted proxy). Carried in `hello.ticket` and in room creation.
- The password and the IdP's tokens never leave the request they arrive in. Clients store the
  device token only.

## Endpoints

| endpoint | auth | returns |
|---|---|---|
| `GET /healthz` | none | adds `auth: {methods:[...], scope}` so the panel knows what to ask for |
| `POST /api/session` | Basic / Bearer, or trusted proxy | `{token, expiresMs, sub}` |
| `POST /api/ticket` | `Bearer <device token>`, or trusted proxy | `{ticket, expiresMs}` |
| `POST /api/auth/begin` | none (rate limited) | `{loginUrl, pollId, code}` — starts a browser login |
| `POST /api/auth/poll` | the `pollId` | `{pending}` or `{token, expiresMs, sub}` once, then gone |
| `GET /auth/login?flow=<id>` | none | a minimal server page: the enabled methods, shows `code` so the user can tell it is their own flow |
| `GET /auth/oidc/callback` | IdP redirect | finishes the flow |
| `POST /api/rooms` | ticket when scope ⊇ create | as before; `401 {error:"auth_required", methods}` otherwise |
| `/ws` `hello.ticket` | when scope = all | `error{code:"auth_required"}` — distinct from `join_refused` |

CORS on `/api/*`: `Allow-Headers` gains `Authorization`; `Allow-Origin: *` stays, no credentials
(bearer headers are not CORS credentials). Nothing under `/api` reads cookies. The login page uses a
`SameSite=Lax` flow cookie under `/auth/` only.

`POST /api/session`, `/api/auth/*` are rate limited per peer (the peer is the forwarded client only
behind a trusted proxy).

## Client flow — one for every authenticator and every shim

A fourth injected piece, `Platform.authFetch(path, init)`, makes every HTTP call from a privileged
context (the extension background, against the **stored server origin** and a fixed path list; the
userscript's `GM_xmlhttpRequest`). The background adds the device token itself; the content script
never holds it.

1. `GET /healthz` → methods.
2. Need a device token and have none:
   - `token` / `password` → the panel asks for a key or user+password → `POST /api/session`.
     *(As built: typed into the login tab instead — see "Keys and passwords" below.)*
   - `oidc`, or a `proxy` gateway that answers with a login redirect → `POST /api/auth/begin`, open
     `loginUrl` in a tab, poll until done. This path works for the userscript and both extensions
     without an identity permission.
   - `proxy` that already lets the request through (Basic at the proxy with the browser's cached
     credentials, or a trusted network) → nothing to do.
3. Before each connect and each room creation: `POST /api/ticket`.
4. A 401 on the ticket drops the device token and goes back to 2.

## Deployment recipes (README)

- Tailnet or LAN: nothing (`-auth none`), extension.
- Public, simplest: `-auth token -auth-tokens-file keys.txt` with TLS.
- Public, accounts: `-auth password`.
- Behind Caddy/nginx Basic or a forward-auth gateway: gate `/api/session` and `/auth/*` at the
  proxy; **leave `/ws`, `/healthz`, `/api/rooms`, `/api/ticket`, `/api/auth/*`, `/api/providers`
  and every `OPTIONS` unauthenticated** (a gated preflight fails as a bare `Failed to fetch`); run
  `-auth proxy -trusted-proxies <proxy address>`. *(As built: the design first gated `/api/ticket`
  and `/api/auth/*` too; see below.)*
- An IdP: `-auth oidc` with the flags above; register `<public-url>/auth/oidc/callback`.

## As built (2026-09-17)

Server: `server/internal/auth` (+ `hub` wiring, `videosyncd` flags and `hash-password`). Client:
`client/core/src/app/authfetch.ts` (the privileged side's HTTP policy, run by both shims),
`client/core/src/app/auth.ts` (the app's flow), the panel's sign-in section, the engine's ticket
source. Wire details in `docs/PROTOCOL.md` §8. Where this departs from the text above, or decides
what it left open:

- **The proxy vouches only where it gates.** `POST /api/ticket` takes a device token and nothing
  else — not "or trusted proxy" as the table says. A client's ticket request carries its bearer
  token, which a Basic or cookie gateway in front would reject, so the gateway has to leave
  `/api/ticket` open; if coming through the proxy counted as signed in there, that open path would
  sign in everyone. The proxy's word counts on `/api/session` and `/auth/login`. The recipe
  changes accordingly: gate **`/api/session` and `/auth/*`** at the proxy, and leave `/api/ticket`,
  `/api/auth/*`, `/api/rooms`, `/ws`, `/healthz` and every `OPTIONS` open. A trusted-network client
  loses nothing: it takes its device token from `/api/session` with no credentials, which the
  client tries on its own before prompting when `proxy` is enabled.
- **`Platform.authFetch(serverUrl, path, req)`** replaces `Platform.createRoom`, so the shims still
  differ in three pieces: storage, transport, HTTP. It takes the server because the userscript has
  nowhere else to get it. The extension's background builds the URL from that server's origin and
  a fixed path list (`isAuthPath`). Tokens are keyed by origin and only ever sent to the origin
  that issued them, on `/api/ticket` and the provider paths. *(Integration: the first build took
  the server from the settings store and refused a call whose `server` differed, and sent the
  token on `/api/ticket` only; see "The worker takes the server from the message" and
  "`/api/providers`" below.)*
- **Where the device token lives.** Extension: the background's own IndexedDB — not
  `chrome.storage.local`, which content scripts read and whose access level the settings store
  needs as it is; not `storage.session`, which dies with the browser. Userscript: GM storage;
  without the grant, memory only (never the page's `localStorage`). `authfetch.ts` strips the token
  from every answer before the app sees it; the app handles tickets only.
- **`/healthz` is read lazily.** A server with access control off costs nothing extra: no health
  check, no ticket, and a connect stays synchronous. A refused creation or `hello` makes the client
  read `/healthz`, remember the scope per origin (store key `authScope`), and retry once; a
  remembered `all` fetches a ticket before the first `hello`. So the first join to an `all` server
  on a fresh profile costs one refused `hello`.
- **The ticket for room creation** travels in the JSON body (`ticket`), as in `hello`.
- **Sign-out** is `DELETE /api/session` inside `authFetch` and never reaches the server: the
  server keeps no sessions, so signing out is forgetting the token.
- **The login page** is Korean like the panel, is not frameable, and offers what applies: an
  account button (`GET /auth/oidc/start`, which the table did not list) and, for a request that
  came through the trusted proxy, a confirm button (`POST /auth/login`, under
  `http.CrossOriginProtection`). The code is 8 characters from a 27-letter alphabet without
  lookalikes or vowels.
- **`-oidc-allow`** entries are `sub:<id>`, `email:<addr>`, `group:<name>`, or bare (matched
  against sub and email). An email counts only if the IdP marks it `email_verified: true` *(integration: was "unless it says unverified"; an IdP that omits the claim, such as Entra ID, lets users type any address — the nOAuth class — so it is matched by `sub:` or `group:` instead)*. The
  `groups` scope is requested only when a `group:` entry exists, since some IdPs refuse scopes the
  client was not configured with. With no `-oidc-allow` the server logs that anyone the IdP accepts
  can use it. Discovery is fetched on first use and cached for an hour; the token call uses
  `client_secret_basic` unless the IdP advertises only `client_secret_post`; the RP never follows a
  redirect from the IdP's endpoints.
- **Device-token `sub`** is display-only: the user name for `password`, `key` for `token`, the
  proxy's user header or `proxy`, and `preferred_username`/`email`/`sub` for OIDC.
- **Limits.** Per client: session 5 then 1 per 2 s, ticket 20 then 2/s, begin 5 then 1 per 5 s,
  poll 30 then 2/s. Concurrent PBKDF2 checks are capped at half the CPUs, and an unknown user is
  checked against a dummy hash of the same cost. At most 100 000 outstanding tickets and 1 000
  logins in progress. `-trusted-proxies` without `-auth` does nothing and says so; no per-address
  room-creation limit was built (F39 is closed by the ticket instead).
- **No cookies from the privileged side.** The background and the userscript call with
  `credentials: 'omit'` / `anonymous` and `redirect: 'manual'`: an answer that is not
  videosyncd's JSON is reported as a gateway's (`gateway`, with `redirected`), and does not drop
  the token. A redirect, a page served as the answer (status 1-399), or a 401/403/407 means "a
  gateway wants a login", which leads to the tab flow; see the review-3 note below for the rest. So the first open question below is moot for the shipped flow — cached proxy
  credentials and gateway cookies are never relied on — though a gateway that gates the tab page
  still needs its own browser login, which is the point.
- **Login tabs** are opened by the extension's background (`tabs.create`, no permission needed)
  and by `GM_openInTab`, so no popup blocker is involved after the `begin` round trip.
- **`/api/providers`** did not exist on this branch. *(Integration, with D7 merged:)* the listing
  and its files are gated whenever access control is on, like room creation, and admitted by a
  device token (`auth.Server.Admits`) — not a ticket, since an index plus its files is several
  requests. `authfetch.ts` therefore sends the device token to two things: `/api/ticket` and the
  provider paths (GET only), still only to the origin that issued it; a 401 there does not drop
  it. The provider paths are on the same allowlist (`isAuthPath`), so the extension worker has one
  fetch path, not two.

*Integration (review fixes):*

- **The worker takes the server from the message.** The first build built the URL from the
  settings store and refused a call whose `server` differed. That was not a boundary — every
  extension context can write the store — and it broke every HTTP call from a tab whose store
  cache was older than another tab's choice of server. The boundary is the path allowlist and the
  per-origin tokens. The content script's store (`sharedstore.ts`) now follows
  `chrome.storage.onChanged` besides.
- **A gateway's page is never a sign-in**: `gateway` is checked before the status everywhere, and
  success needs a stored token (`signedIn`). A late 401 forgets only the token it refused.
  *(Review 3:)* nor is every gateway page a request to sign in. On `/api/ticket`,
  `gatewayWantsLogin(status, redirected)` in `auth.ts` separates the two: a redirect (known from
  `redirected`, never guessed from a status 0, which is also what an answer that says nothing
  reads as), a page served as the answer, or 401/403/407 asks for the login tab. Anything else —
  nginx's 502 while videosyncd restarts, a 503/504, Go's text/plain 404 from a server restarted
  without `-auth`, a bare status 0 — is an outage: a plain error the engine retries with backoff,
  and the cached `/healthz` is forgotten so the next connect asks what the server needs now. Read
  as a sign-in, that 502 put every member's engine in the final `refused` state while their device
  tokens were still good.
- **The browser-login deadline is local** (`LOGIN_WAIT_MS` from `begin`), not the server's
  `expiresMs` compared with this machine's clock.
- **A ticket that never comes** fails the connect attempt after `TICKET_TIMEOUT_MS` (20 s) and takes
  the normal backoff; `fetchHttp` has a 15 s deadline. Network failures fetching a ticket count in
  `stats.ticketFailures`, not `connectFailures`.
- **Rate-limit identity**: `X-Real-IP` and the `X-Forwarded-For` hop must agree when both arrive;
  otherwise the proxy's own address is charged.
- **A trusted proxy vouches for the privileged side only.** `/api/session` takes the proxy's word
  only with `X-VideoSync-Device: 1`, which the preflight admits for an extension origin alone
  (PROTOCOL §8). A network-admitting gateway otherwise handed any page the user had open a device
  token with one bare POST, and gating `/api/session` at the proxy does not stop a request the
  gateway lets through.
- **Keys and passwords are typed into the login tab, never the panel.** The panel is in the site's
  DOM; key events are composed, so a capture listener on the site's `window` reads every
  keystroke typed into its closed shadow root, `stopPropagation()` or not — and those secrets mint
  the device token that `authfetch.ts` keeps away from the page. `/auth/login` therefore offers a
  key form and a user/password form (same flow, cookie binding, `CrossOriginProtection`, and the
  `session` rate bucket), `begin` works whatever methods are on, and the panel's sign-in section is
  one button. Client flow step 2 becomes "begin, open the tab, poll" for every method; a trusted
  network still signs in with no tab (the `proxy` step above). A bonus: the browser's password
  manager fills the server's own origin.
- **`-public-url` must be an origin** (no path): the rest of the flow assumes the root.

## Open, to measure before documenting

- Does the extension background's `fetch` send cached proxy Basic credentials or gateway cookies?
- tinyauth's answer (302 vs 401 + `X-Tinyauth-Location`) to a non-navigating client.
- Real Tampermonkey `GM_xmlhttpRequest` (still unverified in this project), including whether it
  honours `redirect: 'manual'` and how `@connect *` asks.
- Nothing of the client flow has run in a browser: the extension background's IndexedDB and
  `tabs.create` (Chromium and Firefox MV2), the panel's sign-in section, and a real IdP. All of it
  is tested against fakes and, for the wire, against a real `videosyncd` (`test-e2e`).
