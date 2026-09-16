package sim

import (
	"math"
	"sort"

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
	// MaxBufferS is how far ahead the player keeps data. Measured default for
	// hls.js in docs/BROWSER-FINDINGS.md was ~10-12 s.
	MaxBufferS float64
	// FillRate is how fast the buffer refills relative to real time when it is
	// not full (a 2 s segment fetched in 0.5 s is 4x).
	FillRate float64
	// NoStallInference disables the stall guard, reproducing what syncplay
	// ships (client.py:521-531 dead-reckons whenever paused is false, with no
	// buffering guard). Used as a control: a Misdetections count of 0 proves
	// nothing unless the same scenario produces a non-zero count without it.
	NoStallInference bool

	// Suspends are [start, end) windows where this member's tab is hidden AND
	// its video is muted. Chrome pauses the element itself in that state and
	// fires a real `pause` event, indistinguishable at the DOM level from the
	// user pressing pause (measured: docs/BROWSER-FINDINGS.md 5).
	Suspends [][2]int64
	// NoSuspendGuard broadcasts those browser-initiated transitions as if they
	// were user intent -- what a client written without the measurement does.
	// Control for TestSuspendGuardIsLoadBearing.
	NoSuspendGuard bool

	// JoinAtMs is when this member joins. A late joiner arrives with zero clock
	// samples, so every confidence-gated correction refuses to act -- the
	// member most in need of correction is the one that cannot be corrected.
	JoinAtMs int64
	// Disconnects are [start, end) windows where nothing reaches this member
	// and nothing leaves. On reconnect it holds a stale anchor and, because its
	// residual is measured AGAINST that stale anchor, reports ~0 while being
	// arbitrarily out of position.
	Disconnects [][2]int64
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

	// SkippedMs is the total forward displacement server corrections imposed:
	// media this member was skipped past without watching.
	SkippedMs float64

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

	// --- buffer model (docs/BROWSER-FINDINGS.md 2) -------------------------
	// A seek inside the buffered range is free (~20 ms measured, at any network
	// speed). A seek outside it costs one segment fetch AND rebuffers for that
	// whole time -- which makes the client MORE out of position before it gets
	// better. Treating all seeks as free is what flattered every seek-based
	// strategy in rounds 1-6.
	bufEndS          float64
	seekStallUntil   int64
	OutOfBufferSeeks int
	InBufferSeeks    int
	// RateTimeMs is the integral of |playbackRate-1| dt: how much time-shift was
	// bought with speed changes. Nudge COUNT is not comparable across control
	// laws -- a continuous controller emits one per report by construction.
	RateTimeMs float64

	// Browser-initiated suspension. Distinguished from buffering by what the
	// element reports: suspension is paused==true with readyState 4 and a full
	// buffer; buffering is paused==false with readyState<3 and a draining one.
	suspended bool
	// outbox carries commands this client originates. Until now the harness
	// only injected commands from scenarios, so the path where a client's own
	// detector decides to broadcast was never exercised at all.
	outbox []MsgCmd
	// SpuriousCmds counts commands this client sent that were caused by the
	// browser, not by its user.
	SpuriousCmds int

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
	if p.MaxBufferS == 0 {
		p.MaxBufferS = 11 // measured hls.js default in the browser harness
	}
	if p.FillRate == 0 {
		p.FillRate = 4
	}
	return &Client{
		P: p, posMs: startPos, paused: paused, appliedRate: 1.0,
		readyState: 4, bufferedS: p.MaxBufferS,
		bufEndS: startPos/1000 + p.MaxBufferS,
	}
}

func (c *Client) clockNow(serverMs int64) int64 { return serverMs + c.P.ClockSkewMs }

// serverNowEst is the client's belief about server time. Every position
// comparison it makes runs through this, so clock error shows up as sync error.
func (c *Client) serverNowEst(serverMs int64) int64 {
	return c.clockNow(serverMs) + c.estOffsetMs
}

// segFetchMs is what one segment fetch costs on this link. The browser probe
// measured an out-of-buffer seek costing almost exactly this, with readyState
// below HAVE_FUTURE_DATA for the same duration.
func (c *Client) segFetchMs() int64 {
	d := c.P.Link.UpMs + c.P.Link.DownMs
	if d < 20 {
		d = 20 // even locally a seek is not instantaneous
	}
	return d
}

// inBuffer reports whether a position is already buffered, which is the whole
// story on what a seek costs.
func (c *Client) inBuffer(posMs float64) bool {
	backS := c.posMs/1000 - 10 // players keep a back buffer
	if backS < 0 {
		backS = 0
	}
	return posMs/1000 >= backS && posMs/1000 <= c.bufEndS
}

// Offline reports whether this member is unreachable right now.
func (c *Client) Offline(serverMs int64) bool {
	if serverMs < c.P.JoinAtMs {
		return true
	}
	for _, w := range c.P.Disconnects {
		if serverMs >= w[0] && serverMs < w[1] {
			return true
		}
	}
	return false
}

func (c *Client) inSuspendWindow(serverMs int64) bool {
	for _, w := range c.P.Suspends {
		if serverMs >= w[0] && serverMs < w[1] {
			return true
		}
	}
	return false
}

// TakeOutbox drains commands this client decided to originate.
func (c *Client) TakeOutbox() []MsgCmd {
	out := c.outbox
	c.outbox = nil
	return out
}

// UpdateSuspension models the browser pausing a hidden muted tab, and the
// client's decision about whether that is user intent worth broadcasting.
func (c *Client) UpdateSuspension(serverMs int64) {
	want := c.inSuspendWindow(serverMs)
	if want == c.suspended {
		return
	}
	c.suspended = want
	if want {
		c.paused = true // the browser did this, not the user
	} else {
		c.paused = c.anchor.Paused // resumes itself on re-show
	}
	if c.P.NoSuspendGuard {
		// No guard: a `pause`/`play` event is a `pause`/`play` event. One
		// member backgrounding a muted tab pauses the whole room, and
		// switching back resumes it -- even a room deliberately paused.
		kind := "play"
		if want {
			kind = "pause"
		}
		c.outbox = append(c.outbox, MsgCmd{Kind: kind, PositionMs: int64(c.posMs)})
		c.SpuriousCmds++
	}
	// With the guard: recognised as browser suspension, never broadcast. The
	// member is absent, not buffering -- see gating below.
}

func (c *Client) Suspended() bool { return c.suspended }

func (c *Client) stalled(serverMs int64) bool {
	if serverMs < c.seekStallUntil {
		return true
	}
	for _, w := range c.P.Stalls {
		if serverMs >= w[0] && serverMs < w[1] {
			return true
		}
	}
	return false
}

// Advance moves playback forward by dt ms of real time, and moves the buffer.
func (c *Client) Advance(serverMs, dt int64) {
	if c.suspended {
		// Paused by the browser: position frozen, but the buffer stays full
		// and readyState stays 4. That is what makes it distinguishable from
		// a buffering stall.
		c.readyState = 4
		c.bufferedS = c.bufEndS - c.posMs/1000
		return
	}
	// Rate cost accrues whenever a nudge is in effect and playback is running.
	if !c.paused && !c.stalled(serverMs) {
		c.RateTimeMs += math.Abs(c.appliedRate-1.0) * float64(dt)
	}

	if c.stalled(serverMs) {
		c.readyState = 2
		c.bufferedS = c.bufEndS - c.posMs/1000
		if c.bufferedS < 0 {
			c.bufferedS = 0
		}
		// A network stall starves the buffer; a seek stall is waiting on a fetch.
		if serverMs >= c.seekStallUntil {
			c.bufEndS = c.posMs / 1000
		}
		return // position does not advance
	}

	if !c.paused {
		c.posMs += float64(dt) * c.P.IntrinsicRate * c.appliedRate
	}
	// Refill toward MaxBufferS.
	want := c.posMs/1000 + c.P.MaxBufferS
	if c.bufEndS < want {
		c.bufEndS += (float64(dt) / 1000) * c.P.FillRate
		if c.bufEndS > want {
			c.bufEndS = want
		}
	}
	c.bufferedS = c.bufEndS - c.posMs/1000
	if c.bufferedS < 0 {
		c.bufferedS = 0
	}
	c.readyState = 4
	if c.bufferedS < 0.3 {
		c.readyState = 2
	}
}

// TimeSync starts one clock-sync exchange.
func (c *Client) TimeSync(net *Network, serverMs int64) {
	net.Send(serverMs, c.P.ID, c.P.ID, "server", true, MsgTimeReq{T0: c.clockNow(serverMs)})
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
		ClientID:        c.P.ID,
		ResidualMs:      int64(res),
		SlopeMsPerS:     c.slope(),
		PositionMs:      int64(c.posMs),
		Paused:          c.paused,
		ReadyState:      c.readyState,
		BufferedAheadS:  c.bufferedS,
		Suspended:       c.suspended,
		BufferedBehindS: math.Min(10, c.posMs/1000),
		LastAppliedSeq:  c.lastAppliedSeq,
		AtServerMs:      est,
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
		// The sender schedules its own command exactly like every other
		// member. Anything else exempts the originator from the simultaneity
		// the whole timebase exists to provide -- and in a real client that
		// shows up as your own gesture landing CMD_DELAY before everyone
		// else's, which is larger than the clock bias we worry about.
		if v.Seq > c.lastAppliedSeq {
			c.pending = append(c.pending, MsgState{
				Seq: v.Seq, When: v.When, EmittedAt: v.EmittedAt,
				Anchor: v.Anchor, By: c.P.ID, Kind: v.Kind})
		}
	case MsgCorrect:
		if v.Mode == "seek" {
			// Re-derive at apply time from our own anchor and clock estimate.
			target := float64(c.anchor.Expected(c.serverNowEst(serverMs)))
			if c.inBuffer(target) {
				c.InBufferSeeks++ // ~free, measured at ~20 ms regardless of link
			} else {
				// Costs one segment fetch and rebuffers for the same duration:
				// the client is MORE out of position before it is less.
				c.OutOfBufferSeeks++
				c.seekStallUntil = serverMs + c.segFetchMs()
				c.bufEndS = target / 1000
			}
			// A forward correction is content this member never saw. That is
			// the cost the readiness gate exists to prevent, and no other
			// metric here captures it: anchorErr excludes a stalled client by
			// construction, so a room that simply left someone behind and then
			// yanked them forward scores *well* on it.
			if target > c.posMs {
				c.SkippedMs += target - c.posMs
			}
			c.posMs = target
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
	// Due order is not seq order: `play` carries CMD_DELAY and `pause` carries
	// none, so a pause pressed inside a play's lead is newer AND due sooner.
	// Same two rules as the engine (engine.ts schedule/applyScheduled): walk
	// in `when` order, and never let an older seq overwrite a newer one --
	// applied in arrival order, the stale play landed last and the member
	// played against a paused room with its lastAppliedSeq going backwards.
	sort.SliceStable(c.pending, func(i, j int) bool { return c.pending[i].When < c.pending[j].When })
	keep := c.pending[:0]
	for _, p := range c.pending {
		if p.Seq <= c.lastAppliedSeq {
			continue // superseded while it waited
		}
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
