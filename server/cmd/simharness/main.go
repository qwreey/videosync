// Command simharness runs the Risk-A experiments: does the sync algorithm
// converge, and does the derivative classifier beat plain thresholds?
// Deterministic virtual-clock simulation, no browser, no network.
package main

import (
	"fmt"
	"strings"

	"github.com/qwreey/videosync/server/internal/sim"
	vsync "github.com/qwreey/videosync/server/internal/sync"
)

func scenarios() []sim.Scenario {
	good := sim.Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	meh := sim.Link{UpMs: 80, DownMs: 80, JitterMs: 30}
	bad := sim.Link{UpMs: 200, DownMs: 200, JitterMs: 90, LossPct: 2}

	return []sim.Scenario{
		{
			Name: "steady/rate-drift", Seed: 1, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.000, Link: good},
				{ID: "b", IntrinsicRate: 0.990, Link: good}, // slow decoder
				{ID: "c", IntrinsicRate: 1.008, Link: meh},  // fast decoder
			},
		},
		{
			Name: "transient-hiccup", Seed: 2, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good,
					// short stalls: falls behind, then catches up on its own
					Stalls: [][2]int64{{20000, 20800}, {50000, 50600}, {80000, 80900}}},
				{ID: "c", IntrinsicRate: 1.0, Link: meh},
			},
		},
		{
			Name: "one-slow-client", Seed: 3, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good},
				{ID: "c", IntrinsicRate: 0.99, Link: bad, // bad line AND slow player
					Stalls: [][2]int64{{30000, 34000}}},
			},
		},
		{
			Name: "clock-skew", Seed: 4, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, ClockSkewMs: 0, Link: good},
				{ID: "b", IntrinsicRate: 0.997, ClockSkewMs: 45000, Link: good},  // 45s ahead
				{ID: "c", IntrinsicRate: 1.003, ClockSkewMs: -120000, Link: meh}, // 2min behind
			},
		},
		{
			Name: "latency-asymmetry", Seed: 5, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				// The failure min-RTT cannot detect: offset is biased by half
				// the up/down difference no matter how many samples we take.
				{ID: "b", IntrinsicRate: 1.0, Link: sim.Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
				{ID: "c", IntrinsicRate: 1.0, Link: sim.Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
			},
		},
		{
			Name: "command-storm", Seed: 6, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 0.999, Link: meh},
				{ID: "c", IntrinsicRate: 1.0, Link: bad},
			},
			Commands: []sim.Command{
				{AtMs: 10000, ClientID: "a", Kind: "pause"},
				{AtMs: 13000, ClientID: "b", Kind: "play"},
				{AtMs: 30000, ClientID: "c", Kind: "seek", PositionMs: 300000},
				// near-simultaneous conflicting commands, the no-host case
				{AtMs: 60000, ClientID: "a", Kind: "pause"},
				{AtMs: 60050, ClientID: "b", Kind: "play"},
				{AtMs: 90000, ClientID: "c", Kind: "seek", PositionMs: 600000},
			},
		},
	}
}

func main() {
	tun := vsync.DefaultTunables()
	correctors := []vsync.Corrector{
		vsync.ThresholdCorrector{},                    // what all 9 references do
		vsync.ThresholdCorrector{HardSeekMs: 2000},    // cytube/SyncTube-style wide deadband
		vsync.DerivativeCorrector{},                   // ours, v1
		vsync.StepRampCorrector{},                     // ours, v2 (post-harness)
	}
	names := []string{"threshold-500", "threshold-2000", "derivative", "step-ramp"}

	fmt.Printf("%-22s %-16s %8s %8s %8s %7s %7s %7s %7s\n",
		"scenario", "strategy", "maxDiv", "p95Div", "meanDiv", "seeks", "waste", "nudges", "gates")
	fmt.Println(strings.Repeat("-", 110))

	for _, sc := range scenarios() {
		for i, c := range correctors {
			r := sim.Run(sc, c, tun)
			fmt.Printf("%-22s %-16s %8.0f %8.0f %8.0f %7d %7d %7d %7d\n",
				sc.Name, names[i], r.MaxDivergenceMs, r.P95DivergenceMs, r.MeanDivergenceMs,
				r.SeeksIssued, r.UnnecessarySeeks, r.NudgesIssued, r.GatesOpened)
			if len(r.ConvergeMs) > 0 {
				fmt.Printf("%-22s %-16s   converge after commands: %v ms\n", "", "", r.ConvergeMs)
			}
		}
		fmt.Println()
	}
}
