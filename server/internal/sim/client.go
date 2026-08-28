package sim

import (
	"math"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// ClientProfile is the adversarial condition we impose on one simulated client.
type ClientProfile struct {
	ID string
	// IntrinsicRate models a player that does not run at exactly 1.0x --
	// a slow decoder, a throttled tab. 0.998 drifts 2 ms behind per second.
	IntrinsicRate float64
	// ClockSkewMs is the client's wall clock error vs the server. The client
	// does not know it and must estimate it out via min-RTT sampling.
	ClockSkewMs int64
	// Stalls are [start, end) windows in server time where the player buffers.
	Stalls [][2]int64
	Link   Link
	// NoStallInference disables the stall guard, reproducing what syncplay
	// ships (client.py:521-531 dead-reckons whenever paused is false, with no
	// buffering guard). Used as a control: a Misdetections count of 0 proves
	// nothing unless the same scenario produces a non-zero count without it.
	NoStallInference bool
}

// Client is a simulated player plus the client half of the sync protocol.
type Client struct {
	P ClientProfile

	// --- player state (ground truth, the client can observe it exactly) ---
	posMs       float64
	paused      bool
	appliedRate float64
	readyState  int
	bufferedS   float64

	// --- clock estimate ---
	estOffsetMs  int64 // add to client clock to get server clock
	bestRTT      int64
	haveOffset   bool
	clockSamples int

	// --- sync state ---
	anchor         vsync.Anchor
	lastAppliedSeq uint64
	lastKnownPos   float64 // for the two-diff test
	residualHist   []sample
	pending        []MsgState // scheduled commands not yet due

	// stall inference -- the client cannot call stalled(); it must work this
	// out from what a real <video> exposes: readyState, and the fact that
	// currentTime stops advancing while paused is still false.
	stallSuspected bool
	lastEvalPos    float64
	haveEvalPos    bool

	// counters the harness reads
	SeeksApplied  int
	NudgesApplied int
	// SeekDetections counts genuine user-seek detections. Any increment during
	// a buffering stall is a MISDETECTION -- the bug syncplay ships
	// (client.py:521-531 dead-reckons with no buffering guard).
	SeekDetections int
	Misdetections  int
}

type sample struct {
	t   int64 // server time (estimated)
	res float64
}

func NewClient(p ClientProfile, startPos float64, paused bool) *Client {
	if p.IntrinsicRate == 0 {
		p.IntrinsicRate = 1.0
	}
	return &Client{
		P: p, posMs: startPos, paused: paused, appliedRate: 1.0,
		readyState: 4, bufferedS: 30,
	}
}

func (c *Client) clockNow(serverMs int64) int64 { return serverMs + c.P.ClockSkewMs }

// serverNowEst is the client's belief about server time. Every position
// comparison it makes runs through this, so clock error shows up as sync error.
func (c *Client) serverNowEst(serverMs int64) int64 {
	return c.clockNow(serverMs) + c.estOffsetMs
}

func (c *Client) stalled(serverMs int64) bool {
	for _, w := range c.P.Stalls {
		if serverMs >= w[0] && serverMs < w[1] {
			return true
		}
	}
	return false
}

// Advance moves playback forward by dt ms of real time.
func (c *Client) Advance(serverMs, dt int64) {
	if c.stalled(serverMs) {
		c.readyState = 2
		c.bufferedS = 0
		return // player is buffering: position does not advance
	}
	c.readyState = 4
	c.bufferedS = 30
	if !c.paused {
		c.posMs += float64(dt) * c.P.IntrinsicRate * c.appliedRate
	}
}

// TimeSync starts one clock-sync exchange.
func (c *Client) TimeSync(net *Network, serverMs int64) {
	net.Send(serverMs, c.P.ID, c.P.ID, "server", true, MsgTimeReq{ClientID: c.P.ID, T0: c.clockNow(serverMs)})
}

func (c *Client) onTimeReply(m MsgTimeReply, serverMs int64) {
	t1 := c.clockNow(serverMs)
	rtt := (t1 - m.T0) - (m.TSend - m.TRecv)
	offset := ((m.TRecv - m.T0) + (m.TSend - t1)) / 2
	// min-RTT rule: only accept the sample if this is the cleanest path we have
	// seen. The minimum-RTT sample is the least polluted by queuing delay.
	// Count every completed exchange. Counting only accepted (new-minimum)
	// samples is wrong: the minimum is found within the first few probes and
	// then almost never improves, so such a counter freezes low and would
	// disable correction for the whole session.
	c.clockSamples++
	if !c.haveOffset || rtt < c.bestRTT {
		c.bestRTT = rtt
		c.estOffsetMs = offset
		c.haveOffset = true
	}
}

// Evaluate is the high-rate local loop: stall inference, two-diff detection,
// residual, slope. Returns a report if the client should speak up.
func (c *Client) Evaluate(serverMs int64, t vsync.Tunables, force bool) (vsync.Report, bool) {
	if !c.haveOffset {
		return vsync.Report{}, false
	}
	est := c.serverNowEst(serverMs)
	expected := float64(c.anchor.Expected(est))

	// --- stall inference (docs/PROTOCOL.md 4) -------------------------------
	// A buffering stall reports paused == false while currentTime freezes.
	// That signature is what separates it from a user seek; without it the
	// two-diff test misclassifies every stall as a backward seek and
	// broadcasts it to the room.
	wasStalled := c.stallSuspected
	frozen := c.haveEvalPos && !c.paused && (c.posMs-c.lastEvalPos) < float64(evalIntervalMs)*0.5
	c.stallSuspected = !c.P.NoStallInference && (c.readyState < t.MinReadyState || frozen)
	c.lastEvalPos = c.posMs
	c.haveEvalPos = true

	// --- two-diff seek detection --------------------------------------------
	playerDiff := math.Abs(c.posMs - c.lastKnownPos)
	roomDiff := math.Abs(c.posMs - expected)
	if c.stallSuspected {
		// Frozen playback is not a seek. Hold the reference point so the gap
		// does not accumulate into a false positive, and let the readiness
		// gate deal with the divergence instead.
		c.lastKnownPos = c.posMs
	} else {
		if wasStalled {
			// Just resumed: re-baseline rather than judging the stall gap.
			c.lastKnownPos = c.posMs
		} else if !c.paused {
			c.lastKnownPos += float64(evalIntervalMs) * c.P.IntrinsicRate * c.appliedRate
		}
		if playerDiff > float64(t.SeekThresholdMs) && roomDiff > float64(t.SeekThresholdMs) {
			c.SeekDetections++
			if c.stalled(serverMs) {
				c.Misdetections++ // ground truth, for the harness only
			}
			c.lastKnownPos = c.posMs
		}
	}

	res := c.posMs - expected
	c.residualHist = append(c.residualHist, sample{t: est, res: res})
	cut := est - slopeWindowMs
	for len(c.residualHist) > 0 && c.residualHist[0].t < cut {
		c.residualHist = c.residualHist[1:]
	}

	if !force && math.Abs(res) < float64(t.ReportThreshold) {
		return vsync.Report{}, false
	}
	return vsync.Report{
		ClientID:       c.P.ID,
		ResidualMs:     int64(res),
		SlopeMsPerS:    c.slope(),
		PositionMs:     int64(c.posMs),
		Paused:         c.paused,
		ReadyState:     c.readyState,
		BufferedAheadS: c.bufferedS,
		LastAppliedSeq: c.lastAppliedSeq,
		AtServerMs:     est,
		// Honest error bound: full path asymmetry biases the estimate by at
		// most half the round trip.
		UncertaintyMs: c.bestRTT / 2,
		RTTMs:         c.bestRTT,
		ClockSamples:  c.clockSamples,
	}, true
}

// slope is d(residual)/dt in ms per second, least squares over the window.
// Computed client-side at high frequency with zero network noise -- the server
// must never try to differentiate 1 Hz reports itself.
func (c *Client) slope() float64 {
	n := len(c.residualHist)
	if n < 3 {
		return 0
	}
	var sx, sy, sxx, sxy float64
	t0 := c.residualHist[0].t
	for _, s := range c.residualHist {
		x := float64(s.t-t0) / 1000.0
		sx += x
		sy += s.res
		sxx += x * x
		sxy += x * s.res
	}
	fn := float64(n)
	den := fn*sxx - sx*sx
	if math.Abs(den) < 1e-9 {
		return 0
	}
	return (fn*sxy - sx*sy) / den
}

func (c *Client) Deliver(m Msg, serverMs int64) {
	switch v := m.(type) {
	case MsgTimeReply:
		c.onTimeReply(v, serverMs)
	case MsgState:
		if v.Seq <= c.lastAppliedSeq {
			return // stale; discard (docs/PROTOCOL.md 3)
		}
		c.pending = append(c.pending, v)
	case MsgAck:
		if v.Seq > c.lastAppliedSeq {
			c.lastAppliedSeq = v.Seq
			c.anchor = v.Anchor // roll optimistic apply onto the winning anchor
		}
	case MsgCorrect:
		if v.Mode == "seek" {
			// Re-derive at apply time from our own anchor and clock estimate.
			c.posMs = float64(c.anchor.Expected(c.serverNowEst(serverMs)))
			c.lastKnownPos = c.posMs
			c.residualHist = nil
			c.SeeksApplied++
		} else {
			c.appliedRate = v.Rate
			c.NudgesApplied++
		}
	}
}

// RunScheduled applies any command whose `when` has arrived.
func (c *Client) RunScheduled(serverMs int64) {
	if !c.haveOffset {
		return
	}
	est := c.serverNowEst(serverMs)
	keep := c.pending[:0]
	for _, p := range c.pending {
		if est >= p.When {
			c.anchor = p.Anchor
			c.lastAppliedSeq = p.Seq
			c.paused = p.Anchor.Paused
			c.posMs = float64(p.Anchor.Expected(est))
			c.lastKnownPos = c.posMs
			c.residualHist = nil
			continue
		}
		keep = append(keep, p)
	}
	c.pending = keep
}

func (c *Client) Pos() float64  { return c.posMs }
func (c *Client) Paused() bool  { return c.paused }
func (c *Client) Rate() float64 { return c.appliedRate }
