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

// A member acquiring media has been through the element's load algorithm,
// which resets playbackRate, so the nudge it was running is gone without any
// absence. Both halves of the room's model have to know: the servo, or it
// reads the missing nudge as a frequency error over the whole acquisition and
// winds its bias; and the "already told them" record, or the same nudge sent
// again is swallowed as held while the member runs 1.0.
func TestAMemberBackFromAcquiringIsNudgedAsBefore(t *testing.T) {
	anchor := vsync.Anchor{PositionMs: 100_000, AtServerMs: 0}
	r, s := newRoom(&vsync.ServoCorrector{}, anchor)
	r.Join(0, "a", "a")
	behind := func(now int64) Report {
		// 1200 ms behind and out of buffer: a nudge the clamp does not cap.
		rep := report(0, -1200)
		rep.PositionMs = anchor.Expected(now) - 1200
		rep.BufferedAheadS, rep.BufferedBehindS = 1.0, 1.0
		return rep
	}
	r.OnReport(1000, "a", behind(1000))
	first := of[Correct](s, "a")
	if len(first) != 1 || first[0].Mode != "nudge" || first[0].Rate <= 1 || first[0].Rate >= 1.09 {
		t.Fatalf("setup: %+v, want one unclamped nudge", first)
	}
	acq := acquiringReport(0)
	r.OnReport(2000, "a", acq)
	r.OnReport(2500, "a", acq)
	// Loaded and conformed, still behind, running 1.0: the slope is 0.
	r.OnReport(3500, "a", behind(3500))
	got := of[Correct](s, "a")[1:]
	if len(got) != 1 || got[0].Mode != "nudge" {
		t.Fatalf("back from acquiring and still behind, sent %+v; want the nudge again", got)
	}
	if d := got[0].Rate - first[0].Rate; d > 0.001 || d < -0.001 {
		t.Fatalf("nudged to %.4f after acquiring, %.4f before: the servo read the reset rate as a frequency error",
			got[0].Rate, first[0].Rate)
	}
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
