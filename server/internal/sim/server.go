package sim

import (
	"sort"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Server is the room: timebase owner and judge. It is not an aggregator --
// client reports decide who needs correcting and whether the gate fires, they
// never move the anchor (research/SYNTHESIS.md 4c).
type Server struct {
	anchor    vsync.Anchor
	seq       uint64
	corrector vsync.Corrector
	tun       vsync.Tunables

	pings map[string]int64 // client -> observed RTT, for the command delay
	gated map[string]int64 // client -> server time it started gating
	corr  map[string]*corrState

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
}

// corrState tracks whether our corrections are actually working on one client.
// Motivation: docs/POC-FINDINGS.md section 2 -- under one-way latency
// asymmetry the clock offset is biased, the residual never closes, and a
// tight deadband turns into thousands of useless seeks. No reference
// implementation detects this.
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
)

func NewServer(c vsync.Corrector, t vsync.Tunables, start vsync.Anchor) *Server {
	return &Server{anchor: start, corrector: c, tun: t,
		pings: map[string]int64{}, gated: map[string]int64{}, corr: map[string]*corrState{}}
}

func (s *Server) Anchor() vsync.Anchor { return s.anchor }

// cmdDelay is clamp(2*p95_ping, 500, 2000). Capped because there is no host:
// one bad connection must not make every pause in the room sluggish.
func (s *Server) cmdDelay() int64 {
	if len(s.pings) == 0 {
		return 500
	}
	var vals []int64
	for _, v := range s.pings {
		vals = append(vals, v)
	}
	// insertion sort; the room is small and this keeps the run deterministic
	for i := 1; i < len(vals); i++ {
		for j := i; j > 0 && vals[j] < vals[j-1]; j-- {
			vals[j], vals[j-1] = vals[j-1], vals[j]
		}
	}
	// A percentile is meaningless at n=3, and the naive ceil-index collapses
	// to max() for every room smaller than ~40 members -- so SYNTHESIS section 2's
	// "p95 so one outlier cannot dominate" was delivered by no code path.
	// Use second-highest once there are at least three members, which is the
	// smallest honest "drop the worst outlier"; below that the 2000 ms cap is
	// the only protection and we say so.
	idx := len(vals) - 1
	if len(vals) >= 3 {
		idx = len(vals) - 2
	}
	return vsync.ClampI(2*vals[idx], 500, 2000)
}

func (s *Server) Deliver(e envelope, net *Network, now int64, clients map[string]*Client) {
	switch v := e.msg.(type) {
	case MsgTimeReq:
		net.Send(now, v.ClientID, "server", v.ClientID, false,
			MsgTimeReply{T0: v.T0, TRecv: now, TSend: now})

	case MsgCmd:
		// Per-room mutex equivalent: single-threaded arrival-order serialization.
		s.seq++
		when := now + s.cmdDelay()
		switch v.Kind {
		case "pause":
			s.anchor = s.anchor.Advance(when)
			s.anchor.Paused = true
		case "play":
			s.anchor = s.anchor.Advance(when)
			s.anchor.Paused = false
		case "seek":
			s.anchor = s.anchor.Reanchor(v.PositionMs, when, s.anchor.Paused)
		}
		st := MsgState{Seq: s.seq, When: when, EmittedAt: now, Anchor: s.anchor, By: v.ClientID, Kind: v.Kind}
		// Sorted, not map order: Go randomises map iteration, so the send order
		// varied run to run, which perturbed the network queue's tie-break and
		// the jitter draws. The harness was not actually deterministic.
		ids := make([]string, 0, len(clients))
		for id := range clients {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			if id == v.ClientID {
				// Sender is excluded from the broadcast but MUST get the ack,
				// or its lastAppliedSeq never advances (SYNTHESIS 5 amendment).
				net.Send(now, id, "server", id, false, MsgAck{
					ReqID: v.ReqID, Seq: s.seq, Anchor: s.anchor,
					When: when, EmittedAt: now, Kind: v.Kind})
				continue
			}
			net.Send(now, id, "server", id, false, st)
		}

	case MsgReport:
		r := v.R
		// Use the client's own measured round trip, not (now - its estimated
		// server time): the latter propagates one client's clock bias into the
		// command delay for the whole room. RTT is a difference of two
		// same-clock timestamps, so it carries no offset error.
		s.pings[r.ClientID] = r.RTTMs

		// A lagging lastAppliedSeq is the only signal that distinguishes "in
		// sync" from "confidently wrong about what it is syncing to". It is
		// already on the wire and nothing was reading it.
		if !s.NoStaleResend && r.LastAppliedSeq < s.seq {
			s.StaleResends++
			net.Send(now, r.ClientID, "server", r.ClientID, false, MsgState{
				Seq: s.seq, When: now, EmittedAt: now, Anchor: s.anchor, By: "server", Kind: "resync"})
			return
		}

		cs := s.corr[r.ClientID]
		if cs == nil {
			cs = &corrState{}
			s.corr[r.ClientID] = cs
		}

		// Judge the *effective* residual: what remains after subtracting the
		// bias we have learned about this client's clock estimate.
		eff := r
		eff.ResidualMs = r.ResidualMs - cs.biasMs

		// Did the last seek accomplish anything? If we seeked and the residual
		// is essentially unchanged, the fault is not the player's position --
		// it is our own idea of where the client should be.
		if cs.lastSeekAt > 0 && now-cs.lastSeekAt > seekCooldownMs/2 && cs.residualAtSeek != 0 {
			improved := absI(eff.ResidualMs) <= int64(float64(absI(cs.residualAtSeek))*seekImprovementFrac)
			if improved {
				cs.failedSeeks = 0
			} else {
				cs.failedSeeks++
				if cs.failedSeeks >= failedSeeksBeforeBias {
					// Absorb it. A residual that survives repeated seeks IS the
					// clock bias, and it is the only way to observe a one-way
					// latency asymmetry that min-RTT cannot see.
					// Bound the learned bias by the client's own uncertainty.
					// Unbounded, a *lost* correction message is
					// indistinguishable from a biased clock, and the learner
					// will absorb a genuine multi-second step as "bias" and
					// strand that client for the rest of the session. The
					// principled bound is the one the timebase analysis
					// derived: a laundered/undetectable offset satisfies
					// |B| <= R_min/2, which is exactly UncertaintyMs.
					bound := r.UncertaintyMs
					if bound <= 0 {
						bound = s.tun.ToleranceMs
					}
					cs.biasMs = vsync.ClampI(cs.biasMs+eff.ResidualMs, -bound, bound)
					cs.failedSeeks = 0
					s.BiasLearned++
					eff.ResidualMs = r.ResidualMs - cs.biasMs
				}
			}
			cs.lastSeekAt = 0
		}

		d := s.corrector.Decide(eff, s.anchor, now, s.tun)
		switch d.Action {
		case vsync.ActionSeek:
			if now-cs.lastSeekAt < seekCooldownMs && cs.lastSeekAt > 0 {
				s.SeeksSuppressed++
				break
			}
			s.SeeksIssued++
			if eff.Closing() && absI(eff.ResidualMs) < s.tun.NudgeMaxResidual {
				s.UnnecessarySeeks++
			}
			cs.lastSeekAt = now
			cs.residualAtSeek = eff.ResidualMs
			net.Send(now, r.ClientID, "server", r.ClientID, false,
				MsgCorrect{Mode: "seek", When: now, Why: d.Why})
		case vsync.ActionNudge:
			s.NudgesIssued++
			net.Send(now, r.ClientID, "server", r.ClientID, false,
				MsgCorrect{Mode: "nudge", Rate: d.Rate, When: now, Why: d.Why})
		case vsync.ActionGate:
			if _, ok := s.gated[r.ClientID]; !ok {
				s.gated[r.ClientID] = now
				s.GatesOpened++
			}
			// Anti-hang: a member stuck buffering past the timeout is dropped
			// from the gate and the room continues without them.
			if now-s.gated[r.ClientID] > gateTimeoutMs {
				delete(s.gated, r.ClientID)
			}
		default:
			delete(s.gated, r.ClientID)
			// Only clear the rate when the client is genuinely back in
			// tolerance. Clearing it while a nudge is still closing the gap
			// cancels the correction that is working.
			if d.ResetRate {
				net.Send(now, r.ClientID, "server", r.ClientID, false,
					MsgCorrect{Mode: "nudge", Rate: 1.0, When: now, Why: "in tolerance"})
			}
		}
	}
}

func absI(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
