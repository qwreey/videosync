package sim

// Simulation cadence. Mirrors the constants table in docs/PROTOCOL.md; the
// point of the harness is to find out whether these values are right.
const (
	stepMs          = 10   // virtual clock granularity
	evalIntervalMs  = 100  // client local evaluation loop (~10 Hz)
	hbIntervalMs    = 1000 // heartbeat
	timeSyncEveryMs = 5000 // clock resync
	slopeWindowMs   = 3000 // least-squares window for d(residual)/dt
	metricSampleMs  = 100  // divergence sampling
	gateTimeoutMs   = 30000
)
