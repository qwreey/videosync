package sync

// Report is the heartbeat / anomaly report a client sends.
// Residual and slope are computed client-side at high frequency with zero
// network noise; the server never differentiates 1 Hz samples itself.
// See docs/PROTOCOL.md section 4.
type Report struct {
	ClientID string `json:"-"`
	// ResidualMs is signed: localPosition - anchor.Expected(serverNow).
	// Negative means the client is behind the room.
	ResidualMs int64 `json:"residualMs"`
	// SlopeMsPerS is d(residual)/dt, least-squares over a short window.
	SlopeMsPerS    float64 `json:"slopeMsPerS"`
	PositionMs     int64   `json:"positionMs"`
	Paused         bool    `json:"paused"`
	ReadyState     int     `json:"readyState"`
	BufferedAheadS float64 `json:"bufferedAheadS"`
	// BufferedBehindS matters as much as ahead: a backward correction that
	// lands inside the back buffer is free, one outside it rebuffers.
	BufferedBehindS float64 `json:"bufferedBehindS"`
	LastAppliedSeq  uint64  `json:"lastAppliedSeq"`
	AtServerMs      int64   `json:"atServerMs"`
	// UncertaintyMs is the client's honest error bound on its own clock
	// estimate: with min-RTT sampling the offset error is bounded by
	// +/- bestRTT/2, reached exactly when the path is fully asymmetric. This
	// is NTP's "maximum error" idea. A residual smaller than this is
	// indistinguishable from our own measurement error, so acting on it is
	// guesswork -- and POC-FINDINGS section 6 showed that guesswork actively
	// creates divergence that was not there.
	UncertaintyMs int64 `json:"uncertaintyMs"`
	// RTTMs is the client's best observed round trip. Unlike any offset-derived
	// quantity it is bias-free, so the server can safely use it for scheduling.
	RTTMs int64 `json:"rttMs"`
	// ClockSamples counts accepted min-RTT samples. Corrections before the
	// estimate has settled do more harm than good.
	ClockSamples int `json:"clockSamples"`
	// Suspended means the browser paused this member's element because its tab
	// is hidden and muted. Such a member is ABSENT, not behind: the readiness
	// gate must not hold the room for them, or the room waits forever for
	// someone who is not watching.
	Suspended bool `json:"suspended"`
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
