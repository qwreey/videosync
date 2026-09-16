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

func TestThrottleWaitIsWhenTheNextEventIsAllowed(t *testing.T) {
	th := newThrottle(2, 5, 4000)
	now := int64(1000)
	th.allow(now)
	th.allow(now)
	for _, at := range []int64{now, now + 50, now + 199} {
		if th.allow(at) {
			t.Fatalf("allowed at +%d inside the 200 ms window", at-now)
		}
		w := th.waitMs(at)
		if w < 1 {
			t.Fatalf("wait %d at +%d: a retry would spin", w, at-now)
		}
		if th.allow(at + w - 1) {
			t.Fatalf("allowed before the wait (%d ms from +%d) ran out", w, at-now)
		}
		if !(&throttle{burst: th.burst, sustained: th.sustained, cooldownMs: th.cooldownMs,
			count: th.count, lastMs: th.lastMs, windowMs: th.windowMs}).allow(at + w) {
			t.Fatalf("refused when the wait (%d ms from +%d) ran out", w, at-now)
		}
	}
}
