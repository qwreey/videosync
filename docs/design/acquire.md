# Acquiring a video, naming a room's media, and the next episode (D8, C1, C3)

Research behind this: `research/design-acquire-video.md` (code paths A–G, browser signals, the
state machine, the probe plan).

## The problem

When a client finds a video — joining, arriving by a follow, an SPA navigation, the next episode,
an element swap — the element's play/pause/position is usually the **site's** doing: autoplay,
resume-from-history, a reused element being reset by the load algorithm. The engine used to treat
the first transition as the member's own and broadcast it (C1). A room could also be created
before anyone named its media, and today the client refuses that (C3); the intended architecture is
that such a room simply waits.

## Order of work

1. **Measure first** — `harness/browser/probe-acquire.mjs` (research §5): event order on `src`
   change and element replacement, when each site autoplays or resumes relative to
   `canplaythrough`, the input→`play` latency per site, what `navigator.userActivation` shows
   around media keys, and, as the control, the commands today's client sends. The constants below
   (`G`, `T_settle`, `endWindow`) come from these runs, not from guesses.
2. Build, with the control reproduced before and absent after.

## Media epoch

A counter the engine bumps on anything that changes *which media is in the element*: the element
being replaced or lost, `emptied`/`loadstart` on the current element, the local media key changing.
The bump happens synchronously in that handler and resets the detector, so no observation can
straddle two media. Queued player work carries its epoch and re-checks it (as `canAim` already does
for the session).

## Acquisition states (per epoch)

`DETACHED` → `CONFORMING` → `GUARDED` → `STEADY` (today's behaviour), with `FOUGHT` when a site keeps
overriding the room. Research §4.2 has the diagram; the rules:

- **CONFORMING**: once the element has metadata, the clock is settled and the page is the room's
  media, apply the room's anchor once. Reports say absent.
- **GUARDED**: the player agrees with the room. An un-gestured change is the site's: put it back
  (counted). A gestured change is the member's: send it, and go to `STEADY`.
- **Leaving GUARDED** is a condition where one exists — a gestured action, or startup finished
  (`canplaythrough` at the room's position, and the site's own move seen and absorbed, or the
  element advancing with a playing room) — and one measured backstop, `T_settle` after
  `canplaythrough`, which degrades to today's behaviour. It never silences anything and cannot
  deadlock: it only decides how an observation is classified.
- A site that keeps overriding the room (`K` re-conforms) → `FOUGHT`: stop fighting, report absent,
  tell the member.
- The creator's adoption happens at `STEADY`, from the state the member settled on.

**Gesture evidence** is injected by the app layer (trusted `pointerdown`/`pointerup`/`touchend`/
`keydown`, capture phase, time and kind only — no targets, no keys) plus a
`navigator.userActivation.isActive` rising edge with no input, for media keys. An observation is
intent if a gesture came within `G` before it **and after the epoch began**.

## A room that names nothing yet (C3)

- A room may be created from a page with no media, and its key stays `''`.
- Members of such a room are quiet: nobody is conformed, corrected or gated.
- The first member who is on media names it with a compare-and-set:
  `cmd{kind:"media", ifMediaKey:"", mediaKey, mediaUrl, positionMs}`.
- The server applies a `media` command with `ifMediaKey` only if the room's key equals it, before
  taking a `seq`; otherwise it answers `ack`-less `error{code:"media_stale"}` and the sender simply
  follows the room as it is.
- That member's own state then goes through acquisition like anyone else's; when it reaches
  `STEADY` it adopts its settled state into the room, as a creator does.

## The next episode

- **The end of media is not a pause.** A `pause` with `ended` set is not sent; the member reports
  itself finished.
- **Continuation, narrowly.** A member's own navigation moves the room automatically only if the
  previous epoch was on the room's media and ended (or was within `endWindow` of the end while
  playing), and the provider descriptor's `continues` says the new key follows the old one
  (Laftel: same series; YouTube: never — autonav picks arbitrary videos). Then:
  `cmd{kind:"media", ifMediaKey:<old key>, positionMs:0}`. Every member whose site autoplayed the
  next episode sends the same compare-and-set; exactly one wins, the others are already there or
  are followed. Anything else keeps the "move the room here" button, as D4 requires.
- The continuation lands paused at 0, and a `play` follows, held by the readiness gate. Members
  who are still navigating count as present-but-unready (bounded by `GATE_TIMEOUT`) rather than
  absent, so the room waits for them instead of skipping ahead.
- A member already on the next episode by its own autoplay is in `GUARDED` for that epoch; its
  autoplay is absorbed rather than broadcast, and the gated `play` starts everyone together.

## Protocol changes

- `cmd.ifMediaKey` (optional) on `media`; `error{code:"media_stale"}`, no `seq` taken.
- Report: `finished` and `acquiring` (present but unready), both documented in PROTOCOL §4.

## As built (2026-09-17, `feat/acquire`)

Measured first (`harness/browser/probe-acquire.mjs`, BROWSER-FINDINGS §20), built on those numbers,
verified live against the same control (§21). Where this deviates from the text above, or decides
something it left open, it says so here.

**Constants, from §20.** `G` = 500 ms (slowest press 268 ms, fastest site autoplay after a
navigation click 750 ms). `T_settle` = 1 s (every measured site move ≤ 11 ms after
`canplaythrough`). `endWindow` = 1 s (both sites move on only after `ended`, 5.3–7.6 s later).
`K` = 3, unmeasured: nothing fought a conform in any run. A continuation is considered only within
20 s of the member's own end. All are `EngineConfig` fields.

**Decided or changed while building:**

1. **Conform at HAVE_FUTURE_DATA, not at metadata** (deviation). Laftel writes its resume position
   repeatedly from `loadedmetadata` until 0.5–0.75 s before `canplaythrough`; a conform in that
   window would be overwritten and counted as a fight. An element that stays at metadata (a paused
   `preload="metadata"` player) is conformed after 5 s. `canplaythrough` itself is not observed:
   `readyState >= 3` stands in for it, because `canplay` and `canplaythrough` fired within 7 ms of
   each other in every run.
2. **"The site's move was seen and absorbed" is not an exit on its own** (deviation). Laftel makes
   two moves (resume, then autoplay), so `T_settle` is measured from the *last* conform instead of
   from `canplaythrough`, and every absorbed move restarts it. The playing-room exit (b) and the
   gesture exit are as designed.
3. **No gesture evidence = no acquisition states.** `EngineDeps.gestures` is optional; without it
   the engine behaves exactly as before D8 (the 160 pre-existing engine/app tests pass unchanged,
   and they are the control for every new test). Both shims always supply it, from
   `client/core/src/app/gestures.ts`. The end-of-media rule and the epoch bump on
   `emptied`/`loadstart`/element loss apply either way.
4. **Input on VideoSync's own panel is not a gesture**, and an activation rise within `G` of such
   input is not a media key either (the panel click activates the page too). Identified by the
   panel host in `composedPath()`, which a closed shadow root still exposes.
5. **A `hello` no longer names the media, not even the first member's** (server change beyond the
   text above). It skipped the namer's adoption, so the namer was conformed to `paused@0`. Naming
   is only the conditional `media` command now.
6. **After any `media` command every member is unready until it reports on the new `seq`**
   (server, found by the end-to-end test): the winner's `play` follows its `media` within one
   conform, which can beat the other member's first `acquiring` report. `GATE_TIMEOUT` bounds the
   rest. *(Integration: a member already reporting `suspended` and not `finished` is not gated —
   a throttled background tab would otherwise hold the next play for up to `GATE_TIMEOUT`.)*
7. **A seeding member (creator or namer) reports `acquiring` while guarded**, so the server does
   not judge a player that is where *it* is against the room's placeholder. Its site's moves are
   absorbed, not put back, and restart `T_settle`. At `STEADY` it seeds the room (`seek`, then
   `play` if playing) — unless somebody else's command moved the room meanwhile, in which case it
   conforms instead. A gesture while guarded ends it the same way; the adoption carries the press.
8. **The room's media changing is a media epoch too**: the room moving onto this member's page
   needs a conform as much as the page moving does. Scheduled transitions that arrive while
   `detached`/`conforming`/`fought` are not applied (the conform reads the newest anchor when it
   runs, and is restarted if a newer `seq` lands while it waits); corrections are ignored while
   acquiring.
9. **In transit**: a member whose element finished the media the room has just left, and which is
   not on the new media yet, reports `acquiring` rather than absent. A member who follows by
   *full-page* navigation leaves the room while its page loads, so the gate is released without it
   and it joins a running room — not covered.
10. **`FOUGHT`** (open question 4): absent, a panel notice asking for a press, left on a gesture or a
    new epoch. Room commands are not applied in it.
11. **Next episode** (open question 2, as the user decided in D8): automatic only for the
    narrow case; the winner sends `play` once it is conformed, losers (`media_stale`) do not. The
    predicate is `continuesMedia()` in `mediakey.ts`, driven by an optional `continues` field on
    the hard-coded rules (Laftel: same series, different episode). Keep it behind that one function
    when provider descriptors land.
12. **No conform when the room's position is more than 2 s past the element's duration**: that
    element is not on the room's timeline (a finished room, an ad, a preview); the member stays
    `detached`.
13. **"Move the room here" is conditional** on the room media the button was shown against.
14. `SwappableAdapter.setTarget(null)` now announces the change (Path E), and `Html5Adapter`
    reports `ended` and forwards `emptied`/`loadstart`.
15. Rooms can be created from a page with no media again (the 2026-09-16 refusal is reverted); the
    panel says that opening a video names the room. After a *full-page* navigation the creator is
    not in the room any more (only a follow carries the session), so this works as intended on the
    SPA sites (YouTube, Laftel) or with a manual rejoin.

**Measured after building (§21):** every C1 case the control reproduced sends nothing, except a
site that autoplays 1.5 s after it can play — past `T_settle`, which is the designed boundary (the
same site at 0.8 s is absorbed). Gestured presses (trusted click, MPRIS key) still go through while
`guarded`. On Laftel, two members at the end of an episode moved on together (one continuation
won; both on the next episode within 60 ms), where the control split them. `probe-follow` 11/11,
`probe-firefox LOCAL=1` 10/10, `probe-laftel-room` unchanged against §16. Simulation:
`site-autoplay-join` (seeds 1..10) sends 2 site commands and ends at 881 s without the guard, 0 and
127 s with it (POC-FINDINGS §43).

**Integration (review fixes):**

- *Somebody else moved the room meanwhile* (item 7) is recorded when that command is applied, in
  any acquisition state (`foreignMove`), not by comparing seqs from the moment guarding began: a
  creator still loading skipped the command and then seeded over it. The same flag drops the seed
  of a member who lost the naming race — the winner's state is somebody else's command — which
  matters most when both were on the same video.
- *In transit* (item 9) only for a finish within the continuation window, and for at most that
  long after the room moved; a finish is timed from when the element finished, not from when it
  was last seen finished, so an end screen left open does not keep the window open.
- *FOUGHT* (item 10) is left by any gestured change, including one that agrees with the room.
- A naming lost with a dropped connection is tried again after the next `welcome`.
- `EngineDeps` pieces are optional, so the engine reports which it was built with
  (`dump().engine.wiring`), and the app tests pin that the shims' shared wiring supplies them.
- The continuation predicate is the descriptor's `continues` (D7), through `continuesMedia()`.

**Integration (second review):**

- A reconnect's `welcome` is a move of the room too: a seq past `lastAppliedSeq` that is not an
  acked one of ours sets `foreignMove` for a seeder, and a changed media key starts a media epoch
  (and *in transit*) as a `state` would. The first `welcome` is not a change of media.
- A continuation (item 11) is dropped by a `welcome` that does not show its key, and no longer
  starts the room once a minute has passed since it was sent (`CONTINUATION_START_MS`): a
  `rate_limited` refusal names no command, and a lost one otherwise stayed armed for the session.
- An element the room is more than `PAST_DURATION_SLACK_MS` past (item 12) is *absent*, not
  acquiring, until the room comes back within it — it held every play for `GATE_TIMEOUT`.
- The K bound (item 10) counts a seeder's absorbed site moves as well; past it the seeder is
  FOUGHT, and a press seeds from wherever the member takes the player.

**Not done:** ads (an ad in the same element bumps the epoch and, if its duration is long enough,
is conformed — Y3 unmeasured); fullscreen consuming activation (Y4); Laftel in Firefox; Firefox
media keys give no evidence (a media-key play while acquiring is put back once).
