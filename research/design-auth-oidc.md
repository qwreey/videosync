# OIDC for VideoSync: how the extension and userscript log in, and who acts as the relying party

Scope: this is research only and nothing in the repository was changed. Every claim below is tagged:
- **[doc]**: taken from a cited external document.
- **[repo]**: read from this repository, with `file:line`.
- **[assumed]**: my own reasoning, not measured or documented.

Nothing in this report was measured in a browser.

**Conclusion.** Make `videosyncd` the only OIDC relying party. It should be a confidential client doing the authorization-code flow with PKCE, and it hands the shims its own short-lived VideoSync tokens. Both shims then share one server-side code path:
- The extension reaches it through `launchWebAuthFlow`, aimed at the VideoSync server rather than at the IdP.
- The userscript reaches it through a tab plus polling.

This can be built with the Go standard library only. The IdP registers one redirect URI, and IdP tokens never reach a browser.

---

## 0. Current shape (what OIDC would plug into)

- **No user identity exists.** Two things carry the security boundary:
  - a room id from a CSPRNG plus a rotatable join secret (`server/internal/hub/ids.go:9`, `hub.go:94-127`);
  - the secret travels in the `hello` frame (`server/internal/room/messages.go:20-26`, `docs/PROTOCOL.md:63`).
- **CORS is `*` because no credentials ride on cookies** (`server/internal/hub/http.go:42-58`, `PROTOCOL.md:450-458`). Any auth design that brings in cookie credentials on `/api/*` would break this reasoning. Bearer tokens in the body or in a frame keep it valid.
- **`POST /api/rooms` is unauthenticated** (`http.go:94-106`). STATE lists this as open item **F39** (`docs/STATE.md:287-288`). F39 is the most concrete reason to add identity at all.
- **Extension:**
  - The MV3 service worker is a "dumb frame relay" plus a relayed `createRoom` fetch (`client/extension/src/sw.ts:17-91`).
  - `permissions` is `["storage"]` only, with no `identity` and no `host_permissions` (`client/extension/manifest.json:6-8`).
  - The content script keeps its settings, including room secrets, in `chrome.storage.local` (`client/extension/src/content.ts:33,43`).
  - The Firefox build is MV2 with gecko id `videosync@videosync.invalid` (`dist-firefox/manifest.json`).
- **Userscript:**
  - It grants only `GM_getValue`/`GM_setValue` (`client/userscript/meta.txt`).
  - It calls `fetch` directly, so every call is cross-origin and needs CORS (`client/userscript/src/main.ts:24-30`).
  - It cannot reach a private or loopback server from a public-origin page (`reach.ts`, BROWSER-FINDINGS §8, measured in the repo).
- **The server URL is chosen by the user at runtime** (STATE:141-143). Neither shim knows its server or the IdP at build time. This decides a lot below.
- **Go 1.27 with no `require` block** (`server/go.mod`). Must stay dependency-free (DECISIONS D2).

---

## 1. Browser extension login

### 1.1 Chrome `chrome.identity.launchWebAuthFlow`

- **[doc]** The redirect URL matches `https://<app-id>.chromiumapp.org/*`, and `getRedirectURL(path?)` builds it. "When the provider redirects to a URL matching the pattern `https://<app-id>.chromiumapp.org/*`, the window will close." Options are `interactive`, and since Chrome 113 also `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive`. ([Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity))
- **[doc]** The API page itself does not say whether a non-IdP server may perform the final redirect. The mechanism watches navigations in the auth window for that URL pattern, so any host in the redirect chain can end the flow, including `videosyncd`. **[assumed from the documented mechanism; verify with a probe.]**
- **[doc, secondary]** It works from an MV3 service worker. The auth window is a separate popup, and the worker is kept alive during the flow. ([mv3-extension.com](https://mv3-extension.com/core-apis-cross-browser-data-management/identity-oauth-authentication/implementing-oauth2-with-launchwebauthflow/))
- **[doc]** `launchWebAuthFlow` is the non-Google route that also works in other Chromium browsers. `getAuthToken` does not, even in Brave ([xiegerts.com](https://www.xiegerts.com/post/chrome-extension-oauth-web-auth-flow-firebase-google/)).
  - Whether it works in **Helium** (built on ungoogled-chromium), the project's test browser, is **unverified**. No source addressed it.
- **Permission:** the API is in the `identity` namespace, so the manifest gains `"identity"`. **[assumed]** I did not confirm whether `identity` alone adds an install warning (`identity.email` is a separate permission). Check this before shipping.
- **Extension ID stability [assumed, standard Chrome behaviour]:**
  - A store build has a fixed ID.
  - An unpacked build's ID comes from its path unless `manifest.key` is set.
  - Any design that registers `https://<id>.chromiumapp.org/` somewhere therefore needs a pinned `key` for development builds.

### 1.2 Firefox `browser.identity`

- **[doc]** `getRedirectURL()` "derives a redirect URL from the add-on's ID … at a fixed domain name and a subdomain derived from the add-on's ID". In practice that is `https://<hash>.extensions.allizom.org/`, though the fetched MDN text did not print the domain.
- **[doc]** Since Firefox 86, `http://127.0.0.1/mozoauth2/[subdomain of getRedirectURL()]` is also accepted, per RFC 8252 §7.3.
- **[doc]** The `identity` permission is required ([MDN identity](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity)).
- **[doc]** With `interactive` false or omitted, the flow must end silently or it fails. Interactive flows should only start from a user action ([MDN launchWebAuthFlow](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow)).
- The Firefox build is MV2 with a persistent-false background (`dist-firefox/manifest.json`). `identity` is available there. The gecko id `videosync@videosync.invalid` fixes the hash, which is good for a redirect allowlist.

### 1.3 PKCE, tokens and refresh (normative)

- **[doc] RFC 9700 §2.1.1:** "Public clients MUST use PKCE". It is RECOMMENDED for confidential clients. **§2.1:** exact string matching of redirect URIs. **§2.1.2:** no implicit grant. **§2.2.2:** "Refresh tokens for public clients MUST be sender-constrained or use refresh token rotation." ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html))
- **Where tokens live [doc]:**
  - `storage.session` is in memory and by default "not exposed to content scripts". `setAccessLevel` can widen it.
  - `storage.local` is exposed to content scripts by default ([Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)).
  - Chrome's security guidance: "Do not send sensitive data (e.g. secrets from the extension …) to content scripts". Content scripts can be "taken over by an attacker if a malicious web page compromises the renderer process" ([Chrome extension security](https://developer.chrome.com/docs/extensions/mv3/security)).
- **Consequence for VideoSync [assumed]:**
  - A long-lived credential should live only in the worker. Candidates are the extension-origin IndexedDB, which content scripts cannot open because they run on the page's origin, or `storage.session` if losing it on browser restart is acceptable.
  - It should **not** go in `storage.local`, because `content.ts` already reads that area wholesale and restricting the area's access level would break the settings store.
  - The worker already sees every outgoing frame (`sw.ts:62-63`). It can add the credential when it relays `hello`, so the content script never holds it. That is a small, deliberate break from "dumb relay", and it still holds no session state beyond one stored token.
  - Room secrets already sit in `storage.local`. That is an existing trade-off and not something this change creates.

---

## 2. Userscript login (no identity API)

A userscript cannot catch a redirect to a URL it does not `@match`, and its server's origin is unknown at build time. Options, best first **[assumed design reasoning unless tagged]**:

1. **Tab plus polling, recommended.** This is the device-authorization pattern (RFC 8628-like), run entirely by `videosyncd`:
   1. The script calls `POST /api/auth/begin` and gets `{flowId, pollToken, loginUrl, userCode}`.
   2. It opens `loginUrl` with `window.open` or `GM_openInTab`. The server does the whole OIDC exchange with the IdP.
   3. It polls `POST /api/auth/poll {pollToken}` until it receives a VideoSync token, then stores it with `GM_setValue`. That storage is per script and the page cannot read it.

   Why this one:
   - It needs no `@match` for the server.
   - It needs no opener relationship.
   - It works with the existing CORS `*`, because the credential is in the body.
   - It survives the IdP setting `Cross-Origin-Opener-Policy`. **[assumed]** A COOP `same-origin` page in the popup's history cuts `window.opener`, which breaks option 2.

   **Risk:** device-code phishing. An attacker sends a victim a `loginUrl` from the attacker's own flow, and the victim's login then produces a session for the attacker. Mitigations:
   - The login page shows `userCode` and the requesting page origin, and the user confirms they match what the panel shows.
   - A TTL of at most 5 minutes, single use, and `pollToken` never appears in the URL.
2. **Popup plus `postMessage`.** The server's final page calls `window.opener.postMessage(ticket, openerOrigin)`. It is simpler, but it is fragile under COOP (see above), and it requires the server to know and check the opener origin. A useful fast path, with (1) as the fallback.
3. **`GM_addValueChangeListener` handoff.** This needs the script to also run on `https://<server>/auth/done`. Possible only through Tampermonkey's per-user "user matches" setting, which is poor UX.
4. **Doing OIDC in the userscript as a public client:** not viable. There is no redirect capture, the IdP token endpoint would need CORS for every OTT origin, and IdP tokens would sit in a script sandbox.

Unmeasured, and worth a probe: whether Tampermonkey's `GM_xmlhttpRequest`, which is issued from the extension background, escapes the private-address block from BROWSER-FINDINGS §8. If it does, the userscript's "public address required" constraint relaxes. That matters beyond auth.

---

## 3. Server side, Go standard library only

### 3.1 Server as confidential client (code flow): fully stdlib

- **Discovery:** `net/http` plus `encoding/json` on `<issuer>/.well-known/openid-configuration`. The `issuer` in the document must equal the configured issuer string exactly (OIDC Discovery §4.3). Trailing slashes matter **[doc, general spec knowledge]**.
- **Issuer is per client on some IdPs:**
  - Kanidm uses `https://idm.example.com/oauth2/openid/:client_id:` ([Kanidm OAuth2](https://kanidm.github.io/kanidm/master/integrations/oauth2.html)).
  - Authentik uses a per-application path. **[assumed from common knowledge; its docs page was not fetched for this point.]**
  - So the configuration takes the **issuer URL**, not a hostname.
- **Authorization request:** `crypto/rand` for `state`, `nonce` and the PKCE verifier. `crypto/sha256` plus `base64.RawURLEncoding` for the S256 challenge.
- **Token exchange:** `http.PostForm` with `client_secret_basic` or `client_secret_post`. Use a bounded `http.Client` timeout and `io.LimitReader`.
- **Key finding [doc], OIDC Core §3.1.3.7:** "If the ID Token is received via direct communication between the Client and the Token Endpoint (which it is in this flow), the TLS server validation MAY be used to validate the issuer in place of checking the token signature." ([OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html))
  - So a minimal RP need not fetch JWKS or do signature verification at all. It must still check `iss`, `aud` (contains client_id), `azp` if present, `exp`, `iat`, and `nonce`.
  - This is the largest simplification available. I would still add signature verification as defence in depth, because it is cheap (§3.2).
- **Where login state lives [assumed]:** `state` → `{nonce, verifier, return target, expiry}` goes in an in-memory map with a TTL, which matches D2's in-memory design.
  - Browser binding for login-CSRF still needs a cookie on the server's own origin, set at `/auth/start`.
  - That cookie must be `SameSite=Lax`, because the IdP callback is a cross-site top-level GET, and `Strict` would drop it.
  - It is the only cookie, it applies only to `/auth/*`, and so the CORS `*` reasoning for `/api/*` still holds.
- **[doc]** Go 1.25's `http.CrossOriginProtection` is available for any cookie-bearing, state-changing POST under `/auth/*` ([Go 1.25 notes](https://go.dev/doc/go1.25)). It must **not** wrap `/api/*`, which is cross-origin by design.

### 3.2 JWT verification in stdlib (for defence in depth, or for the public-client design)

Feasible in roughly 300 lines **[assumed estimate]**:

| alg | stdlib call | JWK → key |
|---|---|---|
| RS256 / PS256 | `rsa.VerifyPKCS1v15(pub, crypto.SHA256, h, sig)` / `rsa.VerifyPSS` | `n`, `e` via `base64.RawURLEncoding` → `big.Int` |
| ES256 | `ecdsa.Verify(pub, h, r, s)`. The JWS signature is **raw 64-byte r‖s**, not DER, so `VerifyASN1` is wrong | Go 1.25+ `ecdsa.ParseUncompressedPublicKey(elliptic.P256(), 0x04‖X‖Y)`; **[doc]** these functions replace `crypto/elliptic`/`math/big` plumbing ([Go 1.25](https://go.dev/doc/go1.25)). X and Y must be left-padded to 32 bytes |
| EdDSA (Ed25519) | `ed25519.Verify` | `x` raw 32 bytes. Needed if Pocket ID is set to Ed25519 |
| HS256 | `crypto/hmac` with the client secret | Only for Authentik with no signing key selected (below) |

Pitfalls, from **[doc] RFC 8725** ([RFC 8725](https://datatracker.ietf.org/doc/html/rfc8725)) plus OIDC Core:
- **Algorithm confusion:**
  - Enforce an allowlist (§3.1).
  - "Each key MUST be used with exactly one algorithm": bind the header `alg` to the JWK's `kty` (and to `alg` when present).
  - Never accept `none`.
  - Never use an RSA or EC public key as an HMAC secret.
  - Accept HS256 only when the operator configured it explicitly.
- **Issuer and audience (§3.8, §3.9):**
  - `iss` must match exactly.
  - `aud` can be a string **or** an array; handle both.
  - If `aud` has several values, `azp` must equal client_id.
  - Use explicit typing or mutually exclusive rules so an IdP access-token JWT is never accepted as an ID token (§3.11–3.12).
- **Clock skew:** allow about 60 s of leeway on `exp`/`nbf`/`iat` **[assumed common practice]**. Reject an `iat` too far in the past.
- **Key rotation:** cache JWKS; on an unknown `kid`, refetch at most once every N minutes to avoid being turned into an amplifier. If `kid` is missing, try every key of the matching `kty`.
  - **[doc]** Keycloak rotates by adding higher-priority active keys and keeping older ones passive ([Keycloak admin](https://www.keycloak.org/docs/latest/server_admin/index.html)).
  - The OIDC Core §10.1.1 text on key rollover was not retrieved in this session (the fetch truncated). The refetch-on-unknown-`kid` rule is common practice and not quoted.
- **Hygiene:** base64url without padding, a limit on JWKS/response size, HTTPS-only issuer (Tinyauth requires HTTPS itself, [tinyauth OIDC](https://tinyauth.app/docs/guides/oidc/)).
  - **[assumed]** Recent Go refuses RSA keys under 1024 bits by default; enforce 2048 as a floor anyway.

### 3.3 VideoSync's own tokens (stdlib)

**[assumed design]**
- **Session token:** an opaque HMAC-SHA256-signed blob `{sub, iss, name, exp, ver}`.
  - The key comes from a file, so sessions survive a restart. Without a key file, a random key at startup gives D2's in-memory default.
  - Revocation works by rotating the key, or by a per-`sub` "not-before" held in memory.
- **Ticket:** a single-use, ~60 s WebSocket ticket (`POST /api/auth/ticket` with the session → `ticket`). It goes into `hello` as a new optional field, never in the URL.
  - Or put the session token in `hello` directly; the frame is already the credential channel (`PROTOCOL.md:456`).
  - The ticket adds one round trip and keeps the long-lived token off the socket path. It is optional.
- **Refresh:**
  - Do not keep IdP refresh tokens unless disabled IdP accounts must be locked out before the VideoSync session expires.
  - Instead, renew the VideoSync session through a new IdP round trip, which is usually one click or silent when an IdP SSO session exists.
  - Whether each IdP honours `prompt=none` for `interactive:false` was not verified.

---

## 4. Recommended design vs extension-as-public-client

### 4.1 Recommended: server is the only RP

```
IdP  <── confidential code flow + PKCE ──>  videosyncd  (one redirect URI: https://sync.example/auth/callback)
                                                │ issues its own VideoSync session / tickets
         ┌──────────────────────────────────────┼─────────────────────────────┐
 extension worker                                            userscript
 launchWebAuthFlow(https://sync.example/auth/start           POST /api/auth/begin → open loginUrl
   ?client=ext&redirect_uri=https://<id>.chromiumapp.org/cb   → poll /api/auth/poll (userCode confirm)
   &state&code_challenge)                                     → GM_setValue(session)
 ← 302 https://<id>.chromiumapp.org/cb?code=<vs one-time code>
 POST /api/auth/token {code, code_verifier} → session (kept in worker only)
```

- `videosyncd` acts as a mini authorization server toward its own shims. It uses PKCE on its own one-time code, and it keeps an **explicit redirect allowlist**:
  - the Chrome store ID's chromiumapp URL;
  - the Firefox gecko-hash URL;
  - plus a `-auth-ext-redirect` flag for development and unpacked IDs.
  - Do not wildcard `*.chromiumapp.org`. **[assumed]** A wildcard would let any installed extension quietly obtain a VideoSync session while the user has an IdP SSO session.
- Auth is **optional**. With no `-oidc-issuer` set, today's behaviour stays unchanged. With it set, the first thing it gates is `POST /api/rooms` (closes F39). Joining can still rest on the room secret, which keeps D4 intact. Requiring auth to join as well is a user decision.
- A server on loopback, used by the extension: the auth window navigates at top level to `http://127.0.0.1:8787/auth/*`.
  - Whether Chromium's private-network rules affect *top-level* navigations inside a `launchWebAuthFlow` window is **unmeasured**. BROWSER-FINDINGS §8 covered subresource and socket requests only.
  - Kanidm allows localhost redirects **only on public clients** ([Kanidm](https://kanidm.github.io/kanidm/master/integrations/oauth2.html)). A local server with Kanidm would therefore need to run as a PKCE public client with no secret, which is still stdlib and still server-side.

### 4.2 Comparison

| | Server is the RP (recommended) | Extension as public client |
|---|---|---|
| IdP registrations | 1 (server callback) | One per extension ID (Chrome store, Chrome unpacked with pinned `key`, Firefox), each a public client |
| Userscript | Same server flow (tab plus poll) | Not possible; would still need the server flow → two code paths |
| IdP token endpoint CORS | Not needed | Needed: the worker's fetch is cross-origin and the manifest has no `host_permissions` (STATE:109-113). The IdP must allow `chrome-extension://…`/`moz-extension://…` origins, or the extension must add host permissions for a runtime-chosen IdP |
| Extension knows the IdP | No, only the VideoSync URL it already has | Yes: issuer and client_id per server, i.e. more configuration |
| Server verification | TLS path allowed (§3.1); JWKS optional | **Must** verify the signature with JWKS, `aud` = the extension's client_id, `azp`; replay risk if audiences are shared |
| IdP tokens in the browser | Never | Yes; a refresh token needs rotation or sender-constraint (RFC 9700 §2.2.2) |
| New permission | `identity` | `identity` (+ likely host permissions) |
| Server complexity | Higher: mini-AS for the shims, state map, one cookie | Lower on the server, higher across every IdP deployment |

### 4.3 Self-hosted IdPs

| IdP | Fits server-as-RP? | Notes (with source) |
|---|---|---|
| **Authelia** | Yes | Confidential or public; `require_pkce` opt-in; redirect URIs exact, `http`/`https` only; ID token default **RS256**; default policy `two_factor` ([Authelia clients](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/)). Refresh needs the `refresh_token` grant type. |
| **Authentik** | Yes, **with a signing certificate selected** | With no signing key, JWTs are **HS256 signed with the client secret** and no JWKS is published ([Authentik OAuth2](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)). The verifier must either support that configuration or tell the operator to pick an RSA/EC key. Redirect URIs can be "strict" or regex. |
| **Keycloak** | Yes | Public or confidential toggle, PKCE method setting, active/passive key rotation ([Keycloak admin](https://www.keycloak.org/docs/latest/server_admin/index.html)). Default RS256 **[assumed]**. |
| **Pocket ID** | Yes | Passkey-only; "Public Client" turns PKCE on; wildcard callback URLs are supported; default **RS256**, optional ES256 / **EdDSA** / RS384 ([Pocket ID custom keys](https://pocket-id.org/docs/advanced/custom-keys), [callback wildcards](https://pocket-id.org/docs/advanced/callback-url-wildcards)). The verifier should handle Ed25519 if it verifies at all. |
| **Kanidm** | Yes | **ES256 by default**; RS256 only through `warning-enable-legacy-crypto`, which then removes ES256; PKCE S256 required on every client unless disabled for a confidential client; per-client issuer URL; localhost redirects only for public clients ([Kanidm OAuth2](https://kanidm.github.io/kanidm/master/integrations/oauth2.html)). **ES256 verification is therefore required** unless we rely only on the TLS path. |
| **Tinyauth** (v5.x) | Probably | Now an OIDC **provider**, "OpenID Certified for Basic OP" at v5.1.0 (2026-06-25). Code flow plus refresh, `response_type=code` only, trusted redirect URIs, HTTPS required, `sub` derived from client ID plus username ([tinyauth repo](https://github.com/tinyauthapp/tinyauth), [tinyauth OIDC](https://tinyauth.app/docs/guides/oidc/)). Signing algorithm and **PKCE support are undocumented** on the pages fetched. **[assumed]** Basic OP certification implies RS256 support. Its older role, as an OAuth *client* in front of Google/GitHub, is irrelevant here. |

For the extension-as-public-client design, all six would need a public client with the chromiumapp/allizom redirect URI **and** token-endpoint CORS for extension origins. I did not verify the CORS side for any of them. That uncertainty is another reason to prefer the server-as-RP design.

---

## 5. Recommendations for VideoSync

1. **Choose server-as-RP.** Add an optional `-oidc-issuer`, `-oidc-client-id`, `-oidc-client-secret-file` and `-oidc-redirect` (or derive the redirect from `-public-url`). With none set, behaviour is unchanged.
2. **Verify the ID token by the TLS path (OIDC Core §3.1.3.7) plus the full claim checks** first. Then add stdlib signature verification with algorithms RS256, ES256 and EdDSA (plus HS256 only when explicitly configured, for Authentik), JWKS caching, and a rate-limited refetch on an unknown `kid`. Zero dependencies either way.
3. **Issue VideoSync-owned tokens:** an HMAC session (key from a file, random if absent) plus an optional single-use `hello` ticket. Never forward IdP tokens to a shim. Do not store IdP refresh tokens by default.
4. **Extension:**
   - Add the `identity` permission.
   - Run `launchWebAuthFlow` **from the worker**, pointed at `videosyncd /auth/start`.
   - Keep the session in worker-only storage (extension-origin IndexedDB, or `storage.session`), **not** `storage.local`.
   - Have the worker add the credential when it relays `hello`, so the content script never sees it.
   - Pin `manifest.key` for development builds so the chromiumapp URL stays stable.
5. **Userscript:**
   - Tab plus poll, with a user-code confirmation and a short-lived, single-use flow.
   - `postMessage` as an optional fast path only.
   - Store the session with `GM_setValue` (add `GM_openInTab` to `@grant` if it is used).
6. **Keep `/api/*` cookie-free** so CORS `*` stays sound (`http.go:42-58`). Use a single `SameSite=Lax` flow cookie under `/auth/*`, and `http.CrossOriginProtection` on cookie-bearing `/auth` POSTs.
7. **Server redirect allowlist for shims:** exact URLs only, defaulting to the published extension IDs. Do not wildcard.
8. **Update the protocol docs (`PROTOCOL.md`) with the change:**
   - `hello` gets an optional `ticket`/`session` field.
   - New `auth_required`/`auth_refused` error codes. Keep one message for all failures, following the `refusal` pattern at `http.go:128-139`.
9. **Probes to write before relying on any of this:**
   - `launchWebAuthFlow` in Helium, both when a non-IdP host issues the final chromiumapp redirect and when the server is on loopback.
   - The Firefox MV2 equivalent.
   - The userscript flow under a real Tampermonkey (which STATE:323 already lists as unverified).

## 6. Open questions

- **What should identity gate?** Creation only (F39), creation plus join, or display names only? Requiring login to join changes D4's "rooms are for people who already know each other" model. This needs a user decision.
- **Session lifetime vs account revocation:** is "disabled at the IdP takes effect when the VideoSync session expires" acceptable, or does the server need to hold IdP refresh tokens and re-check?
- **Browser behaviour in the auth window (unmeasured):**
  - Does Chromium's private-network block apply to top-level navigations inside a `launchWebAuthFlow` window (server on loopback)?
  - Does that window share the profile's IdP cookies, which would make SSO silent?
- **Does Helium/ungoogled-chromium ship a working `chrome.identity.launchWebAuthFlow`?** No source found.
- **Does `identity` add a Chrome install-time warning?** Not confirmed.
- **Tinyauth:** PKCE support and the ID-token signing algorithm are undocumented on the pages fetched.
- **Which IdPs support `prompt=none`,** so that `interactive:false` renewal works? Not checked for any of the six.
- **Tampermonkey's `GM_xmlhttpRequest`:** does it bypass the private-address block (§8)? It is unmeasured, and the answer matters beyond auth.
- **How does the server find its own public callback URL** behind a reverse proxy? Needs an explicit `-public-url`; do not trust `X-Forwarded-*` without a trusted-proxy setting, which ties into F39's per-IP question.
- **Multi-instance:** HMAC sessions work across processes if they share a key file, but the in-memory login-state map does not (D2 already has one process only).

Sources: [Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity) · [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage) · [Chrome extension security](https://developer.chrome.com/docs/extensions/mv3/security) · [MDN identity](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity) · [MDN launchWebAuthFlow](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow) · [mv3-extension.com launchWebAuthFlow](https://mv3-extension.com/core-apis-cross-browser-data-management/identity-oauth-authentication/implementing-oauth2-with-launchwebauthflow/) · [xiegerts.com](https://www.xiegerts.com/post/chrome-extension-oauth-web-auth-flow-firebase-google/) · [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) · [RFC 8725](https://datatracker.ietf.org/doc/html/rfc8725) · [OIDC Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) · [Go 1.25 release notes](https://go.dev/doc/go1.25) · [Authelia clients](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/) · [Authentik OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) · [Keycloak admin guide](https://www.keycloak.org/docs/latest/server_admin/index.html) · [Pocket ID custom keys](https://pocket-id.org/docs/advanced/custom-keys) · [Pocket ID callback wildcards](https://pocket-id.org/docs/advanced/callback-url-wildcards) · [Kanidm OAuth2](https://kanidm.github.io/kanidm/master/integrations/oauth2.html) · [tinyauth repo](https://github.com/tinyauthapp/tinyauth) · [tinyauth OIDC guide](https://tinyauth.app/docs/guides/oidc/)

Repository files referenced: `/home/yaeji/Projects/videosync/server/internal/hub/http.go`, `/home/yaeji/Projects/videosync/server/internal/hub/hub.go`, `/home/yaeji/Projects/videosync/server/internal/hub/ids.go`, `/home/yaeji/Projects/videosync/server/internal/room/messages.go`, `/home/yaeji/Projects/videosync/client/extension/src/sw.ts`, `/home/yaeji/Projects/videosync/client/extension/src/content.ts`, `/home/yaeji/Projects/videosync/client/extension/manifest.json`, `/home/yaeji/Projects/videosync/client/extension/dist-firefox/manifest.json`, `/home/yaeji/Projects/videosync/client/userscript/meta.txt`, `/home/yaeji/Projects/videosync/client/userscript/src/main.ts`, `/home/yaeji/Projects/videosync/docs/STATE.md`, `/home/yaeji/Projects/videosync/docs/PROTOCOL.md`, `/home/yaeji/Projects/videosync/docs/DECISIONS.md`