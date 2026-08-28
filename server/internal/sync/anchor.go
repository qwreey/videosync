// Package sync holds the timebase and correction logic shared by the real server
// and the simulation harness. It must stay free of transport concerns.
package sync

// Anchor is the single source of truth for where the room is.
// See docs/PROTOCOL.md "Anchor".
type Anchor struct {
	PositionMs int64
	AtServerMs int64
	Paused     bool
	MediaKey   string
}

// Expected returns where a perfectly-synced client should be at server time T.
// Every position question on either side is answered by this and nothing else.
func (a Anchor) Expected(serverMs int64) int64 {
	if a.Paused {
		return a.PositionMs
	}
	return a.PositionMs + (serverMs - a.AtServerMs)
}

// Reanchor moves the anchor to an explicit position at an explicit server time.
func (a Anchor) Reanchor(positionMs, serverMs int64, paused bool) Anchor {
	a.PositionMs = positionMs
	a.AtServerMs = serverMs
	a.Paused = paused
	return a
}

// Advance rebases the anchor onto serverMs without changing the expected position.
// Used when pausing: freeze at wherever the room was.
func (a Anchor) Advance(serverMs int64) Anchor {
	return a.Reanchor(a.Expected(serverMs), serverMs, a.Paused)
}
