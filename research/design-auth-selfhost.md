# VideoSync: opt-in, pluggable auth for a self-hosted sync server (topic: selfhost-ws-auth)

I changed nothing in the repository. Every claim below is tagged:

- **[code]**: read in this repo, with `file:line`.
- **[local]**: checked in the installed Go 1.27.0 toolchain.
- **[doc]**: vendor or spec documentation, with URL.
- **[src]**: third-party source code, with URL.
- **[report]**: an issue thread or blog post. Weaker evidence.
- **[unmeasured]**: my inference, not yet tested in a browser. Needs a probe.

---

## 1. What exists today

- **The room secret is the only credential.** The server has no idea who is connecting.
  - `POST /api/rooms` accepts anyone. That is the review finding F39 [code `server/internal/hub/http.go:92`, `docs/STATE.md:287`].
  - The WebSocket checks only the `Origin` allowlist before the upgrade [code `http.go:148`].
  - The first frame must be `hello`, carrying `room` + `secret` [code `http.go:172-178`]. The secret is compared in constant time [code `server/internal/hub/ids.go:36`].
- **CORS allows any origin, because no credentials are involved.**
  - The server sends `Access-Control-Allow-Origin: *` [code `http.go:53-60`].
  - The preflight allows only the `Content-Type` header [code `http.go:67`].
  - `STATE.md:109-113` records that the extension needs **no `host_permissions`**, and that this depends on CORS headers reaching the client.
- **The server never negotiates a subprotocol.** `ws.Upgrade` writes a fixed 101 response with no `Sec-WebSocket-Protocol` [code `server/internal/ws/ws.go:127-130`].
- **Client network paths:**
  - **Chrome MV3:** the service worker opens `new WebSocket(url)` [code `client/extension/src/sw.ts:28`] and relays room creation with a plain `fetch(msg.url, {method:'POST'})` [code `sw.ts:90`]. The URL comes from the content script.
  - **Firefox MV2:** the same `sw.js` runs as a non-persistent background script [code `client/extension/dist-firefox/manifest.json`]. It is MV2 because Firefox's MV3 background upgrades `ws://` to TLS (BROWSER-FINDINGS §19).
  - **Userscript:** grants only `GM_getValue`/`GM_setValue` [code `client/userscript/meta.txt:12-13`]. Room creation uses the sandbox's plain `fetch` [code `client/userscript/src/main.ts:25`]. The socket is a plain `new WebSocket` [code `client/core/src/engine/transport.ts:37`].
- **Hard reachability constraints that shape everything below:**
  - A public-origin page, and therefore a userscript, cannot reach loopback or private addresses at all (BROWSER-FINDINGS §8).
  - An extension's service worker can (§9).
- **The Go toolchain has PBKDF2 but no bcrypt, scrypt or argon2** [local]:
  - `crypto/pbkdf2` exists: `func Key[Hash hash.Hash](h func() Hash, password string, salt []byte, iter, keyLength int) ([]byte, error)`.
  - `crypto/hkdf` also exists.
  - There is no bcrypt, scrypt or argon2 in `src/crypto`. The toolchain's `src/vendor/golang.org/x/crypto` holds only `chacha20`, `chacha20poly1305`, `cryptobyte` and `hkdf`, and vendored packages cannot be imported anyway.
  - **So bcrypt (`$2y$` htpasswd), argon2id and scrypt all require `golang.org/x/crypto`, which is a dependency.**
  - `net/http` provides `Request.BasicAuth()`, `http.CrossOriginProtection` and cookie helpers.

---

## 2. Findings by mechanism

### 2.1 No auth, behind Tailscale or a VPN

- **Extension (Chrome and Firefox): works as-is.**
  - The service worker or background page can reach a private address (§9). A tailnet address (100.64.0.0/10) is the same case.
  - The server can be `ws://`. MagicDNS or Tailscale Serve can provide `https`.
- **Userscript: does not work on Chrome.** Chrome's Local Network Access (enforcing since Chrome 142) classifies **100.64.0.0/10 as local, like RFC 1918**, so a page on youtube.com cannot reach a tailnet IP [report: https://github.com/oxyc/den-edge/issues/8 ; https://steeleobrienconsulting.com/blog/chrome-local-network-access/]. This agrees with the project's own §8 measurement for RFC 1918 addresses. There are two ways around it:
  - An enterprise policy `LocalNetworkAccessIpAddressSpaceOverrides` (Chrome 146+) [report, same sources]. Not realistic for friends.
  - **Tailscale Funnel**, which gives a public address. But then the server is on the internet and "the VPN is the auth" no longer holds.
  - [unmeasured] Whether a Tampermonkey page-context WebSocket to 100.x is blocked has not been probed. The CGNAT classification comes from a third-party report, not from this repo.
- **Firefox pages:** Firefox does not block public → loopback (BROWSER-FINDINGS §19 table). A Firefox userscript may therefore reach a tailnet directly [unmeasured for 100.x].
- **Conclusion:** `none` stays the default and is correct for tailnet-plus-extension. It is not a userscript story on Chrome.

### 2.2 HTTP Basic auth at a reverse proxy

- **`fetch` with `user:pass@` in the URL throws** a TypeError ("Request cannot be constructed from a URL that includes credentials") [report: https://bugzilla.mozilla.org/show_bug.cgi?id=1195820 ; https://github.com/isomorphic-git/isomorphic-git/issues/678]. The alternative is an explicit `Authorization: Basic …` header, which scripts are allowed to set.
- **Page context (the userscript's sandbox `fetch`) needs extra CORS support:**
  - `Authorization` makes the request preflighted.
  - The server must list it explicitly: **`Access-Control-Allow-Headers: *` does not cover `Authorization`** [doc: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers]. Today's `http.go:67` would reject it.
  - **The preflight `OPTIONS` never carries credentials.** A proxy that answers every unauthenticated request with 401, including `OPTIONS`, therefore breaks the call before it happens. Proxies must be configured to let `OPTIONS` through, which is a common self-hoster mistake.
- **Extension service worker or background page with host permissions** may make cross-origin requests to those hosts [doc: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests]. Content scripts get no such exemption (same doc).
  - Sources disagree on whether a preflight still occurs for a custom header under host permissions [report: https://bestchromeextensions.com/docs/guides/cross-origin-requests/ says it does] **[unmeasured]**.
  - Today the extension has **no** host permissions (§11). Adding auth headers without them puts it back on the preflight/CORS path, which is fine if the server's CORS is right and the proxy lets `OPTIONS` through.
- **`GM_xmlhttpRequest`** has explicit `user`/`password`/`headers`/`anonymous`/`cookie` options [doc: https://www.tampermonkey.net/documentation.php?locale=en&q=GM_xmlhttpRequest]. It runs in Tampermonkey's background, so CORS and the page's CSP do not apply.
  - It requires `@grant GM_xmlhttpRequest` and a `@connect` entry.
  - A self-hosted domain cannot be known in advance, so use `@connect *`. Tampermonkey then shows a per-domain confirmation, with an "always allow all domains" button when `*` is declared [doc: https://www.tampermonkey.net/documentation.php?locale=en&q=connect].
- **The WebSocket handshake cannot carry `Authorization`.** The WHATWG constructor takes only a URL and protocols [doc: https://websockets.spec.whatwg.org/]. That leaves four options:
  - **Userinfo in the `ws://` URL.** The spec's constructor steps do not strip or reject userinfo [doc, same]. Behaviour differs by browser:
    - Firefox caches credentials aggressively and reuses expired ones [doc: https://websockets.readthedocs.io/en/stable/topics/authentication.html].
    - A 10-year-old Firefox bug about whether it sends the header at all is still UNCONFIRMED [report: https://bugzilla.mozilla.org/show_bug.cgi?id=1229443].
    - The python-websockets docs say Chrome behaves; other reports say it does not.
    - **Do not rely on it.** [unmeasured in this repo]
  - **Browser-cached Basic credentials.** A page that got a 401 prompt may have the browser attach cached credentials to later same-origin requests. A service worker has no prompt UI, and a cross-origin page gets no prompt for subresources [unmeasured]. Not usable.
  - **Tokens in a subprotocol, the query string, a cookie, or the first frame.** See §2.4.
- **Conclusion:** the proxy can protect the **HTTP** endpoints with Basic auth. The **WS upgrade must be exempted at the proxy** and authenticated by the app, or it needs a proxy-independent token.

### 2.3 App-level user/password with hashed secrets

- **Standard library only:** PBKDF2-HMAC-SHA256 at **≥ 600 000 iterations** is OWASP's current PBKDF2 figure (and the FIPS option) [doc: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html].
- **Argon2id** (19 MiB, t=2, p=1) and **scrypt** (N=2^17, r=8, p=1) are OWASP's preferred choices, but both need `golang.org/x/crypto`. **Dependency.**
- **Reading an existing Apache htpasswd file** (`$2y$` bcrypt, `$apr1$` MD5) needs bcrypt from x/crypto for the recommended format. **Dependency.** `{SHA}` and MD5-crypt are stdlib-implementable but weak. Do not offer them.
- **Cost:** 600k PBKDF2 iterations take on the order of 100–300 ms of CPU per verification [unmeasured on this host].
  - Clients reconnect often: service-worker teardown, SPA navigation, `rejoin`.
  - Verifying the password on every reconnect is a CPU denial-of-service vector and adds latency.
  - Exchange the password once for a high-entropy token, which is safe to check with a fast hash or HMAC.
- **High-entropy random tokens (≥128 bits) do not need a slow KDF.** SHA-256 plus `subtle.ConstantTimeCompare`, or HMAC verification, is sufficient [standard practice; OWASP's cheat sheet is about low-entropy passwords].

### 2.4 Ways to put a credential on the WebSocket

| mechanism | can a browser send it? | rejected before the upgrade? | leaks into logs? | notes |
|---|---|---|---|---|
| **First frame (`hello`)** | yes, everywhere | no; the upgrade happens first | no | Already how the room secret travels [code `http.go:172-178`]. python-websockets calls it "the most secure mechanism" [doc: https://websockets.readthedocs.io/en/stable/topics/authentication.html]. Unauthenticated sockets are bounded by `HandshakeTimeout` (10 s) [code `http.go:30-33`]. A reverse proxy cannot see it. |
| **Query `?ticket=`** | yes | yes (HTTP 401) | **yes**: access logs, proxy logs | Acceptable only if the ticket is single-use and lives ~30 s [doc, same page]. |
| **`Sec-WebSocket-Protocol` token** | yes (`new WebSocket(url, [...])`) | yes | usually not logged | **The server must echo one offered protocol, or the browser fails the connection**: "If protocols is not the empty list and … `Sec-WebSocket-Protocol` … results in null, failure, or the empty byte sequence, then fail the WebSocket connection" [doc: https://websockets.spec.whatwg.org/]. Kubernetes precedent: `base64url.bearer.authorization.k8s.io.<b64url token>` plus a real protocol for the server to echo [src: https://github.com/kubernetes/kubernetes/pull/47740]. Needs a small change to `ws.Upgrade` [code `ws.go:127-130`]. Tokens need base64url encoding, since subprotocol tokens forbid `/` and `=` (same PR). |
| **Cookie** | the handshake uses credentials mode "include" [doc: WHATWG spec] | yes | no | Depends on SameSite and third-party cookie rules; see §2.6. Works only for the extension. |
| **Userinfo in the URL** | inconsistent (§2.2) | yes | maybe | Avoid. |

### 2.5 Forward-auth gateways and a client that never navigates

**How the proxies behave:**

- **nginx `auth_request`:** a 2xx from the subrequest allows the request. A 401 or 403 is returned to the client, with the subrequest's `WWW-Authenticate` on a 401. Any other status is an error. The body is not passed [doc: https://nginx.org/en/docs/http/ngx_http_auth_request_module.html].
- **Caddy `forward_auth`:** any non-2xx response from the gateway "is copied back to the client", which usually means a 302 to a login page. On 2xx, `copy_headers` copies response headers into the upstream request [doc: https://caddyserver.com/docs/caddyfile/directives/forward_auth]. The docs say nothing about stripping client-supplied copies of those headers.
- **Traefik ForwardAuth:** `authResponseHeaders` "replac[es] any existing conflicting headers" [doc: https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/].

**Which gateways accept a header credential instead of a redirect-and-cookie login:**

- **Authelia:** strategies `HeaderAuthorization` (Basic/Bearer), `HeaderProxyAuthorization`, `CookieSession`, and others, tried in order.
  - A failed `HeaderAuthorization` returns **401 + `WWW-Authenticate`**. A failed `CookieSession` redirects [doc: https://www.authelia.com/configuration/miscellaneous/server-endpoints-authz/ ; https://www.authelia.com/reference/guides/proxy-authorization/].
  - So Authelia can accept `Authorization: Basic` from a client that cannot follow a login flow.
- **tinyauth:** the context middleware calls `c.Request.BasicAuth()` and checks local users, **but refuses users who have TOTP enabled** [src: https://github.com/tinyauthapp/tinyauth/blob/main/internal/middleware/context_middleware.go].
  - Unauthenticated **non-browser** requests get **401** with an `x-tinyauth-location` header. Browsers get a 302.
  - "Browser" is decided by a User-Agent regex matching `Chrome|Gecko|AppleWebKit|…` [src: https://github.com/tinyauthapp/tinyauth/blob/main/internal/controller/proxy_controller.go].
  - Extension and userscript requests carry a browser User-Agent, so **they get a 302**, and `fetch` follows it opaquely to a login HTML page. Detect this: status 200 with `Content-Type: text/html`, `redirected: true`, or an opaque redirect under `redirect: 'manual'`.
  - OAuth-only tinyauth users cannot use Basic.
- **authentik proxy provider:** accepts HTTP Basic, where the password must be an **app password**, and Bearer tokens. The reserved username `goauthentik.io/token` treats the password as a token [doc: https://docs.goauthentik.io/add-secure-apps/providers/proxy/header_authentication/].
- **oauth2-proxy:**
  - With `--skip-jwt-bearer-tokens`, a valid JWT bearer is accepted.
  - A request with `Accept: application/json` gets 401 instead of a redirect.
  - An invalid JWT redirects unless `--bearer-token-login-fallback=false`.
  - [report/doc: https://oauth2-proxy.github.io/oauth2-proxy/behaviour/ ; https://github.com/oauth2-proxy/oauth2-proxy/issues/2512]
  - Getting a JWT means an OIDC client flow, which is heavy for this project.

**Where each gateway lands:**

- **Works with a header credential:** Authelia (with `HeaderAuthorization`), tinyauth (local users without TOTP), authentik (app password or token), plain Caddy `basic_auth` / nginx `auth_basic`.
- **Cookie-only (SSO/2FA users):** tinyauth with OAuth or TOTP, Authelia 2FA-only policies. These need a session cookie from a login tab (§2.6).

**Trusted identity headers (`Remote-User`):**

- Only safe if videosyncd is reachable **exclusively** through the proxy, and the proxy overwrites or strips any client-supplied copy.
- Traefik documents overwriting. Caddy's docs are silent on stripping (see above). nginx needs an explicit `proxy_set_header Remote-User $user;` from `auth_request_set`.
- Therefore the app must also check that the TCP peer is in a configured trusted-proxy CIDR list. The same setting is what F39's per-IP limit needs (`STATE.md:287-288`).

### 2.6 Session cookies from a login tab

**Chrome:**

- "Requests from an extension to a third-party are treated as same-site **if the extension has host permissions** for the third-party."
- "Cookies set on chrome-extension:// pages always use SameSite=Lax."
- The same-site treatment "does not apply if third-party cookies are blocked."
- [doc: https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies ; https://www.chromium.org/updates/same-site/faq/]
- A report says a service worker `fetch` did not include cookies by default even with host permissions [report: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/RMUtNEhR0R8]. Probably `credentials` defaulting to `same-origin`, so `credentials: 'include'` is needed [unmeasured].
- Third-party cookies remain on by default in Chrome; Privacy Sandbox was retired in October 2025 [report: https://www.consenteo.com/knowledge-hub/cookies/third_party_cookies_2026_after_google_reversal].
- **Extension + host permission + login tab → the gateway's `SameSite=Lax` cookie is sent** on `fetch(…, {credentials:'include'})`, and plausibly on the WS upgrade [unmeasured].
- This needs a `host_permissions` entry for a server origin unknown at build time, i.e. `optional_host_permissions: ["https://*/*", "http://*/*"]` plus a runtime `permissions.request` for the one origin. That is a UX and permissions cost this project has so far avoided.

**Firefox:**

- "requests from moz-extension documents (NOT content scripts) are treated as first-party … PROVIDED that the extension has host permissions for the URL" [report, Mozilla engineer: https://bugzilla.mozilla.org/show_bug.cgi?id=1608685 comment 3].
- If the user blocks third-party cookies, fetches go out without cookies [report, same].
- The MV2 background page qualifies, with the same permission cost. In MV2, host permissions go in `permissions` / `optional_permissions`.

**Userscript:**

- A page `WebSocket` from youtube.com to `sync.example.com` is a **cross-site** request, so gateway cookies (typically `SameSite=Lax`) are **not** sent on it.
- Under Firefox Total Cookie Protection, the cookie jar is partitioned by top-level site. A cookie set in a login tab is in a different partition from youtube.com [unmeasured here, but this is how partitioning works].
- **Cookie auth on the userscript's socket is not viable.**
- `GM_xmlhttpRequest` runs from Tampermonkey's background, which does send browser cookies, with a known gap for `Partitioned` cookies [report: https://github.com/Tampermonkey/tampermonkey/issues/2057]. **A cookie-authenticated ticket request is plausible, but the socket itself cannot carry the cookie** [unmeasured].

**Conclusion:** cookies can authenticate an **HTTP ticket request** from privileged contexts (extension background, `GM_xmlhttpRequest`). They cannot be the WebSocket credential for all three clients. **The WebSocket must carry an app-issued ticket.**

### 2.7 The ticket pattern

This is the only shape that works for all three clients and all proxy types:

1. The client makes an **authenticated HTTP request** from a privileged context: the extension service worker, the MV2 background page, or `GM_xmlhttpRequest`. The credential is whatever the deployment uses: Basic/Bearer header, gateway cookie, or nothing.
2. The server returns a **short-lived, random ticket**.
3. The client opens `/ws` and presents the ticket.

The proxy protects `/api/*` and **exempts `/ws`** (and `/healthz`). videosyncd itself enforces the ticket on `/ws`, so exempting it at the proxy is safe.

---

## 3. Recommendations for VideoSync

### 3.1 Two independent layers

- **Server access** (new, opt-in): who may use this server at all.
- **Room access** (unchanged): the room id + rotatable secret in `hello`. Keep it in every mode; it is the no-host "kick" (D4).

### 3.2 Four server-side modes (`-auth`)

| mode | who authenticates | what videosyncd checks on `POST /api/session` | typical deployment |
|---|---|---|---|
| `none` (default) | nobody | nothing; issues a ticket anyway, or skips tickets entirely | tailnet + extension; local dev |
| `token` | videosyncd | `Authorization: Bearer <key>`, or Basic with any username and the key as the password. Keys come from `-auth-tokens-file`, stored as SHA-256, compared in constant time | the simplest internet-facing setup; share one key with friends |
| `password` | videosyncd | `Authorization: Basic user:pass` against `-auth-users-file`. Format `user:$pbkdf2-sha256$i=600000$<salt>$<hash>`, via `videosyncd hash-password` | per-person accounts, no proxy. Stdlib only. bcrypt/argon2 import would be a **dependency** (x/crypto); leave it out unless someone asks |
| `proxy` | the reverse proxy / gateway | trusts the request **only if** the TCP peer is in `-trusted-proxies` (CIDRs), and optionally requires a non-empty `-auth-user-header` (e.g. `Remote-User`) | Caddy/nginx Basic, Authelia, tinyauth, authentik, oauth2-proxy |

**In every mode except `none`:**

- `POST /api/rooms` requires a valid ticket or session token (closes F39).
- `/ws` requires a ticket in `hello`.

### 3.3 Endpoints

**`POST /api/session`**

- Authenticated per the mode.
- Returns `{"token":"…","expiresMs":…}`, a **device token**, e.g. 30 days.
- Make it stateless: an HMAC-SHA256 over `{user, issuedAt, expiry}` with a server key from `-auth-key-file`. That fits the no-persistence decision (D2), and rotating the key file revokes every token.
- Rate-limit it per peer, reusing the hub's rate limiter.
- This is the only endpoint that sees a password, so PBKDF2 runs once per device, not once per reconnect (§2.3).

**`POST /api/ticket`**

- `Authorization: Bearer <device token>`; the HMAC check is fast.
- Returns `{"ticket":…,"expiresMs":…}`: random, single-use, 30–60 s TTL, held in memory.
- In `proxy` mode the client may skip the device token and call this directly, since the proxy has already authenticated the request.

**On `/ws`**

- Add `hello.ticket`. Consume it before `Lookup`.
- A missing or invalid ticket gets `{"t":"error","code":"auth_required"}`, a code distinct from `join_refused`, so the panel can prompt for credentials instead of saying "wrong room".
- It still arrives after the upgrade. That cost is already bounded by `HandshakeTimeout`.
- **Optional hardening, later:** also accept the ticket as a `Sec-WebSocket-Protocol` token so bad sockets are refused before the upgrade.
  - Echoing `videosync.v1` must then be added to `ws.Upgrade` [code `ws.go:127-130`].
  - A browser fails the connection without that echo (WHATWG).
  - Not needed for v1.
- **Do not use the query string for tickets.** A single-use 30 s ticket would be tolerable, but `hello` already exists and logs nothing.

**CORS**

- Add `Authorization` to `Access-Control-Allow-Headers` [code `http.go:67`]. A wildcard does not cover it (MDN).
- Keep `Allow-Origin: *` with **no** `Allow-Credentials` for header-based modes.
- A cookie-mode request from a page would need an echoed origin plus `Allow-Credentials: true`. That is one more reason to issue tickets only from privileged contexts.

### 3.4 One client flow for all modes and all three clients

A `Platform.authFetch(serverUrl, path, init)` injected piece (a fourth shim difference, beside storage, transport and room creation) sends every HTTP call from a privileged context:

- **Chrome MV3 / Firefox MV2:** the background makes the call.
  - The background must build the URL from the **stored server origin** and a fixed path allowlist (`/api/session`, `/api/ticket`, `/api/rooms`).
  - It must not attach credentials to an arbitrary URL from the content script. Today's relay forwards `msg.url` verbatim [code `sw.ts:90`], and Chrome's docs warn against that [doc: network-requests].
- **Userscript:** `GM_xmlhttpRequest` with `@grant GM_xmlhttpRequest` and `@connect *`.
  - No CORS preflight and no page CSP.
  - Room creation should move here too, which removes the `main.ts:25` page-fetch path.

**Session start (`bootstrap.ts`, shared):**

1. `GET /healthz`. Extend it to report `{"auth":"none|token|password|proxy"}` so the panel knows what to ask for. It stays unauthenticated at the proxy.
2. If the mode is not `none` and no device token is stored:
   - For `token`/`password`: prompt for key or user+password, `POST /api/session` with `Authorization: Basic`, store the token.
   - For `proxy`: go straight to step 3.
3. Before each connect or reconnect: `POST /api/ticket` → put the ticket in `hello`.
4. **Handling a failed ticket request:**
   - **401**: clear the token and re-prompt. If the response carries `WWW-Authenticate: Basic` (plain proxy Basic, or Authelia `HeaderAuthorization`), the same user/password prompt works: resend with `Authorization: Basic`.
   - **A redirect or an HTML 200** (tinyauth or Authelia cookie flows, which send browsers a 302):
     - The panel shows "sign in to your server" and opens `serverUrl` in a tab.
     - After login, retry with `credentials: 'include'`, or GM_xhr's default cookie behaviour.
     - Extension-only, and it requires a runtime-granted host permission for that origin (§2.6).
     - Document it as the fallback for SSO/2FA-only gateways, not the main path.
5. **What to store:** the device token (`chrome.storage.local` / `GM_setValue`), **never the password**. The ticket is not stored.

### 3.5 What to tell self-hosters (README)

- **Tailnet:** `-auth none`, extension only on Chrome. The userscript will not reach 100.x on Chrome (LNA, §2.1) unless you use Funnel, and Funnel means you need auth.
- **Public with Caddy/nginx:** protect `/api/*`, **exempt `/ws` and `/healthz`, and let `OPTIONS` through**. Run `-auth proxy -trusted-proxies 127.0.0.1/32`.
- **Gateways:** Authelia needs `HeaderAuthorization` in `authn_strategies` for the Basic path. tinyauth users must not have TOTP for the Basic path. authentik uses app passwords.
- **No proxy:** `-auth password` or `-auth token` with `-tls-cert`.

### 3.6 Tests and probes to add before believing §2.4–2.6

- **Hub tests, asserting on the wire:** `auth_required` vs `join_refused`, ticket single-use and expiry, trusted-proxy CIDR enforcement, CORS headers including `Authorization`.
- **Browser probe: extension service worker `fetch` to a Basic-protected origin** without host permissions (preflight path). Then with an optional host permission granted: is there a preflight? Are cookies sent with `credentials:'include'` from a login-tab session?
- **Browser probe: does the WS upgrade from the service worker / MV2 background carry the gateway cookie?**
- **Real Tampermonkey:** `GM_xmlhttpRequest` with `user`/`password` and with cookies. This is also the still-open "Tampermonkey itself is unverified" item (`STATE.md:323`).
- **tinyauth UA-based 302** against an extension request, to confirm the redirect-detection path.

---

## 4. Open questions (need the user or a measurement)

1. **Is a dependency acceptable for bcrypt/argon2?** Without one, `password` mode is PBKDF2-SHA256 only and cannot read existing Apache htpasswd files. With `golang.org/x/crypto`, both become possible. This is a D2-style decision to write down.
2. **Is an optional host permission acceptable in the extension** for the cookie-login fallback? Today's install prompt has none (§11). Without it, cookie-only SSO/2FA gateways are unsupported.
3. **Should `none` still issue tickets** so there is only one code path, or skip them? Issuing them costs nothing and keeps the client uniform.
4. **Device-token lifetime and revocation:** is "rotate the key file, everyone re-logs in" enough, or is per-user revocation wanted? The latter needs state or a denylist, which touches D2.
5. **Should room *creation* be allowed for authenticated users while *joining* stays open to anyone with a room secret?** That would let a friend without an account join via an invite link. It would need `/ws` to accept `hello` without a ticket in a `-auth-join-open` sub-mode.
6. **[unmeasured]** Does Chrome send `Authorization` from `wss://user:pass@host` in an extension service worker? Only relevant if someone wants proxy-only Basic auth with no app changes. The research says do not rely on it.
7. **[unmeasured]** Do Chrome's LNA rules block a Tampermonkey page-context WebSocket to a tailnet 100.x address, as third-party reports claim?