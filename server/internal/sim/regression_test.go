package sim

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Each test here locks in a finding from docs/POC-FINDINGS.md. They exist so a
// future change cannot silently reintroduce a bug the harness already caught.

func stallScenario(noGuard bool) Scenario {
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	meh := Link{UpMs: 80, DownMs: 80, JitterMs: 30}
	return Scenario{
		Name: "long-stalls", Seed: 7, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: good, NoStallInference: noGuard},
			{ID: "b", IntrinsicRate: 1.0, Link: good, NoStallInference: noGuard,
				Stalls: [][2]int64{{20000, 24000}, {55000, 58500}, {90000, 96000}}},
			{ID: "c", IntrinsicRate: 1.0, Link: meh, NoStallInference: noGuard,
				Stalls: [][2]int64{{40000, 43000}}},
		},
	}
}

// A buffering stall reports paused==false with a frozen currentTime. Without a
// stall guard the two-diff detector reads that as a backward user seek and
// broadcasts it, dragging the room back -- the bug syncplay ships
// (client.py:521-531 dead-reckons with no buffering guard).
func TestStallGuardIsLoadBearing(t *testing.T) {
	tun := vsync.DefaultTunables()
	corr := vsync.ThresholdCorrector{}

	withGuard := Run(stallScenario(false), corr, tun)
	if withGuard.Misdetections != 0 {
		t.Errorf("stall guard on: want 0 misdetections, got %d", withGuard.Misdetections)
	}

	// The control matters: a zero above proves nothing unless the same
	// scenario misdetects without the guard.
	without := Run(stallScenario(true), corr, tun)
	if without.Misdetections == 0 {
		t.Error("control run misdetected nothing -- the test no longer proves the guard does anything")
	}
}

// Under one-way latency asymmetry the min-RTT offset estimate is biased by
// ~half the path difference, undetectably. Acting on it pushes clients that
// were perfectly aligned apart. Confidence gating must refuse to act inside
// the client's own error bound.
func TestConfidenceGatingStopsBiasDrivenSeeks(t *testing.T) {
	tun := vsync.DefaultTunables()
	sc := Scenario{
		Name: "latency-asymmetry", Seed: 5, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
			{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
			{ID: "c", IntrinsicRate: 1.0, Link: Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
		},
	}

	ungated := Run(sc, vsync.StepRampCorrector{}, tun)
	if ungated.SeeksIssued == 0 {
		t.Error("control: ungated corrector issued no seeks -- scenario no longer stresses the bias")
	}

	gated := Run(sc, vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}}, tun)
	if gated.SeeksIssued != 0 {
		t.Errorf("gated: want 0 seeks on a pure clock bias, got %d", gated.SeeksIssued)
	}
	if gated.MeanDivergenceMs > 1 {
		t.Errorf("gated: clients play at 1.0x and start aligned, so any divergence is self-inflicted; got %.0f ms",
			gated.MeanDivergenceMs)
	}
}

// Confidence gating must be free: it may only suppress corrections that were
// acting on unmeasurable error, never degrade the healthy cases.
func TestConfidenceGatingCostsNothingOnHealthyLinks(t *testing.T) {
	tun := vsync.DefaultTunables()
	plain := Run(stallScenario(false), vsync.StepRampCorrector{}, tun)
	gated := Run(stallScenario(false), vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}}, tun)
	if gated.MeanDivergenceMs > plain.MeanDivergenceMs*1.05 {
		t.Errorf("gating degraded a healthy scenario: %.0f -> %.0f ms",
			plain.MeanDivergenceMs, gated.MeanDivergenceMs)
	}
}

// Two members issue conflicting commands 50 ms apart with no host. Arrival-order
// serialization under the room mutex must settle it without flapping.
func TestNoHostConflictingCommandsConverge(t *testing.T) {
	tun := vsync.DefaultTunables()
	sc := Scenario{
		Name: "conflict", Seed: 6, DurationMs: 40000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
			{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 80, DownMs: 80, JitterMs: 30}},
		},
		Commands: []Command{
			{AtMs: 10000, ClientID: "a", Kind: "pause"},
			{AtMs: 10050, ClientID: "b", Kind: "play"},
		},
	}
	r := Run(sc, vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}}, tun)
	for i, c := range r.ConvergeMs {
		if c < 0 {
			t.Errorf("command %d never converged", i)
		}
		if c > 3000 {
			t.Errorf("command %d took %d ms to converge", i, c)
		}
	}
}

// The sender is excluded from the state broadcast for echo suppression. That
// must NOT also exclude it from scheduling: without `when` on the ack it has
// nothing to schedule against and never applies its own transition. The
// existing suite passed with that bug present, which is why this test exists.
func TestSenderAppliesItsOwnCommand(t *testing.T) {
	tun := vsync.DefaultTunables()
	sc := Scenario{
		Name: "sender-applies", Seed: 11, DurationMs: 30000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
			{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 80, DownMs: 80, JitterMs: 30}},
		},
		// "a" issues the pause, so "a" is the one at risk of not applying it.
		Commands: []Command{{AtMs: 10000, ClientID: "a", Kind: "pause"}},
	}
	r := Run(sc, ConfidenceGatedStepRamp(), tun)
	// If the sender keeps playing while everyone else pauses, divergence grows
	// without bound for the remaining 20 s.
	if r.MaxDivergenceMs > 500 {
		t.Errorf("sender did not apply its own pause: max divergence %.0f ms", r.MaxDivergenceMs)
	}
}

// A scheduled command makes each client apply at its own biased notion of
// `when` and derive position from the same biased clock, so the error lands in
// real media position while the residual reads ~0. Confidence gating cannot
// see it. This test pins the known-bad number so a future fix shows up as a
// failure rather than going unnoticed.
func TestSchedulingLaundersClockBias(t *testing.T) {
	tun := vsync.DefaultTunables()
	mk := func(cmds []Command) Scenario {
		return Scenario{
			Name: "launder", Seed: 5, DurationMs: 120000,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
				{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
				{ID: "c", IntrinsicRate: 1.0, Link: Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
			},
			Commands: cmds,
		}
	}
	quiet := Run(mk(nil), ConfidenceGatedStepRamp(), tun)
	if quiet.MaxDivergenceMs != 0 {
		t.Errorf("command-free asymmetry should stay at 0, got %.0f", quiet.MaxDivergenceMs)
	}

	withCmd := Run(mk([]Command{
		{AtMs: 30000, ClientID: "a", Kind: "pause"},
		{AtMs: 33000, ClientID: "a", Kind: "play"},
	}), ConfidenceGatedStepRamp(), tun)

	if withCmd.MaxDivergenceMs < 500 {
		t.Fatalf("laundering no longer reproduces (%.0f ms) -- if this was fixed on purpose, "+
			"update POC-FINDINGS and this test", withCmd.MaxDivergenceMs)
	}
	// The damage is invisible to the residual channel: the corrector does not
	// even try. That blindness is the finding.
	if withCmd.SeeksIssued != 0 || withCmd.BiasLearned != 0 {
		t.Errorf("expected the residual channel to be blind, got %d seeks / %d biases learned",
			withCmd.SeeksIssued, withCmd.BiasLearned)
	}
}

// The browser probe measured that an in-buffer seek is free (~20 ms at any
// network speed) while an out-of-buffer seek costs a full segment fetch and
// rebuffers for it -- leaving the client further out of position than it
// started. A corrector must therefore never seek outside the buffer.
func TestServoNeverSeeksOutOfBuffer(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	meh := Link{UpMs: 80, DownMs: 80, JitterMs: 30}
	sc := Scenario{
		Name: "long-stalls", Seed: 7, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: good},
			{ID: "b", IntrinsicRate: 1.0, Link: good,
				Stalls: [][2]int64{{20000, 24000}, {55000, 58500}, {90000, 96000}}},
			{ID: "c", IntrinsicRate: 1.0, Link: meh, Stalls: [][2]int64{{40000, 43000}}},
		},
	}
	servo := Run(sc, &vsync.ServoCorrector{}, tun)
	if servo.OutOfBufferSeeks != 0 {
		t.Errorf("servo issued %d out-of-buffer seeks; each one rebuffers the client it was meant to fix",
			servo.OutOfBufferSeeks)
	}
	// Control: the plain threshold strategy does take those expensive seeks,
	// so a zero above means something.
	base := Run(sc, vsync.ThresholdCorrector{}, tun)
	if base.OutOfBufferSeeks == 0 {
		t.Error("control: baseline took no out-of-buffer seeks -- scenario no longer exercises the cost")
	}
}

// A rate mismatch is what playbackRate is for, and the frequency term should
// cancel it rather than letting error accumulate to a dead-band and seeking.
func TestServoCancelsRateDriftWithoutSeeking(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	sc := Scenario{
		Name: "steady/rate-drift", Seed: 1, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.000, Link: good},
			{ID: "b", IntrinsicRate: 0.990, Link: good},
			{ID: "c", IntrinsicRate: 1.008, Link: good},
		},
	}
	servo := Run(sc, &vsync.ServoCorrector{}, tun)
	base := Run(sc, vsync.ThresholdCorrector{}, tun)
	if servo.MeanAnchorErrMs >= base.MeanAnchorErrMs {
		t.Errorf("servo %.0f ms should beat threshold %.0f ms on a pure rate mismatch",
			servo.MeanAnchorErrMs, base.MeanAnchorErrMs)
	}
	// Rate-time is not overhead here: cancelling 1.0%% and 0.8%% errors over
	// 120 s necessarily costs about 0.018*120000 = 2160 ms of time-shift.
	if servo.RateTimeMs < 1500 || servo.RateTimeMs > 3500 {
		t.Errorf("rate-time %.0f ms is outside the range the physics requires (~2160 ms)", servo.RateTimeMs)
	}
}

// Confidence must be inside a continuous control law, not wrapped around it:
// ConfidenceGated is a no-op for a controller that never consults the
// dead-band (docs/POC-FINDINGS.md 26).
func TestServoRefusesToChaseAClockBias(t *testing.T) {
	tun := vsync.DefaultTunables()
	sc := Scenario{
		Name: "latency-asymmetry", Seed: 5, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
			{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
			{ID: "c", IntrinsicRate: 1.0, Link: Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
		},
	}
	servo := Run(sc, &vsync.ServoCorrector{}, tun)
	if servo.MeanAnchorErrMs > 50 {
		t.Errorf("servo chased an unmeasurable bias: %.0f ms anchor error (clients all play at 1.0x and start aligned)",
			servo.MeanAnchorErrMs)
	}
	pll := Run(sc, &vsync.PLLCorrector{}, tun)
	if pll.MeanAnchorErrMs < 100 {
		t.Error("control: a phase integrator no longer walks into the bias trap -- scenario weakened")
	}
}
