package hub

import "testing"

func TestThrottleAllowsTheBurstThenPaces(t *testing.T) {
	th := newThrottle(4, 1, 4000)
	now := int64(1000)
	for i := 0; i < 4; i++ {
		if !th.allow(now) {
			t.Fatalf("burst event %d refused", i)
		}
	}
	if th.allow(now) {
		t.Fatal("5th event in the same instant was allowed")
	}
	// Sustained is 1/s: one more at +1000 ms, none at +1500.
	if !th.allow(now + 1000) {
		t.Fatal("sustained event refused after 1 s")
	}
	if th.allow(now + 1500) {
		t.Fatal("allowed twice within the sustained interval")
	}
}

func TestThrottleResetsAfterIdle(t *testing.T) {
	th := newThrottle(4, 1, 4000)
	now := int64(1000)
	for i := 0; i < 4; i++ {
		th.allow(now)
	}
	if th.allow(now) {
		t.Fatal("burst not exhausted")
	}
	// Idle past the cooldown: the whole allowance comes back, which is what
	// makes this anti-accident rather than a punishment.
	now += 5000
	for i := 0; i < 4; i++ {
		if !th.allow(now) {
			t.Fatalf("event %d refused after cooldown", i)
		}
	}
}
