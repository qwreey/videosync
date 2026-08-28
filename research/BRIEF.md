# Research brief — shared output schema

Project goal: a **self-hostable video sync system** (Netflix-Party-class) with:
- Generic HTML5 `<video>` sync + a **pluggable per-provider adapter** interface (YouTube, Laftel, Netflix, ...)
- Browser extension (Chrome MV3 + Firefox)
- Self-hostable sync server (Go preferred)
- **No host/방장** — every member has full control
- Chat
- NO screen capture / stream relay. Only URL + currentTime + play/pause state is synced. Every participant already has legal access to the media.

## Required output format
Write `research/<slug>.md` with EXACTLY these H2 sections. Cite `file:line` into the clone for every claim.
If something is absent in the reference, write `ABSENT` — do not invent.

## 1. Overview
What it is, language/stack, maintenance status (last commit date, open issue signal), license.

## 2. Transport & message schema
WS / SSE / WebRTC / polling. Reproduce the **verbatim** message shapes (JSON keys, types) for the sync-relevant messages.

## 3. Clock synchronization
How do they make `currentTime` comparable across clients with different wall clocks and RTT?
RTT halving? min-RTT sampling over N pings? server-authoritative timebase? NONE?
Quote the actual formula.

## 4. Drift correction policy
Deadband threshold (in ms/s)? Hard `currentTime =` seek vs `playbackRate` nudge vs both?
What are the exact constants?

## 5. Echo suppression
When applying remote state, how do they avoid the resulting local `play`/`pause`/`seeked`/`ratechange` event being rebroadcast (feedback loop)?
(ignore-flag with timeout? sequence compare? event source check?) Quote the mechanism.

## 6. Conflict resolution without a host
Two users issue conflicting commands simultaneously. What breaks the tie?
Server-assigned monotonic sequence? Lamport clock? last-write-wins on server timestamp? UNHANDLED?

## 7. Buffering / readiness gating
If one client stalls, does the room wait? How is "ready" signalled and aggregated?

## 8. Provider coupling
Generic `<video>` element or per-site adapters? **Where exactly is the seam** (file/interface)?
How do they find the video element? How do they handle SPA navigation / video element replacement / iframes / shadow DOM?

## 9. Room, identity & auth model
Room creation/join, persistence, membership, rate limiting, abuse controls.

## 10. What's broken / unmaintained / worth NOT copying
Be blunt. Known bugs, dead code, bad ideas.

## 11. Top 5 ideas worth stealing
Ranked, each with the `file:line` where it lives.

## Rules
- Read actual code. Do not summarize the README.
- Prefer `rg`/`grep` to locate: `currentTime`, `playbackRate`, `seeked`, `readyState`, `Date.now`, `ping`, `latency`, `offset`, `drift`, `ignore`, `suppress`.
- Keep the file under ~450 lines. Dense, factual, cited.
- Your FINAL RESPONSE must be a <=40 line summary (not the full doc): the 5 most decision-relevant findings for our design.
