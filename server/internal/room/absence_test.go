package room

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// absentPlant is one member behind a playing room, judged by the real servo
// through the room. It runs whatever rate it was last sent and, like the
// engine (engine.ts releaseRate), hands that rate back while it is absent.
type absentPlant struct {
	res  float64 // ms, player - anchor
	rate float64
}

// runAbsence reports once a second for 12 s, absent during [absentFrom,
// absentTo), and returns the rate the member ran after each report.
func runAbsence(t *testing.T, absentFrom, absentTo int64) map[int64]float64 {
	t.Helper()
	anchor := vsync.Anchor{PositionMs: 100_000, AtServerMs: 0}
	r, s := newRoom(&vsync.ServoCorrector{}, anchor)
	r.Join(0, "a", "a")
	p := &absentPlant{res: -2800, rate: 1}
	rates := map[int64]float64{}
	for now := int64(1000); now <= 12_000; now += 1000 {
		absent := now >= absentFrom && now < absentTo
		if absent {
			p.rate = 1
		}
		rep := report(0, int64(p.res))
		rep.SlopeMsPerS = (p.rate - 1) * 1000
		rep.PositionMs = anchor.Expected(now) + int64(p.res)
		// Out of buffer, and inside what a nudge can close: the servo nudges.
		rep.BufferedAheadS, rep.BufferedBehindS = 1.0, 1.0
		rep.Suspended = absent
		before := len(of[Correct](s, "a"))
		r.OnReport(now, "a", rep)
		for _, c := range of[Correct](s, "a")[before:] {
			if c.Mode != "nudge" {
				t.Fatalf("at %d: %s (%s), want only nudges", now, c.Mode, c.Why)
			}
			p.rate = c.Rate
		}
		rates[now] = p.rate
		if !absent {
			p.res += (p.rate - 1) * 1000
		}
	}
	return rates
}

// The servo assumes an absent member's rate was handed back. The room's
// "already told them" record did not, so the first nudge after a short
// absence -- the same rate as before it -- was swallowed as already held: the
// member ran 1.0 while still behind, and the servo, believing its nudge in
// effect, integrated the missing rate into its frequency bias.
func TestAMemberBackFromAShortAbsenceIsNudgedAgainAtOnce(t *testing.T) {
	control := runAbsence(t, 0, 0)
	if control[1000] <= 1 {
		t.Fatalf("control: not nudged at all (%v); the test measures nothing", control[1000])
	}
	got := runAbsence(t, 2000, 5000)
	if got[1000] <= 1 || got[2000] != 1 {
		t.Fatalf("setup: rate %v before and %v during the absence", got[1000], got[2000])
	}
	for _, at := range []int64{5000, 6000} {
		if got[at] <= 1 {
			t.Fatalf("back at 5000 and still behind, but running %v at %d", got[at], at)
		}
	}
}
