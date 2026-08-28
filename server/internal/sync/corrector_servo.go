package sync

// ServoCorrector is the synthesis of everything the two harnesses measured.
// It exists because no earlier strategy was safe across all scenarios and the
// reasons why are now all understood:
//
//   - Phase is unobservable up to the clock bias; the slope is not
//     (`d/dt res = rate-1` for any constant offset). So the term that fixes a
//     rate mismatch runs on the slope and is immune to a bad estimate.
//   - You cannot resolve phase finer than `UncertaintyMs`, and a scheduled
//     command launders exactly that much bias into media position with a
//     residual of zero. A phase *integrator* therefore aims at a target that
//     does not exist -- so the phase term here is proportional and dead-banded
//     at the uncertainty, driving the error to the bound and then stopping.
//   - `ConfidenceGated` cannot help a continuous law from the outside, because
//     such a law never consults the dead-band. Confidence is built in here.
//   - An in-buffer seek is free at any network speed; an out-of-buffer seek
//     costs a segment fetch AND rebuffers for it, making the client *more* out
//     of position before it is less. So a seek is only ever taken when the
//     target is already buffered.
//
// See docs/POC-FINDINGS.md 24-28 and docs/BROWSER-FINDINGS.md 2.
type ServoCorrector struct {
	// FreqGain scales how fast the frequency term integrates observed slope.
	FreqGain float64
	st       map[string]*servoState
}

type servoState struct {
	rateBias float64 // accumulated frequency correction, in rate units
	lastAt   int64
}

func (c *ServoCorrector) Name() string { return "servo" }

func (c *ServoCorrector) state(id string) *servoState {
	if c.st == nil {
		c.st = map[string]*servoState{}
	}
	if s, ok := c.st[id]; ok {
		return s
	}
	s := &servoState{}
	c.st[id] = s
	return s
}

// targetBuffered reports whether the position we would seek to is already in
// the client's buffer -- the single fact that decides what a seek costs.
func targetBuffered(r Report, a Anchor, serverMs int64) bool {
	delta := float64(a.Expected(serverMs) - r.PositionMs)
	if delta >= 0 {
		return delta/1000 <= r.BufferedAheadS
	}
	return -delta/1000 <= r.BufferedBehindS
}

func (c *ServoCorrector) Decide(r Report, a Anchor, serverMs int64, t Tunables) Decision {
	// A suspended member is absent, not behind. Gating on them holds the room
	// for someone who is not watching (docs/BROWSER-FINDINGS.md 5).
	if r.Suspended {
		return Decision{Action: ActionNone, Why: "suspended"}
	}
	if r.ReadyState < t.MinReadyState || r.BufferedAheadS < t.MinBufferedS {
		return Decision{Action: ActionGate, Why: "buffering"}
	}
	s := c.state(r.ClientID)
	dt := float64(serverMs-s.lastAt) / 1000
	if s.lastAt == 0 || dt <= 0 || dt > 10 {
		dt = 1 // first sample, or a long gap: do not integrate a huge step
	}
	s.lastAt = serverMs

	// The floor below which we cannot tell a real error from our own
	// measurement error. Never try to correct inside it.
	band := t.ToleranceMs
	if r.UncertaintyMs > band {
		band = r.UncertaintyMs
	}

	// --- frequency term: integrate the slope. Bias-immune by construction. ---
	// Frozen while the slope is implausible for a rate mismatch: a 1% rate
	// error is 10 ms/s, a buffering stall is ~1000 ms/s. Integrating a stall's
	// slope winds the loop up for a discontinuity it cannot fix.
	gain := c.FreqGain
	if gain == 0 {
		gain = 0.35
	}
	if absF(r.SlopeMsPerS) <= t.RampMaxSlope {
		s.rateBias += -r.SlopeMsPerS / 1000 * gain * dt
		s.rateBias = clampF(s.rateBias, -0.06, 0.06)
	}

	// --- phase term: proportional, and only on the part of the error that
	// exceeds the band. Deliberately not an integrator (see the type comment).
	phase := 0.0
	res := float64(r.ResidualMs)
	if abs64(r.ResidualMs) > band {
		excess := res
		if res > 0 {
			excess = res - float64(band)
		} else {
			excess = res + float64(band)
		}
		phase = -excess / float64(t.NudgeCloseMs)
	}

	// --- discrete escape: seek whenever it is FREE and needed --------------
	// The gate is cost, not size. An in-buffer seek was measured at ~20 ms at
	// every network speed, so there is no reason to let a gap grow to some
	// arbitrary threshold first -- rate-nudging a 900 ms step takes 9 seconds
	// of audibly wrong playback to fix something a free seek fixes instantly.
	// Conversely an out-of-buffer seek is never worth it: it costs a segment
	// fetch and rebuffers for that whole time, leaving the client further out
	// of position than it started.
	if abs64(r.ResidualMs) > band && targetBuffered(r, a, serverMs) {
		s.rateBias = 0 // step is gone; do not keep a frequency correction for it
		return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "free seek"}
	}
	// An out-of-buffer seek is expensive, but not seeking is not free either:
	// the rate clamp closes at most 10% of real time, so a gap of G ms takes
	// G/0.10 ms of audibly wrong playback to absorb. Past NudgeMaxResidual that
	// is minutes, and one segment fetch is plainly the cheaper of the two.
	// (The first version of this rule refused out-of-buffer seeks outright and
	// left a member returning from a 15 s tab suspension nudging for 150 s.)
	if abs64(r.ResidualMs) >= t.NudgeMaxResidual {
		s.rateBias = 0
		return Decision{Action: ActionSeek, TargetMs: a.Expected(serverMs), Why: "gap beyond what rate can close"}
	}

	rate := clampF(1.0+s.rateBias+phase, t.RateMin, t.RateMax)

	// Settled: inside the band with no residual frequency error to hold.
	if abs64(r.ResidualMs) <= band && absF(s.rateBias) < 5e-4 {
		return Decision{Action: ActionNone, ResetRate: true, Why: "within uncertainty"}
	}
	return Decision{Action: ActionNudge, Rate: rate, Why: "servo"}
}
