package room

import (
	"sort"
	"strconv"
	"strings"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Sink delivers one frame to one member.
//
// Contract, and it matters: Sink.Send is called while the room lock is held,
// so it MUST NOT block. A real transport buffers per connection and, when that
// buffer is full, closes the connection and lets the reader report a Leave --
// a slow member must never be able to stall every other member's commands
// behind the room mutex.
type Sink interface {
	Send(clientID string, m Msg)
}

// Forgetter is implemented by correctors that keep per-client state. Rooms
// live for weeks; without this the state map only grows.
type Forgetter interface{ Forget(clientID string) }

// Member is one participant, as the room sees them.
type Member struct {
	ID   string
	Name string

	// RTTMs is the client's own best observed round trip. Unlike anything
	// derived from its offset estimate this is bias-free, so it is safe to
	// feed into the command delay.
	RTTMs  int64
	hasRTT bool

	LastAppliedSeq uint64
	Suspended      bool
	ReadyState     int
	BufferedAheadS float64
	LastSeenMs     int64

	gated   bool
	gatedAt int64
	// gateWaived: this member timed out of the gate and is excluded from it
	// until they report ready again. Without the latch the timeout flaps --
	// the next report would just reopen the gate at a fresh gatedAt and the
	// room would never resume.
	gateWaived bool
	corr       corrState

	// lastRate is the playbackRate we most recently told this client to hold,
	// and when. A continuous control law recomputes a rate on every report, so
	// without this the server sends a `correct` at the report rate forever --
	// measured at 17 nudges in a 20 s browser session, each one firing a
	// `ratechange` on the element the detector is watching.
	lastRate   float64
	lastRateAt int64
}

// corrState tracks whether our corrections are actually working on one client.
// Motivation: docs/POC-FINDINGS.md section 2 -- under one-way latency
// asymmetry the clock offset is biased, the residual never closes, and a tight
// deadband turns into thousands of useless seeks. No reference implementation
// detects this.
type corrState struct {
	lastSeekAt     int64
	residualAtSeek int64
	failedSeeks    int
	biasMs         int64 // learned clock-estimate bias, subtracted from reports
}

const (
	// seekCooldownMs is the floor between two seeks for the same client. On
	// its own this bounds the storm; it does not fix the cause.
	seekCooldownMs = 2000
	// failedSeeksBeforeBias: after this many seeks that did not move the
	// residual, stop blaming the player and blame our own clock estimate.
	failedSeeksBeforeBias = 3
	// seekImprovementFrac: a seek "worked" if it cut the residual by at least
	// this fraction.
	seekImprovementFrac = 0.5
	// rateRefreshMs re-states a rate the client should already be holding, in
	// case the `correct` that set it was lost.
	rateRefreshMs = 5000
	// GateTimeoutMs drops a still-buffering member from the gate so the room
	// can continue without them. Jellyfin's Waiting state has no such timeout.
	GateTimeoutMs = 30000
)

// Room is the timebase owner and the judge. It is NOT an aggregator: client
// reports decide who needs correcting and whether the gate fires, they never
// move the anchor (research/SYNTHESIS.md 4c).
//
// Room is not safe for concurrent use; the caller serialises it. In the real
// server that is one mutex per room, which is also what makes command ordering
// well-defined.
type Room struct {
	ID string

	anchor    vsync.Anchor
	seq       uint64
	corrector vsync.Corrector
	tun       vsync.Tunables
	sink      Sink

	members map[string]*Member
	ids     []string // sorted; Go randomises map iteration and the harness must be deterministic

	// NoStaleResend disables the stale-anchor resend, as a control. Without it
	// a client that missed a command holds a stale anchor and reports
	// residual ~= 0 -- because the residual is measured against that same
	// stale anchor -- while being arbitrarily out of position. No corrector
	// reads LastAppliedSeq, so nothing else notices.
	NoStaleResend bool

	// metrics
	StaleResends     int
	SeeksIssued      int
	NudgesIssued     int
	UnnecessarySeeks int // seek issued while the residual was already closing
	GatesOpened      int
	SeeksSuppressed  int // blocked by the cooldown or the failed-seek detector
	BiasLearned      int // clients whose clock bias we gave up on and absorbed
	GateFrames       int // Gate broadcasts actually put on the wire
	GatesWaived      int // members dropped from the gate by GATE_TIMEOUT
	NudgesSuppressed int // rate commands the client was already holding
	CmdsHeld         int // commands the gate held before applying
	JudgingDeferred  int // reports not judged because a command was not due yet
	GateHoldMs       int64

	// GateDisabled turns the hold off, as a control: the gate is still
	// announced but never delays anything. Without a measured comparison
	// "gating is better" is an assertion, and a member who is chronically slow
	// to buffer could make the gate worse than no gate at all.
	GateDisabled bool

	// lastCmdWhen is when the most recent command becomes due. Until then a
	// member that has not applied it is not stale -- it is early.
	lastCmdWhen int64

	// held is the one command the readiness gate is holding, if any. At most
	// one: any later command supersedes it, because holding a queue would let
	// a member who is slow to buffer replay a stale burst of user intent at
	// the room minutes later.
	held *heldCmd

	// gateSig is the last announced gated set, so a Gate frame goes out only
	// when the set CHANGES. Re-announcing it on every heartbeat would put a
	// broadcast on the wire at the report rate times the member count.
	gateSig string
}

// heldCmd is a command the gate is holding until the room is ready for it.
type heldCmd struct {
	by      string
	cmd     Cmd
	sinceMs int64
}

func New(id string, c vsync.Corrector, t vsync.Tunables, start vsync.Anchor, sink Sink) *Room {
	return &Room{
		ID: id, anchor: start, corrector: c, tun: t, sink: sink,
		members: map[string]*Member{},
		// Seed the signature with "nobody waiting, nothing held" so the first
		// report in a healthy room does not broadcast a gate frame announcing
		// that nothing is wrong.
		gateSig: "false|",
	}
}

func (r *Room) Anchor() vsync.Anchor     { return r.anchor }
func (r *Room) Seq() uint64              { return r.seq }
func (r *Room) Tunables() vsync.Tunables { return r.tun }
func (r *Room) Member(id string) *Member { return r.members[id] }
func (r *Room) Size() int                { return len(r.members) }
func (r *Room) SetSink(s Sink)           { r.sink = s }

// SetMediaKey names what the room is watching. Only meaningful before anyone
// has committed to a media: changing it afterwards is a `media` command, which
// takes a seq and re-anchors like every other transition.
func (r *Room) SetMediaKey(k string) { r.anchor.MediaKey = k }

// IDs returns the member ids in a stable order.
func (r *Room) IDs() []string { return r.ids }

func (r *Room) reindex() {
	r.ids = r.ids[:0]
	for id := range r.members {
		r.ids = append(r.ids, id)
	}
	sort.Strings(r.ids)
}

// Join adds a member. It does not send Welcome -- the transport does that,
// because only the transport knows whether the connection survived the join.
func (r *Room) Join(now int64, id, name string) *Member {
	m := &Member{ID: id, Name: name, LastSeenMs: now, ReadyState: 4}
	r.members[id] = m
	r.reindex()
	return m
}

// Leave removes a member and every trace of them from the correction state.
//
// The gate entry must go with them: Jellyfin's anti-hang rule is that a member
// who leaves while buffering counts as ready, otherwise a dropped connection
// freezes the room for someone who is no longer in it.
func (r *Room) Leave(now int64, id string) {
	if _, ok := r.members[id]; !ok {
		return
	}
	delete(r.members, id)
	r.reindex()
	if f, ok := r.corrector.(Forgetter); ok {
		f.Forget(id)
	}
	// Jellyfin's anti-hang rule: a member who leaves while buffering counts as
	// ready, so a dropped connection cannot freeze the room.
	r.releaseGate(now)
	r.announceGate()
}

// MemberList is the membership snapshot sent to clients.
func (r *Room) MemberList() []MemberInfo {
	out := make([]MemberInfo, 0, len(r.ids))
	for _, id := range r.ids {
		m := r.members[id]
		out = append(out, MemberInfo{
			ID: m.ID, Name: m.Name, Suspended: m.Suspended,
			Ready: m.ReadyState >= r.tun.MinReadyState,
		})
	}
	return out
}

func (r *Room) send(id string, m Msg) {
	if r.sink != nil {
		r.sink.Send(id, m)
	}
}

// Broadcast sends to every member; except is skipped when non-empty.
func (r *Room) Broadcast(except string, m Msg) {
	for _, id := range r.ids {
		if id == except {
			continue
		}
		r.send(id, m)
	}
}

// CmdDelay is clamp(2*p95_ping, 500, 2000). Capped because there is no host:
// one bad connection must not make every pause in the room sluggish.
func (r *Room) CmdDelay() int64 {
	// Alone, there is nobody to be simultaneous with, and the delay is pure
	// latency imposed on your own gesture: the anchor transitions CMD_DELAY
	// after you press, and your player is then moved to meet it -- a visible
	// jump of the whole delay, in whichever direction you were going. Measured
	// end to end, alone in a room on the 500 ms floor: pausing at 103.20 s put
	// the player at 103.70 s, and pressing play then pulled it from 104.31 s
	// back to 103.80 s. Neither jump synchronises anything with anybody.
	if len(r.ids) <= 1 {
		return 0
	}
	vals := make([]int64, 0, len(r.ids))
	for _, id := range r.ids {
		if m := r.members[id]; m.hasRTT {
			vals = append(vals, m.RTTMs)
		}
	}
	if len(vals) == 0 {
		return 500
	}
	sort.Slice(vals, func(i, j int) bool { return vals[i] < vals[j] })
	// A percentile is meaningless at n=3, and the naive ceil-index collapses to
	// max() for every room smaller than ~40 members -- so SYNTHESIS section 2's
	// "p95 so one outlier cannot dominate" was delivered by no code path. Use
	// second-highest once there are at least three members, the smallest honest
	// "drop the worst outlier"; below that the 2000 ms cap is the only
	// protection and we say so.
	idx := len(vals) - 1
	if len(vals) >= 3 {
		idx = len(vals) - 2
	}
	return vsync.ClampI(2*vals[idx], 500, 2000)
}

// OnTime answers a clock probe. Two server stamps, no arithmetic: the client
// owns the offset estimate, because only the client knows its own t1.
func (r *Room) OnTime(now int64, id string, m TimeReq) {
	r.send(id, TimeReply{T0: m.T0, TRecv: now, TSend: now})
}

// OnCmd serialises one user command: assign seq, move the anchor, schedule the
// transition into the future so every member transitions at the same instant.
func (r *Room) OnCmd(now int64, id string, m Cmd) {
	// Validate BEFORE taking a seq. A kind we do not understand used to fall
	// through the switch, burn a seq and broadcast a State that changed
	// nothing -- which still advances every client's lastAppliedSeq, so the
	// room would quietly agree it had transitioned to the same place.
	switch m.Kind {
	case "pause", "play", "seek":
	case "media":
		if m.MediaKey == "" {
			r.send(id, Error{Code: "bad_cmd", Msg: "media command needs a mediaKey"})
			return
		}
	default:
		r.send(id, Error{Code: "bad_kind", Msg: "unknown command kind " + m.Kind})
		return
	}
	if m.PositionMs < 0 {
		m.PositionMs = 0
	}

	// --- the readiness gate, section 6 -------------------------------------------
	//
	// Only `play` is held. Starting playback that somebody cannot follow is the
	// transition where being unready is actually fatal; mid-playback buffering
	// is handled by correcting that one member, which is what the whole
	// judge-don't-aggregate design is for. Gating every transition -- what
	// Jellyfin does -- turns one member's 200 ms rebuffer into a room-wide
	// stutter. `media` needs no gate because it lands paused by construction,
	// so the `play` that follows is the one that waits.
	//
	// Note what this does NOT require: any cooperation from the client. The
	// gate acts BEFORE the anchor moves, and the anchor is the only truth, so
	// there is nothing for a client to obey and nothing that can get stuck if
	// it does not.
	if m.Kind == "play" && !r.GateDisabled && len(r.Gated()) > 0 {
		r.held = &heldCmd{by: id, cmd: m, sinceMs: now}
		r.CmdsHeld++
		r.announceGate()
		return
	}
	// Any other command supersedes whatever was held: the user changed their
	// mind, and replaying stale intent minutes later would be worse than
	// dropping it.
	r.held = nil

	r.apply(now, id, m)
	r.announceGate()
}

// leavesRoomStopped reports whether the room will be paused once this command
// has been applied. `media` always lands paused by construction; a `seek`
// inherits the pause state it found.
func leavesRoomStopped(kind string, a vsync.Anchor) bool {
	switch kind {
	case "pause", "media":
		return true
	case "seek":
		return a.Paused
	}
	return false
}

// apply performs a command that has already been validated and cleared by the
// gate. Split out of OnCmd so a held command takes exactly the same path when
// it is finally released.
func (r *Room) apply(now int64, id string, m Cmd) {
	r.seq++

	// Simultaneity only buys anything while the clock is running.
	//
	// A command that leaves the room STOPPED needs no lead time: once everyone
	// is paused at the same position there is nothing left to happen at the
	// same instant, and the lead is spent entirely on making the person who
	// pressed pause watch their own picture jump forward -- into media they
	// never saw, which is the thing `SkippedMs` exists to count. So `when` is
	// now, and every member stops as soon as the command reaches them.
	//
	// A command that leaves the room PLAYING keeps the full lead, because from
	// then on everybody's clock is running and the instant is the whole point.
	when := now + r.CmdDelay()
	if leavesRoomStopped(m.Kind, r.anchor) {
		when = now
	}

	switch m.Kind {
	case "pause":
		// Anchor where the person actually stopped, not where the room would
		// have been at `when`. The pause and the position it happened at are
		// the thing being synchronised; projecting it forward invents a
		// position nobody chose and that the pauser never saw. `positionMs`
		// has always been on the wire for this command and was being thrown
		// away.
		r.anchor = r.anchor.Reanchor(m.PositionMs, when, true)
	case "play":
		r.anchor = r.anchor.Advance(when)
		r.anchor.Paused = false
	case "seek":
		r.anchor = r.anchor.Reanchor(m.PositionMs, when, r.anchor.Paused)
	case "media":
		// A new media resets the timebase completely: position, pause state and
		// identity all change at once, so nothing carries over from the old one.
		// It starts paused -- nobody has loaded it yet, and the readiness gate
		// is the mechanism that decides when the room may start.
		r.anchor = vsync.Anchor{PositionMs: m.PositionMs, AtServerMs: when,
			Paused: true, MediaKey: m.MediaKey}
	}
	r.lastCmdWhen = when
	st := State{Seq: r.seq, When: when, EmittedAt: now, Anchor: r.anchor, By: id, Kind: m.Kind}
	for _, mid := range r.ids {
		if mid == id {
			// Sender is excluded from the broadcast (echo suppression) but MUST
			// get the ack, or its lastAppliedSeq never advances and it cannot
			// tell stale state from fresh (SYNTHESIS 5 amendment).
			r.send(mid, Ack{ReqID: m.ReqID, Seq: r.seq, Anchor: r.anchor,
				When: when, EmittedAt: now, Kind: m.Kind})
			continue
		}
		r.send(mid, st)
	}
}

// OnReport judges one client's position report.
func (r *Room) OnReport(now int64, id string, in Report) {
	m := r.members[id]
	if m == nil {
		return
	}
	// The gate can open or close anywhere below, including on the stale-resend
	// path, so releasing and announcing are deferred rather than repeated.
	defer func() {
		r.releaseGate(now)
		r.announceGate()
	}()

	rep := in.Report
	// Identity comes from the connection, never from a field the sender fills.
	rep.ClientID = id

	m.LastSeenMs = now
	m.LastAppliedSeq = rep.LastAppliedSeq
	m.Suspended = rep.Suspended
	m.ReadyState = rep.ReadyState
	m.BufferedAheadS = rep.BufferedAheadS
	// Use the client's own measured round trip, not (now - its estimated server
	// time): the latter propagates one client's clock bias into the command
	// delay for the whole room. RTT is a difference of two same-clock
	// timestamps, so it carries no offset error.
	m.RTTMs, m.hasRTT = rep.RTTMs, true

	// A member that has not applied the newest command is mid-transition, and
	// there are exactly two things that can be true of it.
	//
	// A lagging lastAppliedSeq is the only signal that distinguishes "in sync"
	// from "confidently wrong about what it is syncing to": a client on a stale
	// anchor measures its residual against that same stale anchor, so it
	// reports ~0 while arbitrarily out of position. It is already on the wire
	// and nothing was reading it. Worth 115 603 ms -> 250 ms.
	//
	// But until it catches up, it is also measuring against a different anchor
	// than the one being judged against here -- so whatever residual it reports
	// is about that disagreement and not about drift. Judging it anyway issued
	// a "free seek" to every member one downlink before the transition they
	// already had scheduled (POC-FINDINGS 40a).
	//
	// Telling the two apart needs a grace period, and CMD_DELAY used to supply
	// one implicitly: a command was never due for at least 500 ms, which is
	// longer than delivery. A command that leaves the room stopped carries no
	// lead at all, so every remote member looked stale for one downlink delay
	// and drew a resend on every single pause -- command-storm StaleResends
	// 1 -> 4. Make the grace explicit and derive it from the member's own
	// measured round trip: it cannot be stale until the command has had time to
	// reach it.
	if rep.LastAppliedSeq < r.seq {
		switch {
		case r.NoStaleResend:
			// The control arm: judge it anyway, which is what produced the
			// 115 603 ms figure the resend exists to fix.
		case now >= r.lastCmdWhen+m.RTTMs:
			r.StaleResends++
			r.send(id, State{Seq: r.seq, When: now, EmittedAt: now,
				Anchor: r.anchor, By: "server", Kind: "resync"})
			return
		default:
			r.JudgingDeferred++
			return
		}
	}

	cs := &m.corr

	// Judge the *effective* residual: what remains after subtracting the bias
	// we have learned about this client's clock estimate.
	eff := rep
	eff.ResidualMs = rep.ResidualMs - cs.biasMs

	// Did the last seek accomplish anything? If we seeked and the residual is
	// essentially unchanged, the fault is not the player's position -- it is
	// our own idea of where the client should be.
	if cs.lastSeekAt > 0 && now-cs.lastSeekAt > seekCooldownMs/2 && cs.residualAtSeek != 0 {
		improved := abs64(eff.ResidualMs) <= int64(float64(abs64(cs.residualAtSeek))*seekImprovementFrac)
		if improved {
			cs.failedSeeks = 0
		} else {
			cs.failedSeeks++
			if cs.failedSeeks >= failedSeeksBeforeBias {
				// Absorb it. A residual that survives repeated seeks IS the
				// clock bias, and it is the only way to observe a one-way
				// latency asymmetry that min-RTT cannot see. Bound the learned
				// bias by the client's own uncertainty: unbounded, a *lost*
				// correction message is indistinguishable from a biased clock
				// and the learner strands that client for the whole session.
				// The principled bound is the one the timebase analysis
				// derived -- a laundered offset satisfies |B| <= R_min/2,
				// which is exactly UncertaintyMs.
				bound := rep.UncertaintyMs
				if bound <= 0 {
					bound = r.tun.ToleranceMs
				}
				cs.biasMs = vsync.ClampI(cs.biasMs+eff.ResidualMs, -bound, bound)
				cs.failedSeeks = 0
				r.BiasLearned++
				eff.ResidualMs = rep.ResidualMs - cs.biasMs
			}
		}
		cs.lastSeekAt = 0
	}

	d := r.corrector.Decide(eff, r.anchor, now, r.tun)
	// Readiness is a fact about this report, not about what the corrector
	// wants done with it. Clearing the gate only on ActionNone left a member
	// who was ready again but still being nudged -- the servo nudges for as
	// long as it holds a rate bias, and a paused member never integrates one
	// away -- gated indefinitely, holding every later play until they left
	// (BROWSER-FINDINGS §15). The timeout below never fires for them either:
	// it is only checked on a report that is itself unready.
	if d.Action != vsync.ActionGate {
		m.gated, m.gateWaived = false, false
	}
	switch d.Action {
	case vsync.ActionSeek:
		if now-cs.lastSeekAt < seekCooldownMs && cs.lastSeekAt > 0 {
			r.SeeksSuppressed++
			break
		}
		r.SeeksIssued++
		if eff.Closing() && abs64(eff.ResidualMs) < r.tun.NudgeMaxResidual {
			r.UnnecessarySeeks++
		}
		cs.lastSeekAt = now
		cs.residualAtSeek = eff.ResidualMs
		r.send(id, Correct{Mode: "seek", When: now, Why: d.Why})
	case vsync.ActionNudge:
		if r.rateAlreadyHeld(m, d.Rate, now) {
			r.NudgesSuppressed++
			break
		}
		r.NudgesIssued++
		m.lastRate, m.lastRateAt = d.Rate, now
		r.send(id, Correct{Mode: "nudge", Rate: d.Rate, When: now, Why: d.Why})
	case vsync.ActionGate:
		if !m.gated && !m.gateWaived {
			m.gated, m.gatedAt = true, now
			r.GatesOpened++
		}
		// Anti-hang: a member stuck buffering past the timeout is dropped from
		// the gate and the room continues without them. The waiver latches --
		// see Member.gateWaived.
		if m.gated && now-m.gatedAt > GateTimeoutMs {
			m.gated, m.gateWaived = false, true
			r.GatesWaived++
		}
	default:
		// Only clear the rate when the client is genuinely back in tolerance.
		// Clearing it while a nudge is still closing the gap cancels the
		// correction that is working.
		if d.ResetRate {
			if r.rateAlreadyHeld(m, 1.0, now) {
				r.NudgesSuppressed++
				break
			}
			m.lastRate, m.lastRateAt = 1.0, now
			r.send(id, Correct{Mode: "nudge", Rate: 1.0, When: now, Why: "in tolerance"})
		}
	}
}

// announceGate broadcasts the readiness gate, but only when the gated set has
// actually changed. Every caller that can open or close a gate must end with
// this, including Leave and Tick -- the gate is the one piece of room state
// that can be entered by a report and left by silence.
//
// Jellyfin's anti-hang rule is that a member who leaves while buffering counts
// as ready. We add what it lacks: GateTimeoutMs, after which a member who is
// still buffering is dropped from the gate and the room resumes without them.
func (r *Room) announceGate() {
	ids := r.Gated()
	held := r.held != nil
	// `waiting` means the room is actually being held; `waitingOn` is who is
	// not ready. They are different facts: a member buffering mid-playback is
	// worth showing in the UI without stopping anybody.
	sig := strconv.FormatBool(held) + "|" + strings.Join(ids, ",")
	if sig == r.gateSig {
		return
	}
	r.gateSig = sig
	r.GateFrames++
	r.Broadcast("", Gate{Waiting: held, WaitingOn: ids, Reason: "buffering"})
}

// Tick is the room's own timer: it expires readiness gates held by members who
// have stopped reporting at all. Without it a member who buffers and then
// vanishes without closing the socket holds the gate until the socket dies.
func (r *Room) Tick(now int64) {
	for _, id := range r.ids {
		m := r.members[id]
		if m.gated && now-m.gatedAt > GateTimeoutMs {
			m.gated, m.gateWaived = false, true
			r.GatesWaived++
		}
	}
	// A member who buffers and then stops reporting entirely would otherwise
	// hold a `play` forever; the timeout above is what makes that finite.
	r.releaseGate(now)
	r.announceGate()
}

// OnChat broadcasts a chat line. The server stamps the time and the identity;
// neither is taken from the frame.
func (r *Room) OnChat(now int64, id string, in ChatIn) {
	m := r.members[id]
	if m == nil {
		return
	}
	r.Broadcast("", ChatOut{From: id, Name: m.Name, Text: in.Text, ServerMs: now})
}

// releaseGate applies the held command once nobody is holding the room back.
// Called from every place a member can become ready or disappear.
func (r *Room) releaseGate(now int64) {
	if r.held == nil || len(r.Gated()) > 0 {
		return
	}
	h := r.held
	r.held = nil
	r.GateHoldMs += now - h.sinceMs
	// The originator is still the originator: they get the ack, everyone else
	// gets the broadcast, exactly as if the command had arrived now.
	r.apply(now, h.by, h.cmd)
}

// Held reports whether the gate is currently holding a command.
func (r *Room) Held() bool { return r.held != nil }

// rateAlreadyHeld reports whether telling this client to run at `rate` would
// change nothing.
//
// The tolerance is one part in a thousand -- far finer than the 5% the rate
// clamp allows, so no real correction is ever swallowed. The refresh exists
// because a `correct` is unicast and unacknowledged: if the one that set the
// rate was lost, nothing else would ever tell the client again. Re-stating it
// every few seconds is cheaper than adding an acknowledgement, and cheaper
// than putting the client's current rate in every heartbeat.
func (r *Room) rateAlreadyHeld(m *Member, rate float64, now int64) bool {
	if m.lastRateAt == 0 {
		return false
	}
	if now-m.lastRateAt > rateRefreshMs {
		return false
	}
	d := m.lastRate - rate
	return d < 0.001 && d > -0.001
}

// Gated returns the ids currently held by the readiness gate, in stable order.
func (r *Room) Gated() []string {
	var out []string
	for _, id := range r.ids {
		if r.members[id].gated {
			out = append(out, id)
		}
	}
	return out
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
