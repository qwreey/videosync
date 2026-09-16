package hub

// throttle is cytube's rate limiter, reimplemented from the description in
// research/cytube-watchparty.md section 12 (`src/utilities.js:135-176`): a free
// burst, then one event per 1000/sustained ms, and the whole thing resets after
// `cooldown` of silence.
//
// The point here is anti-accident, not anti-malice (SYNTHESIS 13.3). A stuck
// adapter re-emitting the same seek, or a reconnect storm, must not be able to
// flood the room. A person cannot out-click these limits.
type throttle struct {
	burst      int
	sustained  float64 // events per second after the burst is spent
	cooldownMs int64

	count    int
	lastMs   int64
	windowMs int64
}

func newThrottle(burst int, sustained float64, cooldownMs int64) *throttle {
	return &throttle{burst: burst, sustained: sustained, cooldownMs: cooldownMs}
}

// allow reports whether one event may proceed at server time now.
func (t *throttle) allow(now int64) bool {
	if t.lastMs != 0 && now-t.lastMs > t.cooldownMs {
		t.count, t.windowMs = 0, 0
	}
	t.lastMs = now
	if t.count < t.burst {
		t.count++
		// Start the sustained window the moment the burst is spent, not on the
		// first refusal -- otherwise a zero window reads as "never paced" and
		// the burst limit does nothing at all.
		if t.count == t.burst {
			t.windowMs = now
		}
		return true
	}
	if now-t.windowMs >= int64(1000/t.sustained) {
		t.windowMs = now
		return true
	}
	return false
}

// waitMs is how long after now the next event would be allowed. Never less
// than 1, so a caller that retries on it always makes progress.
func (t *throttle) waitMs(now int64) int64 {
	if t.count < t.burst {
		return 1
	}
	return max(t.windowMs+int64(1000/t.sustained)-now, 1)
}
