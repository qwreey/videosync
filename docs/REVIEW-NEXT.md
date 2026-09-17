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
   - lost-command resend with `lostSeek`/`lostPaused` (N16)
   - welcome conform waiting for a play's `when`, `MAX_WELCOME_LEAD_MS` (N29)
   - lone-member hold via `gateHolds`/`reportedUnready` (N25)
   - the reconciler holding its wait during an apply, and `releaseRate` on close (5c044b6)
   - How these meet `holdForRoom`, `ownAck` and `sendOfflineChanges`.
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
- **N16:** a press in about the first 10 s of a black-holed outage is still lost. Documented,
  accepted.
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
- **Sim fidelity.** `server/internal/sim` does not model `intended`, liveness, lost-command resend,
  the reconciler hold or the lone-member hold. Its conclusions about those paths are not evidence.
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

## D. Suggested order for round 5

1. A2 (the merge resolution) and A1, one pass each, 4 finders × 2 lenses, 2 verifiers each.
2. Fix what they find in one small batch; review the diff.
3. B items, a few at a time, each with a test first.
4. A3–A9, one area per pass.
5. The C items as short investigations, with a live probe where one exists
   (`harness/browser/probe-*.mjs`).
6. A full but half-size convergence probe (16 finders) once the narrow passes come back empty.
