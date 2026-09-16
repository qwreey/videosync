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
- Behind Caddy/nginx Basic or a forward-auth gateway: gate `/api/session`, `/api/ticket`,
  `/api/auth/*` and `/auth/*` at the proxy; **leave `/ws`, `/healthz`, `/api/providers` and every
  `OPTIONS` unauthenticated** (a gated preflight fails as a bare `Failed to fetch`); run
  `-auth proxy -trusted-proxies <proxy address>`.
- An IdP: `-auth oidc` with the flags above; register `<public-url>/auth/oidc/callback`.

## Open, to measure before documenting

- Does the extension background's `fetch` send cached proxy Basic credentials or gateway cookies?
- tinyauth's answer (302 vs 401 + `X-Tinyauth-Location`) to a non-navigating client.
- Real Tampermonkey `GM_xmlhttpRequest` (still unverified in this project).
