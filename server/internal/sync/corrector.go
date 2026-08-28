package sync

// Action is what the server decides to do about one client's report.
type Action int

const (
	ActionNone Action = iota
	ActionNudge
	ActionSeek
	ActionGate
)

func (a Action) String() string {
	switch a {
	case ActionNudge:
		return "nudge"
	case ActionSeek:
		return "seek"
	case ActionGate:
		return "gate"
	default:
		return "none"
	}
}

// Decision is the server's judgement about a single client. A Decision never
// moves the anchor -- reports judge clients, they never move the room.
type Decision struct {
	Action   Action
	Rate     float64 // ActionNudge
	TargetMs int64   // ActionSeek
	// ResetRate asks the client to drop back to 1.0x. Only set when the client
	// is genuinely back in tolerance -- clearing the rate while a nudge is
	// still working is a self-inflicted oscillation.
	ResetRate bool
	Why       string
}

// Tunables mirrors the constants table in docs/PROTOCOL.md.
type Tunables struct {
	ToleranceMs      int64
	NudgeMaxResidual int64
	RateMin, RateMax float64
	// NudgeCloseMs: aim to close the residual within this long. Bounded by
	// the rate clamp, so a 10% cap closes at most 100 ms of gap per second.
	NudgeCloseMs int64
	// RampMinSlope (ms/s) separates a *ramp* (ongoing rate mismatch, fixable
	// by nudging) from a *settled step* (a stall already happened, the gap is
	// now constant and nudging would take forever).
	RampMinSlope float64
	// RampMaxSlope (ms/s) is the upper bound of a *plausible* rate mismatch.
	// A 1% playback-rate error is 10 ms/s; a buffering stall is ~1000 ms/s.
	// Anything above this is a discontinuity in progress, not a rate problem,
	// and nudging it just delays the seek that is actually needed.
	RampMaxSlope    float64
	MinReadyState   int
	MinBufferedS    float64
	SeekThresholdMs int64
	ReportThreshold int64
	// MinClockSamples gates all position correction until the offset estimate
	// has settled.
	MinClockSamples int
}

func DefaultTunables() Tunables {
	return Tunables{
		ToleranceMs:      500,
		NudgeMaxResidual: 3000,
		RateMin:          0.95,
		RateMax:          1.10,
		NudgeCloseMs:     8000,
		RampMinSlope:     1.0,
		RampMaxSlope:     100.0,
		MinReadyState:    3,
		MinBufferedS:     1.0,
		SeekThresholdMs:  1000,
		ReportThreshold:  250,
		MinClockSamples:  3,
	}
}

// Corrector decides what to do about a client that is out of tolerance.
// Implementations are swappable so competing policies can be measured rather
// than argued about.
type Corrector interface {
	Name() string
	Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision
}

// --- Strategy 1: what every reference implementation does -------------------

// ThresholdCorrector thresholds on absolute offset only and always hard-seeks.
// This is the behaviour of jellyfin, VideoTogether, opentogethertube, SyncTube,
// cytube and syncwatch. It is the baseline our derivative approach must beat.
type ThresholdCorrector struct{ HardSeekMs int64 }

func (ThresholdCorrector) Name() string { return "threshold" }

func (c ThresholdCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if r.Suspended {
		return Decision{Action: ActionNone, Why: "suspended"}
	}
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	limit := c.HardSeekMs
	if limit == 0 {
		limit = t.ToleranceMs
	}
	if abs64(r.ResidualMs) >= limit {
		return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "over threshold"}
	}
	return Decision{Action: ActionNone, ResetRate: true}
}

// --- Strategy 2: ours -------------------------------------------------------

// DerivativeCorrector uses (residual, d(residual)/dt). The derivative chooses
// *which* correction to apply, not merely whether to correct -- so a client
// that is behind but catching up is left alone, and a rate mismatch is nudged
// rather than seeked. See docs/PROTOCOL.md section 5.
type DerivativeCorrector struct{}

func (DerivativeCorrector) Name() string { return "derivative" }

func (DerivativeCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	res := r.ResidualMs
	if abs64(res) < t.ToleranceMs {
		return Decision{Action: ActionNone, ResetRate: true}
	}
	if abs64(res) >= t.NudgeMaxResidual {
		return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "large divergence"}
	}
	// Already resolving -- leave the current rate alone and let it finish.
	// Resetting the rate here would cancel the nudge that is doing the work.
	if r.Closing() {
		return Decision{Action: ActionNone, Why: "closing"}
	}
	rate := nudgeRate(res, t)
	return Decision{Action: ActionNudge, Rate: rate, Why: "diverging"}
}

// --- Strategy 3: step vs ramp ----------------------------------------------

// StepRampCorrector refines the derivative idea after the harness showed the
// naive version losing to a plain threshold. The useful distinction is not
// "closing vs diverging" but *what shape* the error is:
//
//   - a ramp  (rate mismatch: residual growing steadily, small constant slope)
//     is exactly what playbackRate nudging fixes, and a seek would not stop it
//     from recurring;
//   - a settled step (a stall already happened: large residual, slope ~ 0)
//     will never close on its own, and nudging is bounded by the rate clamp --
//     10% closes only 100 ms of gap per second, so an 800 ms step needs 8 s of
//     audible speed-up. Seek it.
//
// This is the classifier the reference implementations lack, stated correctly.
type StepRampCorrector struct{}

func (StepRampCorrector) Name() string { return "step-ramp" }

func (StepRampCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	if r.Suspended {
		return Decision{Action: ActionNone, Why: "suspended"}
	}
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	res := r.ResidualMs
	if abs64(res) < t.ToleranceMs {
		return Decision{Action: ActionNone, ResetRate: true}
	}
	if abs64(res) >= t.NudgeMaxResidual {
		return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "large divergence"}
	}
	if r.Closing() {
		return Decision{Action: ActionNone, Why: "closing"}
	}
	// Diverging with a real slope: a rate mismatch. Nudge fixes the cause.
	if sl := absF(r.SlopeMsPerS); sl >= t.RampMinSlope && sl <= t.RampMaxSlope {
		return Decision{Action: ActionNudge, Rate: nudgeRate(res, t), Why: "ramp"}
	}
	// Persistent gap that is not moving: a step that already happened.
	return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "settled step"}
}

// nudgeRate picks a playbackRate that would close res within NudgeCloseMs,
// clamped to the safe range. Behind (res<0) => faster.
func nudgeRate(res int64, t Tunables) float64 {
	return clampF(1.0-float64(res)/float64(t.NudgeCloseMs), t.RateMin, t.RateMax)
}

func absF(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ClampI constrains v to [lo, hi].
func ClampI(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// --- Confidence gating (decorator) ------------------------------------------

// ConfidenceGated wraps any Corrector and refuses to act on a residual the
// client cannot actually distinguish from its own clock error.
//
// Motivation is empirical, not aesthetic: under one-way latency asymmetry the
// min-RTT offset estimate is biased by ~half the path difference and this is
// undetectable in principle. POC-FINDINGS section 6 measured what happens when
// a corrector acts on it anyway -- three clients that were playing at exactly
// 1.0x and perfectly aligned were pushed 1.2 s apart *by the corrections
// themselves*. Learning the bias afterwards does not undo that.
//
// The fix is to treat the offset as an interval rather than a point: widen the
// dead-band to the client's own uncertainty, so a residual inside the error
// bound is left alone.
type ConfidenceGated struct{ Inner Corrector }

func (c ConfidenceGated) Name() string { return c.Inner.Name() + "+conf" }

func (c ConfidenceGated) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	// Buffering is observed directly from the player and does not depend on
	// any clock estimate, so it stays live even before the clock settles.
	buffering := r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS

	if r.ClockSamples < t.MinClockSamples {
		if buffering {
			return Decision{Action: ActionGate, Why: "buffering"}
		}
		return Decision{Action: ActionNone, Why: "clock not settled"}
	}

	// Inside our own error bound we cannot tell whether the client is off or
	// our estimate is. Widen the dead-band rather than guess.
	if r.UncertaintyMs > t.ToleranceMs {
		t.ToleranceMs = r.UncertaintyMs
	}
	return c.Inner.Decide(r, a, serverMs, t)
}
