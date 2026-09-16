# How code-docker's router integrates tinyauth, and what VideoSync can take from it

Everything here comes from reading files; I ran nothing and changed nothing. Code-docker's own write-ups marked "verified live" or "confirmed live" are passed on as their measurements. Anything taken only from upstream docs or source is marked as such. Items marked **[assumed]** or **[unverified]** are my inference.

**Short answer:**
- **Proxy and flow:** Caddy's `forward_auth` checks each request with tinyauth. It is switched on per route (Dev Proxy, App Routes, some VNC targets), not across the whole site.
- **Headers to apps:** none. The config forwards no identity header to the protected app.
- **Cookie domain:** tinyauth's own default puts the session cookie on the parent domain, so one login covers sibling hostnames.
- **Non-browser clients:** code-docker exempts nothing inside tinyauth. Clients that can't follow a login redirect (WebDAV) are kept out of forward-auth altogether and given their own password.
- **Optional:** the feature is off unless configured. When unconfigured, tinyauth idles instead of crash-looping.

For VideoSync the key finding is this: a cookie-based forward-auth on `/ws` or on the CORS preflight would probably break both shims. If VideoSync adds opt-in auth, it should gate only room creation, the open F39 item in STATE.md, and do it with the standard library alone.

---

## 1. Findings

### 1.1 Where tinyauth runs and how it gets in the image

- **Not a separate service.** tinyauth runs as a supervisord program inside the `router` container (`router/config/supervisord.d/tinyauth.conf:6-7` runs `/etc/router/tinyauth.sh`).
- **Binary copied from the upstream image, not built.** The Dockerfile pulls the prebuilt binary out of `ghcr.io/tinyauthapp/tinyauth:v5` (`router/Dockerfile:79`, `:172`). The reason given is that upstream's own build needs a pnpm frontend step (`router/Dockerfile:74-78`).
- **Listens only inside the container,** on `127.0.0.1:3000`. The check path is `/api/auth/caddy` (`router/backend/internal/devproxy/devproxy.go:58-59`).
- **State directory.** tinyauth hardcodes its state under `/data`. The start script symlinks that to the router's persistent volume (`router/config/tinyauth/tinyauth.default.sh:44-50`).

### 1.2 Which proxy, and the request path

Requests pass through three hops: an outer TLS proxy you run yourself, then the router's nginx on port 80, then the router's internal Caddy over unix sockets.

```
browser ─TLS─> your outer proxy (Caddy/nginx) ─http─> router nginx :80
   /exports/  → unix:/run/caddy-adapter.sock   (Dev Proxy, Host-matched)
   /app/<n>/  → unix:/run/caddy-app.sock       (App Routes, path-matched)
   TINYAUTH_HOSTS server{} → 127.0.0.1:3000    (tinyauth's own login UI)
Caddy: forward_auth 127.0.0.1:3000 → 2xx: reverse_proxy target
                                   → 4xx + X-Tinyauth-Location: redir
```

- **nginx:** `router/config/nginx/nginx.default.conf:237-254` (`/exports/`) and `:331-341` (`/app/`). Both set `Upgrade`/`Connection`, `X-Forwarded-Proto`, and a `Cookie` header with the router's admin cookie removed.
- **Caddy block:** one generator, `ForwardAuthBlock`, in `router/backend/internal/devproxy/forwardauth.go:54-98`. Dev Proxy uses it per route (`devproxy.go:223-224`) and App Routes per app, inside `handle_path` (`internal/approutes/approutes.go:126-128`). The generated block:

```caddy
forward_auth 127.0.0.1:3000 {
	uri /api/auth/caddy
	header_up X-Forwarded-Uri {http.request.orig_uri}
	header_up X-Forwarded-Host {http.request.host}
	header_up X-Forwarded-Proto {http.request.header.X-Forwarded-Proto}
	@tinyauth_login {
		status 4xx
		header X-Tinyauth-Location *
	}
	handle_response @tinyauth_login {
		redir * {rp.header.X-Tinyauth-Location}
	}
}
```

- **Granularity is per route or per app, a boolean `RequireAuth`.**
  - Dev Proxy routes use Caddy's `handle` (first match wins) or `route`, so a narrow public path can be listed before a gated catch-all (`devproxy.go:95-115`).
  - `vhost` entries (`ROUTER_VHOST_<NAME>`) never get tinyauth. Auth there is left to the outer proxy (`nginx-service.default.sh:331-333`, `docs/vhost.md` table).
  - VNC targets that use the `rfb` backend **refuse** `RequireAuth` rather than silently ignoring it (`router/CLAUDE.md:244-246`).

**Why every extra line in that block exists.** The original block was the two-liner from tinyauth's docs, and it never worked. Two causes were confirmed live against tinyauth v5.1.3 and Caddy v2.11.4 (`forwardauth.go:12-36`):
1. **Caddy sets no `X-Forwarded-Proto` or `X-Forwarded-Host` on requests that arrive over a unix-socket listener,** and doesn't pass through incoming ones either. tinyauth answers **400** when they are missing.
   - Upstream `main` source only requires `x-forwarded-host` and `x-forwarded-uri` for this path, so the Proto requirement may be version-specific.
2. **tinyauth reported "not logged in" as 401 plus `X-Tinyauth-Location`, not a 302.** Caddy's `forward_auth` copies non-2xx responses through unchanged, so the browser saw a bare `{"message":"Unauthorized"}`.
   - Upstream `main` (`internal/controller/proxy_controller.go`) chooses by User-Agent: `Chrome|Gecko|AppleWebKit|Opera|Edge` gets a 302, anything else gets 401/403 plus `x-tinyauth-location`.
   - Why a browser request got 401 in their test is unexplained (a curl-driven test or a version difference would explain it) **[unverified]**. The `handle_response` handles both cases anyway.
3. **`X-Forwarded-Uri` must be the original URI** (`orig_uri`), because `handle_path` has already stripped `/app/<name>` and tinyauth builds its post-login redirect from this header (`forwardauth.go:58-65`).
4. **`X-Forwarded-Proto` is copied from the incoming header rather than taken from `{scheme}`.** The router always speaks plain HTTP, so `{scheme}` would send the browser back to an `http://` URL after login. nginx guarantees the header exists and defaults it to its own `$scheme` (`nginx.default.conf:70-83`, `$router_forwarded_proto` map).
5. **The redirect only fires when the header is present.** Otherwise a tinyauth *error* would become a 302 with an empty Location, which is a redirect loop (`forwardauth.go:84-88`).
6. **Existing deployments are repaired automatically.** At startup, `devproxy.Normalize` and `approutes.Normalize` re-render any structured fragment that differs from the current template; hand-edited fragments are left alone (`internal/devproxy/normalize.go:9-24`).

### 1.3 Headers passed to the protected app

- **No identity reaches the app.** The block has no `copy_headers`, so tinyauth's success headers are discarded.
  - tinyauth does emit `Remote-User`, `Remote-Email`, `Remote-Name`, `Remote-Groups` and `Remote-Sub` (tinyauth docs, *Headers* reference).
  - The app only learns that the request was let through.
- **Client-sent copies are not stripped either [my inference].** Caddy deletes a client-supplied copy of a header only for names listed in `copy_headers` (Caddy source, `forwardauth/caddyfile.go`, "Always delete the client-supplied header…"). Neither the Caddy block nor nginx removes `Remote-*`. So in this topology, **a `Remote-User` that reaches an app may come from the client** and must not be trusted.
- **What the app does receive:**
  - `Host` as the browser sent it.
  - `X-Forwarded-Proto` from the nginx map.
  - The browser's `Cookie` minus `router_manager_unlock`, removed by a three-pass regex map (`nginx.default.conf:145-156`).
  - `vhost` blocks also set `X-Real-IP` and `X-Forwarded-For` (`nginx-service.default.sh:~514-520`).
- **tinyauth can inject credentials, but code-docker doesn't use it.** Upstream supports `TINYAUTH_APPS_<NAME>_RESPONSE_BASICAUTH_*` and custom `response.headers` to hand a Basic-auth or custom header to the app (tinyauth *Configuration* and *Advanced* docs). Nothing in code-docker sets them.

### 1.4 Cookie domain and the login host

- **The login UI needs a whole hostname** (`TINYAUTH_HOSTS`). tinyauth's SPA uses root-absolute asset and API paths and has no base-path setting; a path in `TINYAUTH_APPURL` "is accepted and ignored" (verified on v5.1.3; `nginx.default.conf:186-193`). `nginx-service.default.sh:287-305` generates a dedicated `server{}` block pointing at `127.0.0.1:3000`.
- **`TINYAUTH_APPURL` is derived from the first `TINYAUTH_HOSTS` entry** as `https://<host>` (`tinyauth.default.sh:27-34`). The two are the same hostname typed twice, and a mismatch "fails silently".
  - nginx logs a warning when `APPURL` is set but `HOSTS` is not (`nginx-service.default.sh:306-311`). That combination is what shipped before, and its symptom gave no clue what was missing.
- **The session cookie is scoped to the parent domain.** This is tinyauth's own default (`TINYAUTH_AUTH_SUBDOMAINSENABLED`, default `true`), not something code-docker arranges. `router/CLAUDE.md:506-508` records it as verified: logging in at `auth.example.com` sets `Domain=example.com`. So one login covers `code.example.com/app/...`.
  - The 2026-09-16 audit, which had not seen that measurement, left the scope as an open question (`audit-claude-opus5-2026-09-16-ignoreme.md:318-335`, `:660`).
- **Other cookie settings:**
  - `TINYAUTH_AUTH_SECURECOOKIE` defaults to `false`; the docs recommend `true` behind https (`router/example-env.router:187-188`).
  - Session expiry defaults to 86400 s, and login attempts are limited (default 3) (tinyauth *Configuration* reference).
  - The `SameSite` attribute of tinyauth's cookie is **not documented or measured** anywhere I found.
- **Open audit finding S11 (Medium):** the tinyauth cookie is *not* removed before proxying to `/exports/`, `/app/` or vhost targets. Only `router_manager_unlock` is. Since the cookie covers the parent domain, a less-trusted backend on a sibling hostname receives a live tinyauth session (`audit-claude-opus5-…:318-335`).

### 1.5 Non-browser, API and WebSocket clients

- **tinyauth itself has no exemption set up.** No `path.allow`, no `ip.bypass`, and no per-app ACL is configured anywhere in router. Upstream supports `TINYAUTH_APPS_<NAME>_PATH_ALLOW` / `_PATH_BLOCK` (regex), `ip.allow` / `ip.block` / `ip.bypass`, and `users.allow` / `users.block`, all keyed on `X-Forwarded-Host` (tinyauth *Access controls* doc).
  - The expansion plan deferred user and group ACLs, OIDC-provider mode, `.well-known` and email attributes: "ldap 같은거 필요해서 안하면 됨" ("not needed — that would need LDAP or the like, so we skip it") (`router/.claude/net-auth-expansion-plan.md:168-237`, `:281-287`).
- **IP-based rules can't work in this topology.** Caddy's forward-auth subrequest over a unix socket carries no `X-Forwarded-For` (`router/example-env.router:189-196`).
- **Exemption happens structurally, one level up:**
  - **WebDAV** clients use Basic auth and can't follow an SSO redirect. So `/webdav` is excluded from the outer forward-auth and protected by its **own** password, `WEBMANAGER_WEBDAV_PASSWORD_HASH`. It is off by default and fails closed (enabled with no password returns 404). It uses argon2id, backs off per IP after 5 failures, and caches a successful check for 5 minutes because clients resend Basic auth on every request. It is published on a dedicated listener and vhost (`code-docker/CLAUDE.md:74`).
  - **PWA and WebAPK assets** (manifest, service worker, icons) must be publicly reachable because Google's WebAPK server fetches them with no cookies. The outer proxy uses a `not path …` matcher ahead of `forward_auth` (`docs/security-login.md:32-51`). A vhost's replacement icon lives at the fixed path `/_pwa-icon.png` so the exemption is the same every time (`router/CLAUDE.md:445`).
  - **Per-path splits inside a gated site** use Dev Proxy route ordering, narrowest first (`docs/vhost.md`, `router/CLAUDE.md` vhost bullet).
- **WebSockets need nothing special on the tinyauth side.** Upstream `main` doesn't branch on method, so upgrades and `OPTIONS` preflights are checked like any other request. A WebSocket behind `RequireAuth` works only because a same-site browser attaches the cookie to the handshake. nginx forwards `Upgrade`/`Connection` and uses `proxy_read_timeout 3600s` (`nginx.default.conf:227`).
  - The router's own WebSocket (the VNC RFB bridge) uses router-manager's `authgate` cookie instead, which is `HttpOnly` and `SameSite=Strict` (`router/backend/internal/authgate/gate.go:386-394`).
  - Audits flag that `websocket.Accept(w, r, nil)` only checks `Origin` against `Host`, which leaves a DNS-rebinding path when `ALLOWED_HOSTS` is empty (`security-audit-ignoreme.md:114-135`; `audit-antigravity-…:236-246`).
- **Basic auth against tinyauth is possible upstream, unused here.** Upstream `internal/middleware/context_middleware.go` accepts `Authorization: Basic` as a fallback to the cookie, except for TOTP users, with lockout on failures. So a non-browser client *could* authenticate through tinyauth. Nothing in code-docker relies on it, and code-docker never tested it.

### 1.6 How it is made optional

There are three layers:
1. **Per entry.** `RequireAuth` defaults to false. Turned off, the route is "completely public unless the outer proxy adds auth" (`docs/app-routes.md:183-184`, `docs/dev-proxy.md:176`).
2. **Per process, which idles rather than crashes:**
   - With no `TINYAUTH_APPURL` and no `TINYAUTH_HOSTS`, the script runs `exec sleep infinity` (`tinyauth.default.sh:36-42`).
   - With no local users **and** no OAuth, LDAP or Tailscale provider, it also sleeps (`:62-79`). Deleting the last user used to crash-loop and surfaced only as `supervisor fault 50: SPAWN_ERROR`.
   - The same pattern is used for `CADDY_ADAPTER_ENABLED` and `TAILSCALE_ENABLED`.
3. **Per hostname.** The login server block exists only when `TINYAUTH_HOSTS` is set (`nginx-service.default.sh:287-311`).

**Users.** There are two ways to set them:
- **Environment:** `TINYAUTH_AUTH_USERS`, generated with `docker run --rm ghcr.io/tinyauthapp/tinyauth:v5 user create --username … --password … --docker`.
- **UI or API:** `internal/tinyauthusers` writes `/var/lib/code-docker-router/tinyauth-users/env`, which the start script sources, then restarts the program, because tinyauth reads users only at startup.

**The environment variable wins.** The UI then shows a read-only notice (`tinyauth.default.sh:52-60`, `docs/router.md:195-223`). The admin API calls that change users sit behind router-manager's password gate, which fails closed.

### 1.7 Other auth mechanisms in this setup

| Mechanism | What it protects | Details |
|---|---|---|
| Outer SSO (Authentik recommended) via `forward_auth` / `auth_request` | code-server (`auth: none`), webmanager, the router-manager domain, optionally the tinyauth domain | Domain-level Authentik mode with a parent cookie domain gives single login across subdomains; public-path exemptions as above (`docs/security-login.md`) |
| tinyauth | Individual Dev Proxy routes, App Routes, `novnc` VNC targets | This report |
| router-manager `authgate` | Router admin API (egress rules, DNS, forwards, tinyauth users) | bcrypt (`golang.org/x/crypto`); cookie `router_manager_unlock`, `HttpOnly`, `SameSite=Strict`, host-only; **fails closed with 503** and a message naming the fix, while `/api/auth/status` and `/api/auth/setup` stay open (`gate.go:398-430`); `ROUTER_MANAGER_HOSTS` gives it its own origin |
| webmanager `authgate` | Terminal, file manager, logs, sessions, file share | Opt-in (`WEBMANAGER_AUTH_PASSWORD_HASH`, argon2id); audits call its fail-open default High or RCE-class (`security-audit-ignoreme.md:54-68`); finding S1: the lockout key is always nginx's address, so 5 bad tries lock everyone out |
| WebDAV password | `/webdav` | Separate, as above |
| Network layer | Everything | `ALLOWED_HOSTS` / `ALLOWED_EXPORT_HOSTS` Host allowlists, `TRUSTED_PROXIES` → nginx `set_real_ip_from`, tailnet ACLs, loopback-forwarding block, netgate egress filtering, dind-authz plugin |

---

## 2. Recommendations for VideoSync

Context: `videosyncd` today has no user auth. The room secret travels in `hello`; `POST /api/rooms` is open and sends `Access-Control-Allow-Origin: *`; WebSocket upgrades are checked against the `-allowed-origins` allowlist (`server/internal/hub/http.go:53-149`; PROTOCOL §"Creation"). STATE.md F39 is still open.

1. **Gate room creation only; never put a cookie forward-auth on `/ws`, `/healthz` or `OPTIONS`.**
   - **Why not cookies:** both shims connect from an OTT-site origin, which is cross-site to the sync server.
     - The userscript opens a `WebSocket` from the site's context (`client/userscript/src/main.ts:23`). Whether a `SameSite=Lax` or third-party-blocked tinyauth cookie would be sent is **[unmeasured]**; the likely answer is no.
     - The extension's service worker has no `host_permissions` (STATE.md). How Chrome classifies its cookies is **[unmeasured]**.
   - **Why not preflights:** tinyauth checks `OPTIONS` like any other request, so a gated preflight fails and the browser reports only `TypeError: Failed to fetch`. That is the same silent failure the CLAUDE.md CORS trap describes.
   - **Why the join path needs nothing more:** it is already authenticated by the ≥128-bit room id plus a rotatable secret. This matches how code-docker exempts WebDAV and PWA paths: clients that can't do the login dance are routed around it, not through it.
2. **Build it into `videosyncd` with the standard library alone:**
   - **Proposed flags:** `-create-token-file` (or `VIDEOSYNC_CREATE_TOKENS`). It stays off unless set, the same pattern as the tinyauth/router opt-outs.
   - **Checking the token:** `POST /api/rooms` requires `Authorization: Bearer <token>`. Store `sha256(token)` and compare with `crypto/subtle.ConstantTimeCompare`. Tokens are random, high-entropy values, so no slow KDF is needed.
   - **If you want human passwords instead:** bcrypt and argon2id would need `golang.org/x/crypto`, **a dependency**. `crypto/pbkdf2` has been in the standard library since Go 1.24 and the module says `go 1.27`, so that is the dependency-free choice.
   - **CORS:** add `Authorization` to `Access-Control-Allow-Headers` and keep `OPTIONS` unauthenticated. Keeping `ACAO: *` stays safe, because a bearer header (unlike a cookie) is not a credential in the CORS sense.
   - **Client side:** the shim stores the token in extension or GM storage, where the room creator's secret already lives, and only the creator path sends it.
3. **Offer a "trusted forward-auth header" mode only with explicit peer trust.**
   - **Proposed flags:** `-auth-header Remote-User -trusted-proxies <CIDR|unix>`. Honour the header only when the TCP peer is in the list; otherwise ignore it or reject the request.
   - **Why:** in code-docker's current Caddy block, a client-supplied `Remote-User` reaches the backend untouched (§1.3). Caddy strips it only if `copy_headers Remote-User` is configured.
   - **Precedent:** router-manager's `rateLimitKey` trusts `X-Real-IP` only when its listener is a unix socket, because "a forgeable key is strictly worse than a shared one" (`router/CLAUDE.md:~275-282`).
   - The same trusted-proxy setting is what F39's per-IP creation limit needs, so build it once.
4. **Don't build OIDC or login UI into the server.** It would need `golang.org/x/oauth2` / `go-oidc` (dependencies) or a hand-rolled JWT/JWKS verifier (possible with the standard library, but a lot of work to maintain). If someone wants SSO, point them at their own proxy, gating only `POST /api/rooms` with option 2 as the non-browser path, the way code-docker's `docs/security-login.md` does.
5. **Deploying behind code-docker's router: use `ROUTER_VHOST_VIDEOSYNC="sync.example.com=videosyncd:8787"`.**
   - **Why vhost:**
     - It gives VideoSync its own origin; it can't sit on the shared origin because `/ws` and `/api` are root paths.
     - It proxies `Upgrade`/`Connection`, keeps idle WebSockets for 3600 s, and sets `X-Real-IP` / `X-Forwarded-For`.
     - It has **no tinyauth**, which is what point 1 wants anyway (`nginx-service.default.sh:490-527`).
   - **Configuration notes:**
     - `videosyncd` should run plain HTTP there; TLS belongs to the outer proxy, as the public-address trap requires.
     - `-allowed-origins` must list the OTT origins and the extension origin.
     - `-trusted-proxies` should be the router's address on the Docker network.
   - **Cookie leak (audit S11):** the tinyauth parent-domain cookie will also reach `videosyncd`. VideoSync reads no cookies, so it's harmless, but log redaction should not print a `Cookie` header under `-verbose`.
6. **Design lessons to copy from code-docker's history:**
   - **Unconfigured states should idle or explain themselves; they should not crash or fail silently.** Examples: tinyauth `sleep infinity`, the nginx warning when `APPURL` is set without `HOSTS`, the 503 naming the fix, and appending the log tail to `SPAWN_ERROR`. For VideoSync: when creation needs a token and the client sends none, return `401` with a JSON body naming the flag, and have the panel show it rather than "Failed to fetch".
   - **Fail closed only where the route is privileged,** and keep the setup and status routes reachable (`authgate.RequirePassword` comment).
   - **Derive one value from another rather than asking twice** (`APPURL` from `HOSTS`). A hand-kept mismatch fails silently.
   - **An environment pin beats UI state,** and the UI says so.
   - **Never reuse one struct for disk and API encoding.** `json:"-"` meant to hide a hash from the API also kept it off disk, which silently broke every user (`router/CLAUDE.md:519-532`).
   - **Validate any environment value pasted into generated config.** The vhost path checks its charset; `TINYAUTH_HOSTS` doesn't (audit S12).
   - **Normalize previously saved config when a template was functionally broken;** otherwise the fix only reaches new entries.
   - **The upstream "hello world" integration was wrong for their topology in two independent ways,** found only live. Any VideoSync auth mode should get a probe in `harness/browser/` before it is documented, in keeping with the "measured, not assumed" rule.

---

## 3. Open questions

1. **Does the extension's service-worker `WebSocket` or `fetch` to the sync host carry that host's cookies in Chrome, with no `host_permissions`?** Firefox MV2 and Tampermonkey `WebSocket` are the same question. This decides whether any cookie-based gate is feasible at all. It needs a probe, similar to `probe-extperm.mjs`.
2. **What `SameSite` value does tinyauth v5's session cookie use?** Not documented or measured anywhere I read.
3. **Why did code-docker get 401 instead of 302 for a browser?** Upstream `main` selects on User-Agent, and Caddy's `forward_auth` normally forwards the original request headers. Was the test driven by curl, or is this a v5.1.3 difference? It only matters if VideoSync documents a tinyauth recipe.
4. **Is the `X-Forwarded-Proto` → 400 requirement specific to v5.1.3?** Upstream `main` source lists only `x-forwarded-host` and `x-forwarded-uri` as required for the forward-auth path.
5. **Tokens or real users for F39?** Is a static creation-token list enough for self-hosters, or do they expect per-user identity (via `Remote-User` from a trusted proxy) for things like per-user room quotas? The second needs point 3 of §2 and a decision recorded in `docs/DECISIONS.md`.
6. **Would Basic auth to tinyauth be acceptable instead of a VideoSync-native token?** It works upstream for local and LDAP users without TOTP, but it would store a user's SSO-adjacent password in extension storage. I'd lean no; that's a user decision.

Sources:
- [tinyauth Headers reference](https://tinyauth.app/docs/reference/headers/)
- [tinyauth Access controls](https://tinyauth.app/docs/guides/access-controls/)
- [tinyauth Configuration reference](https://tinyauth.app/docs/reference/configuration/)
- [tinyauth Advanced guide](https://tinyauth.app/docs/guides/advanced/)
- [tinyauth proxy_controller.go (main)](https://raw.githubusercontent.com/tinyauthapp/tinyauth/main/internal/controller/proxy_controller.go)
- [tinyauth context_middleware.go (main)](https://raw.githubusercontent.com/tinyauthapp/tinyauth/main/internal/middleware/context_middleware.go)
- [DeepWiki: tinyauth proxy integration](https://deepwiki.com/tinyauthapp/tinyauth/4.2-proxy-integration-(forwardauth-authrequest-extauthz))
- [tinyauth Discussion #182 (Basic auth headers)](https://github.com/tinyauthapp/tinyauth/discussions/182)
- [tinyauth Discussion #43 (Remote-User)](https://github.com/tinyauthapp/tinyauth/discussions/43)
- [Caddy forward_auth docs](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
- [Caddy forwardauth/caddyfile.go](https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddyhttp/reverseproxy/forwardauth/caddyfile.go)

Local files cited are under `/home/yaeji/Projects/code-docker/`, mainly `router/` (`config/tinyauth/tinyauth.default.sh`, `config/supervisord.d/tinyauth.conf`, `config/nginx/nginx.default.conf`, `config/nginx/nginx-service.default.sh`, `backend/internal/devproxy/forwardauth.go`, `CLAUDE.md`, `docs/router.md`, `docs/app-routes.md`, `docs/dev-proxy.md`, `docs/vhost.md`, `example-env.router`, `.claude/net-auth-expansion-plan.md`), plus `docs/security-login.md`, `CLAUDE.md` and `audit-claude-opus5-2026-09-16-ignoreme.md` at the repo root. VideoSync files: `/home/yaeji/Projects/videosync/server/internal/hub/http.go` and `/home/yaeji/Projects/videosync/docs/STATE.md`.