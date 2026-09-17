package sync

import (
	"math"
	"testing"
)

// servoPlant is one member under ServoCorrector, with nothing else in the way:
// a player at its own intrinsic rate that applies every decision at once, and
// a detector that reports d(residual)/dt exactly as the client does -- a
// least-squares fit over the RAW residual, so the slope contains whatever rate
// the servo itself commanded.
type servoPlant struct {
	intrinsic   float64
	aheadS      float64 // buffered ahead of the playhead
	behindS     float64 // buffered behind it
	uncertainty int64

	// kickAtMs, if set, moves the player by kickMs at that instant: a step
	// the servo did not cause, such as a hiccup.
	kickAtMs int64
	kickMs   float64

	res   float64 // ms, player - anchor
	rate  float64 // the rate the servo last commanded
	hist  [][2]float64
	seeks int
	// rateDrops counts decisions after the kick that put the player back to
	// exactly 1.0, by a reset or a nudge.
	rateDrops int

	// extraAfterKickMs, if set, adds one report that long after the kick,
	// off the whole-second grid, as an anomaly report would be.
	extraAfterKickMs int64
	// trackAfterKick records worstRateAfterKick: the largest distance between
	// the rate the player runs and 1/intrinsic after any decision past the
	// kick's seek.
	trackAfterKick     bool
	worstRateAfterKick float64
}

const plantStepMs = 50

func (p *servoPlant) slope() float64 {
	n := float64(len(p.hist))
	if n < 3 {
		return 0
	}
	var sx, sy, sxx, sxy float64
	for _, h := range p.hist {
		sx += h[0]
		sy += h[1]
		sxx += h[0] * h[0]
		sxy += h[0] * h[1]
	}
	den := n*sxx - sx*sx
	if math.Abs(den) < 1e-9 {
		return 0
	}
	return (n*sxy - sx*sy) / den
}

// run plays the member for durMs and returns the largest |residual| seen in
// the last tailMs of it.
func (p *servoPlant) run(c *ServoCorrector, durMs, tailMs int64) float64 {
	t := DefaultTunables()
	a := Anchor{PositionMs: 100000}
	if p.rate == 0 {
		p.rate = 1
	}
	worst := 0.0
	for now := int64(plantStepMs); now <= durMs; now += plantStepMs {
		p.res += (p.intrinsic*p.rate - 1) * plantStepMs
		if p.kickAtMs > 0 && now == p.kickAtMs {
			p.res += p.kickMs
		}
		p.hist = append(p.hist, [2]float64{float64(now) / 1000, p.res})
		for len(p.hist) > 0 && p.hist[0][0] < float64(now-3000)/1000 {
			p.hist = p.hist[1:]
		}
		if now >= durMs-tailMs && math.Abs(p.res) > worst {
			worst = math.Abs(p.res)
		}
		extra := p.extraAfterKickMs > 0 && p.kickAtMs > 0 && now == p.kickAtMs+p.extraAfterKickMs
		if now%1000 != 0 && !extra {
			continue
		}
		d := c.Decide(Report{
			ClientID: "m", ResidualMs: int64(p.res), SlopeMsPerS: p.slope(),
			PositionMs: a.Expected(now) + int64(p.res), ReadyState: 4,
			BufferedAheadS: p.aheadS, BufferedBehindS: p.behindS,
			UncertaintyMs: p.uncertainty, RTTMs: 2 * p.uncertainty, ClockSamples: 10,
		}, a, now, t)
		switch {
		case d.Action == ActionSeek:
			p.res = float64(a.Expected(now) - d.TargetMs)
			p.hist = nil
			p.seeks++
		case d.Action == ActionNudge:
			p.rate = d.Rate
		case d.ResetRate:
			p.rate = 1
		}
		if p.kickAtMs > 0 && now > p.kickAtMs && p.rate == 1 && d.Action != ActionSeek {
			p.rateDrops++
		}
		if p.trackAfterKick && p.kickAtMs > 0 && now > p.kickAtMs {
			p.worstRateAfterKick = math.Max(p.worstRateAfterKick, math.Abs(p.rate-1/p.intrinsic))
		}
	}
	return worst
}

// When no seek is free the servo has only its rate to close a gap with, and
// the rate must actually close it. The frequency integrator used to read the
// slope the phase nudge itself produced as a frequency error and wind up
// against it: the loop has a line of equilibria where the rate is exactly 1.0
// and the residual is still outside the band, and every report after that is
// a "nudge" to 1.0000 the room suppresses as already held. Only the free-seek
// and NudgeMaxResidual escapes ever closed such a gap.
func TestServoNudgeClosesAGapNoSeekCanReach(t *testing.T) {
	band := float64(DefaultTunables().ToleranceMs)
	cases := []struct {
		name  string
		plant servoPlant
		band  float64
		// canSeek: nudging brings the target inside the thin forward buffer,
		// at which point a free seek is the right finish.
		canSeek bool
	}{
		// Ahead, and the player keeps nothing behind the playhead.
		{"2000 ms ahead, no back buffer", servoPlant{intrinsic: 1, res: 2000, aheadS: 11}, band, false},
		{"800 ms ahead, 0.5 s back buffer", servoPlant{intrinsic: 1, res: 800, aheadS: 11, behindS: 0.5}, band, false},
		// Behind, on a thin forward buffer and an uncertain clock.
		{"2500 ms behind, 1.05 s ahead", servoPlant{intrinsic: 1, res: -2500, aheadS: 1.05, behindS: 10, uncertainty: 600}, 600, true},
		// And with a slow decoder on top: the gap must still close AND the
		// rate mismatch must still be learned.
		{"2000 ms ahead on a 0.99x decoder", servoPlant{intrinsic: 0.99, res: 2000, aheadS: 11}, band, false},
	}
	for _, tc := range cases {
		p := tc.plant
		worst := p.run(&ServoCorrector{}, 300000, 60000)
		if !tc.canSeek && p.seeks != 0 {
			t.Errorf("%s: %d seeks; this case has no free seek and is under NudgeMaxResidual", tc.name, p.seeks)
		}
		// A little slack over the band: the loop legitimately rides its edge.
		if worst > tc.band+50 {
			t.Errorf("%s: still %.0f ms out after 4 minutes of nudging (band %.0f ms, rate %.4f)",
				tc.name, worst, tc.band, p.rate)
		}
	}
}

// The frequency term's whole job, which the fix must not cost: a member on a
// slow decoder, starting aligned, is held there by rate alone and the servo
// learns the mismatch.
func TestServoLearnsARateMismatch(t *testing.T) {
	for _, intrinsic := range []float64{0.99, 0.995, 1.008} {
		p := servoPlant{intrinsic: intrinsic, aheadS: 11, behindS: 10}
		worst := p.run(&ServoCorrector{}, 300000, 60000)
		if want := 1 / intrinsic; math.Abs(p.rate-want) > 0.002 {
			t.Errorf("%.3fx decoder: settled at rate %.4f, want ~%.4f", intrinsic, p.rate, want)
		}
		if worst > float64(DefaultTunables().ToleranceMs) {
			t.Errorf("%.3fx decoder: drifted %.0f ms out", intrinsic, worst)
		}
	}
}

// A seek removes a step, not a rate mismatch, and it does not touch the rate
// the client is running. dropStep keeps the loop as the last command left it,
// so the frequency term sees the client still compensating. Zeroing the bias
// alone made the report right after the seek look settled -- residual 0, slope
// 0 -- and the servo told a 0.99x decoder to run at exactly 1.0 again, then
// learned the whole mismatch back from the drift that caused.
func TestServoKeepsTheLearnedRateAcrossAFreeSeek(t *testing.T) {
	// The kick lands on a report (whose slope then carries the step) or
	// between two (whose window then carries it too steeply to integrate).
	for _, kickAt := range []int64{120000, 120500} {
		for _, intrinsic := range []float64{0.99, 0.995, 1.008} {
			p := servoPlant{intrinsic: intrinsic, aheadS: 11, behindS: 10, kickAtMs: kickAt, kickMs: 1500}
			p.run(&ServoCorrector{}, 180000, 0)
			if p.seeks != 1 {
				t.Fatalf("kick at %d, %.3fx decoder: %d seeks, want the one free seek for the kick", kickAt, intrinsic, p.seeks)
			}
			if p.rateDrops != 0 {
				t.Errorf("kick at %d, %.3fx decoder: put back to rate 1.0 %d times after the seek; it needs ~%.4f",
					kickAt, intrinsic, p.rateDrops, 1/intrinsic)
			}
			if want := 1 / intrinsic; math.Abs(p.rate-want) > 0.002 {
				t.Errorf("kick at %d, %.3fx decoder: settled at rate %.4f after the seek, want ~%.4f", kickAt, intrinsic, p.rate, want)
			}
		}
	}
}

// An absent member's engine resets its rate to 1.0 (engine.ts releaseRate),
// so the phase nudge this loop last commanded is no longer in the slope. Read
// as still in effect, it looked like a frequency error of the nudge's size,
// integrated over the whole absence, and wound the bias to its clamp on the
// first report back.
func TestServoAbsenceDoesNotWindUpTheBias(t *testing.T) {
	tun := DefaultTunables()
	a := Anchor{PositionMs: 100000}
	c := &ServoCorrector{}
	rep := func(now int64, slope float64, suspended bool) Report {
		return Report{ClientID: "m", ResidualMs: -1500, SlopeMsPerS: slope,
			PositionMs: a.Expected(now) - 1500, ReadyState: 4,
			BufferedAheadS: 1.2, BufferedBehindS: 10, ClockSamples: 10, Suspended: suspended}
	}
	// 1.5 s behind on a thin buffer: no free seek, so the servo nudges hard.
	if d := c.Decide(rep(1000, 0, false), a, 1000, tun); d.Action != ActionNudge || d.Rate <= 1.05 {
		t.Fatalf("setup: %v rate %.3f, want a strong nudge", d.Why, d.Rate)
	}
	before := c.st["m"].rateBias
	for now := int64(2000); now <= 9000; now += 1000 {
		c.Decide(rep(now, 0, true), a, now, tun)
	}
	// Back, running at 1.0 on a decoder 0.5% fast: the slope is real, and
	// one report's worth of it is all that may be integrated.
	const slope = 5.0
	c.Decide(rep(10000, slope, false), a, 10000, tun)
	got := c.st["m"].rateBias - before
	want := -slope / 1000 * 0.35 * 1
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("first report after the absence moved the bias by %.5f, want %.5f", got, want)
	}
}

// A paused element's residual does not move, so its slope is 0 whatever rate
// the element holds: it says nothing about frequency. Integrated anyway, it
// read the last phase nudge as a frequency error of the opposite sign. A
// paused member sitting exactly on the anchor was wound to a bias of
// phaseRate*0.35 per second -- to the clamp after a few seconds' gap, such as
// the acquisition that follows a media command -- kept being nudged while
// paused, and then played ahead of the room by what the loop took to unwind.
func TestServoAPausedReportIsNotAFrequencyError(t *testing.T) {
	tun := DefaultTunables()
	for _, gapMs := range []int64{1000, 5000} {
		c := &ServoCorrector{}
		playing := Anchor{PositionMs: 100000}
		// 1200 ms behind, out of buffer: no free seek, so the servo nudges.
		d := c.Decide(Report{ClientID: "m", ResidualMs: -1200, PositionMs: playing.Expected(1000) - 1200,
			ReadyState: 4, BufferedAheadS: 1.0, UncertaintyMs: 20, ClockSamples: 10}, playing, 1000, tun)
		if d.Action != ActionNudge || d.Rate <= 1.05 {
			t.Fatalf("setup: %v rate %.4f, want a strong nudge", d.Action, d.Rate)
		}
		before := c.st["m"].rateBias
		paused := Anchor{PositionMs: 101000, AtServerMs: 1000 + gapMs, Paused: true}
		for now := 1000 + gapMs; now <= 5000+gapMs; now += 1000 {
			d = c.Decide(Report{ClientID: "m", ResidualMs: 0, SlopeMsPerS: 0, PositionMs: 101000, Paused: true,
				ReadyState: 4, BufferedAheadS: 5, BufferedBehindS: 5, UncertaintyMs: 20, ClockSamples: 10}, paused, now, tun)
			if got := c.st["m"].rateBias; math.Abs(got-before) > 1e-9 {
				t.Fatalf("gap %d ms, paused on the anchor at %d: the bias moved %.4f -> %.4f (%v %.4f)",
					gapMs, now, before, got, d.Action, d.Rate)
			}
		}
		if d.Action == ActionNudge {
			t.Fatalf("gap %d ms: a paused member on the anchor with nothing learned is still nudged to %.4f", gapMs, d.Rate)
		}
	}
}

// RateReleased is the room saying the member's element is back at 1.0 without
// an absence: a member acquiring media has been through the load algorithm,
// which resets playbackRate. The loop must take its last nudge back out, as
// the suspended branch does, and restart dt.
func TestServoARateReleaseIsNotAFrequencyError(t *testing.T) {
	tun := DefaultTunables()
	a := Anchor{PositionMs: 100000}
	c := &ServoCorrector{}
	rep := func(now int64, slope float64) Report {
		return Report{ClientID: "m", ResidualMs: -1500, SlopeMsPerS: slope,
			PositionMs: a.Expected(now) - 1500, ReadyState: 4,
			BufferedAheadS: 1.2, BufferedBehindS: 10, ClockSamples: 10}
	}
	if d := c.Decide(rep(1000, 0), a, 1000, tun); d.Action != ActionNudge || d.Rate <= 1.05 {
		t.Fatalf("setup: %v rate %.3f, want a strong nudge", d.Why, d.Rate)
	}
	before := c.st["m"].rateBias
	c.RateReleased("m")
	c.RateReleased("unknown")
	if _, ok := c.st["unknown"]; ok {
		t.Fatal("releasing a member the loop never saw created state for it")
	}
	const slope = 5.0 // a decoder 0.5% fast, running at 1.0
	c.Decide(rep(6000, slope), a, 6000, tun)
	got := c.st["m"].rateBias - before
	if want := -slope / 1000 * 0.35 * 1; math.Abs(got-want) > 1e-9 {
		t.Errorf("first report after the release moved the bias by %.5f, want %.5f", got, want)
	}
}

// The free-seek hand-over, off the whole-second grid. A seek removes a step,
// not a rate mismatch, so the rate a decoder was learned to need must still be
// what it is told right after the seek. Handing the whole running rate to the
// phase term and zeroing the bias commanded 1+bias+phase with both near 0: a
// 0.99x decoder that had learned 1.0101 was told 1.0035 on the next heartbeat,
// and a 0.995x one reporting 150 ms after the seek was told exactly 1.0.
// TestServoKeepsTheLearnedRateAcrossAFreeSeek reports only on whole seconds
// and counts only exact 1.0s, so it saw neither.
func TestServoCommandsTheLearnedRateRightAfterAFreeSeek(t *testing.T) {
	for _, gap := range []int64{1000, 250, 150} {
		for _, intrinsic := range []float64{0.99, 0.995, 1.008} {
			p := servoPlant{intrinsic: intrinsic, aheadS: 11, behindS: 10,
				kickAtMs: 120000, kickMs: 1500, extraAfterKickMs: gap, trackAfterKick: true}
			p.run(&ServoCorrector{}, 180000, 0)
			if p.seeks != 1 {
				t.Fatalf("gap %d ms, %.3fx: %d seeks, want the one free seek", gap, intrinsic, p.seeks)
			}
			if p.worstRateAfterKick > 0.002 {
				t.Errorf("gap %d ms, %.3fx decoder: ran up to %.4f off the ~%.4f it needs after the seek",
					gap, intrinsic, p.worstRateAfterKick, 1/intrinsic)
			}
		}
	}
}
