package sim

import (
	"math"
	"sort"
	"strconv"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Command is a user action injected by a scenario at a given server time.
type Command struct {
	AtMs       int64
	ClientID   string
	Kind       string
	PositionMs int64
}

// Scenario is one reproducible experiment.
type Scenario struct {
	Name        string
	Seed        int64
	DurationMs  int64
	Clients     []ClientProfile
	Commands    []Command
	StartPos    int64
	StartPaused bool
	// NoStaleResend is a control: see Server.NoStaleResend.
	NoStaleResend bool
	// GateDisabled is a control: announce the readiness gate but never hold a
	// command for it. "Gating is better" is an assertion until this is run.
	GateDisabled bool
}

// Result is what we compare strategies on.
type Result struct {
	Scenario  string
	Corrector string

	// Inter-client spread. Kept for continuity with earlier rounds, but it
	// REWARDS INACTION: in a scenario where clients start aligned at 1.0x, a
	// strategy that does nothing scores a perfect 0. It cannot distinguish
	// "correctly did nothing" from "was never tested", and it cannot see the
	// whole room drifting away from the anchor together.
	MaxDivergenceMs  float64
	P95DivergenceMs  float64
	MeanDivergenceMs float64

	// Anchor error is |clientPos - anchor.Expected(TRUE server time)| -- the
	// quantity a corrector is actually minimising, measured against the real
	// clock rather than any client's estimate of it. This is the primary
	// metric. Blanked for 4 s after each command, when nobody is meant to be
	// in position yet; ConvergeMs covers the transition.
	MeanAnchorErrMs float64
	P95AnchorErrMs  float64

	SeeksIssued      int
	UnnecessarySeeks int
	NudgesIssued     int
	GatesOpened      int
	SeeksSuppressed  int
	BiasLearned      int
	StaleResends     int
	// CmdsHeld counts commands the readiness gate delayed, GateHoldMs the
	// total time they spent held. Both are costs, not achievements: the gate
	// buys alignment by making somebody wait.
	CmdsHeld   int
	GateHoldMs int64
	// SkippedMs is media the room skipped past for its members: the sum of
	// forward displacement imposed by server-ordered seeks. It is the cost the
	// gate exists to prevent and the reason anchorErr alone cannot score it --
	// anchorErr excludes a stalled client, so leaving someone behind and then
	// yanking them forward looks like a good run.
	SkippedMs float64
	// Seeks split by what they actually cost: an in-buffer seek is ~free, an
	// out-of-buffer seek costs a segment fetch AND rebuffers for it.
	InBufferSeeks    int
	OutOfBufferSeeks int
	// RateTimeMs = sum over clients of integral |playbackRate-1| dt. The honest
	// counterpart to seek count, because nudge count is not comparable across
	// control laws.
	RateTimeMs float64
	// Misdetections counts stalls the client's detector mistook for user
	// seeks. Any value > 0 means the room would have been dragged backward by
	// someone's buffering -- the bug syncplay ships.
	Misdetections int
	// SpuriousCmds counts commands originated by the browser rather than by a
	// user -- a hidden muted tab's pause/play. Each one moves the whole room.
	SpuriousCmds int
	// RoomPausedBySuspension counts anchor transitions into paused that were
	// caused by a suspended member.
	RoomPausedBySuspension int
	// SiteSpuriousCmds is the part of SpuriousCmds that a member's own site
	// caused on arrival -- autoplay, resume (C1). SiteMovesAbsorbed is how
	// many such moves the acquisition guard put back instead.
	SiteSpuriousCmds  int
	SiteMovesAbsorbed int

	// The next episode. MediaApplied is how many `media` commands moved the
	// room (each restarts it at 0, paused); MediaStale how many the
	// compare-and-set refused; ContinuationsSent how many members' sites sent
	// one. ArrivedLateMs is the part of SkippedMs that members lost by being
	// conformed into a new episode the room had already started without them.
	MediaApplied      int
	MediaStale        int
	ContinuationsSent int
	ArrivedLateMs     float64

	// ConvergeMs is time from each command until every non-stalled client is
	// within tolerance of the anchor. -1 means it never converged.
	ConvergeMs []int64

	// FinalAnchor is the room's anchor when the run ended.
	FinalAnchor vsync.Anchor
}

// Run executes one scenario against one corrector. Deterministic: same seed,
// same result, every time.
func Run(sc Scenario, corr vsync.Corrector, tun vsync.Tunables) Result {
	net := NewNetwork(sc.Seed)
	clients := map[string]*Client{}
	var order []string
	for _, p := range sc.Clients {
		net.SetLink(p.ID, p.Link)
		clients[p.ID] = NewClient(p, float64(sc.StartPos), sc.StartPaused)
		order = append(order, p.ID)
	}
	sort.Strings(order)

	start := vsync.Anchor{PositionMs: sc.StartPos, AtServerMs: 0, Paused: sc.StartPaused, MediaKey: "m"}
	srv := NewServer(corr, tun, start)
	srv.NoStaleResend = sc.NoStaleResend
	srv.GateDisabled = sc.GateDisabled
	// Membership follows the shipped path: a member joins when it connects and
	// leaves when the connection goes, and every session starts from a welcome.
	// Joining everyone at t=0 regardless made a late joiner count toward the
	// command delay before it existed, and a reconnect a session that never
	// ended.
	connected := map[string]bool{}
	updateMembership := func(now int64) {
		for _, id := range order {
			c := clients[id]
			online := !c.Offline(now)
			switch {
			case connected[id] && !online:
				srv.Disconnect(now, net, id)
				c.Disconnect()
				connected[id] = false
			case !connected[id] && online:
				srv.Connect(now, net, id)
				c.Welcome(srv.Seq(), srv.Anchor(), now)
				connected[id] = true
			}
		}
	}

	var divergences []float64
	var anchorErrs []float64
	roomPausedBySuspension := 0
	lastCmdAt := int64(-1 << 40)
	cmdIdx := 0
	type pendingConv struct{ at int64 }
	var awaiting []pendingConv
	converge := []int64{}

	for now := int64(0); now <= sc.DurationMs; now += stepMs {
		// 0. connections come and go
		updateMembership(now)

		// 1. deliver
		for _, e := range net.Due(now) {
			// A message in flight when the link drops is lost, in both
			// directions -- that is what makes reconnect a real test.
			if c, ok := clients[e.from]; ok && c.Offline(now) {
				continue
			}
			if e.to == "server" {
				srv.Deliver(e, net, now, clients)
			} else if c, ok := clients[e.to]; ok {
				if c.Offline(now) || c.dropsDown(now) {
					continue
				}
				c.Deliver(e.msg, now)
			}
		}

		// 2. scenario commands
		for cmdIdx < len(sc.Commands) && sc.Commands[cmdIdx].AtMs <= now {
			cm := sc.Commands[cmdIdx]
			pos := cm.PositionMs
			if cm.Kind == "pause" || cm.Kind == "play" {
				// A pressed button carries where the presser's player is --
				// the engine always sends it, and the room anchors a pause
				// there. Left to the scenario it was 0, and every scripted
				// pause rewound the room to the start.
				pos = int64(clients[cm.ClientID].Pos())
			}
			net.Send(now, cm.ClientID, cm.ClientID, "server", true,
				MsgCmd{ReqID: strconv.Itoa(cmdIdx), Kind: cm.Kind, PositionMs: pos})
			awaiting = append(awaiting, pendingConv{at: now})
			lastCmdAt = now
			cmdIdx++
		}

		// 3. advance players, apply scheduled commands, drain client-originated
		//    commands (browser-driven pause/play among them)
		for _, id := range order {
			c := clients[id]
			if c.Offline(now) {
				// Still playing locally -- a dropped connection does not pause
				// anyone's video, which is exactly why they drift apart. A
				// member that has not joined yet has not started watching.
				if c.Joined() {
					c.Advance(now, stepMs)
				}
				continue
			}
			c.UpdateSuspension(now)
			c.UpdateSite(now)
			c.RunScheduled(now)
			c.UpdateEpisode(now)
			c.Advance(now, stepMs)
			for _, cm := range c.TakeOutbox() {
				if cm.Kind == "pause" && c.Suspended() {
					roomPausedBySuspension++
				}
				net.Send(now, id, id, "server", true, cm)
			}
		}

		// 4. client timers
		for _, id := range order {
			c := clients[id]
			if c.Offline(now) {
				continue
			}
			// Probe fast at the start of every session, not only the first:
			// a reconnect starts from no clock at all.
			since := now - c.connectedAt
			if now%timeSyncEveryMs == 0 || (since < 250 && since%50 == 0) {
				c.TimeSync(net, now)
			}
			// One look per tick. The heartbeat is not a second evaluation at
			// the same instant -- it is this one, reported regardless.
			if now%evalIntervalMs == 0 {
				if r, ok := c.Evaluate(now, tun, now%hbIntervalMs == 0); ok {
					net.Send(now, id, id, "server", true, MsgReport{Report: r})
				}
			}
		}

		// 5. metrics
		if now%metricSampleMs == 0 {
			var live []float64
			for _, id := range order {
				c := clients[id]
				if c.stalled(now) || c.Offline(now) || c.Suspended() || c.holdsPlayer() {
					continue // legitimately behind, absent, or not watching
				}
				live = append(live, c.Pos())
			}
			if now-lastCmdAt > 4000 {
				exp := float64(srv.Anchor().Expected(now))
				for _, id := range order {
					c := clients[id]
					if c.stalled(now) || !c.haveOffset || c.Offline(now) || c.Suspended() || c.holdsPlayer() {
						continue
					}
					anchorErrs = append(anchorErrs, math.Abs(c.Pos()-exp))
				}
			}
			if len(live) >= 2 {
				mn, mx := live[0], live[0]
				for _, v := range live {
					mn = math.Min(mn, v)
					mx = math.Max(mx, v)
				}
				divergences = append(divergences, mx-mn)
			}
			// convergence check
			if len(awaiting) > 0 {
				allIn := true
				for _, id := range order {
					c := clients[id]
					if c.stalled(now) || !c.haveOffset || c.Offline(now) || c.Suspended() || c.holdsPlayer() {
						continue
					}
					exp := float64(srv.Anchor().Expected(c.serverNowEst(now)))
					if math.Abs(c.Pos()-exp) > float64(tun.ToleranceMs) {
						allIn = false
						break
					}
				}
				if allIn {
					converge = append(converge, now-awaiting[0].at)
					awaiting = awaiting[1:]
				}
			}
		}
	}
	for range awaiting {
		converge = append(converge, -1)
	}

	res := Result{
		Scenario: sc.Name, Corrector: corr.Name(),
		SeeksIssued: srv.SeeksIssued, UnnecessarySeeks: srv.UnnecessarySeeks,
		NudgesIssued: srv.NudgesIssued, GatesOpened: srv.GatesOpened,
		SeeksSuppressed: srv.SeeksSuppressed, BiasLearned: srv.BiasLearned,
		StaleResends:           srv.StaleResends,
		CmdsHeld:               srv.CmdsHeld,
		GateHoldMs:             srv.GateHoldMs,
		RoomPausedBySuspension: roomPausedBySuspension,
		MediaApplied:           srv.MediaApplied,
		MediaStale:             srv.MediaStale,
		ConvergeMs:             converge,
		FinalAnchor:            srv.Anchor(),
	}
	for _, id := range order {
		c := clients[id]
		res.Misdetections += c.Misdetections
		res.SpuriousCmds += c.SpuriousCmds
		res.SiteSpuriousCmds += c.SiteSpuriousCmds
		res.SiteMovesAbsorbed += c.SiteMovesAbsorbed
		res.InBufferSeeks += c.InBufferSeeks
		res.OutOfBufferSeeks += c.OutOfBufferSeeks
		res.RateTimeMs += c.RateTimeMs
		res.SkippedMs += c.SkippedMs
		res.ContinuationsSent += c.ContinuationsSent
		res.ArrivedLateMs += c.ArrivedLateMs
	}
	if len(divergences) > 0 {
		sorted := append([]float64(nil), divergences...)
		sort.Float64s(sorted)
		res.MaxDivergenceMs = sorted[len(sorted)-1]
		res.P95DivergenceMs = sorted[int(float64(len(sorted))*0.95)]
		var sum float64
		for _, v := range divergences {
			sum += v
		}
		res.MeanDivergenceMs = sum / float64(len(divergences))
	}
	if len(anchorErrs) > 0 {
		sorted := append([]float64(nil), anchorErrs...)
		sort.Float64s(sorted)
		res.P95AnchorErrMs = sorted[int(float64(len(sorted))*0.95)]
		var sum float64
		for _, v := range anchorErrs {
			sum += v
		}
		res.MeanAnchorErrMs = sum / float64(len(anchorErrs))
	}
	return res
}

// ConfidenceGatedStepRamp is the current best strategy (POC-FINDINGS section 11),
// named once so tests do not each re-spell it.
func ConfidenceGatedStepRamp() vsync.Corrector {
	return vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}}
}
