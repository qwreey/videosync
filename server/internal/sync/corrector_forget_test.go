package sync

import (
	"reflect"
	"testing"
)

// perClientState returns the length of a corrector's per-client map, found by
// reflection so a new stateful law cannot be added without this test seeing
// its state. ok is false for a stateless law.
func perClientState(c Corrector) (n int, ok bool) {
	v := reflect.ValueOf(c)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return 0, false
	}
	for i := 0; i < v.NumField(); i++ {
		if f := v.Field(i); f.Kind() == reflect.Map && f.Type().Key().Kind() == reflect.String {
			return f.Len(), true
		}
	}
	return 0, false
}

// A member who leaves must take its loop state with it: the room calls Forget
// on whatever corrector it holds, and a reconnect starts a new clock and a new
// detector that the old integrator state knows nothing about. Only the servo
// did this, and no "+conf" wrapper passed it on, so every other strategy in the
// reconnect and late-join rows resumed a departed member's loop.
func TestEveryStatefulCorrectorForgetsALeaver(t *testing.T) {
	laws := []Corrector{
		&ServoCorrector{}, &PICorrector{}, &PLLCorrector{}, &FLLCorrector{},
		&KalmanCorrector{}, &LeadSeekCorrector{}, &HybridCorrector{},
	}
	tun := DefaultTunables()
	a := Anchor{PositionMs: 100000}
	for _, law := range laws {
		for _, wrapped := range []bool{false, true} {
			var c Corrector = law
			if wrapped {
				c = ConfidenceGated{Inner: law}
			}
			for now := int64(1000); now <= 5000; now += 1000 {
				for _, id := range []string{"gone", "stays"} {
					c.Decide(Report{ClientID: id, ResidualMs: 900, SlopeMsPerS: 3,
						PositionMs: a.Expected(now) + 900, ReadyState: 4,
						BufferedAheadS: 11, BufferedBehindS: 10, ClockSamples: 10}, a, now, tun)
				}
			}
			before, ok := perClientState(law)
			if !ok || before != 2 {
				t.Fatalf("%s: %d per-client entries after two members reported, want 2", c.Name(), before)
			}
			f, ok := c.(forgetter)
			if !ok {
				t.Errorf("%s (wrapped=%v): no Forget, so the room keeps its state for good", c.Name(), wrapped)
				continue
			}
			f.Forget("gone")
			if after, _ := perClientState(law); after != 1 {
				t.Errorf("%s (wrapped=%v): %d entries after one member left, want 1", c.Name(), wrapped, after)
			}
			f.Forget("stays") // leave the law clean for the next pass
		}
	}
}

// The room reaches RateReleased, like Forget, only by asserting on the
// corrector it holds. A "+conf" wrapper that does not pass it on leaves a
// wrapped servo still counting its last nudge as in effect after the element's
// load algorithm reset the rate, while the room's own model says 1.0.
func TestConfidenceGatedPassesARateReleaseThrough(t *testing.T) {
	tun := DefaultTunables()
	a := Anchor{PositionMs: 100000}
	servo := &ServoCorrector{}
	var c Corrector = ConfidenceGated{Inner: servo}
	d := c.Decide(Report{ClientID: "m", ResidualMs: -1500, PositionMs: a.Expected(1000) - 1500,
		ReadyState: 4, BufferedAheadS: 1.2, BufferedBehindS: 10, ClockSamples: 10}, a, 1000, tun)
	if d.Action != ActionNudge {
		t.Fatalf("setup: %v, want a nudge", d.Why)
	}
	rr, ok := c.(interface{ RateReleased(clientID string) })
	if !ok {
		t.Fatal("ConfidenceGated has no RateReleased, so the room's release never reaches the wrapped law")
	}
	rr.RateReleased("m")
	s := servo.st["m"]
	if s.lastAt != 0 || s.phaseRate != -s.rateBias {
		t.Errorf("wrapped servo after a release: lastAt=%d phaseRate=%.5f rateBias=%.5f, want lastAt 0 and phaseRate = -rateBias",
			s.lastAt, s.phaseRate, s.rateBias)
	}
	rr.RateReleased("unknown") // a stranger, or a law without the hook, is fine
	var pi Corrector = ConfidenceGated{Inner: &PICorrector{}}
	pi.(interface{ RateReleased(clientID string) }).RateReleased("m")
}
