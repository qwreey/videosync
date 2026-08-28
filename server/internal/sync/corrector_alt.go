package sync

import "math"

// Absolute bounds on a commanded rate, used where Tunables is not in scope.
const (
	RateFloor = 0.90
	RateCeil  = 1.15
)

// Alternative control laws for drift correction, measured against
// StepRampCorrector (docs/POC-FINDINGS.md section 7). See
// research/alternatives/correction.md for the results and the reasoning.
//
// # The observability argument that organises this file
//
// A client's residual is measured *through its own estimate of server time*:
//
//	res(t) = pos(t) - anchor.Expected(clientClock(t) + estOffset)
//
// If estOffset is wrong by b (one-way latency asymmetry: min-RTT cannot see it,
// SYNTHESIS section 1), every residual is wrong by exactly b, forever. Phase is
// therefore unobservable up to a constant. The derivative is not:
//
//	d/dt res(t) = effectiveRate - 1     for any constant b
//
// Two consequences drive the designs below:
//
//  1. Any integrator on phase (PI, PLL) will wind up to the full bias and
//     physically move the client to a wrong position. This is exactly the trap
//     in POC-FINDINGS section 6 -- textbook control theory does not avoid it,
//     it *automates* it.
//  2. A frequency-locked loop (integrate the slope, not the residual) is
//     immune to a constant clock bias by construction. It cannot close a phase
//     offset, so phase must be handled separately and gated on evidence that
//     the offset is real rather than estimated.
//
// Correctors here are stateful (per-client) and therefore MUST be constructed
// fresh for each simulation run -- cmd/simharness/main.go uses factories.

// --- shared per-client state ------------------------------------------------

type altClient struct {
	haveT bool
	lastT int64

	// commanded rate, and the last rate we actually put on the wire
	rate     float64
	sentRate float64

	// PI / PLL integrator, in seconds of accumulated phase error
	integ float64

	// frequency estimate (dimensionless rate offset) for the FLL
	freq float64

	// hysteresis latch: are we actively correcting phase right now
	phaseActive bool

	// deadUntil is transport dead time: the interval after issuing a
	// correction during which reports still describe the world *before* it
	// landed. Acting on those is how a loop with delay oscillates -- the
	// harness caught this as a 1.10x nudge issued 10 ms after the seek that
	// had already fixed the error, leaving the client running 10% fast into a
	// 100 ms overshoot. The server's seek cooldown suppresses the duplicate
	// *seek* but nothing suppressed the duplicate *nudge*.
	deadUntil int64

	// freqHoldUntil freezes the frequency loop while the client's slope window
	// still contains a discontinuity. The slope is a 3 s least-squares fit, so
	// for 3 s after a stall or a seek it reports the *step* as a rate, and
	// integrating that poisons the frequency estimate for minutes.
	freqHoldUntil int64

	// seek bookkeeping (the server has its own cooldown; this keeps the
	// corrector's model of "I just moved this client" honest)
	lastSeekAt int64

	// one-way delay estimate for seek-with-lead: min-filtered, so jitter and
	// queueing do not inflate it.
	minOneWay  int64
	haveOneWay bool

	// warm-up / bias learning
	warmStart int64
	warmN     int
	warmSx    float64 // sum t (s)
	warmSy    float64 // sum res
	warmSxx   float64
	warmSxy   float64
	warmDone  bool
	bias      float64

	// last seen applied seq, to notice a room-wide re-position
	lastSeq uint64

	// noise-floor tracking for the adaptive dead-band
	nMean, nM2 float64
	nCount     float64

	// Kalman state: x = [phase ms, freq ms/s], P = covariance
	kx    [2]float64
	kp    [2][2]float64
	kInit bool
}

func (s *altClient) dt(now int64) float64 {
	if !s.haveT {
		s.haveT = true
		s.lastT = now
		return 0
	}
	d := float64(now-s.lastT) / 1000.0
	s.lastT = now
	if d < 0 {
		d = 0
	}
	if d > 5 {
		d = 5 // a gap this long means we lost the client; do not integrate it
	}
	return d
}

// observeOneWay min-filters (arrival - client's stamp) as an estimate of the
// one-way delay. Under asymmetry this is itself biased (a 20 ms up / 1200 ms
// down client reports ~610 ms, not 1200), so it is clamped hard.
func (s *altClient) observeOneWay(r Report, serverMs int64) {
	d := serverMs - r.AtServerMs
	if d < 0 {
		d = 0
	}
	if d > 600 {
		d = 600
	}
	if !s.haveOneWay || d < s.minOneWay {
		s.minOneWay = d
		s.haveOneWay = true
	}
}

func (s *altClient) lead() int64 {
	if !s.haveOneWay {
		return 0
	}
	return s.minOneWay
}

// emit turns a desired playbackRate into a Decision, suppressing messages that
// would not change anything. Critically it never sets ResetRate: the server
// sends rate=1.0 on ResetRate, which would slam a continuous controller's
// accumulated output back to unity on every heartbeat inside the dead-band.
func (s *altClient) emit(rate float64, why string, t Tunables) Decision {
	rate = clampF(rate, t.RateMin, t.RateMax)
	s.rate = rate
	if math.Abs(rate-s.sentRate) < 0.002 {
		return Decision{Action: ActionNone, Why: "hold"}
	}
	s.sentRate = rate
	return Decision{Action: ActionNudge, Rate: rate, Why: why}
}

func (s *altClient) seek(a Anchor, serverMs int64, lead int64, why string) Decision {
	s.lastSeekAt = serverMs
	s.deadUntil = serverMs + 2*lead + 250
	s.freqHoldUntil = serverMs + 3000
	s.integ = 0
	s.phaseActive = false
	// Do NOT reset s.freq: the rate mismatch that may also be present is a
	// separate fault from the step we are removing. A PLL preserves its VCO
	// frequency across a phase jump for the same reason.
	//
	// The seek carries the rate with it. Without this the nudge that was in
	// flight when the step was detected keeps running after the jump lands:
	// the harness trace of long-stalls showed a 4 s stall corrected to +45 ms
	// and then pushed to +100 ms by a 1.10x rate nobody had cancelled, where
	// it parked inside the hysteresis band. Seek and rate are one action.
	s.sentRate = clampF(1+s.freq, RateFloor, RateCeil)
	return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs + lead),
		Rate: s.sentRate, Why: why}
}

// observeNoise is a running standard deviation of the residual, used by the
// adaptive dead-band. Welford, so it needs no window buffer.
//
// It is fed ONLY from quiet samples (|res| inside the fixed tolerance). This
// is not a detail: measured over everything, one genuine 270 s step inflates
// sigma to tens of thousands, the adaptive band opens wider than the error,
// and the corrector silently stops correcting. That failure was in the first
// version of this file and the harness caught it as command-storm anchor
// error of 22 s -- an adaptive threshold whose input includes the signal it
// is meant to threshold is a self-disabling mechanism.
func (s *altClient) observeNoise(res float64, quietBand float64) float64 {
	if math.Abs(res) < quietBand {
		s.nCount++
		d := res - s.nMean
		s.nMean += d / s.nCount
		s.nM2 += d * (res - s.nMean)
	}
	if s.nCount < 8 {
		return 0
	}
	return math.Sqrt(s.nM2 / (s.nCount - 1))
}

// --- Strategy 4: textbook PI on playbackRate --------------------------------

// PICorrector is proportional-integral control of playbackRate against the
// residual, with anti-windup and a seek only as a last resort. This is what
// "use a proper controller instead of bang-bang" means concretely.
//
// Plant model: commanding rate 1+u makes the residual move at u*1000 ms/s, so
// the plant is a pure integrator. For a pure integrator, PI gives the closed
// loop s^2 + Kp*s + Ki, i.e. wn = sqrt(Ki), zeta = Kp/(2*sqrt(Ki)).
//
// Prediction, written before the first run: this wins on steady rate drift
// (it drives the *rate* error to zero, which no threshold strategy does) and
// is actively harmful under clock bias, because the integrator's job is
// precisely to eliminate a constant offset -- including one that is not real.
type PICorrector struct {
	Kp, Ki float64
	cs     map[string]*altClient
}

func (c *PICorrector) Name() string { return "pi" }

func (c *PICorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1}
		c.cs[id] = s
	}
	return s
}

func (c *PICorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if c.Kp == 0 {
		c.Kp, c.Ki = 0.25, 0.02 // wn 0.14 rad/s, zeta 0.88
	}
	s := c.state(r.ClientID)
	dt := s.dt(serverMs)
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	if r.LastAppliedSeq != s.lastSeq {
		s.lastSeq = r.LastAppliedSeq
		s.integ = 0 // the room moved everyone; the old phase error is void
	}
	// err > 0 means "the client must catch up", i.e. speed up.
	err := -float64(r.ResidualMs) / 1000.0

	if abs64(r.ResidualMs) >= t.NudgeMaxResidual {
		s.integ = 0
		return s.seek(a, serverMs, 0, "beyond rate authority")
	}
	u := c.Kp*err + c.Ki*s.integ
	// Anti-windup: integrate only when the output is not saturated, or when
	// integrating would bring it out of saturation.
	sat := u > (t.RateMax-1) || u < (t.RateMin-1)
	if !sat || (u > 0) != (err > 0) {
		s.integ += err * dt
	}
	return s.emit(1+u, "pi", t)
}

// --- Strategy 5: phase-locked loop ------------------------------------------

// PLLCorrector treats the media clock as an oscillator to be locked to the
// server reference: playbackRate is the VCO control, the residual is the phase
// detector output, and the loop filter is the standard second-order
// (2*zeta*wn, wn^2) pair. It differs from PICorrector in two ways that matter:
//
//   - gains are set from a loop bandwidth rather than picked, so the settling
//     time is a design input;
//   - it has a cycle-slip detector. A step larger than the loop can pull in
//     within its bandwidth is a slip: jump the phase (seek) but *keep the VCO
//     frequency estimate*, which is the combined seek-and-nudge action that
//     neither the baseline nor any reference implementation performs.
type PLLCorrector struct {
	Wn, Zeta float64
	SlipMs   int64
	cs       map[string]*altClient
}

func (c *PLLCorrector) Name() string { return "pll" }

func (c *PLLCorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1}
		c.cs[id] = s
	}
	return s
}

func (c *PLLCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if c.Wn == 0 {
		c.Wn, c.Zeta, c.SlipMs = 0.30, 0.707, 900
	}
	s := c.state(r.ClientID)
	dt := s.dt(serverMs)
	s.observeOneWay(r, serverMs)
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	if r.LastAppliedSeq != s.lastSeq {
		s.lastSeq = r.LastAppliedSeq
		s.integ = 0
	}
	err := -float64(r.ResidualMs) / 1000.0

	// Cycle slip: the phase error is outside the loop's pull-in range. A
	// second-order loop with these gains closes ~100 ms/s at saturation, so a
	// step near a second takes ten seconds of audible speed change.
	kp := 2 * c.Zeta * c.Wn
	ki := c.Wn * c.Wn
	if abs64(r.ResidualMs) >= c.SlipMs && math.Abs(r.SlopeMsPerS) < t.RampMaxSlope {
		if serverMs-s.lastSeekAt > 2000 || s.lastSeekAt == 0 {
			// Hand the integrator's accumulated frequency to the VCO register
			// before the jump clears it. This is the whole point of doing the
			// phase jump inside a loop rather than as a separate policy: the
			// rate mismatch is a different fault from the step, and it must
			// survive the correction of the step.
			s.freq = clampF(ki*s.integ, t.RateMin-1, t.RateMax-1)
			return s.seek(a, serverMs, s.lead(), "cycle slip")
		}
	}
	u := kp*err + ki*s.integ + s.freq
	sat := u > (t.RateMax-1) || u < (t.RateMin-1)
	if !sat || (u > 0) != (err > 0) {
		s.integ += err * dt
	}
	return s.emit(1+u, "pll", t)
}

// --- Strategy 6: frequency-locked loop --------------------------------------

// FLLCorrector locks *frequency only*: it integrates the reported slope, never
// the residual. d(res)/dt is invariant to a constant clock-offset error, so
// this loop physically cannot be pulled off position by a biased estimate --
// the failure mode that produced 2598 seeks and then 1184 ms of self-inflicted
// divergence in POC-FINDINGS sections 2 and 6.
//
// The price is stated up front: an FLL has no phase term, so it leaves a
// constant offset in place forever. On its own it is not a shippable policy;
// it is the clean experiment that isolates how much of the residual is rate
// error (fixable, bias-immune) versus offset (only fixable through an estimate
// we cannot trust).
type FLLCorrector struct {
	Kf float64 // 1/s, integral gain on frequency error
	cs map[string]*altClient
}

func (c *FLLCorrector) Name() string { return "fll" }

func (c *FLLCorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1}
		c.cs[id] = s
	}
	return s
}

func (c *FLLCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if c.Kf == 0 {
		c.Kf = 0.30
	}
	s := c.state(r.ClientID)
	dt := s.dt(serverMs)
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		s.freqHoldUntil = serverMs + 3000
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	// A stall is a frequency excursion of ~1000 ms/s. Feeding it to the loop
	// would saturate the integrator for the whole stall; the readiness gate
	// owns that case, and for 3 s afterwards the slope window still contains
	// the step.
	if math.Abs(r.SlopeMsPerS) < t.RampMaxSlope && serverMs >= s.freqHoldUntil {
		s.freq += -c.Kf * (r.SlopeMsPerS / 1000.0) * dt
		s.freq = clampF(s.freq, t.RateMin-1, t.RateMax-1)
	}
	return s.emit(1+s.freq, "fll", t)
}

// --- Strategy 7: Kalman filter over (phase, frequency) ----------------------

// KalmanCorrector runs a two-state filter -- phase (ms) and frequency (ms/s) --
// over the residual measurements, then applies the StepRampCorrector policy to
// the *filtered* estimates, and additionally refuses to seek while the phase
// variance is above a threshold (the "do not act on an untrusted estimate"
// requirement from POC-FINDINGS section 8 item 4, expressed as a covariance
// rather than as a sample count).
//
// Prediction, written before the first run: this does nothing useful in the
// stock scenarios, because the harness's residual has no measurement noise --
// the client computes it exactly from its own position and its own offset
// estimate, and the slope is already a 3 s least-squares fit. A filter that
// assumes zero-mean measurement noise cannot see a *bias* by construction, and
// bias is the dominant error term in this system. The `noisy-position`
// scenario exists to give it a fair test.
type KalmanCorrector struct {
	// R is measurement variance (ms^2); Q the process noise on frequency.
	R, Qf, Qp float64
	// MaxSeekVar: refuse to seek while the phase estimate variance exceeds it.
	MaxSeekVar float64
	cs         map[string]*altClient
}

func (c *KalmanCorrector) Name() string { return "kalman" }

func (c *KalmanCorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1}
		c.cs[id] = s
	}
	return s
}

func (c *KalmanCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if c.R == 0 {
		c.R, c.Qp, c.Qf, c.MaxSeekVar = 900, 25, 4, 2500
	}
	s := c.state(r.ClientID)
	dt := s.dt(serverMs)
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	z := float64(r.ResidualMs)
	if !s.kInit {
		s.kInit = true
		s.kx = [2]float64{z, 0}
		s.kp = [2][2]float64{{c.R, 0}, {0, 100}}
	} else {
		// predict: x = F x, P = F P F' + Q, with F = [[1,dt],[0,1]]
		s.kx[0] += s.kx[1] * dt
		p00 := s.kp[0][0] + dt*(s.kp[1][0]+s.kp[0][1]) + dt*dt*s.kp[1][1] + c.Qp
		p01 := s.kp[0][1] + dt*s.kp[1][1]
		p10 := s.kp[1][0] + dt*s.kp[1][1]
		p11 := s.kp[1][1] + c.Qf
		// update with H = [1, 0]
		sInnov := p00 + c.R
		k0 := p00 / sInnov
		k1 := p10 / sInnov
		y := z - s.kx[0]
		s.kx[0] += k0 * y
		s.kx[1] += k1 * y
		s.kp[0][0] = (1 - k0) * p00
		s.kp[0][1] = (1 - k0) * p01
		s.kp[1][0] = p10 - k1*p00
		s.kp[1][1] = p11 - k1*p01
	}
	res := int64(s.kx[0])
	slope := s.kx[1]
	if r.LastAppliedSeq != s.lastSeq {
		s.lastSeq = r.LastAppliedSeq
		s.kInit = false
	}

	// StepRamp policy, on filtered estimates, plus the variance gate.
	if abs64(res) < t.ToleranceMs {
		if s.sentRate != 1.0 {
			return s.emit(1.0, "in tolerance", t)
		}
		return Decision{Action: ActionNone, ResetRate: true}
	}
	trusted := s.kp[0][0] <= c.MaxSeekVar
	if abs64(res) >= t.NudgeMaxResidual && trusted {
		return s.seek(a, serverMs, 0, "large divergence")
	}
	if sl := absF(slope); sl >= t.RampMinSlope && sl <= t.RampMaxSlope {
		return s.emit(nudgeRate(res, t), "ramp", t)
	}
	if trusted {
		return s.seek(a, serverMs, 0, "settled step")
	}
	return s.emit(nudgeRate(res, t), "untrusted estimate", t)
}

// --- Strategy 8: step-ramp with seek-with-lead ------------------------------

// LeadSeekCorrector is StepRampCorrector with exactly one change, so the
// effect is attributable: the seek target is Expected(now + oneWayDelay)
// instead of Expected(now). A hard seek is visible partly because it lands at
// a position that is already stale by the downlink delay by the time the
// player applies it; on a 200 ms link the baseline plants the client 200 ms
// behind the anchor at the very instant it "corrected" it.
type LeadSeekCorrector struct {
	cs map[string]*altClient
}

func (c *LeadSeekCorrector) Name() string { return "step-ramp+lead" }

func (c *LeadSeekCorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1}
		c.cs[id] = s
	}
	return s
}

func (c *LeadSeekCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	s := c.state(r.ClientID)
	s.observeOneWay(r, serverMs)
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	res := r.ResidualMs
	if abs64(res) < t.ToleranceMs {
		return Decision{Action: ActionNone, ResetRate: true}
	}
	if abs64(res) >= t.NudgeMaxResidual {
		return s.seek(a, serverMs, s.lead(), "large divergence")
	}
	if r.Closing() {
		return Decision{Action: ActionNone, Why: "closing"}
	}
	if sl := absF(r.SlopeMsPerS); sl >= t.RampMinSlope && sl <= t.RampMaxSlope {
		return Decision{Action: ActionNudge, Rate: nudgeRate(res, t), Why: "ramp"}
	}
	return s.seek(a, serverMs, s.lead(), "settled step")
}

// --- Strategy 9: the composite -----------------------------------------------

// HybridCorrector is the proposal. Four independent pieces, each of which is
// separately measurable:
//
//  1. A frequency-locked loop on the reported slope (bias-immune) removes the
//     *cause* of ramps, and keeps running underneath every other action.
//  2. Phase is judged against a per-client baseline learned at join. At the
//     moment a client joins it has just positioned itself from the anchor, so
//     its true position error is ~0 by construction and whatever residual it
//     reports is its clock-estimate bias. Subtracting that up front is the
//     same conclusion the failed-seek detector reaches after several damaging
//     seeks (POC-FINDINGS section 2), reached before the damage.
//  3. Seeks lead by the estimated one-way delay, and preserve the frequency
//     estimate across the jump (seek-and-nudge as one action).
//  4. The dead-band is hysteretic and adapts to the observed noise floor:
//     enter at max(TOLERANCE, 3*sigma), leave at half that.
//
// Seeks are additionally gated on the baseline being established, which is the
// "do not correct on an untrusted clock estimate" requirement from
// POC-FINDINGS section 8 item 4.
type HybridCorrector struct {
	Kf      float64 // FLL gain
	Kphase  float64 // proportional phase gain (1/s)
	WarmMs  int64   // baseline learning window
	MaxBias float64 // refuse to believe a baseline larger than this
	NoBias  bool    // ablation: disable baseline learning
	cs      map[string]*altClient
}

func (c *HybridCorrector) Name() string {
	if c.NoBias {
		return "hybrid-nobias"
	}
	return "hybrid"
}

func (c *HybridCorrector) state(id string) *altClient {
	if c.cs == nil {
		c.cs = map[string]*altClient{}
	}
	s := c.cs[id]
	if s == nil {
		s = &altClient{rate: 1, sentRate: 1, warmStart: -1}
		c.cs[id] = s
	}
	return s
}

func (c *HybridCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if c.Kf == 0 {
		c.Kf, c.Kphase, c.WarmMs, c.MaxBias = 0.30, 0.22, 2500, 1500
	}
	s := c.state(r.ClientID)
	dt := s.dt(serverMs)
	s.observeOneWay(r, serverMs)

	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		s.freqHoldUntil = serverMs + 3000
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	if r.LastAppliedSeq != s.lastSeq {
		s.lastSeq = r.LastAppliedSeq
		s.phaseActive = false
		s.freqHoldUntil = serverMs + 3000
		// NOTE: a client applying a scheduled command jumps to Expected(est)
		// using its OWN estimate, so a biased client lands bias-ms off the
		// true position while its measured residual reads ~0 -- the error is
		// invisible on the channel we read. Issuing one corrective seek here
		// (in true server time) was implemented and MEASURED: it made
		// bias+commands worse, 286/705 -> 290/805 ms and 16 -> 29 seeks. The
		// stale baseline is a real limitation; this is not its fix. See
		// research/alternatives/correction.md section 5e.
	}

	if serverMs < s.deadUntil {
		return s.emit(1+s.freq, "dead time", t)
	}

	res := float64(r.ResidualMs)

	// --- (2) baseline learning ------------------------------------------
	// Least-squares fit over the warm-up window; the intercept is the offset
	// that was already present before we watched anything happen, i.e. the
	// part of the residual we have no evidence is real. The slope term stops
	// a genuine rate drift from being mistaken for an offset.
	if !s.warmDone && !c.NoBias {
		if s.warmStart < 0 {
			s.warmStart = serverMs
		}
		x := float64(serverMs-s.warmStart) / 1000.0
		s.warmN++
		s.warmSx += x
		s.warmSy += res
		s.warmSxx += x * x
		s.warmSxy += x * res
		if serverMs-s.warmStart >= c.WarmMs && s.warmN >= 4 {
			n := float64(s.warmN)
			den := n*s.warmSxx - s.warmSx*s.warmSx
			icept := s.warmSy / n
			if math.Abs(den) > 1e-9 {
				sl := (n*s.warmSxy - s.warmSx*s.warmSy) / den
				icept = (s.warmSy - sl*s.warmSx) / n
			}
			s.bias = clampF(icept, -c.MaxBias, c.MaxBias)
			// Only absorb a baseline big enough to matter. A bias smaller
			// than the dead-band can never produce a persistent correction,
			// so learning it buys nothing and costs a permanent steady-state
			// offset equal to the estimate's own error.
			if math.Abs(s.bias) < float64(t.ToleranceMs) {
				s.bias = 0
			}
			s.warmDone = true
		}
		// While the baseline is unknown the clock estimate is untrusted:
		// hold, do not seek. This is cheap and it is what prevents the
		// self-inflicted divergence, rather than bounding it after the fact.
		return s.emit(1+s.freq, "warming up", t)
	}
	s.warmDone = true
	eff := res - s.bias

	// --- (1) frequency loop ---------------------------------------------
	if math.Abs(r.SlopeMsPerS) < t.RampMaxSlope && serverMs >= s.freqHoldUntil {
		s.freq += -c.Kf * (r.SlopeMsPerS / 1000.0) * dt
		s.freq = clampF(s.freq, t.RateMin-1, t.RateMax-1)
	}

	// --- (4) adaptive hysteretic dead-band -------------------------------
	// The band widens to 3 sigma of the *quiet* residual, capped: a dead-band
	// must never be able to grow past the error it is judging.
	sigma := s.observeNoise(eff, float64(t.ToleranceMs))
	enter := math.Min(math.Max(float64(t.ToleranceMs), 3*sigma), 1.5*float64(t.ToleranceMs))
	exit := enter / 2
	if math.Abs(eff) >= enter {
		s.phaseActive = true
	} else if math.Abs(eff) <= exit {
		s.phaseActive = false
	}
	if !s.phaseActive {
		return s.emit(1+s.freq, "in band", t)
	}

	// --- (3) phase correction --------------------------------------------
	// The step/ramp distinction, but taken on the bias-corrected residual and
	// on the slope, which is the only bias-immune signal we have.
	settled := absF(r.SlopeMsPerS) < t.RampMinSlope || absF(r.SlopeMsPerS) > t.RampMaxSlope
	if settled && math.Abs(eff) >= float64(t.ToleranceMs) {
		if s.lastSeekAt == 0 || serverMs-s.lastSeekAt > 2000 {
			return s.seek(a, serverMs, s.lead(), "settled step")
		}
	}
	// A ramp: the frequency loop is already removing the cause. Add a
	// proportional phase term to close what has accumulated.
	u := s.freq + c.Kphase*(-eff/1000.0)
	return s.emit(1+u, "ramp", t)
}
