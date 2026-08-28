package sim

import (
	"math"
	"sort"

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
	Name       string
	Seed       int64
	DurationMs int64
	Clients    []ClientProfile
	Commands   []Command
	StartPos   int64
	StartPaused bool
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
	// Misdetections counts stalls the client's detector mistook for user
	// seeks. Any value > 0 means the room would have been dragged backward by
	// someone's buffering -- the bug syncplay ships.
	Misdetections int

	// ConvergeMs is time from each command until every non-stalled client is
	// within tolerance of the anchor. -1 means it never converged.
	ConvergeMs []int64
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
	for _, id := range order {
		clients[id].anchor = start
		clients[id].lastKnownPos = float64(sc.StartPos)
	}

	var divergences []float64
	var anchorErrs []float64
	lastCmdAt := int64(-1 << 40)
	cmdIdx := 0
	type pendingConv struct{ at int64 }
	var awaiting []pendingConv
	converge := []int64{}

	for now := int64(0); now <= sc.DurationMs; now += stepMs {
		// 1. deliver
		for _, e := range net.Due(now) {
			if e.to == "server" {
				srv.Deliver(e, net, now, clients)
			} else if c, ok := clients[e.to]; ok {
				c.Deliver(e.msg, now)
			}
		}

		// 2. scenario commands
		for cmdIdx < len(sc.Commands) && sc.Commands[cmdIdx].AtMs <= now {
			cm := sc.Commands[cmdIdx]
			net.Send(now, cm.ClientID, cm.ClientID, "server", true,
				MsgCmd{ClientID: cm.ClientID, ReqID: cmdIdx, Kind: cm.Kind, PositionMs: cm.PositionMs})
			awaiting = append(awaiting, pendingConv{at: now})
			lastCmdAt = now
			cmdIdx++
		}

		// 3. advance players and apply scheduled commands
		for _, id := range order {
			c := clients[id]
			c.RunScheduled(now)
			c.Advance(now, stepMs)
		}

		// 4. client timers
		for _, id := range order {
			c := clients[id]
			if now%timeSyncEveryMs == 0 || (now < 250 && now%50 == 0) {
				c.TimeSync(net, now)
			}
			if now%evalIntervalMs == 0 {
				if r, ok := c.Evaluate(now, tun, false); ok {
					net.Send(now, id, id, "server", true, MsgReport{R: r})
				}
			}
			if now%hbIntervalMs == 0 {
				if r, ok := c.Evaluate(now, tun, true); ok {
					net.Send(now, id, id, "server", true, MsgReport{R: r})
				}
			}
		}

		// 5. metrics
		if now%metricSampleMs == 0 {
			var live []float64
			for _, id := range order {
				c := clients[id]
				if c.stalled(now) {
					continue // legitimately behind; that is the gate's job
				}
				live = append(live, c.Pos())
			}
			if now-lastCmdAt > 4000 {
				exp := float64(srv.Anchor().Expected(now))
				for _, id := range order {
					c := clients[id]
					if c.stalled(now) || !c.haveOffset {
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
					if c.stalled(now) || !c.haveOffset {
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
		ConvergeMs: converge,
	}
	for _, id := range order {
		res.Misdetections += clients[id].Misdetections
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
