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
			// Stalls longer than SEEK_THRESHOLD (1 s). Without stall
			// inference the detector reads each one as a backward user seek
			// and broadcasts it, dragging the room back.
			Name: "long-stalls", Seed: 7, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good,
					Stalls: [][2]int64{{20000, 24000}, {55000, 58500}, {90000, 96000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: meh,
					Stalls: [][2]int64{{40000, 43000}}},
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

// controlRun re-runs the stall scenario with the stall guard disabled, to
// demonstrate that the guard is load-bearing rather than decorative.
func controlRun(tun vsync.Tunables) {
	fmt.Println("CONTROL: same scenario, stall inference DISABLED (= syncplay's behaviour)")
	for _, sc := range scenarios() {
		if sc.Name != "long-stalls" && sc.Name != "transient-hiccup" {
			continue
		}
		off := sc
		off.Clients = append([]sim.ClientProfile(nil), sc.Clients...)
		for i := range off.Clients {
			off.Clients[i].NoStallInference = true
		}
		on := sim.Run(sc, vsync.ThresholdCorrector{}, tun)
		res := sim.Run(off, vsync.ThresholdCorrector{}, tun)
		fmt.Printf("  %-18s stall-guard ON  -> misdetections %d\n", sc.Name, on.Misdetections)
		fmt.Printf("  %-18s stall-guard OFF -> misdetections %d\n", "", res.Misdetections)
	}
	fmt.Println()
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

	fmt.Printf("%-20s %-15s %8s %8s %8s %6s %6s %6s %6s %6s %5s\n",
		"scenario", "strategy", "maxDiv", "p95Div", "meanDiv",
		"seeks", "suppr", "nudges", "gates", "bias", "MISD")
	fmt.Println(strings.Repeat("-", 118))

	for _, sc := range scenarios() {
		for i, c := range correctors {
			r := sim.Run(sc, c, tun)
			fmt.Printf("%-20s %-15s %8.0f %8.0f %8.0f %6d %6d %6d %6d %6d %5d\n",
				sc.Name, names[i], r.MaxDivergenceMs, r.P95DivergenceMs, r.MeanDivergenceMs,
				r.SeeksIssued, r.SeeksSuppressed, r.NudgesIssued, r.GatesOpened,
				r.BiasLearned, r.Misdetections)
			if len(r.ConvergeMs) > 0 {
				fmt.Printf("%-20s %-15s   converge: %v ms\n", "", "", r.ConvergeMs)
			}
		}
		fmt.Println()
	}
	controlRun(tun)
}
