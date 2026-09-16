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
