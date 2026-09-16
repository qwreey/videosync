# C1 research: initial state, newly found `<video>` elements, and next episode

## 0. Scope and how much to trust each part

- **Read:** `docs/STATE.md`, `docs/PROTOCOL.md` §2–§4, `docs/BROWSER-FINDINGS.md` §3, §5 and §12–§19, `client/core/src/{engine/engine.ts, detector/detector.ts, detector/types.ts, app/bootstrap.ts, adapter/{resolve,swappable,html5,types,mediakey}.ts}`, `server/internal/room/{room.go,messages.go}` (the media-command parts only), `research/*.md`, and the probe results in `harness/browser/results/`.
- **Reference code:** `refs/` does not exist in the working tree. I re-cloned 7 references plus a sparse `jellyfin-web` checkout (`--depth=1`, HEAD on 2026-09-17) into the scratchpad `/tmp/claude-1000/-home-yaeji-Projects-videosync/a6588961-2997-471a-ab26-fd8e8debebc8/scratchpad/refs/`. Nothing in the repository was modified. `file:line` citations below point at those clones, so they may differ from line numbers in `research/*.md`, which were taken from older clones.
- **Evidence tags used throughout:**
  - **[SPEC]:** quoted from WHATWG HTML or W3C Media Session, fetched today.
  - **[CODE]:** derived by reading VideoSync or reference source. Nothing here was run.
  - **[MEASURED]:** a number already recorded in `BROWSER-FINDINGS`.
  - **[UNMEASURED]:** a belief no probe has checked yet. Section 5 is the plan to check these.
- **Constraint check:** nothing proposed needs a Go dependency. The one protocol addition (§3.4) is a field plus a comparison in `room.go`.

---

## 1. What the code does today

### 1.1 How a play/pause/seek becomes a command

- **Play/pause.** `SeekDetector.evaluate` reports `playstate` only when `lastPaused !== null && lastPaused !== s.paused` (`detector.ts:196-199`). After construction or `reset()`, `lastPaused` is `null` (`detector.ts:234-241`), so the first evaluation only records a baseline and reports nothing.
- **Seek.** A seek needs both diffs to exceed 1000 ms (`jumped`, `detector.ts:152-154`), and it needs `expectedMs !== null`, i.e. a settled clock.
- **Sending.** `SyncEngine.evaluate` sends a `playstate` as `play`/`pause` whenever it disagrees with the anchor and with any in-flight applied transition (`engine.ts:1044-1048`). That branch has **no `clock.ready` check**; it needs only `status === 'joined'` (`engine.ts:1006`) and `onRoomMedia()`.
- **Holding.** A sent `play` triggers `holdForRoom()` in rooms of two or more (`engine.ts:1048`, `1159-1178`). The member is re-paused, and **the whole room** starts at `when`.
- **Nothing asks where a transition came from.** The engine never checks whether the user, the site, or the browser caused it. The only non-user source it recognises is Chrome's background pause (`detector.ts:82-109`).

### 1.2 The concrete C1 paths [CODE, not reproduced]

**Path A – a joiner whose site autoplays** (the room is paused).
1. `welcome` arrives → `joined` (`engine.ts:642-653`).
2. The first evaluation sets `lastPaused = true` if the element has not started yet.
3. The site calls `play()` once metadata or its own player is ready. `play()` fires `play` [SPEC], the adapter triggers an evaluation (`engine.ts:437-438`), and the detector reports `playstate paused:false`.
4. The engine sends `play`, holds, and **everyone starts**.
- This is the likely shape of `followRoom`'s arrival: the page rejoins 0.3–0.4 s after load (§18 [MEASURED]), and a site's autoplay typically comes later than that.
- Whether Laftel or YouTube autoplay on arrival is [UNMEASURED]. Every live probe so far ran with `--autoplay-policy=no-user-gesture-required` (§14 "Not covered", `probe-youtube.mjs:74`).

**Path B – a joiner whose site resumes from watch history.**
- The site writes `currentTime = saved` shortly after load.
- Before the clock settles, `jumped` is false, and `lastKnownPos` stays at the old baseline (only dead-reckoned, `detector.ts:186-190`). The jump is therefore still pending when the clock becomes ready.
- The first evaluation after that sees both diffs large and **sends `seek` to the member's own history position**. The room is dragged there.

**Path C – the creator.**
- `pendingAdopt` fires on the first evaluation after the clock settles (`engine.ts:1021-1024`), typically ~250 ms after joining.
- If the site's resume-seek or autoplay has not happened yet, the room is seeded with the pre-resume state (often `paused@0`). The site's later moves then arrive as ordinary `seek`/`play` commands.
- The end result is roughly right for a creator, but it takes two or three extra commands, and one of them is a `seek` the room applies to everyone.

**Path D – same element, new `src` (next episode) before the URL change is noticed.**
- The HTML load algorithm, run whenever `src` changes (including a new MSE `blob:` URL), does four things [SPEC]:
  - queues `abort` and `emptied`;
  - sets `paused` to true **without firing `pause`**;
  - sets the current position to 0;
  - sets `playbackRate` to `defaultPlaybackRate`.
- `PageWatcher` notices a `pushState` only on a DOM mutation or the 1 s poll (`resolve.ts:116`, `122-127`).
- In that window the engine still believes it is on the room's media. It sees a jump from about `duration` to 0, both diffs large, and **sends `seek 0` for the old episode**. The site's autoplay of the new episode then **sends `play`**.
- Every other member is rewound to the start of the episode they just finished.

**Path E – the element is removed before its replacement is inserted.**
- A removed media element runs the internal pause steps, which queue `pause` [SPEC].
- If the MutationObserver callback sees no `<video>` at all, `onChange(null)` calls `adapter.setTarget(null)`.
- `SwappableAdapter.setTarget` **returns before firing `elementreplaced`** when `next` is null (`swappable.ts:46`). The detector is therefore not reset.
- `readState()` now returns `ABSENT` (`positionS: 0, paused: true, readyState: 0`, `swappable.ts:6-9`). `readyState 0` puts the detector in its stall branch, where `lo − pos` is the full playback position, so it reports `seek` → **the engine sends `seek 0`**.
- Whether any real site removes before it inserts in a separate task is [UNMEASURED]. React usually commits both in one task. The code path exists regardless.

**Path F – a new element for the same media** (for example a player rebuild).
- `elementreplaced` resets the detector and conforms the element to the room (`engine.ts:439-457`). That is correct as far as it goes.
- The site's later autoplay on that element is then Path A again. STATE.md already lists "An element swap resets the detector, so a play pressed on the newly picked element is not broadcast". That is the opposite failure, caused by the same missing concept: nothing knows whether a transition on a new element came from the user.

**Path G – end of media.**
- At the end the element sets `paused = true` and fires `pause`, then `ended`, in the same task [SPEC]. `el.ended` is already true when the `pause` handler runs.
- `PlayerState` has no `ended` field (`types.ts:53-72`), so this is broadcast as a user pause. The first member to finish pauses the room at its own end position. A member ~100 ms behind is paused just short of the end, never reaches `ended`, and a site that advances on `ended` never advances for them.
- Syncplay handles this case specially (§2).

**Side finding [SPEC vs CODE].** `engine.ts:1098-1101` says "a site that reuses its `<video>` element keeps its playbackRate". The load algorithm resets `playbackRate` to `defaultPlaybackRate` on every `src` change. On a real site `rateWeSet` goes stale after a `src` change unless the site re-applies the rate itself. [UNMEASURED]

---

## 2. How the references handle this

None of the nine uses `isTrusted` or `navigator.userActivation`; a grep over all clones found no hits. Each uses one of five strategies.

| Reference | Initial state / autoplay | New media / next episode | Evidence |
|---|---|---|---|
| **OpenTogetherTube** | **Never trusts the element.** A `playing`/`paused` event only re-applies the store's state. Intent comes only from the room's own UI (`roomapi.play()`). | Server-timed: the server itself dequeues when its clock passes `length` | `client/src/views/Room.vue:616-628` (onPlaybackChange → applyIsPlaying), `:585-605`, `:566-572`; `server/room.ts:745-757`; `DirectPlayer.vue:324-327` calls `play()` after `load()` itself |
| **Jellyfin SyncPlay (web)** | **Neutralise, then report ready.** On every new item it waits for the player's `playbackstart`, calls `localPause()`, then sends `Ready{PositionTicks, IsPlaying}`. The server decides when the group resumes. The start position is estimated from the last command. | `NextItem` is a **group request**. The player's own `nextTrack` is overridden to send the request instead of acting locally. The group enters `Waiting` and resumes when everyone is ready. | `src/plugins/syncPlay/core/QueueCore.js:169-194`, `:203-240`, `:58-76`; `ui/players/NoActivePlayer.js:54,72,296-299`; server side in `research/jellyfin-syncplay.md:222-236` |
| **Syncplay** | **The first global update is imposed** (`_initPlayerState`). Player updates are not sent before the first global update. A pause/play counts only if it differs from both the player's and the room's last state. | A pause within 5 s of EOF is **not broadcast**; it advances the shared playlist. **Timer windows:** for `AUTOPLAY_DELAY+5` s after an advance and 5 s after a rewind, local changes send the *global* state back instead. A seek over 5 s within 1 s of a rewind is ignored. | `syncplay/client.py:374-379`, `452-457`, `270-283`, `218-223`, `256-260`, `311-326`, `227-238`, `866-872`; `constants.py:46-47,90`; playlist `client.py:2192-2215` |
| **SyncTube** | **A gesture-window heuristic:** a `click` on the player container sets `inUserInteraction` for 350 ms ("Chrome has ~300ms event delay"). A non-leader's play is honoured only inside that window; otherwise the player is paused back. | Server gating: the next video starts when all clients report `VideoLoaded`, or after `VIDEO_START_MAX_DELAY` = 3 s | `src/client/Player.hx:76-80`, `329-363`; `src/client/Main.hx:143`; `src/server/Main.hx:41`, `845-848`, `1357-1374` |
| **watchparty** | No handling. | **Idempotent advance:** `CMD:playlistNext(url)` carries the URL that just ended, and the server ignores it if the room has already moved. **Stale-timestamp guard:** a 1 s `preventTSUpdate` window after a video change drops late timestamps from the old video (a timer). | `server/room.ts:670-686`, `540-548`, `805-812`; `src/components/App/App.tsx:1961-1971` |
| **CyTube** | Only the leader's state changes are sent. Includes a workaround for pausing before the first PLAYING event. | The leader alone emits `playNext` on ENDED. | `player/youtube.coffee:41-56` (same pattern in `dailymotion`, `videojs`, `twitch`, …) |
| **VideoTogether** | The host pushes whatever its element reports, autoplay included. Members are fully slaved each tick (1 s throttle). The authors noticed the problem ("maybe we need to check if the event is activated by user interaction") and did not solve it. | **Follow the host:** the room carries the host's URL, and a member whose URL differs jumps to it. | `source/extension/vt.js:2850-2856`, `3125-3151`, `3169-3193`, `3457-3528`; the `activatedVideo` branch is dead code at `3258-3265` |
| **syncwatch** | Every trusted `playing` is broadcast as `play`. No join-time state: the server stores only the shared URL. The echo flag is the known deadlock (`content.ts:87-104`). | Nothing. | `packages/syncwatch-extension/entrypoints/content.ts:12,56-76,197-204`; `packages/syncwatch-server/server.ts:155-169` |
| **watchbear** | No source ([CRX]); nothing re-derivable. | – | – |

What carries over to VideoSync:

1. **Jellyfin's "neutralise on acquisition, then report"** is the closest match to what the user asked for, and it fits VideoSync's "the anchor is truth" rule.
2. **Syncplay's EOF rule** fixes Path G. Its timer windows are the kind of timer CLAUDE.md warns against; avoid copying them.
3. **SyncTube's gesture window** is the only prior art for recognising intent, and it is a bare timer on `click`. It is weaker than what browsers now expose (§3.2).
4. **watchparty's `playlistNext(url)`** is compare-and-set on the current media: the idempotency a next-episode race needs.
5. **OTT's "never trust the element"** does not transfer: VideoSync has no UI of its own for play/pause; the site's controls are the controls.

---

## 3. Browser signals

### 3.1 What exists

| Signal | What it tells us | Usable? |
|---|---|---|
| `Event.isTrusted` on `play`/`pause`/`seeked` | Media events are fired by the browser whether a user or a script caused them. `isTrusted` is false only for `dispatchEvent` from script, which changes no element state. [SPEC: media events are queued by the browser; DOM `isTrusted`] | **No.** It cannot separate user from site. |
| `isTrusted` on **input** events | An activation-triggering input event is, by definition, `isTrusted` and one of: `keydown` (not Esc, not a browser-reserved shortcut), `mousedown`, `pointerdown` (mouse), `pointerup` (non-mouse), `touchend`. [SPEC, HTML §6.4.2] | **Yes**, as gesture evidence, with capture-phase listeners on `window`. |
| `navigator.userActivation.isActive` | Transient activation: true for a browser-defined duration after the last activation. Chromium's `kActivationLifespan` is 5 s. Firefox also ~5 s [UNMEASURED here]. Consumed by some APIs, **including `requestFullscreen()` and `window.open()`**. [SPEC; MDN] | **Partly.** True for 5 s after *any* click, including the click on "next episode". Fullscreen, e.g. a double-click on the YouTube player, consumes it. Useful mainly for its **false→true edge with no input event**; see media keys below. |
| `navigator.userActivation.hasBeenActive` | Sticky activation. Survives SPA navigation because the Document persists. [SPEC] | **No** for intent. It explains why a site's autoplay succeeds after the first click: MDN lists media autoplay as sticky-activation-gated. |
| `play()` rejection | `NotAllowedError` is returned **before any state change**, so a refused site autoplay fires no `play`. [SPEC: play() step 1] | A refused autoplay never reaches the detector. Only *allowed* autoplay is a C1 problem. |
| `play` vs `playing` | `play` fires when `paused` becomes false. `playing` fires when data allows playback: at `readyState ≥ 3`, or later through the ready-state transitions. The `autoplay` attribute sets `paused = false` and fires `play` only when `readyState` reaches HAVE_ENOUGH_DATA (or on viewport entry). [SPEC] | Attribute autoplay arrives **after `canplaythrough`**, which is a useful anchor for "startup done". Script autoplay can come at any time. |
| Load algorithm on `src` change | Order: `abort` (if loading/idle) → `emptied` (if the network state was not empty) → **silently** `paused = true`, position 0, `playbackRate = defaultPlaybackRate`, duration NaN with no `durationchange` → **media events still queued for the old resource are discarded** → `loadstart` → `durationchange` → `loadedmetadata` → `loadeddata` → `canplay` → `canplaythrough` → (`play` → `playing`). [SPEC] | **`emptied` and `loadstart` mark a change of media on the element itself**, independent of the URL. The adapter listens to neither today (`html5.ts:6-8`). |
| New element | `networkState` starts EMPTY, so no `emptied`/`abort`: `loadstart` → … as above. The **removed** element runs the internal pause steps → `timeupdate` + `pause` after a stable state. [SPEC] | Explains Path E. The old element's `pause` must never be judged. |
| End of media | `timeupdate`, then (if not paused) `paused = true` + **`pause`**, then **`ended`**, all in one task. [SPEC] | `el.ended` is true inside the `pause` handler, so a pause caused by reaching the end is identifiable. |
| Media Session actions | Per spec the browser runs the page's action handler, **then runs the activation-notification steps**. A joint play/pause key maps to play or pause from the session's actual state. The browser should provide a default play/pause handler when the page sets none. [SPEC, W3C mediasession "handle media session action"] | A media-key play (Linux MPRIS, headset, OS overlay, PiP) comes with **no page input event** but probably an activation edge. Whether Chromium activates on its **default** handler, and whether `isActive` is already true when the resulting `play` event fires, is [UNMEASURED]. |
| Navigation API (`navigation` `navigate`/`currententrychange`) | Fires on SPA `pushState`/`replaceState` without patching `history`. | Could trigger `PageWatcher.check` immediately instead of waiting up to 1 s. Availability in Firefox and in an isolated world is [UNMEASURED]. |

### 3.2 What follows for recognising intent

- **No single signal proves user intent.** The best available evidence is "a trusted activation-triggering input happened shortly before the transition", plus "an activation edge with no input event" for media keys.
- **Both have holes:**
  - A click on the "next episode" link is an input shortly before that episode's autoplay.
  - A site may delay a click: YouTube starts playback ~200 ms later on click than on Space (§17 [MEASURED]).
  - Synthetic events dispatched by a site carry no activation (§16 notes this for the probe's own synthetic presses).
- **So gesture evidence must not be required everywhere.** Requiring it only inside a bounded "untrusted" window (§4) keeps its false negatives small. A missed gesture means the element is put back to the room's state and the user presses again, which is visible and recoverable. A missed site autoplay, by contrast, starts the whole room.

---

## 4. Proposal

### 4.1 Separate "which media" from "which element"

Add a **media epoch**, a counter in the engine that is bumped by any of:

1. `elementreplaced`. Also fire it (or a new `elementlost`) when `setTarget(null)` runs; this closes Path E.
2. **`emptied` or `loadstart` on the current element.** These are new `AdapterEvent`s emitted by `Html5Adapter`. This closes Path D without depending on URL timing.
3. `setLocalMediaKey` with a changed key (today's `detector.reset()` site).
4. Later: an ad adapter's "ad started/ended". It is the same concept, and it would address the "Ads" gap in STATE.md.

On a new epoch, before anything else, the detector is reset **and** the engine enters `ACQUIRING`. Both happen synchronously, inside the event handler that bumped the epoch.

`PlayerState` gains `ended: boolean` (Path G) and, optionally, an `epoch`/`srcToken` so that a sample taken across a `src` change can be discarded.

### 4.2 The acquisition state machine

Per session, per epoch:

```
             new epoch (any source above)
                      │
                      ▼
   ┌────────────── DETACHED ◄──────────── element lost / key ≠ room / not joined
   │  no element, or readyState 0, or hidden tab (§5b: media never loads)
   │  reports: suspended=true (absent)   commands: none
   │                      │ element present ∧ readyState ≥ HAVE_METADATA
   │                      │ ∧ duration known ∧ clock.ready ∧ onRoomMedia
   │                      ▼
   │                 CONFORMING
   │  one serialised applyTransition(expected(anchor), anchor.paused)
   │  reports: suspended=true   commands: gestured only (see 4.3)
   │                      │ that transition resolved (seeked + pause/play settled)
   │                      ▼
   │                  GUARDED   ◄─────────────┐
   │  player agrees with the room             │ un-gestured deviation:
   │  reports: normal (judged, gate-able)     │ re-conform (count siteMovesAbsorbed);
   │  un-gestured play/pause/seek → re-conform ┘ K-th re-conform in this epoch → FOUGHT
   │  gestured observation → send (existing path) → STEADY
   │                      │ end condition (4.4)
   │                      ▼
   └──────────────────► STEADY   (today's behaviour, unchanged)

   FOUGHT: the site keeps overriding the room (K = 3). Stop fighting; report
   suspended=true; panel says "this player keeps changing on its own".
   Leave on a gesture (→ STEADY) or on a new epoch.
```

Notes:

- **Detector baseline.** In `DETACHED`/`CONFORMING` the detector runs only to keep its baseline. Its observations are *classified* rather than dropped: gestured ones are sent, un-gestured ones are ignored until `GUARDED` can re-conform. The baseline is re-established by `rebaseline()` at the end of the conform step, which already happens (`engine.ts:869-874`).
- **Joiners** get `CONFORMING` on the `welcome`'s anchor as soon as the clock is ready. Today they wait for the reconciler (3 s) or a server seek. This is Jellyfin's "localPause on playbackstart", except that it conforms to the room's state instead of always pausing.
- **The creator** (`adoptLocalStateOnJoin`) gets an `ADOPT` policy instead of `CONFORMING`:
  - no conform step;
  - `GUARDED` lets un-gestured changes happen without sending them (the site is setting up the creator's own player);
  - `adoptLocalState` fires **at the `STEADY` transition**, not on the first evaluation after the clock settles (`engine.ts:1021`).
  - This removes the extra `seek` and `play` of Path C.
- **The reconciler** (`engine.ts:1060-1079`) is inactive outside `STEADY`, because `GUARDED` re-conforms immediately. It keeps its job in `STEADY`.
- **Nothing here is a suppression flag.** State only decides how an observation is *classified*. Every exit from `GUARDED` is either an observable condition or the backstop in 4.4, and the backstop leads to `STEADY`, which is today's behaviour. It cannot deadlock the way syncwatch's flag does (CLAUDE.md trap).

### 4.3 Recognising user intent while the window is open

- **Gesture evidence.** Put this in the shared app layer, not in `core/engine`, and inject it as `EngineDeps.lastGesture(): {at, kind} | null`. The engine stays DOM-free.
  - Capture-phase, passive listeners on `window` for `pointerdown` (mouse), `pointerup` (non-mouse), `touchend` and `keydown`, trusted events only. Excluding Escape and bare modifiers mirrors the spec's list.
  - Record `performance.now()` and the kind.
  - Record nothing else: no key codes, no targets. That keeps it privacy-neutral.
- **Media-key evidence.** Sample `navigator.userActivation.isActive` on each evaluation (10 Hz) and in each media-event handler. An **edge false→true with no input recorded in the last G ms** counts as a gesture of kind `activation`. [UNMEASURED: whether the edge exists and is visible from the isolated world; see probe M3/M4.]
- **The rule inside `CONFORMING`/`GUARDED`.** An observation is intent iff a gesture was recorded within `G` ms before the observation, or within the same evaluation for an `activation` edge.
  - `G` is a latency bound between a gesture and its effect, not a guess at "how long the site takes". Start it from measurement: YouTube's click delay (~200–300 ms, §17 plus SyncTube's comment) plus a margin. Proposed initial value: 600 ms, to be replaced by the probe's distribution.
- **Why this does not misfire on "next episode" clicks.** A click on a next-episode link comes *before* the epoch starts. The epoch bump resets the evaluation, and the autoplay follows `loadstart`/`canplay`, typically more than G after the click [UNMEASURED; probe L2/Y1 measures exactly this gap]. If the gap turns out to be shorter than G on some site:
  - require the gesture to be **after** the epoch began, since a gesture before `emptied`/`loadstart` belongs to the navigation and not to the new media;
  - then ignore `isActive` entirely for the first play of an epoch unless an input was seen after `loadstart`.
- **Keyboard shortcuts** (Space, `k`) are trusted `keydown` events, so they count.
- **Synthetic presses from a site's own remote-control features** have no activation and are treated as the site's own. That is correct.

### 4.4 What ends the untrusted window

Exits to `STEADY`, in priority order, with conditions rather than timers where one exists:

1. **A gestured observation.** The user has taken control. It is sent through today's path, including `holdForRoom`.
2. **Startup has finished,** meaning *all* of:
   - the epoch has reached `readyState ≥ HAVE_FUTURE_DATA` **at the room's position**, i.e. after the conform seek;
   - `canplaythrough` has fired for this epoch, the last point at which the spec's attribute autoplay runs;
   - and either:
     - (a) the site has made its autonomous move and it was absorbed: for a paused room, a `play` then re-pause; for a resume, a seek then re-seek; **or**
     - (b) for a **playing** room, the element has advanced in agreement with the anchor. After that point a site pause is indistinguishable from a user pause except by gesture, and today's behaviour is the right default.
3. **Backstop for a paused room where the site never moves.** Leave `GUARDED` after `T_settle` **measured from `canplaythrough`**, not from acquisition. Set `T_settle` from the probe: the maximum observed delay between `readyState 4` and a site's first autonomous move on Laftel and YouTube, plus a margin.
   - This is the one timer. Exceeding it degrades to today's behaviour. Being too long only means a media-key press in that window is put back once.
   - A hidden tab never reaches this point because its media does not load (§5b), which is correct: it stays `DETACHED`/absent.

### 4.5 Next episode and the room

Today navigation never moves the room (`bootstrap.ts:268-290`), and the reason still holds: without a host, an accidental navigation must not drag everyone along. Recommended changes:

1. **The end of media is not a pause command** (Path G, Syncplay's EOF rule).
   - If `observation.paused && state.ended`, do not send `pause`. The member reports `finished` (absent, with a new `finished: true` bit or just `suspended: true`).
   - Each member reaches its own end at the room's time, and nobody is pulled back 100 ms short of `ended`.
   - If the room anchor keeps running past `duration`, `expectedAt` exceeds the duration. `landsAt` already clamps that (`engine.ts:270-273`).

2. **Automatic continuation, narrowly.** A member's own navigation sends `media` automatically only when **all** of these hold:
   - (a) the previous epoch was on the room's media and ended: `ended` was seen, **or** the position was within `endWindow` of `duration` while the room was playing, which covers credits-countdown players that navigate before `ended` [UNMEASURED for Laftel];
   - (b) no gesture after the epoch began, or a gesture — both are allowed, because (c) is what limits the scope;
   - (c) a **continuation predicate** from the provider rule says the new key continues the old one. For Laftel: same `/player/<series>/` segment (`laftel:/player/45462/93304` → `…/93295`, §14 [MEASURED key shape]). For YouTube: none by default, so YouTube keeps the button, because autonav jumps to an arbitrary recommendation.
   - Anything else keeps today's "move the room here" button.

3. **Compare-and-set on the server**, which is the one protocol addition.
   - `cmd{kind:"media", ifMediaKey:"<key the sender was on>"}`. `room.go` applies it only if `anchor.MediaKey == ifMediaKey`; otherwise it answers `error{code:"media_stale"}`, or simply an `ack` carrying the current anchor, without taking a `seq`.
   - This is watchparty's `playlistNext(url)` (`server/room.ts:670-686`). Every member whose site autoplays ep2 sends the same CAS, exactly one wins, and the rest are already on ep2 or are taken there by `followRoom`.
   - Two members whose sites went to *different* "next" pages: the first wins, the second is refused and followed to the winner's media.
   - Stdlib only: one string comparison before `seq` is taken, consistent with the existing `bad_cmd` handling (PROTOCOL §3).

4. **The continuation lands paused at 0, then plays together.**
   - `media` already lands paused (PROTOCOL §3). Send `positionMs: 0`, not the sender's position: the sender's site may already be a few seconds into ep2.
   - The sender then sends `play`, which the readiness gate holds while members are unready.
   - **Gap:** members who are still navigating report `suspended`, so they are absent and not gated. The play would fire without them, and they would join a playing room a few seconds late. That shows up as `SkippedMs`.
   - Two options, left open in §6: report "in transit / acquiring" as **present-but-unready**, bounded by `GATE_TIMEOUT`; or accept the skip.
   - Jellyfin chooses to wait (`Waiting` → resume when all are ready). SyncTube waits with a 3 s cap (`Main.hx:41,1357-1374`).

5. **Members already on ep2 by their own autoplay** are in `CONFORMING`/`GUARDED` for that epoch. When the `media` ack/state arrives they are `onRoomMedia`, so they conform to `paused@0` and the gated `play` starts them together. Their site's ep2 autoplay before the command arrives is un-gestured, so it is absorbed instead of broadcast. That is the race Path D currently loses.

6. **Ordering safety.** Because the epoch bump happens on `emptied`/`loadstart`, synchronously, the old-episode `seek 0` of Path D can no longer be produced: the detector is reset before the position reads 0, and the engine is out of `STEADY`.
   - Work queued under the old epoch must re-check the epoch, as `canAim(epoch)` already does for the session epoch. Carry the media epoch into the `current()` closures (`engine.ts:796`, `449-455`).

7. **Faster navigation detection** (optional): subscribe `PageWatcher.check` to `navigation`'s `currententrychange` where it exists (no patching; consistent with `resolve.ts:100-104`), and on YouTube to `yt-navigate-finish` as a plain document event listener. The media epoch makes URL timing much less critical, so this is a UI-latency improvement only.

### 4.6 Implementation map

| Where | Change |
|---|---|
| `adapter/types.ts` | `ended` in `PlayerState`; `'emptied' \| 'loadstart'` (or a synthesised `'mediachanged'`) in `AdapterEvent` |
| `adapter/html5.ts` | listen to `emptied`, `loadstart`; return `ended` |
| `adapter/swappable.ts:46` | fire `elementreplaced` (or `elementlost`) on `setTarget(null)` too |
| `engine/engine.ts` | media epoch + the acquisition state; `EngineDeps.lastGesture` / `activationEdge`; classify observations by state; creator adoption on `STEADY`; `ended` pause → finished; carry the epoch into `current()`; new stats `siteMovesAbsorbed`, `gesturedIntents`, `ungesturedSuppressed`, `acquisitions`, `fought` |
| `app/bootstrap.ts` | gesture listeners (shared by both shims, so no shim change); continuation predicate + CAS `media` |
| `adapter/mediakey.ts` | an optional `continues(prevBody, nextBody)` per rule (Laftel: same series) |
| `server/internal/room` + `wire` + PROTOCOL §3 | `ifMediaKey` on `cmd media`; refusal without a `seq` |
| sim | model a join with site autoplay and resume, so the regression has a control (CLAUDE.md: controls, averaged over seeds) |

---

## 5. Probe plan: measure before building

A new `harness/browser/probe-acquire.mjs`, driven over CDP like `probe-laftel*.mjs`.

**Recorder** (injected with `Page.addScriptToEvaluateOnNewDocument`; page world is fine because this is measurement, not shipping):
- `document.addEventListener(type, h, true)` for: `abort`, `emptied`, `loadstart`, `durationchange`, `loadedmetadata`, `loadeddata`, `canplay`, `canplaythrough`, `play`, `playing`, `pause`, `ended`, `seeking`, `seeked`, `waiting`, `stalled`, `ratechange`, `timeupdate` (sampled). Capture phase at the document catches non-bubbling media events from every element, including ones not yet picked.
- Per event, log:
  - `t = timeOrigin + now` and `isTrusted`;
  - element serial (a `WeakMap` counter), `isConnected`, `currentSrc` (hash plus scheme);
  - `readyState`, `networkState`, `paused`, `ended`, `currentTime`, `duration`, `muted`, `volume`, `playbackRate`, `defaultPlaybackRate`;
  - `location.href`, `visibilityState`;
  - `userActivation.isActive` / `hasBeenActive`;
  - ms since the last trusted input of each activation-triggering type;
  - on YouTube, `#movie_player.classList.contains('ad-showing')`.
- Also log:
  - trusted input events (type only);
  - `navigation` `navigate`/`currententrychange` and `yt-navigate-start/finish`;
  - a `MutationObserver` for `<video>` insertions and removals;
  - a 10 ms poll of the picked element's `paused`/`currentTime`/`currentSrc`, to catch the load algorithm's silent `paused = true`;
  - the same `isActive` read **from the `VideoSync` isolated world** at the same instants (M5).
- Run each scenario **twice**:
  1. with the current extension joined to a room with a second member and `videosyncd -verbose` — the **control** that must reproduce C1 (commands on the wire);
  2. later with the fix — expect 0 un-gestured commands.
- Run under **both** autoplay policies: the default, and `no-user-gesture-required`, which all existing live probes used.
- Real input comes from CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`, which produces trusted, activating events [UNMEASURED; assert it in the probe by reading `isActive` afterwards]. The window must be **on screen**: §16 found CDP input 3–6 s late on Wayland for off-screen windows.

| # | Where | Scenario | What decides the design |
|---|---|---|---|
| L1 | Laftel (Helium profile) | full load of an episode: fresh, and after watching 2 min (resume) | does Laftel autoplay; does it seek to a resume point; delay from `canplaythrough` to its first autonomous move (→ `T_settle`); control: `play`/`seek` sent by a joiner (Paths A/B) |
| L2 | Laftel | in-app episode click (SPA) | **same element or new** (serial); order of `pushState`/`currententrychange` vs `emptied`/`loadstart` vs insert/remove; gap between the click and the new episode's `play` (must exceed `G`); `isActive` at that `play`; is there ever a moment with no `<video>` (Path E); control: `seek 0` on the old key (Path D) |
| L3 | Laftel | seek to `duration−20 s`, no input for > 5 s, let it end | `pause`→`ended` order and `el.ended` inside the `pause` handler; does Laftel navigate **before** `ended` (credits countdown) and at what position (→ `endWindow`); autoplay to the next episode; `isActive` false at that `play`; rate after the `src` change (the spec says reset) |
| L4 | Laftel | 10 min idle playback | any spontaneous `emptied`/`loadstart`/element swaps (quality change, ads) that would bump the epoch spuriously |
| L5 | Laftel | press play by click, Space, and the site's button, 20 each | distribution of input→`play` latency (→ `G`) |
| Y1 | YouTube | click a recommendation (watch→watch) | as L2; plus `yt-navigate-finish` timing |
| Y2 | YouTube | short video (or seek near end) with autonav on | as L3 |
| Y3 | YouTube | playlist `list=` advance; a video with a pre-roll ad | ads: is the ad in the same element with a different `src` (epoch bumps and `ad-showing` agree?) |
| Y4 | YouTube | signed-in resume point; double-click fullscreen, then Space | resume seek; **does `requestFullscreen` zero `isActive`** before the next play |
| Y5 | YouTube | click vs Space vs `k` latency, 20 each | → `G` (§17 suggests click ≈ +200 ms) |
| M1 | `local-media.mjs` (container, deterministic) | same element: `src` swap while playing; while paused; a `blob:` MSE swap | spec order observed in Chromium and Firefox; silent `paused`; `playbackRate` reset; discarded queued events |
| M2 | local media | element replacement: insert-then-remove vs remove-then-insert in separate tasks | Path E reproduces `seek 0` today (control); `pause` from the removed element |
| M3 | local media, host Helium | **media keys via MPRIS**: `playerctl -p chromium play-pause`, with and without a page `mediaSession` handler | `isActive` before/at/after the `play` event; any input event; `isTrusted`; an activation edge visible from the isolated world (→ the media-key half of 4.3) |
| M4 | local media, Firefox flatpak | same as M3 (MPRIS), plus `navigator.userActivation` availability and transient duration | Firefox half of 4.3 |
| M5 | local media | `isActive` read in the page world and the content-script world at the same instant, 50 samples around clicks | whether the engine can read it at all from the isolated world |
| M6 | local media | attribute `autoplay` vs script `play()` at `loadedmetadata` vs script `play()` at `canplay` | confirms that `canplaythrough` bounds attribute autoplay only; script autoplay timing |

Acceptance numbers to take from the runs:
- `G` = p99(input→`play`) across L5/Y5 plus a margin, and it must stay below min(click→autonomous `play`) in L2/Y1. If it does not, the "gesture after `loadstart`" rule from 4.3 becomes mandatory.
- `T_settle` = max(`canplaythrough`→autonomous move) in L1/L3/Y1/Y2 plus a margin.
- `endWindow` from L3/Y2.
- Spurious epoch bumps per hour from L4.
- Commands sent per scenario must be 0 in the fixed build; the control run must show > 0.

---

## 6. Open questions

1. **In-transit members and the gate.** Should a member acquiring or following be *present-unready* (gated, bounded by `GATE_TIMEOUT`) rather than *absent*? That trades the continuation's `SkippedMs` against a room held for a slow joiner. It interacts with STATE.md's known gap "a member who has never reported counts as ready".
2. **Automatic continuation at all?** Section 4.5.2 relaxes the explicit "navigation never moves the room" decision (`bootstrap.ts:268-276`) for same-series, near-end cases only. This is a product decision for the user. The CAS field is worth adding either way, because the "move the room here" button can race too.
3. **Gesture requirement outside the window.** Should `STEADY` also require gesture evidence for `play` in a paused room (strongest against late site autoplay; costs media-key and OS-control plays if M3/M4 show no activation edge)? The proposal says no, pending M3/M4.
4. **`FOUGHT` handling.** After K re-conforms, is "absent plus a panel notice" right, or should the member follow the site and send its state?
5. **Creator whose site never autoplays nor resumes.** `STEADY` then comes only from the `T_settle` backstop, so adoption is delayed by `T_settle` after `canplaythrough`. Is that acceptable, or should the creator adopt at `CONFORMING` time and again at `STEADY`?
6. **Firefox.** `navigator.userActivation` and the Navigation API in an MV2 content script are [UNMEASURED]. The design degrades to input events only there.
7. **Ads.** The media epoch would treat a same-element ad as "not the room's timeline". That needs an ad→content epoch transition that re-conforms rather than resets the room. Y3 decides whether `ad-showing` and `src` changes line up.
8. **The `rateWeSet` comment** (`engine.ts:1098-1101`) contradicts the spec's rate reset on `src` change. M1/L3 settle it.
9. **Path E is a code-reading finding only.** M2 should reproduce it before it is fixed. The fix (`setTarget(null)` resets the detector) is independent of C1 and cheap.

## Sources

- WHATWG HTML, media elements (load algorithm, `play()`/internal play steps, the autoplay steps under `readyState` changes, end of media, removal → internal pause steps): https://html.spec.whatwg.org/multipage/media.html
- WHATWG HTML, user activation (data model, activation-triggering input events, `UserActivation`): https://html.spec.whatwg.org/multipage/interaction.html
- W3C Media Session, "handle media session action" (handler, then activation notification): https://w3c.github.io/mediasession/
- [MDN, User activation](https://developer.mozilla.org/en-US/docs/Web/Security/User_activation) (`requestFullscreen`/`window.open` consume it; autoplay is sticky-gated)
- [MDN, UserActivation](https://developer.mozilla.org/en-US/docs/Web/API/UserActivation) (available across browsers since Nov 2023)
- Chromium `kActivationLifespan` = 5 s: [blink-dev: Intent to Ship: User Activation v2](https://groups.google.com/a/chromium.org/g/blink-dev/c/nkTDR8AUlwM/m/RVHaoPgLCQAJ), [user-activation-v2 explainer](https://mustaqmed.github.io/user-activation-v2/), [Chrome for Developers: user activation](https://developer.chrome.com/blog/user-activation)
- [Chromium, Controlling Media Playback](https://chromium.googlesource.com/chromium/src/+/HEAD/services/media_session/controlling_media_playback.md) (says nothing about activation, hence the M3 probe)
- [DEV: detecting YouTube SPA navigation](https://dev.to/ktg0215/detecting-youtube-spa-navigation-in-a-chrome-extension-content-script-2fi8) — weak evidence that YouTube rebuilds the player DOM; treat as [UNMEASURED] until Y1
- Reference clones: `/tmp/claude-1000/-home-yaeji-Projects-videosync/a6588961-2997-471a-ab26-fd8e8debebc8/scratchpad/refs/{opentogethertube,jellyfin-web,syncplay,SyncTube,watchparty,cytube,VideoTogether,syncwatch}`
- VideoSync files: `/home/yaeji/Projects/videosync/client/core/src/engine/engine.ts`, `/home/yaeji/Projects/videosync/client/core/src/detector/detector.ts`, `/home/yaeji/Projects/videosync/client/core/src/app/bootstrap.ts`, `/home/yaeji/Projects/videosync/client/core/src/adapter/{resolve,swappable,html5,types,mediakey}.ts`, `/home/yaeji/Projects/videosync/docs/BROWSER-FINDINGS.md`, `/home/yaeji/Projects/videosync/docs/PROTOCOL.md`, `/home/yaeji/Projects/videosync/harness/browser/probe-laftel.mjs`, `/home/yaeji/Projects/videosync/server/internal/room/messages.go`