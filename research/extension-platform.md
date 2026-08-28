# Extension Platform Research — Cross-Site Video Sync (Chrome MV3 + Firefox)

Researched 2026-08-28. Scope: can we reliably reach and control page-world video-player JS (YouTube `movie_player`, Netflix's internal player) from a Chrome MV3 / Firefox extension, get data back out, hold a persistent sync-server connection, survive cross-origin iframes and fullscreen, and stay within store policy. Confidence tags: **[CONFIRMED — url]**, **[LIKELY — reasoning]**, **[UNVERIFIED]**.

Local primary-source evidence used throughout: `refs/VideoTogether` (a real, shipping cross-browser video-sync extension) at `/code/Projects/VideoSync/refs/VideoTogether/source/{chrome,firefox}/manifest.json`, `pre.js`, `preInjected.js`, `extension.chrome.user.js`.

---

## 1. Chrome MV3 MAIN world

- Declarative `content_scripts[].world: "MAIN"` in `manifest.json` shipped in **Chrome 111** (March 2023). Values: `"ISOLATED"` (default) or `"MAIN"`. [CONFIRMED — https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts, corroborated by https://github.com/w3c/webextensions/issues/485]
- The `world` parameter on the *scripting API* (`chrome.scripting.executeScript({world: "MAIN"})`, `chrome.scripting.registerContentScripts({world: "MAIN"})`) shipped earlier — Chrome 95 for `executeScript`, Chrome 96 for `registerContentScripts`. [LIKELY — reported by web research, not independently re-verified against release notes]
- A MAIN-world script "shares the execution environment with the host page's JavaScript" — it sees and can mutate real page globals (`window.netflix`, a `movie_player` DOM element's methods, React internals, etc.), exactly what's needed to drive a player API. [CONFIRMED — https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts]
- Chrome 133+ added a `worldId` param (under `chrome.userScripts`, less clearly under plain `chrome.scripting`) to run multiple *isolated* MAIN-world instances so two extensions' MAIN-world code doesn't collide. Not needed for a single-extension design; flagged for awareness only. [LIKELY — https://developer.chrome.com/docs/extensions/reference/api/userScripts, not fully cross-checked against current `chrome.scripting` docs]
- **MAIN-world code has no access to `chrome.*` APIs, including `chrome.runtime`.** This is the central design constraint: MAIN-world code cannot call `chrome.runtime.sendMessage` directly. [CONFIRMED in practice by Google's own content-script guide, which routes MAIN→ISOLATED communication through `postMessage` rather than any chrome.* call — https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts]

### The postMessage bridge — concrete, correct pattern

Google's own doc sample checks only `event.source !== window` — it does **not** authenticate the message contents. That's insufficient: a page script can trivially forge `{type: 'FROM_PAGE', ...}` in the exact shape a naive listener expects. Because the MAIN-world script and the ISOLATED-world content script execute against the **same `window` object and the same origin**, `event.source` is always `window` and `event.origin` is always the page's own origin for *both* legitimate and spoofed messages — neither check distinguishes your bridge traffic from a hostile page script. Confirmed empirically: VideoTogether's real listener (`extension.chrome.user.js:296`) does not check `event.origin` at all, only a `source: "VideoTogether"` string tag — which is itself forgeable by any page script that reads the extension's own bundled JS. The fix is a per-page-load secret nonce known only to the two extension-authored scripts:

```js
// isolated-bridge.js — ISOLATED world, run_at: document_start
const BRIDGE_NONCE = crypto.randomUUID();
// Hand the nonce to the MAIN-world script via a DOM attribute set *before*
// the MAIN-world script runs (both are document_start; ISOLATED and MAIN
// scripts declared in the same content_scripts entry batch run in
// registration order, so list this script first, or use a data attribute
// that main-world.js polls for on next microtask).
document.documentElement.dataset.vsNonce = BRIDGE_NONCE;

window.addEventListener('message', (event) => {
  if (event.source !== window) return;                 // reject other frames (necessary, not sufficient)
  const d = event.data;
  if (!d || d.channel !== 'videosync' || d.nonce !== BRIDGE_NONCE) return; // authenticate
  chrome.runtime.sendMessage(d.payload);                // relay MAIN world -> service worker
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.channel !== 'videosync-cmd') return;
  window.postMessage({ channel: 'videosync-cmd', nonce: BRIDGE_NONCE, payload: msg.payload }, '*');
});
```

```js
// main-world.js — world: "MAIN", document_start
(function () {
  const nonce = document.documentElement.dataset.vsNonce;
  delete document.documentElement.dataset.vsNonce;      // don't leave it readable by the page

  function toExtension(payload) {
    window.postMessage({ channel: 'videosync', nonce, payload }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.channel !== 'videosync-cmd' || d.nonce !== nonce) return;
    // e.g. d.payload = { action: 'seek', time: 123.4 }
    const player = document.getElementById('movie_player');
    if (player && d.payload.action === 'seek') player.seekTo(d.payload.time, true);
  });

  const player = document.getElementById('movie_player');
  if (player) toExtension({ type: 'PLAYER_READY' });
})();
```

Manifest entry ordering both scripts into the same page:

```json
"content_scripts": [
  {
    "matches": ["https://*.netflix.com/*", "https://*.youtube.com/*", "https://*.youtube-nocookie.com/*"],
    "js": ["isolated-bridge.js"],
    "run_at": "document_start",
    "all_frames": true
  },
  {
    "matches": ["https://*.netflix.com/*", "https://*.youtube.com/*", "https://*.youtube-nocookie.com/*"],
    "js": ["main-world.js"],
    "world": "MAIN",
    "run_at": "document_start",
    "all_frames": true
  }
]
```

---

## 2. CSP

- Declaratively-injected content scripts (both ISOLATED and MAIN, injected via the manifest `content_scripts` mechanism or `chrome.scripting`) are injected by the browser itself, not through the page's script loader, so the **injection step itself is not blocked by page CSP**. [CONFIRMED — https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts]
- Nuance: once a script is injected as **MAIN world**, it now executes inside the page's own realm, and the page's CSP governs its subsequent runtime behavior (e.g., it inherits the page's restrictions on `eval`, on loading additional remote scripts, etc.) — the page's CSP does not stop the *initial* MAIN-world injection, but it does constrain what that script can do afterward (dynamic `eval`, remote `<script>` loads it tries to perform). [CONFIRMED — same URL]
- `window.postMessage` traffic is **not** restricted by any CSP directive — there is no `script-src`/`connect-src` rule that governs structured-clone postMessage. [LIKELY — no CSP directive covers postMessage traffic; absence of restriction confirmed by omission across MDN's CSP directive reference]
- DOM-injecting `<script src="chrome-extension://EXTENSION_ID/foo.js">` from an ISOLATED-world content script (the pre-MAIN-world / cross-browser-fallback technique, used by VideoTogether's `pre.js` on both Chrome and Firefox builds even today) is a **murkier case than a blanket "CSP blocks it"**: secondary sources (e.g. a hackerblog CSP-auditing writeup) claim page `script-src` can block such tags, but Chrome has historically special-cased `chrome-extension:`-scheme resources here, and behavior differs from Firefox's `moz-extension:` scheme. This claim could not be nailed down to an authoritative, current source — **mark [LIKELY, not CONFIRMED]**, and do not rely on it as the primary injection path when declarative `world: "MAIN"` is available (Chrome 111+, Firefox 128+ — see §3). The DOM-injection trick should be treated as a legacy fallback only, not the primary mechanism, precisely because its CSP-robustness is unverified.
- Either way, the injected resource must be listed in `web_accessible_resources` — this is an extension-side access-control gate, unrelated to and checked independently of page CSP.

Exact MV3 manifest stanza:

```json
"web_accessible_resources": [
  {
    "resources": ["preInjected.js"],
    "matches": ["https://*.netflix.com/*", "https://*.youtube.com/*", "https://*.youtube-nocookie.com/*"],
    "use_dynamic_url": true
  }
]
```

`use_dynamic_url: true` randomizes the resource's URL per browser session, which helps against site scripts that fingerprint/block known extension resource URLs. [CONFIRMED — https://developer.chrome.com/docs/extensions/mv3/manifest/web_accessible_resources]

**Recommendation: use declarative `world: "MAIN"` (§1) as the primary and only injection path on Chrome and modern Firefox. It is browser-injected, not DOM-injected, so it sidesteps the CSP-robustness question entirely** — this is the strongest reason to prefer it over the `<script src=chrome-extension://...>` pattern VideoTogether still ships (which predates Firefox's `world: "MAIN"` support and exists for that historical reason).

---

## 3. Firefox

- Firefox has supported MV3 since Firefox 109 and, unlike Chrome, has **explicitly stated no plans to deprecate MV2** ("no plans to deprecate MV2 in the foreseeable future," March 2024). Contrast: Chrome ended MV2 stable support at Chrome 138 (July 2025) and the Chrome Web Store delisted MV2 extensions Aug 31, 2026. [CONFIRMED — https://blog.mozilla.org/addons/2024/03/13/manifest-v3-manifest-v2-march-2024-update/]
- Firefox's MV3 diverges from Chrome's in two load-bearing ways:
  1. Firefox still allows **blocking `webRequest`** (Chrome MV3 restricts this to the non-blocking `declarativeNetRequest` style).
  2. **Firefox's MV3 background is not a service worker** — the primary, documented mechanism is a non-persistent **event page** (`background.scripts` + `background.type: "module"`, no `persistent: false` needed as it always is in MV3), not `background.service_worker`. [CONFIRMED — https://blog.mozilla.org/addons/2024/03/13/manifest-v3-manifest-v2-march-2024-update/] This is architecturally significant for §4: Chrome's WS-keepalive pattern is specifically about a *service worker's* 30s idle timer; Firefox's event-page lifecycle is governed by different rules that were not independently verified in this pass — **[UNVERIFIED]** exact Firefox event-page idle timing. Treat Firefox as needing the same defensive reconnect-on-wake pattern as Chrome rather than assuming either better or worse persistence.
- **`world: "MAIN"` is fully supported in Firefox as of Firefox 128** (July 2024) — across all three surfaces: the `content_scripts[].world` manifest key, `browser.scripting.executeScript({world:"MAIN"})`, and `browser.scripting.registerContentScripts({world:"MAIN"})`. Tracked as Bugzilla 1736575, RESOLVED FIXED, milestone firefox128. [CONFIRMED — https://bugzilla.mozilla.org/show_bug.cgi?id=1736575] Given Firefox is far past version 128 as of August 2026, **no runtime feature-detection fallback is needed for the MAIN-world injection mechanism itself** — declare `world: "MAIN"` identically in both manifests. Only pre-128 Firefox (long past EOL relevance) would need the legacy DOM-injection fallback.
- Legacy/pre-128 mechanism, useful context and a defensive fallback if ever targeting old Firefox ESR: content scripts run **Xray-wrapped**, sharing the DOM with the page but not JS globals.
  - `window.wrappedJSObject` unwraps Xray vision to read/write real page-world objects:
    ```js
    console.log(window.foo);               // undefined — Xray-wrapped view
    console.log(window.wrappedJSObject.foo); // real value set by the page's own script
    ```
  - `exportFunction(fn, window, {defineAs: "notify"})` exposes a content-script function callable from page scripts:
    ```js
    function notify(message) {
      browser.runtime.sendMessage({ content: `Function call: ${message}` });
    }
    exportFunction(notify, window, { defineAs: "notify" });
    // page script can now call: window.notify("hi")
    ```
  - `cloneInto(obj, window, {cloneFunctions: true})` structured-clones an object (including functions, if flagged) into the page world:
    ```js
    const messenger = {
      notify(m) { browser.runtime.sendMessage({ content: `Object method call: ${m}` }); }
    };
    window.wrappedJSObject.messenger = cloneInto(messenger, window, { cloneFunctions: true });
    ```
  [CONFIRMED — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts]
  - A genuinely non-obvious Firefox gotcha: bare `eval()` in a Firefox content script runs in the **content script's own sandbox**; `window.eval()` runs in the **page's world**.
    ```js
    window.eval("window.x = 1;"); // executes in PAGE context
    eval("window.y = 2");         // executes in CONTENT SCRIPT context
    ```
    [CONFIRMED — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts]
- **`browser.*` vs `chrome.*`**: Firefox natively implements the promise-based `browser.*` namespace; Chrome exposes only callback-based `chrome.*` with no native promise support and no `browser` alias. `mozilla/webextension-polyfill` (latest release v0.12.0) is a no-op on Firefox and still fills the gap on Chrome. [LIKELY — https://github.com/mozilla/webextension-polyfill] **Recommendation: still ship the polyfill in 2026** — low cost, and Chrome has not added native promise support or a `browser` alias.
- **What actually forces a Chrome/Firefox shim in this project, given MAIN-world parity**: not the injection mechanism (identical `world: "MAIN"` on both), but **the background surface** — `background.service_worker` (Chrome) vs `background.scripts`/event page (Firefox) require two different manifest `background` stanzas, and the Chrome-116 WebSocket-keepalive pattern (§4) is specifically a service-worker mechanism with no confirmed Firefox equivalent.
- Firefox also treats host permissions as **optional-by-default from the user's perspective**: Firefox prompts the user per-site via a permissions doorhanger even for permissions listed in `host_permissions`, which is relevant to §7 and means the runtime-request flow (§7) is closer to Firefox's native UX than to Chrome's. [LIKELY — general Firefox WebExtensions permission-model behavior, not independently re-verified against current MDN wording in this pass]

---

## 4. MV3 service worker lifetime and the persistent WebSocket

This is the single highest-risk item for the architecture and was independently re-verified (not just relayed from a subagent report) by fetching the primary source directly.

- Baseline: Chrome MV3 service workers idle-terminate after **~30 seconds** of inactivity, with a **5-minute** max lifetime for a single top-level event, as the enduring model as of 2026. [CONFIRMED — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle]
- **As of Chrome 116, WebSocket message activity can reset the 30-second idle timer — but only if messages are actually exchanged inside that window; an idle-but-open WebSocket does not, by itself, keep the worker alive.** Verified verbatim from Chrome's own docs:
  > "Previously, a service worker could become inactive despite a WebSocket connection being active if no other extension events occurred for 30 seconds."
  > "From Chrome 116 on, you can keep a service worker with a WebSocket connection active by exchanging messages within the 30s service worker activity window."
  [CONFIRMED — https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets, verified live 2026-08-28]
- Consequently, Chrome's own tutorial requires an **application-level periodic ping** — it does not rely on "the connection being open" as sufficient:
  > "Set the interval to 20 seconds to prevent the service worker from becoming inactive."
  ```js
  const PING_INTERVAL_MS = 20 * 1000; // must stay under the 30s idle window
  let webSocket = null;

  function connect() {
    webSocket = new WebSocket('wss://sync.example.com/ws');
    webSocket.onopen = () => keepAlive();
    webSocket.onmessage = (event) => handleServerMessage(event.data);
    webSocket.onclose = () => { webSocket = null; setTimeout(connect, 1000); };
  }

  function keepAlive() {
    const id = setInterval(() => {
      if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(id);
      }
    }, PING_INTERVAL_MS);
  }
  ```
  Requires `"minimum_chrome_version": "116"` and a module-type service worker. [CONFIRMED — https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/functional-samples/tutorial.websockets/service-worker.js, https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets]
- **`chrome.offscreen` is not documented by Chrome as a WebSocket host.** Its `reasons` enum (`TESTING`, `AUDIO_PLAYBACK`, `IFRAME_SCRIPTING`, `DOM_SCRAPING`, `BLOBS`, `DOM_PARSER`, `USER_MEDIA`, `DISPLAY_MEDIA`, `WEB_RTC`, `CLIPBOARD`, `LOCAL_STORAGE`, `WORKERS`, `BATTERY_STATUS`, `MATCH_MEDIA`, `GEOLOCATION`) has **no `WEBSOCKET` reason**; some extensions pragmatically use `WORKERS` since an offscreen document is not subject to the 30s SW idle clock and can run indefinitely, but this is a workaround, not Chrome's documented primary path since Chrome 116 shipped the simpler in-SW pattern above. [CONFIRMED (reasons enum) — https://developer.chrome.com/docs/extensions/reference/api/offscreen; workaround status — LIKELY]
- `chrome.alarms` minimum period is **30 seconds** for packed/published extensions (`periodInMinutes < 0.5` is silently not honored, with a warning), no minimum for unpacked/dev-mode. [CONFIRMED — https://developer.chrome.com/docs/extensions/reference/api/alarms, verified live 2026-08-28] Use `chrome.alarms` as a **reconnect watchdog**, not as the primary keepalive — 30s granularity plus "may delay an arbitrary amount more" is too coarse for real-time sync but is exactly right as a fallback: if the SW was recycled anyway (Chrome killed it despite the ping, e.g. after a laptop sleep), the alarm's `onAlarm` listener (registered at top level so it survives worker restarts) checks whether `webSocket` is null and reconnects.
- Using `chrome.runtime.connect` long-lived ports purely as an artificial keepalive is called out as an **anti-pattern** by the Chrome extensions team; Chrome has tightened behavior here rather than treating it as a supported technique. Chrome's own suggested alternatives to ad hoc keepalive hacks are `chrome.storage.session`, opening an extension page, or an offscreen document — not port-pinging. [CONFIRMED — https://github.com/GoogleChrome/developer.chrome.com/issues/2688]
- Holding the WebSocket in a **content script** instead is viable only as a redundant/fallback channel: it dies on tab navigation or close and isn't a stable place to anchor a background sync connection. [LIKELY — reasoning from content-script lifecycle, not from a specific doc]
- No confirmed real open-source video-sync extension was found exposing this exact Chrome-116 pattern in the time available; recommendation below is therefore built directly from Chrome's own official docs and sample, not from an observed production extension.

**Recommendation:** hold the WebSocket in the service worker, using the Chrome ≥116 pattern (ping every ~20s) as primary, plus a `chrome.alarms` watchdog (~30–60s) as a reconnect safety net for the cases where the SW is recycled anyway (sleep/resume, Chrome killing it despite best efforts, or any Chrome < 116 / Firefox environment where this exact mechanic isn't guaranteed — see §3, Firefox event pages were not verified against this exact behavior).

---

## 5. Cross-origin iframes

- Frame matching for content scripts is evaluated against **each frame's own URL**, not the top-level page's URL. `all_frames: true` injects the content script into every frame (including cross-origin iframes) whose own URL matches the `matches` pattern; a non-matching frame is skipped even if its parent page matched. `match_about_blank` extends matching to `about:blank` frames whose creator matched; `match_origin_as_fallback` extends it to `data:`/`blob:`/`filesystem:` frames by origin inheritance (and takes priority over `match_about_blank` when both are set). [CONFIRMED — https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts]
- **Practical implication:** to reach a YouTube embed served from `youtube-nocookie.com`, or a raw media frame under `*.googlevideo.com`, `matches`/`host_permissions` must explicitly list those embed domains. Permission for the parent page's origin (e.g. some third-party site embedding a YouTube player) does **not** extend into the iframe's own origin.
- **Top-frame ↔ cross-origin-child-frame messaging:** target a specific frame with `chrome.tabs.sendMessage(tabId, msg, {frameId})`; incoming messages carry `sender.frameId` (0 = top frame). Content scripts cannot enumerate sibling frames themselves, so the **service worker** resolves frame topology via `chrome.webNavigation.getAllFrames({tabId})` (requires the `"webNavigation"` permission), mapping frame URLs to frameIds, then relays: [CONFIRMED — https://developer.chrome.com/docs/extensions/reference/api/webNavigation, MDN tabs.sendMessage]

  ```js
  // service worker — resolve and relay
  async function relayToPlayerFrame(tabId, command) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const playerFrame = frames.find(f => /youtube-nocookie\.com|googlevideo\.com/.test(f.url));
    if (!playerFrame) return; // no matching frame -> likely a host_permissions gap, see below
    chrome.tabs.sendMessage(tabId, { channel: 'videosync-cmd', payload: command }, { frameId: playerFrame.frameId });
  }
  ```

  ```json
  { "manifest_version": 3, "permissions": ["webNavigation"] }
  ```

- If the embed domain isn't covered by `host_permissions`/`matches`, **no content script runs there at all** — there is no frameId to target and no messaging path; nothing raises an explicit error, the frame is simply silent. The fix is adding the domain to `host_permissions` (statically) or `optional_host_permissions` + `chrome.permissions.request()` at runtime (see §7).

---

## 6. Fullscreen overlay UI

- The Fullscreen API renders the fullscreen element in the browser's **top layer**, entirely outside normal document stacking contexts. A sibling overlay element cannot be shown above it via `z-index` at any value — this is a spec property, not a bug to work around with higher numbers. [CONFIRMED — https://developer.mozilla.org/en-US/docs/Web/API/Element/fullscreenchange_event, https://developer.mozilla.org/en-US/docs/Web/CSS/:fullscreen]
- **Standard fix:** listen for `fullscreenchange` on `document`, check `document.fullscreenElement`, and re-parent the overlay into it on entry, back to its original location on exit:

  ```js
  const overlay = document.querySelector('#videosync-overlay-host');
  let overlayOriginalParent = overlay.parentNode;
  let overlayOriginalNextSibling = overlay.nextSibling;

  document.addEventListener('fullscreenchange', () => {
    const fsEl = document.fullscreenElement;
    if (fsEl) {
      fsEl.appendChild(overlay);
    } else if (overlayOriginalParent) {
      overlayOriginalParent.insertBefore(overlay, overlayOriginalNextSibling);
    }
  });
  ```

- **Sites vary in which element actually goes fullscreen** — YouTube and Netflix fullscreen a player *wrapper* `<div>`, not the raw `<video>` element. The extension must read `document.fullscreenElement` dynamically at the moment of the event rather than hardcoding a selector, since the wrapper's class/id can change with site redesigns. [CONFIRMED via spec mechanics — https://developer.mozilla.org/en-US/docs/Web/API/Element/fullscreenchange_event; site-specific wrapper behavior — LIKELY, consistent with known YouTube/Netflix DOM structure]
- **Shadow DOM** (`element.attachShadow({mode: 'open'})`) is the standard isolation technique for injected overlay UI, in both directions: the host page's CSS cannot reach into the shadow tree to restyle your UI (a few inherited properties like `font`/`color` still cross the boundary unless explicitly reset, e.g. with `all: initial` on the shadow root's top-level element), and your UI's own CSS is scoped and cannot leak out to break the page. [CONFIRMED (shadow boundary mechanics) — standard Shadow DOM spec behavior; specific interaction with `::backdrop`/`:fullscreen` pseudo-elements on particular sites — **UNVERIFIED**, no direct source found confirming site-specific conflicts, though the top-layer isolation itself is spec-confirmed and shouldn't interact adversely with a shadow-hosted overlay appended as a plain DOM child of the fullscreen element]
- Known pitfall: `mode: 'closed'` shadow roots block the page (and, notably, some devtools/automation) from inspecting your overlay, which is good for CSS isolation but makes your own debugging harder — prefer `mode: 'open'` during development.

---

## 7. Store policy

- Chrome Web Store: a 2026 policy update (enforced from Aug 1, 2026) tightened data-use/disclosure requirements generally. [CONFIRMED — https://developer.chrome.com/blog/cws-policy-updates-2026] Separately and more directly relevant here, longstanding Chrome Web Store policy requires requesting the **narrowest permission set that accomplishes the extension's function**; `host_permissions: ["<all_urls>"]` draws elevated reviewer scrutiny and can be rejected if the reviewer judges it unjustified by the extension's actual behavior. [CONFIRMED — https://developer.chrome.com/docs/webstore/program-policies]
- MV3 bans remotely-fetched/executed code — all injected JS (including the MAIN-world player-control scripts in §1) must ship inside the packaged extension; fetching and `eval`-ing player-control logic from a sync-provider's own server at runtime is explicitly disallowed. This is directly relevant: **do not** design the sync server to push executable JS to the extension at runtime — only sync *data* (timestamps, play/pause events), never code. [CONFIRMED — https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code]
- **Recommended alternative to `<all_urls>`:** `optional_host_permissions` + runtime `chrome.permissions.request()`, combined with `activeTab` for the "sync whatever tab I click the button on" case:

  ```json
  {
    "permissions": ["activeTab", "storage", "webNavigation"],
    "host_permissions": [],
    "optional_host_permissions": ["https://*/*", "http://*/*"]
  }
  ```

  ```js
  // popup.js / options page — request the current site only, on explicit user action
  document.getElementById('enableSyncHere').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const origin = new URL(tab.url).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) chrome.tabs.reload(tab.id); // reload so content scripts now match
  });
  ```

- Mozilla AMO mirrors this stance: reviewers evaluate whether requested permissions are actually needed for stated functionality, and the documented alternative to `<all_urls>` is the same narrower-host, runtime-request pattern. [CONFIRMED — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions] Firefox additionally prompts users per-site via a permissions doorhanger even where `host_permissions` is set statically, so the runtime-request UX gap between the two browsers is smaller than on Chrome (§3).
- **Practical tension for this project:** a video-sync extension's core value proposition is "works on any OTT site the user picks," which pulls toward broad host access, while store policy pulls toward narrow/optional. The `optional_host_permissions` + per-site `chrome.permissions.request()` pattern resolves this cleanly — the user explicitly grants each new site the first time they try to sync on it, which is both policy-compliant and arguably better UX (no scary blanket permission at install time).

---

## Verdict: recommended extension architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Tab — arbitrary OTT site (e.g. netflix.com), granted via                  │
│ optional_host_permissions + chrome.permissions.request() (§7)             │
│                                                                             │
│  ┌───────────────────── MAIN world ─────────────────────┐                 │
│  │ main-world.js   world:"MAIN", document_start          │                 │
│  │  - direct access to page globals: movie_player,       │                 │
│  │    Netflix's player API, etc.                         │                 │
│  │  - NO chrome.* access                                 │                 │
│  │  - talks out only via window.postMessage(nonce) (§1)  │                 │
│  └───────────────────────────┬────────────────────────────┘               │
│                               │ postMessage (nonce-authenticated,          │
│                               │ event.source===window check)              │
│  ┌────────────────────────────▼─────────────────────────────┐            │
│  │ ISOLATED world (ordinary content script)                  │            │
│  │ isolated-bridge.js                                        │            │
│  │  - verifies nonce, relays MAIN world <-> chrome.runtime    │            │
│  │  - injects chat/status overlay into a Shadow DOM host      │            │
│  │    (attachShadow) for CSS isolation (§6)                   │            │
│  │  - fullscreenchange listener re-parents overlay into       │            │
│  │    document.fullscreenElement (§6)                         │            │
│  └────────────────────────────┬─────────────────────────────┘            │
│                               │ chrome.runtime.sendMessage/onMessage       │
│  ┌── cross-origin iframe (e.g. youtube-nocookie.com embed) ──┐            │
│  │ own instance of main-world.js + isolated-bridge.js          │           │
│  │ (all_frames:true; matches must list the embed domain, §5)   │           │
│  │ reached from top frame via                                  │           │
│  │ chrome.tabs.sendMessage(tabId, msg, {frameId}) (§5)          │           │
│  └───────────────────────────────────────────────────────────┘            │
└──────────────────────────────┬─────────────────────────────────────────────┘
                                │ chrome.runtime.sendMessage / onMessage
                                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Chrome: MV3 service worker (background.js, "type": "module")               │
│  - holds the persistent WebSocket to the sync server directly (§4)         │
│  - Chrome ≥116: exchanges a ping every ~20s so WS message activity keeps   │
│    the 30s idle timer reset (open-but-silent WS is NOT sufficient alone)   │
│  - chrome.alarms watchdog (~30-60s min period) reconnects if the SW was    │
│    recycled anyway (sleep/resume, OS throttling, etc.)                     │
│  - chrome.webNavigation.getAllFrames() resolves frameIds for iframe        │
│    targeting (§5)                                                          │
│  - relay hub: content-script command <-> sync-server JSON message          │
│    (never ships executable code over the WS — data only, §7)               │
│                                                                              │
│ Firefox: MV3 event-page background (background.scripts, no                 │
│  service_worker key) — same relay responsibilities, but the Chrome-116     │
│  WS-in-SW-idle-timer mechanic is Chrome-specific and unverified for        │
│  Firefox's event-page lifecycle (§3/§4); apply the same ping+alarm         │
│  defensive pattern rather than assuming Firefox is more forgiving.         │
└───────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                     Sync server (WebSocket, JSON messages only —
                     play/pause/seek timestamps, never executable code)
```

**No offscreen document in the primary design** — Chrome's own docs, verified directly (§4), document the WS-in-service-worker + ping pattern as the current (Chrome 116+) recommended approach, and `chrome.offscreen`'s `reasons` enum has no `WEBSOCKET` entry. Add an offscreen document only if profiling later shows the service worker is still being recycled mid-ping in practice (e.g. under aggressive OS power-saving) — treat it as a documented escape hatch, not a starting assumption.

**The single biggest residual risk:** the Chrome-116 keepalive is a *best-effort* mechanic (Chrome's own docs still say the SW "may" become inactive; the ping reduces but does not eliminate reconnect churn), and Firefox's equivalent guarantee was not found and could not be confirmed in this pass. The architecture above is deliberately defensive — ping *and* alarm watchdog *and* reconnect-on-wake logic in every consuming component — because no single mechanism on either browser was confirmed to guarantee zero WS drops.
