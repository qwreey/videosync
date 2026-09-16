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

	res   float64 // ms, player - anchor
	rate  float64 // the rate the servo last commanded
	hist  [][2]float64
	seeks int
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
		p.hist = append(p.hist, [2]float64{float64(now) / 1000, p.res})
		for len(p.hist) > 0 && p.hist[0][0] < float64(now-3000)/1000 {
			p.hist = p.hist[1:]
		}
		if now >= durMs-tailMs && math.Abs(p.res) > worst {
			worst = math.Abs(p.res)
		}
		if now%1000 != 0 {
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
