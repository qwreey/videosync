# Provider Player Control — Research

**Question under test:** does "just wire up `<video>` play/pause/seeked/timeupdate and set `video.currentTime`" work as a universal sync mechanism, or does it break per-provider?

**Short answer:** it works as a *baseline* on most providers (YouTube's own page, Laftel, and probably Disney+/Prime/Wavve/TVING's DOM layer), but it is **known to actively break Netflix** (player crashes/resets on raw `currentTime` writes), and even where it "works" there are real MSE-level failure modes (unbuffered seeks stall, `playbackRate` nudging is fragile, DRM/EME adds an indirection layer that changes nothing about DOM control but changes everything about buffering behavior around license renewal). Provider adapters are required; a single generic adapter is not sufficient as the only implementation, though it can be the default/fallback for "anything with an HTML5 video."

Confidence tags used throughout: **[CONFIRMED — source]**, **[LIKELY — reasoning/source]**, **[UNVERIFIED]**.

---

## Netflix

**Bottom line: raw `video.currentTime = X` does not reliably work and is documented to crash Netflix's player. A private/internal JS API is the established workaround, with UI-click simulation as a second, more resilient fallback for play/pause.**

- **[CONFIRMED — multiple independent sources]** The internal API pattern is real and has been used by multiple independent extensions/gists over several years:
  ```js
  const videoPlayer = netflix.appContext.state.playerApp.getAPI().videoPlayer;
  const sessionId = videoPlayer.getAllPlayerSessionIds()[0];
  const player = videoPlayer.getVideoPlayerBySessionId(sessionId);
  player.seek(343931);   // milliseconds
  player.play();
  player.pause();
  player.getCurrentTime();
  ```
  Sources: [Control Netflix Playback gist (JacobRBlomquist)](https://gist.github.com/JacobRBlomquist/5bf6b046334ed84bac030260a93567ba), [Netflix Seek gist (dannyid)](https://gist.github.com/dannyid/52775a76f2a8738334d3), [easysubs issue #31](https://github.com/Nitrino/easysubs/issues/31), [Through the Looking-Glass at Netflix](https://engelsjk.com/posts/through-the-looking-glass-at-netflix/), [netflixparty.js gist (ollybritton)](https://gist.github.com/ollybritton/3826013e3738fd69e05087fe223d3928).

- **[CONFIRMED — reasoning stated in source]** Extensions avoid raw `currentTime` on purpose. The JacobRBlomquist gist states this API "avoids the issue with **Netflix crashing** when trying to change the video element's currentTime property" directly. This is consistent with an MSE/EME player that keeps its own internal state machine synced to `SourceBuffer` ranges; a raw DOM seek desyncs that bookkeeping and the player reacts by erroring rather than gracefully re-buffering.

- **[CONFIRMED — real extension source]** A recovered Netflix-Party-style extension ([ollybritton gist](https://gist.github.com/ollybritton/3826013e3738fd69e05087fe223d3928)) uses `videoPlayer.seek()` for seeking, but for **play/pause does not use the internal API at all** — it simulates clicks on the real UI buttons: `jQuery('.button-nfplayerPause').click()`, `jQuery('.button-nfplayerPlay').click()`.

- **[CONFIRMED — real extension source]** [`LongDistanceNetflix`](https://raw.githubusercontent.com/gfiore88/LongDistanceNetflix/master/extension/player.js) goes further and avoids the internal API entirely: it *reads* `$('video')[0].currentTime`/`.duration` (read is fine), but *writes* only via simulated UI interaction (button clicks, scrubber drag events) — never `currentTime =` and never the internal seek API. This is independent confirmation that reading the video element is safe but writing to it directly is the risky operation.

- **[LIKELY — no DRM-level restriction found]** EME/Widevine does not block JS from reading/writing `currentTime` or calling `.play()`/`.pause()` — those are standard `HTMLMediaElement` members orthogonal to the CDM, which only decrypts sample data. The Netflix crash is a **player-application state desync**, not a DRM-enforced block. No source claims DRM itself prevents currentTime manipulation.

- **[CONFIRMED — moving target]** The internal API path has shifted historically: older code used `window.netflix.cadmium.objects.videoPlayer()`, which stopped working (per comment threads on the dannyid gist, circa 2016), and was superseded by the current `appContext.state.playerApp.getAPI().videoPlayer` + `getAllPlayerSessionIds()` pattern. **No fresh 2023–2026 confirmation was found** — treat current validity as **[UNVERIFIED]** and smoke-test against a live Netflix watch page before shipping; build a runtime feature-detect since Netflix can silently change this again.

- **[LIKELY — architecture inference]** `window.netflix` is not exposed to an isolated-world content script; injection must happen in **page (MAIN) world** (an injected `<script>` tag, or Manifest V3 `world: "MAIN"`), matching how easysubs and ollybritton's extension operate (message-passing between an injected page script and the isolated content script).

**Recommendation:** primary path = internal `videoPlayer` API for seek/getCurrentTime/getDuration, injected into MAIN world, with a runtime capability probe (the object graph is undocumented and has broken before). Fallback for play/pause (and as an overall fallback if the internal API disappears) = simulate clicks on `.button-nfplayerPlay` / `.button-nfplayerPause`. **Never write `video.currentTime` directly on Netflix.**

---

## YouTube

**Bottom line: on youtube.com itself (not an iframe embed), the page's own `#movie_player` element exposes the full YT.Player-style API, and it is reachable from a content script. But the most mature real-world extension (SponsorBlock) prefers raw `video.currentTime` writes for seeking over `movie_player.seekTo()`, while using `movie_player`'s API/events for state, ads, and player queries.**

Primary source used by the research agent: [SponsorBlock (`ajayyy/SponsorBlock`)](https://github.com/ajayyy/SponsorBlock) and its shared library [`ajayyy/maze-utils`](https://github.com/ajayyy/maze-utils) — a mature, widely deployed content script running directly on youtube.com watch pages.

- **[CONFIRMED — https://github.com/ajayyy/maze-utils/blob/master/src/injected/document.ts]** `document.getElementById("movie_player")` exposes `getPlayerState()`, `getCurrentTime()`, and custom events via `addEventListener('onAdStart', ...)` / `'onAdFinish'`. Also **[CONFIRMED — gist by Araxeus](https://gist.github.com/Araxeus/fc574d0f31ba71d62215c0873a7b048e)**: `$("#movie_player")` supports `getPlayerState()`, `playVideo()`, `pauseVideo()`, `getCurrentTime()`, `getDuration()`, `getVideoData()`, `getPlayerResponse()`, `onStateChange`/`onAdEnd` events.

- **[CONFIRMED — same maze-utils source]** SponsorBlock injects a script into the **page's own JS context**, not the isolated content-script world, specifically to reach `movie_player` reliably: *"Content scripts are run in an isolated DOM so it is not possible to access some key details that are sanitized when passed cross-dom... This script is used to get the details from the page and make them available for the content script by being injected directly into the page."* Full API reliability (custom ad events especially) needs page-context injection; basic calls may work from isolated world but this is the pattern real extensions use.

- **[CONFIRMED — https://github.com/ajayyy/maze-utils/blob/master/src/video.ts]** SponsorBlock's `setCurrentTime()` does **not** call `seekTo()` — it does `getVideo()!.currentTime = time + adDuration;`, a direct raw `<video>` write from the isolated content-script world. This is strong real-world evidence that direct `video.currentTime` assignment is reliable enough for production on YouTube's own page. **[LIKELY]** `seekTo()` is presumably avoided because it triggers YouTube's own buffering/quality-switch machinery, unwanted overhead for frame-accurate seeks.

- **[CONFIRMED — same source]** SPA navigation is handled via `document.addEventListener("yt-navigate-finish", refreshListeners)`, current and actively maintained (2024–2026 codebase). No `spfdone`/`yt-page-data-updated` listeners appear (those are legacy pre-Polymer). SponsorBlock re-resolves the `<video>` element after every navigation rather than caching it, and additionally runs a `MutationObserver` on `#movie_player .html5-video-container` (`setupVideoMutationListener`) to catch cases where the element changes without a clean nav event — implying `movie_player`/`video` are **not guaranteed stable** across in-SPA navigations. **[UNVERIFIED]** whether `movie_player` is literally destroyed/recreated vs. reused; the defensive re-query pattern is suggestive but not definitive proof either way.

- **[CONFIRMED — same source]** Ad state is tracked via `movie_player`'s own `onAdStart`/`onAdFinish` events (relayed to the content script via `postMessage`), not by polling `getPlayerState()` alone. **[LIKELY — dev.to/penge](https://dev.to/penge/chrome-extension-that-skips-youtube-ads-steps-how-to-create-it-3ibp)**: ad UI is also identifiable via classes like `ytp-ad-skip-button-text` / `ytp-ad-overlay-close-button`; a commenter notes `#movie_player` isn't always present (e.g., homepage), so a MutationObserver higher in the DOM is more robust for detecting when it appears. **[UNVERIFIED]** a literal `getAdState()` method or `.ad-showing` class on `.html5-video-player` — only secondary/AI-summarized claims were found, not a primary-source snippet.

**Recommendation:** read state and detect ads via `#movie_player`'s API/events (injected page-context script recommended for full reliability); write `currentTime`/play/pause directly on the `<video>` element (matches SponsorBlock's proven approach) rather than via `seekTo()`/`playVideo()`/`pauseVideo()`, to avoid triggering YouTube's own buffering churn. Re-resolve the video element and re-attach listeners on `yt-navigate-finish`, and don't assume the element instance survives navigation.

---

## Laftel (laftel.net)

**Bottom line: the only provider in this study with a primary-source, hands-on confirmation that a plain generic adapter works cleanly.**

- **[CONFIRMED — Korean dev blog, harimkim.com "라프텔 이어보기 기능 개선하기 (Feat. Tampermonkey)"](https://www.harimkim.com/articles/2.%20Area/%ED%94%84%EB%A1%9C%EA%B7%B8%EB%9E%98%EB%B0%8D/%ED%94%84%EB%A1%A0%ED%8A%B8%EC%97%94%EB%93%9C%20%EA%B0%9C%EB%B0%9C/%EB%9D%BC%ED%94%84%ED%85%94%20%EC%9D%B4%EC%96%B4%EB%B3%B4%EA%B8%B0%20%EA%B8%B0%EB%8A%A5%20%EA%B0%9C%EC%84%A0%ED%95%98%EA%B8%B0%20(Feat.%20Tampermonkey))** — A real userscript author live-tested Laftel's player in devtools: `document.querySelector('video')` returns the element directly, and both reading and writing `video.currentTime` "영상 조작이 순조롭게 잘 되네요" (works smoothly), unlike sites that gate playback through a proprietary jwplayer-style API. The author shipped a working "continue watching" fix built on exactly this behavior.

- **[UNVERIFIED — search-snippet only, Korean, https://help.laftel.net/hc/ko/articles/10080499940751]** Laftel's help center states content carries DRM and requires HDCP 2.2-capable displays. Direct fetch returned 403 so this is via a search-engine snippet, not a page read directly. This likely governs the mobile/TV/4K delivery path; it does not contradict the primary-source blog above showing `currentTime` is directly writable on the web player.

- **[CONFIRMED — Chrome Web Store + GitHub, e.g. https://github.com/2jun0/laftel-ad-autoskipper]** Multiple third-party extensions alter Laftel's skip interval and auto-skip ads/intros, corroborating that Laftel's playback surface is generically scriptable from an ordinary content script.

- **[UNVERIFIED]** Which player library (hls.js, shaka-player, native HLS, custom) Laftel uses under the hood — no source confirmed this either way. Given the DOM-level behavior is a plain `<video>` element with directly writable `currentTime` and no reported crashes, the underlying library choice appears not to matter for sync purposes.

**Recommendation:** generic adapter (raw `<video>` events + `currentTime` writes) should work as-is for Laftel. Still worth a live smoke test given the DRM/HDCP note, but no evidence suggests it will break the way Netflix does.

---

## Disney+ / Prime Video / Wavve / TVING (Korean OTTs) — brief

- **Disney+ (Korea):** **[CONFIRMED — Widevine partner list](https://www.widevine.com/solutions/widevine-drm)** Disney+ uses Widevine (EME/MSE), so segments are encrypted, but **[LIKELY]** DRM restricts decryption, not the `<video>` DOM surface — `currentTime`/`play()`/`pause()` are typically still directly controllable. Teleparty markets Disney+ support with the same generic, no-special-integration language it uses for most non-Netflix services (contrasted with the well-documented Netflix-specific handling). **[UNVERIFIED]** no source code confirming the exact mechanism was found; treat as needing a live smoke test, with Netflix-style special-casing budgeted as a fallback risk.

- **Amazon Prime Video:** **[CONFIRMED — https://www.teleparty.com/amazon-prime-video]** Teleparty officially supports Prime Video via a "TP" button injected into the player page, described as working automatically. **[CONFIRMED — Widevine partner list](https://www.widevine.com/solutions/widevine-drm)** Prime Video is also Widevine/EME, same DRM-doesn't-block-DOM-control caveat as Disney+. **[LIKELY]** generic, non-bespoke handling based on Teleparty's marketing tier language; **[UNVERIFIED]** no extension source code recovered to directly confirm.

- **Wavve (wavve.com):** **[LIKELY — Korean security-research blog series, blog.dork94.com, titles/snippets only — direct fetch failed with DNS error]** Wavve's catalog appears **mixed**: some titles via MPEG-DASH + Widevine DRM, others via plain HLS with **no DRM** (relying on forensic watermarking instead). If accurate, non-DRM titles should work with a fully generic adapter; DRM titles carry the same decryption-only caveat as Disney+/Prime. **[UNVERIFIED]** not independently confirmed beyond snippet-level evidence; treat with caution and verify per-title behavior live.

- **TVING (tving.com):** **[LIKELY — Korean Wikipedia's Widevine article lists TVING among Korean OTTs using Widevine DRM, alongside Netflix/Wavve/Watcha]** TVING uses Widevine (EME/MSE). Same architectural reasoning applies: `<video>` element likely standard and scriptable, decryption is the only gated layer. **[UNVERIFIED]** no watch-party extension or userscript targeting TVING specifically was found (unlike Laftel and the global services), so this is the least-verified of the five Korean/OTT services and should get its own live smoke test before shipping.

**Overall for this group:** architecturally, Widevine/EME DRM is expected to leave the DOM control surface (`currentTime`, `play`, `pause`, events) intact — the CDM only gates decryption of already-fetched, already-demuxed sample data. But this is inference from EME's design plus circumstantial "Teleparty just works" marketing, not primary-source confirmation for any of these four. **Do not assume parity with Netflix's failure mode, but do not assume safety either — smoke-test each with `document.querySelector('video').currentTime = x` in devtools before committing to a purely generic adapter.**

---

## General MSE gotchas

- **Seeking outside the buffered range does not throw — it stalls/rebuffers.** Per the HTML spec's seek algorithm, `readyState` drops below `HAVE_FUTURE_DATA` when the seek target isn't buffered, firing `waiting`; playback resumes (`canplay`/`playing`) only once enough data around the new position is fetched. **[CONFIRMED — MDN buffering/seeking guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/buffering_seeking_time_ranges)**. Empirically corroborated by Shaka Player's buffering-config docs and issue tracker (unbuffered seeks stall until `rebufferingGoal` seconds are fetched). **[LIKELY — https://shaka-player-demo.appspot.com/docs/api/tutorial-network-and-buffering-config.html, https://github.com/shaka-project/shaka-player/issues/3130]**

- **Event ordering on seek:** `seeking` fires first when the seek starts; if data isn't immediately available, `waiting` fires and `readyState` drops; `canplay`/`canplaythrough` may follow once buffered; `seeked` fires when the seek algorithm completes; `playing` fires if playback resumes. WHATWG explicitly tightened this ordering ("Make the events around seeking more predictable and reliable") to guarantee `seeking` always precedes other seek-related events. **[CONFIRMED — MDN `seeking` / `seeked` event docs](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seeking_event)** ([seeked](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seeked_event)); full algorithm at the [HTML spec's media seeking section](https://html.spec.whatwg.org/multipage/media.html#seeking).

- **Non-monotonic `currentTime`:** the MSE spec documents a case where removing an already-passed buffered range can leave `currentTime` outside the effectively playable/seekable range, independent of any script-driven seek — an open, spec-acknowledged edge case relevant to live/DASH-like streams. **[CONFIRMED — https://github.com/w3c/media-source/issues/291]**. DRM license renewal near expiry can also force a pause/stall unrelated to buffering. **[LIKELY — videojs-contrib-eme docs/issues](https://github.com/videojs/videojs-contrib-eme)**

- **`playbackRate` nudging for drift correction is a known but fragile technique.** Syncplay ships exactly this (slow down on minor desync, rewind on major desync) as an **optional, user-disableable** feature, and its own troubleshooting guide tells users to disable it and use a fixed manual rate if it misbehaves — direct evidence the technique is imperfect in practice and player-dependent. **[CONFIRMED — https://syncplay.pl/guide/trouble/, https://github.com/Syncplay/syncplay/discussions/443]**. Separately, Jellyfin/Syncplay issues show desync driven by transcoding/bitrate mismatches independent of rate control, meaning rate-nudging alone doesn't fix all drift sources. **[LIKELY — https://github.com/jellyfin/jellyfin-web/issues/6210, https://github.com/Syncplay/syncplay/issues/607]**. No primary-source (Google/Netflix engineering) statement was found confirming that YouTube/Netflix explicitly reset a script-set `playbackRate`, but a commonly reported failure mode in video-speed-controller extensions is that the underlying `<video>` element gets silently replaced on quality/seek transitions, discarding a previously-set rate. **[UNVERIFIED]** — treat as a real risk to guard against (re-apply rate after any element/quality transition) rather than a confirmed Netflix/YouTube-specific behavior.

**Implication for the sync design:** never blind-seek to a target and assume immediate correctness — always wait for `seeked` (and be ready to further wait through `waiting`→`playing` if the target wasn't buffered). Treat `playbackRate` nudging as a best-effort, small-drift-only technique with a hard cap (e.g. ±2–5%) and a fallback to a hard seek beyond some drift threshold, and make it disable-able per the Syncplay precedent.

---

## Autoplay policy

- **Chrome (current):** muted autoplay is always allowed. Unmuted autoplay via `play()` requires one of: prior user interaction with the domain, a sufficiently high desktop Media Engagement Index (MEI) score, the page running as an installed PWA/home-screen app, or top-frame permission delegation to an iframe. **[CONFIRMED — https://developer.chrome.com/blog/autoplay]**

- **Media Engagement Index (MEI):** a per-site score Chrome computes from "significant playback" signals (playback >7s, audio unmuted, tab active/visible, video ≥200×140px). Once high enough, Chrome allows unmuted autoplay on later visits to that site — meaning a site the user watches often on their own account (their Netflix/Laftel login) plausibly does get unmuted-autoplay privileges over time. There is **no content-script-readable API** for the current MEI score (only inspectable manually at `chrome://media-engagement/`); the practical approach is try `play()` and handle the rejected-promise case. **[CONFIRMED — https://developer.chrome.com/blog/autoplay, https://docs.theoplayer.com/faq/17-how-does-mei-affect-autoplay-on-chrome.md/]**

- **Firefox (current):** blocks audible autoplay by default unless the content is muted, the user previously interacted with the site, the site is on an allowlist, or an iframe was granted permission via Permissions Policy; governed by `media.autoplay.default` (0=allow, 1=block audible, 5=block all) and related `about:config` prefs. **[LIKELY — https://support.mozilla.org/en-US/kb/block-autoplay]** (pref numeric values sourced from community docs, not independently re-confirmed against current Mozilla source).

- **Rejected `play()`:** returns a Promise that rejects with a `NotAllowedError` `DOMException`. Standard, spec-aligned guidance (Chrome and MDN) is to never assume playback started — always `.catch()` the promise. **[CONFIRMED — https://developer.chrome.com/blog/autoplay, https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play]**

**Implication for the sync design:** when a remote play command arrives in a tab that has no recent user gesture and low MEI, `play()` can legitimately fail. The fallback UX must be a visible "click to sync / resume" overlay that captures the required user gesture and retries `play()` inside the click handler — this is the standard, spec-compliant pattern, not a workaround to route around.

---

## Verdict: what the adapter interface must expose

The naive "generic HTML5 video adapter" is necessary but not sufficient. It should be the **default/fallback implementation** ("anything with an HTML5 video"), with per-provider adapters overriding specific capabilities where the generic approach is known to fail (Netflix) or is unverified (Disney+/Prime/Wavve/TVING). The interface needs to abstract not just "get/set time and play state" but *how* a seek/play/pause is issued (raw DOM vs internal API vs simulated UI click), whether writes need confirmation via events before being trusted, and how autoplay rejection is surfaced back to the sync engine.

```typescript
/** Capability flags an adapter reports so the sync engine can adapt its strategy per provider. */
interface ProviderCapabilities {
  /** Direct `video.currentTime = x` writes are safe (false for Netflix). */
  supportsDirectSeek: boolean;
  /** Direct `video.play()`/`.pause()` calls are safe/reliable (false where UI-click simulation is required). */
  supportsDirectPlayPause: boolean;
  /** Adapter can report an ad is currently playing; sync engine should suppress seek/play/pause commands during ads. */
  supportsAdDetection: boolean;
  /** Small drift correction via playbackRate nudging is safe to attempt on this provider. */
  supportsPlaybackRateNudge: boolean;
  /** The underlying <video> element / player instance may be replaced without a full page navigation (SPA nav, ad transition, quality switch) — adapter must re-resolve rather than cache. */
  volatileVideoElement: boolean;
}

/** One adapter instance is bound to the page's current player for its lifetime; sync engine re-creates/rebinds it on navigation. */
interface ProviderAdapter {
  readonly providerId: "netflix" | "youtube" | "laftel" | "disneyplus" | "primevideo" | "wavve" | "tving" | "generic";
  readonly capabilities: ProviderCapabilities;

  /** Resolves once the player is present and ready to query/control on the current page. Re-invoked after SPA navigation. */
  attach(): Promise<void>;
  /** Tears down listeners/injected scripts when leaving the page or provider. */
  detach(): void;

  // --- Reads (always safe per findings — DRM/EME does not block reading DOM media state) ---
  getCurrentTime(): number;             // seconds
  getDuration(): number | null;
  getPlaybackState(): "playing" | "paused" | "buffering" | "ad" | "unknown";
  isAdPlaying(): boolean;

  // --- Writes (routed through provider-specific strategy internally: raw DOM, internal API, or simulated UI click) ---
  /** Resolves only after a `seeked` event (or provider-equivalent) confirms the seek landed — never assume synchronous success. */
  seekTo(seconds: number): Promise<void>;
  /** Rejects with a typed AutoplayBlockedError if play() is rejected due to missing user gesture / low MEI — sync engine must show a "click to sync" overlay and retry inside the resulting click handler. */
  play(): Promise<void>;
  pause(): Promise<void>;
  /** No-op / rejects if !capabilities.supportsPlaybackRateNudge. Sync engine caps nudges (e.g. ±2–5%) and falls back to a hard seekTo beyond a drift threshold. */
  setPlaybackRateNudge(rate: number): Promise<void>;

  // --- Events the sync engine subscribes to (adapter normalizes provider-specific event sources into these) ---
  onTimeUpdate(cb: (seconds: number) => void): () => void;   // unsubscribe fn
  onPlay(cb: () => void): () => void;
  onPause(cb: () => void): () => void;
  onSeeked(cb: (seconds: number) => void): () => void;
  onWaiting(cb: () => void): () => void;   // buffering started — suppress drift-correction commands while true
  onAdStateChange(cb: (isAd: boolean) => void): () => void;
  /** Fires when the underlying <video>/player instance is replaced (SPA nav, quality switch, ad transition) — sync engine must re-arm any pending rate nudge / re-check readiness. */
  onPlayerReplaced(cb: () => void): () => void;
}

class AutoplayBlockedError extends Error {
  readonly name = "AutoplayBlockedError";
}
```

**Justification, tied to findings:**
- `supportsDirectSeek`/`supportsDirectPlayPause` exist because Netflix is confirmed to crash on raw `currentTime` writes and real extensions route seeks through an internal API and play/pause through simulated UI clicks — a capability-flagged adapter lets the sync engine (and the generic fallback) share one call surface while the Netflix adapter swaps the underlying mechanism.
- `seekTo()`/`play()`/`pause()` return Promises resolved only on confirming events, because MSE seeks to unbuffered ranges stall rather than complete synchronously, and the spec's `seeking`→`waiting`→`seeked`→`playing` ordering is the only reliable completion signal.
- `AutoplayBlockedError` and the "click to sync" contract exist because `play()` legitimately rejects with `NotAllowedError` absent a user gesture or sufficient MEI, and the standard fix is a manual-gesture overlay, not a workaround.
- `isAdPlaying()`/`onAdStateChange` exist because YouTube (and presumably other ad-supported/ad-interstitial providers) has a distinct ad-playing state where sync commands should be suppressed (per SponsorBlock's `onAdStart`/`onAdFinish` handling).
- `onPlayerReplaced` and `volatileVideoElement` exist because YouTube's own extension ecosystem (SponsorBlock) defensively re-resolves the video element after every SPA navigation rather than caching it, and generic video-speed-controller experience suggests rate/state can be silently dropped when the element is swapped.
- `setPlaybackRateNudge` is capability-gated and capped because Syncplay — the closest prior art — ships this as an optional, disableable feature precisely because it is fragile across different players/streams.
