package hub

import "time"

// Clock is the server timebase. Every anchor, every `when`, every time.reply
// stamp comes from here.
//
// It is derived from the monotonic clock, not read from the wall clock each
// time. `atServerMs` is the quantity every client offsets against; if NTP or a
// suspend/resume steps the wall clock mid-session, reading it directly would
// jump the whole room's idea of where it is, and every client would "correct"
// toward the new nonsense. Stamp the wall clock once for the epoch and count
// monotonically from there.
type Clock struct {
	baseWallMs int64
	start      time.Time
}

func NewClock() *Clock {
	return &Clock{baseWallMs: time.Now().UnixMilli(), start: time.Now()}
}

func (c *Clock) NowMs() int64 {
	return c.baseWallMs + int64(time.Since(c.start)/time.Millisecond)
}
