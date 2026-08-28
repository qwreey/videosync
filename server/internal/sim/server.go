package sim

import (
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

	// metrics
	SeeksIssued      int
	NudgesIssued     int
	UnnecessarySeeks int // seek issued while the residual was already closing
	GatesOpened      int
}

func NewServer(c vsync.Corrector, t vsync.Tunables, start vsync.Anchor) *Server {
	return &Server{anchor: start, corrector: c, tun: t,
		pings: map[string]int64{}, gated: map[string]int64{}}
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
	idx := (len(vals)*95 + 99) / 100
	if idx >= len(vals) {
		idx = len(vals) - 1
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
		for id := range clients {
			if id == v.ClientID {
				// Sender is excluded from the broadcast but MUST get the ack,
				// or its lastAppliedSeq never advances (SYNTHESIS 5 amendment).
				net.Send(now, id, "server", id, false, MsgAck{ReqID: v.ReqID, Seq: s.seq, Anchor: s.anchor})
				continue
			}
			net.Send(now, id, "server", id, false, st)
		}

	case MsgReport:
		r := v.R
		s.pings[r.ClientID] = now - r.AtServerMs + 0 // crude one-way estimate
		d := s.corrector.Decide(r, s.anchor, now, s.tun)
		switch d.Action {
		case vsync.ActionSeek:
			s.SeeksIssued++
			// Would this seek have been unnecessary? If the residual was
			// already closing and within nudge range, the client would have
			// recovered on its own. This is the metric that separates the
			// two strategies.
			if r.Closing() && absI(r.ResidualMs) < s.tun.NudgeMaxResidual {
				s.UnnecessarySeeks++
			}
			net.Send(now, r.ClientID, "server", r.ClientID, false,
				MsgCorrect{Mode: "seek", TargetMs: d.TargetMs, When: now, Why: d.Why})
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
