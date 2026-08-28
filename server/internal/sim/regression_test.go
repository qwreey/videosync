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
