package sync

// Report is the heartbeat / anomaly report a client sends.
// Residual and slope are computed client-side at high frequency with zero
// network noise; the server never differentiates 1 Hz samples itself.
// See docs/PROTOCOL.md section 4.
type Report struct {
	ClientID string
	// ResidualMs is signed: localPosition - anchor.Expected(serverNow).
	// Negative means the client is behind the room.
	ResidualMs int64
	// SlopeMsPerS is d(residual)/dt, least-squares over a short window.
	SlopeMsPerS    float64
	PositionMs     int64
	Paused         bool
	ReadyState     int
	BufferedAheadS float64
	LastAppliedSeq uint64
	AtServerMs     int64
}

// Closing reports whether the residual is shrinking on its own, i.e. the slope
// pushes the residual back toward zero. This is the signal no reference
// implementation uses; all nine threshold on absolute offset only.
func (r Report) Closing() bool {
	if r.ResidualMs == 0 {
		return true
	}
	if r.ResidualMs < 0 {
		return r.SlopeMsPerS > 0
	}
	return r.SlopeMsPerS < 0
}
