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
