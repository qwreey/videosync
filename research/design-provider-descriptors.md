# Provider descriptors for VideoSync: design research

I changed nothing in the repository. I used scratch clones of `the-via/app`, `the-via/keyboards` and `darkreader/darkreader` in the session scratchpad. `refs/` does not exist in this checkout: it is gitignored and was never cloned (STATE.md:416). So every claim about the reference implementations below comes from `research/*.md`, which cites `file:line` into those clones, and not from the clones themselves.

Evidence tags:
- **[MEASURED]**: a probe or test in this repo.
- **[SOURCE]**: I read the upstream code or docs this session.
- **[DOC]**: vendor documentation, fetched this session.
- **[DERIVED]**: my own reasoning from documented behaviour.
- **[UNVERIFIED]**: not checked.

---

## 1. What exists today in VideoSync

### 1.1 Media identity (`client/core/src/adapter/mediakey.ts`)
- **Rule shape.** A `MediaKeyRule` is `{id, hosts[], key(u), pathFallback?, url?(body)}` (mediakey.ts:16-33). All of it is code: `key` and `url` are closures.
- **`YOUTUBE`** (36-61):
  - Hosts: `youtube.com`, `youtube-nocookie.com`, `youtu.be`.
  - The key is read in this order: `?v=` on **any path**, then `/embed|shorts|live|v/<id>`, then the first path segment on `youtu.be`.
  - `pathFallback: false`.
  - Canonical URL: `https://www.youtube.com/watch?v=<encoded id>`.
- **`LAFTEL`** (71-76): `key: () => null`, which falls through to the generic path rule. `url: path => https://laftel.net${path}`.
- **Host matching** in `providerFor` (80-88) is an exact match or a suffix match on a dot boundary (`h === s || h.endsWith('.'+s)`). That boundary is correct and must be kept: `laftel.net.evil.example` is already rejected (mediakey.test.ts:355).
- **Generic rule** (117-121): the key is `hostname-without-www:pathname-without-trailing-slash`. An empty path means no media.
- **Wire form:** `<providerId>:<body>`. The provider id is **part of the wire identity**, and the server repeats it to every member. The server only bounds its length (`MaxMediaKey = 512`, server/internal/room/mediaurl.go:13).
- **`followableUrl`** (154-173) is the gate on moving other people. A URL passes only if all of these hold:
  - it normalises to exactly the room's key;
  - it is on a *known* provider or on the member's current site;
  - it is https when the provider is known.

  It then returns the **canonical** `watchUrl`, never the URL as sent.

### 1.2 F20: the gap a descriptor should close
STATE.md:292 and PROTOCOL.md:108-110 describe it: "on a path-keyed site, a `media` command can name any path there as 'media', and members are taken to that path."

[DERIVED] from the code:
1. `normalizeMediaKey('https://laftel.net/logout')` returns `laftel:/logout`.
2. `followableUrl` finds a known host, https, and a matching key.
3. `watchUrl` returns `https://laftel.net/logout`, and every member is navigated there after the 1.5 s grace period.

For unknown hosts, the same thing happens through the `sameSite` branch.

The fix is a per-provider allowlist of media paths with `pathFallback: false`. After that, `/logout` names no media, so no room key can equal it.

### 1.3 Element selection (`resolve.ts`) and capabilities (`html5.ts`)
- **Candidates:** `document.querySelectorAll('video')` (resolve.ts:145). It does not pierce shadow DOM (SYNTHESIS §8 recommended adding that) and it has no per-site filter.
- **Ranking in `pickVideo`** (resolve.ts:66): audibly playing (not paused, readyState ≥ 1, not muted, volume > 0) comes first. Then the largest *intrinsic* area (`videoWidth*videoHeight`), then readyState.
- **Stickiness:** `OUTCLASSED = 4` (resolve.ts:43). STATE.md:305 notes that this constant has no test bound.
- **Capabilities.** `Html5Adapter.capabilities` are constants (html5.ts:18-24): direct seek, direct play/pause and rate nudge are true; ad detection and volatile element are false.
- **Seek quirks are hard-coded:** a 0.5 s landing tolerance (html5.ts:147) and a 10 s timeout (html5.ts:123).
- [MEASURED] Laftel's in-buffer seek costs ~100 ms with readyState 1 throughout, and a resume lands ~90 ms ahead (BROWSER-FINDINGS §14). Both are per-provider facts that a descriptor could carry.
- **The adapter is always `new Html5Adapter(el, 'html5')`** (bootstrap.ts:261). No provider-specific adapter exists, and no MAIN-world bridge exists (DECISIONS D5 amendment).

### 1.4 Where the host set lives today
The host set is written down in three places that drift independently:
- `RULES[].hosts`
- `manifest.json` `content_scripts.matches`: www/m.youtube.com and laftel.net (manifest.json:15)
- `client/userscript/meta.txt` `@match`, which adds `youtu.be`

On the extension side:
- It has no `host_permissions`, no `scripting` permission and no options page [MEASURED, BROWSER-FINDINGS §11].
- It stores exactly the keys `server, room, secret, name, rejoin` (content.ts:22). A key that is not listed is never hydrated.

### 1.5 Server
- **HTTP surface:** `GET /healthz`, `POST /api/rooms` (with CORS) and `GET /ws` (http.go:89-113).
- **Dependencies:** none. `go.mod` has no `require` block (STATE.md:418).
- **What the server knows about providers:** nothing. `SanitizeMediaURL` checks scheme, credentials, fragment and length. The server trusts clients to validate keys and URLs, and says so (mediaurl.go:24-32).

---

## 2. Precedents

### 2.1 VIA keyboard definitions — the closest match to what was asked
[SOURCE: the-via/app @352aebd, the-via/keyboards @91dcec4; DOC: caniusevia.com/docs/specification]

- **Structure.**
  - One JSON file per device, under `v3/<vendor>/<board>/<board>.json`.
  - Identity is `vendorId` + `productId`. That is a hard key: no pattern matching at all.
  - Required fields: `name`, `vendorId`, `productId`, `matrix`, `layouts`. Optional: `menus`, `keycodes`, `customKeycodes`, `firmwareVersion`.
- **Versioning is by *schema* generation, not by file.**
  - v2 and v3 are separate formats, each with its own validator.
  - A definition has no per-file content version.
  - The index `supported_kbs.json` has `{generatedAt, version (package version), theme, vendorProductIds:{v2,v3}}` (keyboards/scripts/build-definitions.ts:28-38).
- **Build pipeline.**
  - The app depends on `"via-keyboards": "github:the-via/keyboards"` (app/package.json:54).
  - `build:kbs` compiles every authoring-format definition (`KeyboardDefinitionV3`) into the runtime format (`VIADefinitionV3`) and writes it to `public/definitions/`. Invalid definitions are logged and fail the build (build-all.ts, build-isolated-definitions.ts).
  - Definitions are served as **static files from the app's own origin**.
- **Update detection by content hash.**
  - `hash.json` is an HMAC-SHA256 over all definitions plus the index (hash-json.ts, build-definitions.ts:49-57).
  - The app reads the hash from `<script id="definition_hash" data-hash=…>` in its own `index.html` (index.html:28).
  - When the hash changes, the app re-fetches the index and **clears the whole definition cache**. Individual definitions are fetched lazily per device from `/definitions/v3/<vpid>.json` (device-store.ts:64-150).
- **Side-loading.**
  - The Design tab takes "Load Draft Definition". It parses the file and validates it with the `@the-via/reader` type predicates (`isKeyboardDefinitionV3 || isVIADefinitionV3`), converting authoring format to runtime format when needed. Validation errors are shown per file (design.tsx:225-283).
  - Valid drafts are stored locally (`storeCustomDefinitions`).
  - **Custom definitions are merged over base definitions per `vendorProductId`**, and the custom one wins (definitionsSlice.ts:129-140).
  - The UI says the feature "is intended for development and troubleshooting" (design.tsx:363).
- **Lessons for VideoSync:**
  1. Keep a reviewed repo of JSON files that is **compiled into the shipped bundle**, with CI validation.
  2. Separate the authoring format from the runtime format.
  3. Detect changes by content hash, not by version.
  4. Key a local override by the same identity as the thing it overrides.

  VIA does not need a trust prompt, because a keyboard definition cannot redirect anyone anywhere. VideoSync's can, so this is where the model has to go further.

### 2.2 Dark Reader site-fix lists
[SOURCE: darkreader @06ca0a7; DOC: CONTRIBUTING.md]

- **Format.** Line-based config files (`dynamic-theme-fixes.config`, `inversion-fixes.config`, …). Each block starts with a domain (`www` omitted, `example.*` for per-country TLDs), followed by rule blocks: `INVERT`, `CSS`, `IGNORE INLINE STYLE`, `IGNORE IMAGE ANALYSIS`.
- **Every rule is data:** selectors and CSS. This is the category the MV3 policy explicitly allows (§2.7).
- **Distribution.**
  - The configs ship in the package.
  - `ConfigManager.loadConfig` fetches `https://raw.githubusercontent.com/darkreader/darkreader/main/src/config/<file>?nocache=…` **only when `syncSitesFixes` is on**, and falls back to the bundled copy on error (config-manager.ts:84-105, 178; src/utils/links.ts:15).
  - `syncSitesFixes` defaults to **`false`** (src/defaults.ts:90).
  - There is also an `overrides` set, a locally edited copy that takes precedence (config-manager.ts:76-82).
- **Lesson:** the bundled data is the safe default, remote refresh is opt-in, and a failed fetch falls back silently to the bundled copy. The precedence order is local edit, then remote (if opted in), then bundled.

### 2.3 uBlock Origin / ABP filter lists
[DOC]
- **Updates.** Lists update on the `! Expires:` header when present, otherwise every 5 days by default. Users can import arbitrary list URLs, one per line ([uBO wiki: Dashboard: Filter lists](https://github.com/gorhill/ublock/wiki/Dashboard:-Filter-lists); [ABP help](https://help.adblockplus.org/hc/en-us/articles/21916870381331-Update-your-filter-lists)).
- **Trust tiers — the key precedent for VideoSync.**
  - Powerful `trusted-*` scriptlets run only from "trusted sources": by default, uBO's own lists.
  - "My filters" is trusted only if the user ticks "Allow custom filters requiring trust".
  - The advanced setting `trustedListPrefixes` (for example `ublock- user-`) changes the set, using a `startsWith` match ([uBO Resources Library](https://github.com/gorhill/ublock/wiki/Resources-Library); [commit 64c1f87](https://github.com/gorhill/uBlock/commit/64c1f8767c); [uAssets discussion #18589](https://github.com/uBlockOrigin/uAssets/discussions/18589)).
  - In other words, **the same syntax has different powers depending on where it came from.**
- **uBO Lite (MV3).** Its FAQ says its "declarative rulesets and scripts are updated only when the extension itself updates", and gives reliability as the reason, not the remote-code rule. A June 2026 edit says custom filters and external lists are now supported; I did not verify how ([uBOL FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ))).

### 2.4 Stylus UserCSS
[DOC] [Stylus wiki: Writing UserCSS](https://github.com/openstyles/stylus/wiki/Writing-UserCSS)
- `@name` + `@namespace` together identify a style and must be unique.
- `@version` is mandatory, is used for the update check, and semver is recommended.
- `@updateURL` overrides where updates come from; otherwise the style updates from where it was installed.
- **Scoping uses `@-moz-document`** ([MDN @document](https://developer.mozilla.org/en-US/docs/Web/CSS/@document)):
  - `domain()` matches the domain *and its subdomains*.
  - `url-prefix()` is a prefix match.
  - `regexp()` "must match the entire URL" (implicitly anchored).
- **Lesson:** an implicitly anchored regex and a dot-boundary domain match are the safe defaults. Stylus gets both right.

### 2.5 Tampermonkey / Greasemonkey matching
[DOC]
- **`@match`** uses WebExtension match-pattern rules. Tampermonkey and Violentmonkey recommend `@match`/`@exclude-match` because they are "safer and more strict" ([Violentmonkey matching](https://violentmonkey.github.io/api/matching/); [Tampermonkey issue #1732](https://github.com/Tampermonkey/tampermonkey/issues/1732)).
- **`@include`** is a glob where "`*` … matches one or more of any character". A rule wrapped in `/…/` is a JS `RegExp`, case-insensitive, and "anchors must be manually included" ([Greasespot wiki](https://wiki.greasespot.net/Include_and_exclude_rules)). Tampermonkey treats `*` before `://` as scheme-only.
- **Both managers support a `.tld` pseudo-suffix** matching any TLD (Violentmonkey docs).
- [DERIVED] from those semantics, two footguns:
  - `@include http://*.example.com/*` also matches `http://evil.test/?.example.com/`, because `*` crosses `/` and `?`.
  - An unanchored `/example\.com/` matches `https://example.com.evil.test/`.
  - `.tld` means "any registry", so `google.tld` includes whoever registered `google.<some TLD>`.
- **Update checks** use `@version` with `@updateURL`/`@downloadURL`. The Tampermonkey docs page renders client-side and I could not fetch its text, so its exact update semantics are [UNVERIFIED].
- **Implication for the userscript shim:** it cannot widen its own `@match` at runtime. A user descriptor for a new host only takes effect after the user edits the script's matches. Tampermonkey's per-script "user matches" setting is [UNVERIFIED] as a supported path.

### 2.6 WebExtension match patterns
[DOC] [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- **Host wildcard:** a `*` in the host "must be the first or only character, and it must be followed by a period (`.`) or forward slash (`/`)". `*.example.com` covers subdomains.
- **TLD wildcards are not supported.**
- **The path is ignored for host permissions.**

This is the right model for descriptor `hosts`: an exact host, or a leading `*.` for a subdomain suffix. VideoSync's current suffix rule is equivalent to listing both `example.com` and `*.example.com`.

- **Adding hosts at runtime** needs three things:
  1. `optional_host_permissions` in the manifest (for example `https://*/*`).
  2. `chrome.permissions.request()` "from inside a user gesture, like a button's click handler". Grants persist ([permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)).
  3. `chrome.scripting.registerContentScripts` (Chrome 96+, `persistAcrossSessions` defaults to true, needs the `scripting` permission plus host permission, and `js` must be files inside the package) ([scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **Firefox MV2:** origins go in `optional_permissions`, and the registration API (`contentScripts.register` versus `scripting.registerContentScripts`) is [UNVERIFIED] for the `strict_min_version: 128` MV2 build.

### 2.7 MV3 remote-code ban: JSON is fine, interpreters are not
[DOC]
- **Definition** ([migrate/remote-hosted-code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)): remotely hosted code is "anything that is executed by the browser that is loaded from someplace other than the extension's own files", and "It does not include data or things like JSON or CSS."
- **Store policy** ([CWS MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)):
  - Allowed: "Fetching a remote configuration file for A/B testing or determining enabled features, where all logic for the functionality is contained within the extension package".
  - Prohibited: "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data".
  - If reviewers cannot discern full functionality from the submitted code, the extension is rejected.
- **What this means for the descriptor design:**
  - Descriptors must **parameterise** bundled logic: host sets, path templates, selectors, numbers, and enums naming bundled adapters.
  - They must **not** be a command language: no step lists, no "click X then wait Y", no expression evaluation, no templates with conditionals.
  - VideoTogether's Disney+ "seek by clicking ±10 s buttons in a loop" (research/videotogether.md:237-238) belongs in a bundled adapter picked by enum, never in a descriptor.

### 2.8 SponsorBlock
[DOC] [K-Anonymity wiki](https://github.com/ajayyy/SponsorBlock/wiki/K-Anonymity)
- **Privacy scheme.** The client sends the first 4 hex characters of `sha256(videoID)`, gets back every entry with that prefix, and filters locally, so the server cannot tell which video is being watched.
- **Architecture.** Per-site logic is bundled code (maze-utils), and the per-video data is remote. SPA handling uses `yt-navigate-finish` plus a MutationObserver (research/provider-player-control.md:136).
- **Lesson for VideoSync:** if a client ever asks a server "do you have a descriptor for host X?", it leaks browsing. Fetch the *whole index* instead, which is small, and match locally.

### 2.9 Identity-rule precedents in the references and related tools
- **yt-dlp** (not a VideoSync reference): one `_VALID_URL` regex per extractor, with a named group `(?P<id>…)` extracted by `_match_id` ([CONTRIBUTING.md](https://github.com/yt-dlp/yt-dlp/blob/master/CONTRIBUTING.md)). This is the "regex with capture" pattern at scale. It is safe there because the regexes are reviewed code, not user input.
- **OpenTogetherTube:** `ServiceAdapter.canHandleURL/getVideoId` gives identity `{service, id}` (research/servers-ott-synctube.md:188).
- **SyncTube:** first `isSupportedLink` wins, with a fallback to the raw player. `Iframe.hx` explicitly opts out of sync instead of faking it (research/servers-ott-synctube.md:193-200). That is a precedent for a descriptor saying "do not sync here".
- **cytube:** two hand-synchronised registries keyed by two-letter type codes, never cross-checked (research/cytube-watchparty.md:156). That is the anti-pattern that one descriptor file per provider, shared by every consumer, prevents.
- **VideoTogether:** about ten inline `hostname.endsWith(...)` branches for (a) choosing among `<video>` elements and (b) ad overlays (research/videotogether.md:234-246). Branches of type (a) map directly to descriptor fields:
  - `iqiyi`: include `.iqp-player-videolayer-inner > video`.
  - `bilibili`: exclude `.video-page-card-small`, `.feed-card`.
  - `iqiyi`/`qq`/`youku`: ad-overlay selectors.
  - Branches of type (b), which replace the player API (Netflix, Tencent, Baidu, Disney+), need bundled adapters.
- **watchbear [CRX]:** largest *rendered* area wins, with a 10 800 px² floor against ads (research/extensions-syncwatch-watchbear.md:370-371). VideoSync uses the *intrinsic* area instead, so a descriptor `minArea` must say which one it means.
- **syncwatch / watchbear:** the only per-site seam is Netflix, selected by host, driving a MAIN-world player API (research/extensions-syncwatch-watchbear.md:221-227). That is an "adapter enum", not data.

### 2.10 Regex engines and ReDoS
- **V8's non-backtracking engine** (the `l` flag) sits behind `--enable-experimental-regexp-engine` and is still experimental ([v8.dev](https://v8.dev/blog/non-backtracking-regexp)). Extension code cannot use it. Browser JS has **no linear-time regex and no match timeout**.
- **Go's `regexp` is RE2** (linear time), but its syntax is **not** JS syntax. The server therefore cannot faithfully validate a JS regex it serves. [DERIVED]
- **`URLPattern`** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern); [spec](https://urlpattern.spec.whatwg.org/)):
  - Baseline since September 2025. Firefox added it in 142 ([MDN FF142 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/142)).
  - Its default segment wildcard is `[^.]+?` in hostnames and `[^/]+?` in paths. `*` is a greedy full wildcard.
  - It allows custom regex groups, and `hasRegExpGroups` reports whether a pattern contains them.
  - The Firefox build pins `strict_min_version: '128.0'` (extension/build.mjs:56), so native `URLPattern` is not available on every supported Firefox. A hand-written matcher is needed anyway (§3.3).

---

## 3. Recommendation: the VideoSync provider descriptor

### 3.1 Principles
1. **Data parameterises bundled code.** A descriptor selects and tunes; it never sequences actions. The only way to reach behaviour is an enum naming a bundled adapter (`"adapter": "html5"`), which is the "determining enabled features" case in CWS policy.
2. **No regex in schema 1.** Use a segment-template language that is linear by construction (§3.3). Regex can be an allowed extension later, for **built-in descriptors only**, gated by CI review.
3. **Where a descriptor comes from limits what it can do**, as with uBO's trusted lists (§3.6). A server descriptor must never, by itself, make a host "known" for `followableUrl`.
4. **Non-built-in descriptors can only restrict capabilities** (for example turn off rate nudge). Adding capability needs a bundled adapter.
5. **A descriptor must never change a key another member computes differently.** The `mediaKey` prefix is part of the wire contract (§3.5).
6. **Each descriptor tests itself.** It carries `examples` that the client runs before accepting it, and CI runs them for built-ins. A descriptor whose examples fail is rejected.

### 3.2 Schema (runtime format, `schema: 1`)

```jsonc
{
  "schema": 1,                         // format generation (VIA v2/v3 style). Client rejects > known.
  "requires": [],                      // critical-extension list (cf. JWS "crit", RFC 7515 §4.1.11): names of
                                       // fields this descriptor relies on; a client that does not implement one
                                       // rejects the descriptor instead of silently ignoring a restriction.
  "id": "laftel",                      // [a-z0-9-]{2,32}; stable forever; the override key
  "keyPrefix": "laftel",               // default = id; FROZEN once published (it is on the wire)
  "name": "Laftel",
  "version": "1.2.0",                  // semver, display + ordering only; the content hash is what trust pins
  "adapter": "html5",                  // enum of bundled adapters; unknown => reject

  "hosts": ["laftel.net", "*.laftel.net"],  // lowercase ASCII LDH / xn-- only; exact or leading "*."; no other wildcards
  "canonicalHost": "laftel.net",       // must be one of `hosts`, no wildcard; https only

  "identity": [                        // first match wins; evaluated on the parsed URL, never on the raw string
    {
      "path": "/player/{series:int}/{episode:int}",
      "key":  "/player/{series}/{episode}",          // key body; placeholders only from this rule's captures
      "watch": "https://laftel.net/player/{series}/{episode}"
    }
  ],
  "pathFallback": false,               // false = only `identity` names media  (this is what closes F20)

  "video": {
    "include": [],                     // CSS selectors; if any element matches, candidates = those only
    "exclude": [],                     // el.closest(sel) != null => dropped
    "pierceShadow": false,             // walk open shadow roots
    "minIntrinsicArea": 0,             // videoWidth*videoHeight floor (NOT rendered px; watchbear's 10800 is rendered)
    "outclassedFactor": 4              // override of resolve.ts OUTCLASSED; clamp [1.5, 16]
  },

  "ads": {                             // reserved: the engine has no ad handling yet (STATE §3); listed in `requires` once consumed
    "activeWhen": []                   // selectors; any match => "ad playing"
  },

  "capabilities": {                    // may only turn true -> false unless the descriptor is built-in
    "playbackRateNudge": true,
    "directSeek": true
  },
  "seek": {
    "landingToleranceS": 0.5,          // html5.ts:147; clamp [0.05, 5]
    "timeoutMs": 10000,                // html5.ts:123; clamp [1000, 60000]
    "typicalInBufferMs": 100           // informational; BROWSER-FINDINGS §14
  },

  "navigation": {
    "spa": true,                       // route changes without a document load (measured for Laftel, §14)
    "volatileElement": true,
    "siteAutoplaysNext": null          // informational until C1 has a design; never moves the room (D4)
  },

  "examples": [                        // self-tests; all must pass or the descriptor is rejected
    { "url": "https://laftel.net/player/45462/93304?utm_source=x",
      "key": "laftel:/player/45462/93304",
      "watch": "https://laftel.net/player/45462/93304" },
    { "url": "https://laftel.net/logout", "key": null },
    { "url": "https://laftel.net.evil.example/player/1/2", "key": null }
  ],

  "notes": "free text, never interpreted"
}
```

The YouTube built-in, expressed in the same format so that it reproduces mediakey.ts:36-61 exactly:

```jsonc
{
  "schema": 1, "id": "yt", "keyPrefix": "yt", "name": "YouTube", "version": "1.0.0", "adapter": "html5",
  "hosts": ["youtube.com", "*.youtube.com", "youtube-nocookie.com", "*.youtube-nocookie.com",
            "youtu.be", "*.youtu.be"],
  "canonicalHost": "www.youtube.com",
  "identity": [
    { "hosts": ["youtu.be", "*.youtu.be"], "path": "/{id}/**",   "key": "{id}", "watch": "https://www.youtube.com/watch?v={id}" },
    { "path": "/**", "query": { "v": "{id:any}" },                "key": "{id}", "watch": "https://www.youtube.com/watch?v={id}" },
    { "path": "/{kind:embed|shorts|live|v}/{id}/**",              "key": "{id}", "watch": "https://www.youtube.com/watch?v={id}" }
  ],
  "pathFallback": false,
  "navigation": { "spa": true, "volatileElement": true },
  "examples": [
    { "url": "https://www.youtube.com/watch?v=abc&t=90", "key": "yt:abc", "watch": "https://www.youtube.com/watch?v=abc" },
    { "url": "https://youtu.be/abc", "key": "yt:abc" },
    { "url": "https://www.youtube.com/results?search_query=x", "key": null }
  ]
}
```

**Two decisions to surface, not to make silently:**
- **Tightening `{id:any}` changes behaviour.** Today any `v=` value becomes a key. Restricting it to YouTube's id alphabet would turn odd values into "no media". That is a behaviour change, so it should be a decision rather than part of the migration.
- **The `?v=` rule applies on any path, as today.** Only `followableUrl`'s canonicalisation makes that safe.

### 3.3 Template language (linear, no backtracking)
- **Path.** Split `URL.pathname` on `/`. First strip one trailing slash, matching the current `replace(/\/+$/,'')`.
- **Segment kinds:**
  - A literal segment compares byte-exact after `decodeURIComponent`. Case is significant, because ids are case-sensitive (mediakey.ts:117-118).
  - `{name}`: one segment of `[A-Za-z0-9._~-]`, 1–128 characters.
  - `{name:int}`: `[0-9]{1,20}`.
  - `{name:any}`: any single non-empty segment, up to 256 characters.
  - `{name:a|b|c}`: a literal alternation of plain words, with no nesting.
  - `**`: zero or more trailing segments. It may appear **only as the last segment**, and it cannot be captured.
- **Complexity.** With at most one `**`, which is always last, matching is a single left-to-right pass: O(number of segments). Nothing can backtrack.
- **Query.** `{"param": "{cap:type}"}` uses `URLSearchParams.get`, so only the first value counts. Every other parameter is ignored, as today.
- **Captured values** are percent-decoded once. They are re-encoded with `encodeURIComponent` when substituted into `watch`, and inserted raw into `key`.
- **`watch` template checks:**
  - It must parse as an absolute `https:` URL whose host is `canonicalHost` or one of the non-wildcard `hosts`.
  - Placeholders may appear only in path segments or query values, never in the scheme, the authority, or a slash position.
- **Round trip.** The client re-normalises every produced `watch` URL and requires it to produce the same key. `followableUrl` already depends on that property.
- **Validator limits:**
  - At most 32 identity rules.
  - At most 16 segments per template.
  - Descriptor size ≤ 16 KiB.
  - Selector strings ≤ 256 characters, at most 16 per list.
  - Reject `:has(`. It is not a ReDoS risk, but it is the one selector feature whose cost scales with the DOM, and `pickVideo` runs on every MutationObserver callback plus at 1 Hz (resolve.ts:140-145). This is [DERIVED], not measured.

**Rejected alternatives:**
- **JS regex from untrusted sources** (§4.1).
- **Native `URLPattern`.** It is unavailable on the supported Firefox 128, its `*` is greedy and crosses dots in hostnames, and it allows regex groups. A subset could be accepted later with `hasRegExpGroups === false` enforced.
- **Globs in `@include` style** (§2.5).

**Parity with the server.** The same grammar is about 150 lines each in TS and in stdlib Go. Share a `testdata/templates.json` vector file between the TS and Go test suites. This follows the project's own rule that "the algorithm cannot drift between what we measure and what we ship" (STATE.md:27-28).

### 3.4 Evaluation, all in bundled code
- **`normalizeMediaKey(href)`:**
  1. Pick the effective descriptor for the hostname (§3.6).
  2. Try each identity rule; the first match gives `keyPrefix:key`.
  3. If nothing matches and `pathFallback === false`, return null.
  4. Otherwise apply the generic path rule.
- **`watchUrl`:** the matched rule's `watch` template. The generic fallback stays origin + path.
- **`followableUrl`:** "known" becomes "has an effective descriptor **whose hosts are followable**" (§3.6). F20 closes for every descriptor with `pathFallback:false`.
- **`PageWatcher`/`pickVideo`:**
  - Candidates are `querySelectorAll('video')`, plus open shadow roots when `pierceShadow` is set.
  - Then apply `include`/`exclude`/`minIntrinsicArea`.
  - Then call `pickVideo(filtered, current, outclassedFactor)`.
  - If `include` matches nothing, fall back to all candidates. An outdated selector must degrade to today's behaviour, not to "no video".
- **`Html5Adapter`:** takes a `capabilities` mask and the seek parameters. `SwappableAdapter` is unchanged.
- **`VideoSync.dump()`** should report the effective descriptor's `id`, `version`, `sha256` and source. Field bugs have all been one-shot (STATE.md:160-162), and "which descriptor was in force" is exactly the question a later investigation will ask.

### 3.5 Keeping `mediaKey` stable across members
This is the pitfall most specific to VideoSync.

- **Different keys for the same page.** Two members with different descriptor sets compute different keys for the same page. The server answers with `media.mismatch`: a notice, not a refusal (PROTOCOL §2). The room then looks split, or offers "move the room here" in a loop.
- **Rule 1.** `keyPrefix` and the key body of a published identity rule are **frozen**. Changing either is a breaking change: publish a new `id`/`keyPrefix`, not a new version.
- **Rule 2: community descriptors should default `keyPrefix` to the bare hostname** (without `www.`), and key bodies to the path. A member *without* the descriptor then computes the same key through the generic rule, whenever the descriptor only *narrows* identity (the Laftel case) rather than re-deriving it (the YouTube case). [DERIVED] from mediakey.ts:91-93 and 117-121. `laftel` and `yt` stay as they are for wire compatibility.
- **Rule 3: optional protocol addition.** `welcome` carries `providers: [{id, sha256}]` for the descriptors the server offers, so a client can say "this room's server uses a newer Laftel rule than you". This is a protocol change and needs a PROTOCOL.md amendment. The server never uses it to judge anyone.

### 3.6 Trust and distribution

| tier | where it comes from | stored as | can make a host "known" (followable)? | capability changes | how it is updated |
|---|---|---|---|---|---|
| **B: built-in** | `client/core/providers/*.json` in this repo, reviewed by PR, CI runs schema + examples + `mise run test` | compiled into the bundle (esbuild JSON import) | yes | any, within bundled adapters | extension/userscript release |
| **S: server-offered** | `videosyncd -providers DIR` (a volume) | not applied until adopted | **only for hosts the user has also granted** (extension) or matched (userscript) | restrict only | prompt when `sha256` changes |
| **U: user-authored** | pasted or imported JSON (extension: an options page; userscript: `GM_setValue`) | `chrome.storage.local` key `videosync.providers` (add it to `KEYS`, content.ts:22) | same as S | restrict only | manual |

**Precedence per host** (VIA-style override by identity, Dark Reader-style local-over-remote):
1. U with the same `id` replaces S and B.
2. An adopted S with the same `id` replaces B **only if the user confirmed "replace built-in"**. The prompt must say so, and must show a diff of `hosts`, `identity` and `canonicalHost`.
3. B.
4. The generic rule.

Two further rules:
- **Different ids claiming overlapping hosts:** the most specific host wins, so an exact host beats `*.`. A tie is a conflict: neither is applied, and the panel says so.
- **An unadopted S is ignored.**

**Server side** (stdlib only: `os`, `io/fs`, `encoding/json`, `crypto/sha256`, `net/http`, `time`):
- `GET /api/providers` returns `{"schema":1,"providers":[{"id","version","sha256","hosts"}]}`. It is small and fetched whole: clients never ask per host (the SponsorBlock lesson).
- `GET /api/providers/{id}.json` returns the exact bytes whose sha256 the index lists. The client hashes **the bytes it received**, so no canonical-JSON step is needed.
- Validation uses `json.Decoder.DisallowUnknownFields` plus the Go port of the template grammar. Invalid files are logged and left out, as VIA's build does.
- Reload on SIGHUP or an mtime poll; neither needs a dependency.
- CORS is identical to `/api/rooms` (http.go:52-86). Without it, the client sees `TypeError: Failed to fetch` (CLAUDE.md Traps).
- Bundling JSON Schema validation in Go would need a dependency (for example `santhosh-tekuri/jsonschema`), so **don't**: hand-validate. A public-suffix check would need `golang.org/x/net/publicsuffix`, which is also a dependency (§4.2).

**Client transport:**
- **Extension:** fetch from the **service worker**. The content script cannot reach a loopback or LAN server (BROWSER-FINDINGS §9). This adds a new relay message type (sw.ts, relay.ts).
- **Userscript:** plain `fetch` works only for a public server, which it needs anyway (§8). `GM_xmlhttpRequest` plus `@connect` is the alternative.
- **Hashing** uses `crypto.subtle.digest('SHA-256')`, which exists only in a secure context. That is fine on https OTT pages and in the worker, but an `http:` page would have to skip S and U descriptors.

**Adoption UX:**
- **Extension:** prompts belong on an **extension page** (popup or options), not in the in-page panel. The panel's closed shadow root keeps page scripts from reading it, but a page can still overlay or clickjack it. [DERIVED]
- **Same page for permissions:** `permissions.request` needs a user gesture on an extension surface, so the same page handles "adopt descriptor Y from server X, which covers hosts H → grant H".
- **Userscript:** no extension page exists. Use `GM_registerMenuCommand` plus `confirm()`, and tell the user to add `@match` lines.
- **Pinning and updates:**
  - Pin adoption to `sha256`. `version` is only shown.
  - On a hash change, show "update available".
  - Never auto-apply a change that widens `hosts`, `identity`, `canonicalHost`, or `pathFallback` (false → true).
  - A Dark Reader-style opt-in "auto-apply updates from this server" is reasonable, **default off**, and still limited to changes that do not widen anything.
- **New hosts in the extension** need `optional_host_permissions: ["https://*/*"]`, the `scripting` permission, and `registerContentScripts` with the bundled `content.js`. This changes the install prompt: `scripting` is added, while optional hosts do not warn at install [DOC]. BROWSER-FINDINGS §11's "no host permissions" result stays true for the built-in set.
- **Firefox MV2:** needs a separate check of `optional_permissions` plus the registration API. [UNVERIFIED]

**Single source of truth.** Generate `manifest.json` `matches` and `meta.txt` `@match` from the built-in descriptors at build time. That removes the three-way host drift described in §1.4.

---

## 4. Safety pitfalls

### 4.1 ReDoS
- A user- or server-supplied JS regex runs on a backtracking engine with no timeout. It would run in the content script on every navigation poll (1 Hz, plus MutationObserver callbacks) and on every incoming `media` command.
- A pattern like `^(a+)+$` against a 30-character path hangs the tab, and **the room can trigger it remotely** by sending a crafted `mediaUrl`, because `followableUrl` normalises whatever a member sends.
- **Mitigation:** do not accept regex (§3.3). If regex is ever admitted for built-ins:
  - require the whole-string anchoring that Stylus uses;
  - lint in CI for nested quantifiers, backreferences and lookarounds;
  - cap input length (the server already caps `mediaUrl` at 512 bytes, mediaurl.go:7). The cap alone is not enough: exponential patterns explode at around 30 characters.
- **Server-side RE2 validation does not prove a JS regex safe** (different engines, different syntax).

### 4.2 Host spoofing and lookalikes
1. **Suffix without a dot boundary.** `endsWith('laftel.net')` would accept `evillaftel.net`. Keep the dot-boundary rule; the test at mediakey.test.ts:355 should become a required `examples` entry for every descriptor.
2. **Glob or unanchored matching on the full URL** (§2.5): `https://evil.test/?x=.laftel.net/`. Always match on `URL.hostname` after parsing, never on the href string.
3. **Userinfo:** `https://laftel.net@evil.example/`. The parsed hostname is `evil.example`. `followableUrl` also rejects any username (mediakey.ts:163). Keep that.
4. **IDN homographs:** `laftеl.net` with a Cyrillic `е` parses to `xn--…`. Descriptor hosts must be ASCII-only and lowercase so a lookalike can never equal them. Non-ASCII in a descriptor means reject.
5. **Trailing dot:** `laftel.net.` is a distinct `hostname` string. Today it falls to the unknown-host branch, which is harmless. Decide explicitly: strip one trailing dot before matching, and add an example.
6. **Wildcards that are too broad:** `*.net`, `*.co.kr`, or a `.tld`-style "any TLD" (§2.5). Reject hosts with fewer than two labels. A real public-suffix check needs a PSL: `golang.org/x/net/publicsuffix` is **a dependency**, and bundling the PSL in JS is about 100 KB of data. The cheaper rule: an S or U descriptor's hosts must be granted by the user anyway, so the browser's permission prompt is the backstop.
7. **The server as attacker.** The strongest risk. Suppose a malicious or compromised `videosyncd` offers `{hosts:["evil.example"], canonicalHost:"evil.example", pathFallback:true}`. If that alone made `evil.example` "known", any member's `media` command could send the whole room there, reopening F20 across sites. Two rules prevent it:
   - S descriptors are **inert until adopted**;
   - followability for S and U descriptors additionally requires the host to be in the user-granted or matched set.
8. **Scheme and port.** `canonicalHost` is https-only and port-less, which preserves the current "never downgrade a known provider" rule (mediakey.ts:170-171). The generic rule's `u.origin` keeps the port. That is fine for same-site, but should be written down.
9. **Side-effecting paths on legitimate hosts** (`/logout`, `/account/delete?confirm`). These are the F20 case itself. `pathFallback:false` plus narrow templates closes it. A descriptor author must not add `/**` as a media path. Lint for that: reject `identity` rules whose `path` is only `**` unless `query` is also set.

### 4.3 Other pitfalls
- **Silently dropping a restriction.** A client that ignores an unknown restrictive field is *less* safe than the author intended. That is why `requires` exists (§3.2) and why clients reject `schema` values higher than they know.
- **Descriptors changing D4 or D1 behaviour.** No descriptor field may auto-move the room on next-episode (bootstrap.ts:265-273 argues why). `navigation.*` stays informational.
- **Capability escalation.** `directSeek:true` from an S or U descriptor on a provider whose bundled adapter says false would crash players such as Netflix's (research/provider-player-control.md:108). Hence the "restrict only" rule.
- **Selector drift.** When an `include` selector goes stale after a site redesign, fall back to all candidates (§3.4). Surface it in `dump()` rather than failing closed into "no video".
- **Storage.** A U descriptor saved under a key missing from `KEYS` is never hydrated. content.ts:18-21 records that this exact mistake has already happened once.
- **Privacy.** Per-host lookups leak browsing (§2.8). Fetch the index whole.

---

## 5. Concrete next steps, in order
1. Convert `YOUTUBE` and `LAFTEL` to descriptor JSON plus the bundled evaluator, keeping keys byte-identical. The existing `mediakey.test.ts` must pass unchanged, and the descriptors' `examples` become additional tests.
2. Add `pathFallback:false` with `/player/{int}/{int}` for Laftel. This closes F20 for Laftel. Other Laftel player routes, if any exist, are unmeasured: BROWSER-FINDINGS §14 saw only `/player/<series>/<episode>`. A live check of the series page and of "continue watching" routes should precede shipping.
3. Generate `matches`/`@match` from the descriptors.
4. Add the `video` hints and capability mask plumbing. Add the missing `OUTCLASSED` test bound while there (STATE.md:305).
5. Server `-providers DIR` plus `/api/providers`, with shared template test vectors between Go and TS.
6. Extension options page: import/export, adoption with hash pinning, `optional_host_permissions` plus `registerContentScripts`. Userscript: a menu command.
7. Optional: the `welcome.providers` hash list (needs a PROTOCOL amendment).

---

## 6. Open questions
1. **Should the server enforce media allowlists?** It could refuse a `media` command whose key matches no loaded descriptor rule (for example a `-strict-media` flag). That moves some trust to the server, which today is deliberately provider-agnostic (mediaurl.go:27-32), and it cannot judge keys for hosts it has no descriptor for.
2. **Regex, ever?** Only for built-ins with CI linting, or never? Schema 1 as proposed says never.
3. **F20 on unknown hosts** (the `sameSite` branch) stays open without a descriptor. Is a conservative generic heuristic acceptable (for example a path with ≥ 2 segments or containing a digit)? Or should following be disabled for descriptor-less sites (a behaviour change to BROWSER-FINDINGS §18's flow)?
4. **YouTube `?v=` alphabet tightening** (§3.2): is it a behaviour change the user wants?
5. **Firefox MV2 dynamic registration.** Which API works on the `strict_min_version: 128` MV2 build, and does Firefox's per-site doorhanger change the adoption flow? [UNVERIFIED]
6. **Tampermonkey.** Is "user matches" a reliable way to extend a userscript to new hosts? Tampermonkey itself is still unverified in this project (STATE.md:323).
7. **Where community descriptors live, and who reviews them.** Options: a `providers/` directory in this repo (the VIA and Dark Reader model) or a separate repo. Licensing is also unsettled: the repo has no LICENSE yet (STATE.md:345).
8. **Future MAIN-world adapters** (Netflix-class). Adding `"adapter": "netflix-main"` to the enum re-activates the per-load-nonce trap (CLAUDE.md). A descriptor must never be able to choose a MAIN-world adapter for a host that the adapter's bundled code does not itself allow.
9. **Ad markers.** YouTube's `.ad-showing` and `#movie_player` ad events are [UNVERIFIED] as selectors (research/provider-player-control.md:138). The `ads` block stays reserved until the engine has an ad state.
10. **`chrome.storage.local` quota** for user descriptors: probably ample at ≤ 16 KiB each, but the exact quota was not checked this session.

Local files referenced: /home/yaeji/Projects/videosync/client/core/src/adapter/mediakey.ts, /home/yaeji/Projects/videosync/client/core/src/adapter/resolve.ts, /home/yaeji/Projects/videosync/client/core/src/adapter/html5.ts, /home/yaeji/Projects/videosync/client/core/src/app/bootstrap.ts, /home/yaeji/Projects/videosync/client/extension/src/content.ts, /home/yaeji/Projects/videosync/client/extension/manifest.json, /home/yaeji/Projects/videosync/client/extension/build.mjs, /home/yaeji/Projects/videosync/client/userscript/meta.txt, /home/yaeji/Projects/videosync/server/internal/hub/http.go, /home/yaeji/Projects/videosync/server/internal/room/mediaurl.go, /home/yaeji/Projects/videosync/docs/STATE.md, /home/yaeji/Projects/videosync/docs/PROTOCOL.md, /home/yaeji/Projects/videosync/research/SYNTHESIS.md, /home/yaeji/Projects/videosync/research/videotogether.md, /home/yaeji/Projects/videosync/research/extensions-syncwatch-watchbear.md, /home/yaeji/Projects/videosync/research/servers-ott-synctube.md, /home/yaeji/Projects/videosync/research/provider-player-control.md

Sources:
- [VIA specification](https://www.caniusevia.com/docs/specification)
- [the-via/app](https://github.com/the-via/app)
- [the-via/keyboards](https://github.com/the-via/keyboards)
- [Dark Reader CONTRIBUTING](https://github.com/darkreader/darkreader/blob/main/CONTRIBUTING.md)
- [uBO: Dashboard filter lists](https://github.com/gorhill/ublock/wiki/Dashboard:-Filter-lists)
- [uBO Resources Library](https://github.com/gorhill/ublock/wiki/Resources-Library)
- [uBO trusted-list commit](https://github.com/gorhill/uBlock/commit/64c1f8767c)
- [uAssets discussion #18589](https://github.com/uBlockOrigin/uAssets/discussions/18589)
- [uBOL FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ))
- [ABP: update filter lists](https://help.adblockplus.org/hc/en-us/articles/21916870381331-Update-your-filter-lists)
- [Stylus: Writing UserCSS](https://github.com/openstyles/stylus/wiki/Writing-UserCSS)
- [MDN @document](https://developer.mozilla.org/en-US/docs/Web/CSS/@document)
- [Violentmonkey matching](https://violentmonkey.github.io/api/matching/)
- [Greasespot include/exclude rules](https://wiki.greasespot.net/Include_and_exclude_rules)
- [Tampermonkey issue #1732](https://github.com/Tampermonkey/tampermonkey/issues/1732)
- [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
- [Chrome remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- [CWS MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [chrome.permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [SponsorBlock K-Anonymity](https://github.com/ajayyy/SponsorBlock/wiki/K-Anonymity)
- [yt-dlp CONTRIBUTING](https://github.com/yt-dlp/yt-dlp/blob/master/CONTRIBUTING.md)
- [V8 non-backtracking RegExp](https://v8.dev/blog/non-backtracking-regexp)
- [MDN URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern)
- [URLPattern spec](https://urlpattern.spec.whatwg.org/)
- [Firefox 142 release notes for developers](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/142)