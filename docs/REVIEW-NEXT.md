# Next review passes (from 2026-09-18)

Where the many-eyes review stands, and what to go through next. `docs/STATE.md` has what each
round fixed; this file is the work list.

## How to run them (the user's direction, 2026-09-17)

Confirmed findings went 69 (round 1) → 47 (round 3) → 35 (round 4). That is fewer, but the
review has not converged. From round 5 on:

- **About half the agents** of round 4 (16 finders instead of 32; fewer verifiers).
- **Many small, narrow passes, not one wide sweep.** Once counts are low, most new findings are
  caused by the previous wave. Large batches kept re-introducing what the last batch fixed.
- **Fix in small batches** (a handful of findings), review that batch's diff, then move on.
- Take the list below one item at a time, slowly. Time is not the constraint.

Every verifier and finder is read-only on the repo (round 4 left a stray `client/n5.test.ts`;
check `git status` after each pass).

## A. What rounds 3–4 and the live runs changed (review these first)

Scope for the first passes: `git diff 5ec092e..HEAD`, taken one area at a time.

1. **Engine: commands and applies** (`engine.ts`)
   - `intended` / `roomAnchor()` (N1)
   - `PLAY_WAIT_MS` race in `tryPlay` (N2)
   - probe-count liveness (N8)
   - ~~lost-command resend with `lostSeek`/`lostPaused` (N16)~~ — **gone (2026-09-18)**: no
     command is resent after a drop. What is left to review is `onClose` doing nothing but
     releasing the rate and resetting.
   - welcome conform waiting for a play's `when`, `MAX_WELCOME_LEAD_MS` (N29)
   - lone-member hold via `gateHolds`/`reportedUnready` (N25)
   - the reconciler holding its wait during an apply, and `releaseRate` on close (5c044b6)
   - How these meet `holdForRoom` and `ownAck`. (`sendOfflineChanges` was removed on
     2026-09-18.)
2. **The merge resolution in `isEcho`/`act`** (d807781): `roomAnchor()` from one branch, the
   unready play-state exemption from the other. Nobody reviewed the combination.
3. **Engine: acquisition** (`engine.ts`, `detector.ts`)
   - activation sampled before the joined check (N3)
   - `hiddenContinuation` / `continueWhenShown` (C1)
   - `noticeUnblocked` (N18)
   - the seeder retry (N19)
   - the stall branch now reporting play state (N4) and its seek-plus-pause handling
4. **App** (`bootstrap.ts`, `panel.ts`)
   - watcher retarget rule (N5)
   - `sessionGen` and internal rejoins (N9)
   - bfcache `pageshow` leave (N20)
   - `rewriteInviteSecret` + `replaceState` (N37)
   - `refreshRejoin` (N23/N38)
   - key events stopped at the shadow root (N7)
   - `gatewayWantsLogin` and GM status 0 (N10)
   - `@inject-into content` (N14)
5. **Hub/room**
   - `coalesce` send order and unknown kinds (N14 r3)
   - the `when` clamp (N15 r3)
   - roster broadcast on a ready/suspended flip (N44 r3)
   - redacted verbose trace (N26)
6. **Servo** (`corrector_servo.go`)
   - paused reports skipped (N27)
   - `dropStep` (N28)
   - `RateReleaser` and its `ConfidenceGated` forwarding
   - suspended rate reset (N43 r3)
   - POC-FINDINGS §45–§46
7. **Auth**
   - OIDC `Sec-Fetch-Site` (N2 r3)
   - kdf queue and cancellation (N13)
   - `/64` keys and the login table share (N7 r3)
   - extension-scheme origin patterns and warnings (N6)
   - `-public-url` warning (N12)
   - server timeouts (N9 r3)
8. **Providers**
   - the plain-URL grammar in both ports (N11)
   - refused `xn--` labels
   - refused backslash/comment/control characters in selectors (N30 r3)
   - hosts-drop widening, and the registry's `blocked` rule (N10)
   - lone surrogates normalised (N21)
   - `manage.ts` `changesFor`
9. **Extension**
   - `socketUrl` in the worker (N13 r3)
   - the `held` token map (N36 r3)
   - options page updated in place (N22)
   - held-back pin cards (N23)

## B. Known leftovers, not fixed yet (small, concrete)

- **N18:** when `tryPlay` succeeds and clears `autoplayBlocked`, `onAutoplayUnblocked` does not
  fire, so the click-to-sync overlay stays over a member who is playing.
- **N25 side effect, untested:** a lone creator's adoption ack now pauses its player while
  `gateHolds` is true. Check that the play really follows.
- **Invite link pasted into a tab already on that page** (a same-document fragment navigation) is
  never read: nothing is prefilled until a reload. Found by `probe-round3.mjs` on 2026-09-18.
- **`manage.ts` `changesFor`:**
  - a descriptor that displaces several built-ins is untested;
  - with a same-id built-in, other displaced built-ins are not diffed.
- `client/extension/README.md` "Permissions" is stale after N6 (the authserver fixer's note).
- ~~**N16:** a press in about the first 10 s of a black-holed outage is still lost.~~ **Removed
  (2026-09-18, the user's decision):** nothing done while the session is down is sent, so there is
  no window to get right. The room wins on reconnect and the panel says so. See STATE.md
  "Round 5: nothing done offline is sent". **But the same 15–20 s survives as a hole in the
  banner:** a silently dead path keeps the status at `joined` for `SILENT_PROBES` ×
  `timeSyncIntervalMs`, so the panel says 연결됨, the banner is off, and a press in that window
  reaches nobody with nothing to say so. Known and accepted; shortening it means probing faster,
  which is unmeasured.
- **A member that reaches the end while the session is down is stranded there.** It comes back
  `ended`: the reconciler skips it, its report says `finished` (= absent), and the server leaves
  an absent member alone — so it sits at the end while the room plays, panel saying 연결됨.
  **Known and accepted (the user's call, 2026-09-18):** separating it from a member who watched to
  the end needs the offline knowledge that was just removed, and dragging the room is worse. Pinned
  by `engine.test.ts` "known and accepted: a member that reaches the end while away is stranded
  there". If it is ever revisited, the lead is the server: an absent member at the end of media
  that the room is still playing is a fact the server can see on its own.
- **The panel is invisible while the site is fullscreen on a browser with no Popover API.** The
  host joins the top layer as a manual popover (`Panel.showTopLayer`), which is the only way to
  paint above a fullscreen element without moving into the site's own subtree — and moving there
  was tried and rejected in review. Firefox before 125 and anything pre-2023 get nothing, banner
  included. **Known and accepted**; the popover path has no live coverage yet, so the next
  `probe-stack` run should check the panel is visible over fullscreen on Laftel and YouTube.
- **The panel's compact collapsed banner is CSS-only and untested.** The fake DOM lays nothing out,
  so `.panel.collapsed .banner .banner-body { display: none }` is unverified; only the structural
  guarantee (the banner is not inside the part collapsing hides) is pinned.
- **N13 residual:** an attacker spread over many `/64`s can keep the kdf queue full while the
  attack lasts. Documented in `docs/design/auth.md`.
- The report's slope comes from the detector's judged history while the residual is against the
  anchor (round 4 T3, low).
- Clearing `intended` in `onClose` has no test; the fixer says it cannot be observed.
- IDN hosts cannot be described (deliberate since round 4); `docs/design/providers.md` should
  define the plain-URL grammar fully.

## C. Nothing confirmed, but worth digging

- **Rejected by verifiers, worth a second look now that the code moved:**
  - N15 r4: a rewatch `play` in a finished room dropped as an echo (with `intended` in place).
  - N30 r4: a roster rebroadcast on every ready flip (heartbeat amplification). Measure it.
  - N45 r3: a member's old connection lingering ~90 s after a network change. The server side of
    liveness.
- **Sim fidelity.** `server/internal/sim` does not model `intended`, liveness, the reconciler hold
  or the lone-member hold. Its conclusions about those paths are not evidence. (It never modelled
  the lost-command resend either; that is no longer a gap — the resend is gone.)
- **The steady ~200–300 ms lag in Firefox on Laftel** (§23, §24). It sits inside the servo's band.
  Is that band right for a room where one member is Firefox?
- **The re-aim at the press on Laftel** (84–206 ms in most trials, §22–§25). Where does it come
  from?
- **The Firefox Widevine frozen `currentTime` after a seek** (on hold, user decision): extra
  corrections.
- **Unmeasured live:**
  - N8 on a real network change (black-holed socket)
  - the bfcache `pageshow` path
  - a hidden-tab continuation (C1)
  - the options page's replace-built-in and held-back flows
  - real Tampermonkey/Violentmonkey (GM status 0, `@inject-into`)
  - OIDC with a real IdP, proxy/tinyauth
  - N2 on a real starved element

## Log of the small passes

### Round 5, pass 1 (2026-09-18): engine command/apply paths, and the `isEcho`/`act` merge

- **Scale.** 8 finders (4 focuses × 2 lenses) on 68dc4c6. Each finding had 2 verifiers, with a
  third on a split. 8 raw findings, 7 distinct, **7 confirmed**. All seven were caused by rounds
  3–4, as expected.
- **Batch 1 (P1, P2, P4; P6 folded in).** One fixer, then four review loops of 1–2 reviewers.
  The loops found 2 → 3 → 2 → 1 new problems, each introduced by the previous fix, and each was
  fixed and pinned. Merged as 611bb50; core tests 538.
  - **P1.** The unready play-state exemption is now narrow (`underOwnSeek`):
    - With gesture evidence, an unready change under a seek of ours is excused only if there was
      no press after the apply began and within `gestureWindowMs`.
    - Without gesture evidence, it is excused only in the post-seek `play()` window.
  - **P2.** A site's unpressed move is judged against the anchor. A press that matches only the
    pending command is treated as the member's.
  - ~~**P4/P6.**~~ **Removed (2026-09-18, the user's decision)** — the whole offline-intent
    machinery is gone, so these fixes are gone with it. What they said:
    - The offline snapshot waits for an old apply.
    - It survives a second drop while the room is unmoved.
    - It merges commands lost in between.
    - A fresh snapshot taken during a *seeking* apply records where that seek lands.

    Nothing a member does while the session is down is sent now: the room wins on reconnect and
    the panel shows a disconnect banner. That this area produced a new bug in four review rounds
    running was the reason. See STATE.md "Round 5: nothing done offline is sent".
- **Still open from pass 1.**
  - **P3** (low): an own-seek prediction survives another member's earlier command, so a pause in
    the gap is swallowed.
  - ~~**P5** (low): a command lost after our own ack, before that ack applied, is not resent.~~
    **Removed (2026-09-18):** no lost command is resent any more.
  - **P7** (low): the delayed welcome conform still runs after a gestured press made acquisition
    steady.
- **Known and accepted.**
  - ~~An offline *seek* can still be undone when a server correction queues behind a parked
    apply.~~ **Removed (2026-09-18):** an offline seek is never sent, so the room undoing it is
    the design.
  - A mouse press is stamped at mousedown, so both of these are taken for the site's (as
    `intent()` already does):
    - a click held longer than 500 ms during our seek;
    - a click whose mousedown came just before the apply began.
- **Flaky test.** `app.test.ts` "takes the click-to-sync prompt down once the member starts
  playing by key" fails about 2 in 12 runs at 68dc4c6 already. It uses real `performance.now()`.
  This belongs in B.
- **Lesson.** Every follow-up review of a fix found something new in that fix, even at one or two
  reviewers. Keep the loop going until a review comes back empty, and keep each fix small.

## D. Suggested order for round 5

1. A2 (the merge resolution) and A1, one pass each, 4 finders × 2 lenses, 2 verifiers each.
2. Fix what they find in one small batch; review the diff.
3. B items, a few at a time, each with a test first.
4. A3–A9, one area per pass.
5. The C items as short investigations, with a live probe where one exists
   (`harness/browser/probe-*.mjs`).
6. A full but half-size convergence probe (16 finders) once the narrow passes come back empty.
