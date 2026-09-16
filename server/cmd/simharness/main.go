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
			// Same asymmetry, but with commands. A scheduled command makes
			// each client apply at its OWN biased notion of `when` and derive
			// its position from the same biased clock -- so the error lands in
			// real media position while the residual reads ~0, invisible.
			Name: "asymmetry+cmds", Seed: 5, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: sim.Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
				{ID: "c", IntrinsicRate: 1.0, Link: sim.Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
			},
			Commands: []sim.Command{
				{AtMs: 30000, ClientID: "a", Kind: "pause"},
				{AtMs: 33000, ClientID: "a", Kind: "play"},
			},
		},
		{
			// Chrome pauses a muted hidden tab and fires a real `pause`. A
			// member switching tabs must not move the room.
			Name: "tab-suspension", Seed: 21, DurationMs: 90000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good,
					Suspends: [][2]int64{{20000, 35000}, {55000, 70000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: meh},
			},
		},
		{
			// A member offline across a seek comes back holding a stale anchor
			// and reports residual ~0 against it.
			Name: "reconnect", Seed: 31, DurationMs: 90000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good, Disconnects: [][2]int64{{25000, 40000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: meh},
			},
			Commands: []sim.Command{{AtMs: 30000, ClientID: "a", Kind: "seek", PositionMs: 600000}},
		},
		{
			// A joiner arrives with zero clock samples -- the member most in
			// need of correction is the one confidence gating refuses to touch.
			Name: "late-join", Seed: 41, DurationMs: 90000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 0.997, Link: good},
				{ID: "c", IntrinsicRate: 1.0, Link: meh, JoinAtMs: 30000},
			},
		},
		{
			// The readiness gate's own scenario. The room is paused, one member
			// cannot buffer for the first 25 s, and somebody presses play at
			// 10 s. Without the gate the room starts without them and they
			// spend the stall falling behind; with it the play waits.
			Name: "slow-to-buffer", Seed: 51, DurationMs: 90000, StartPos: 0, StartPaused: true,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good},
				{ID: "c", IntrinsicRate: 1.0, Link: meh, Stalls: [][2]int64{{0, 25000}}},
			},
			Commands: []sim.Command{{AtMs: 10000, ClientID: "a", Kind: "play"}},
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

	// The readiness gate is the one piece of the design that was shipped as a
	// notification before it was ever measured. Its benefit cannot show up in
	// anchorErr -- that metric excludes a stalled client -- so score it on the
	// media its members were skipped past, and charge it for the delay it
	// imposes.
	fmt.Println("CONTROL: slow-to-buffer, readiness gate ON vs OFF")
	for _, sc := range scenarios() {
		if sc.Name != "slow-to-buffer" {
			continue
		}
		off := sc
		off.GateDisabled = true
		for _, c := range []struct {
			label string
			sc    sim.Scenario
		}{{"gate ON ", sc}, {"gate OFF", off}} {
			r := sim.Run(c.sc, &vsync.ServoCorrector{}, tun)
			fmt.Printf("  %-8s anchorErr %4.0f ms   skipped %6.0f ms   out-of-buffer seeks %d"+
				"   held %d cmd for %d ms\n",
				c.label, r.MeanAnchorErrMs, r.SkippedMs, r.OutOfBufferSeeks, r.CmdsHeld, r.GateHoldMs)
		}
	}
	fmt.Println()
}

// strategy is one row label in the table and the corrector it runs.
type strategy struct {
	name string
	mk   func() vsync.Corrector
}

// strategies lists what the table compares, as constructors rather than
// instances. Most correctors keep per-client state keyed by member id, every
// scenario reuses the ids a/b/c, and nothing in a finished run tells the
// corrector those members left. One instance shared across the table therefore
// started each scenario with the previous scenario's integrators wound up, and
// the published rows depended on the order the scenarios happened to be listed
// in (POC-FINDINGS 41a). The real server builds one corrector per room.
func strategies() []strategy {
	return []strategy{
		{"threshold-500", func() vsync.Corrector { return vsync.ThresholdCorrector{} }},                  // what all 9 references do
		{"threshold-2000", func() vsync.Corrector { return vsync.ThresholdCorrector{HardSeekMs: 2000} }}, // cytube/SyncTube-style wide deadband
		{"step-ramp+conf", func() vsync.Corrector { return vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}} }},
		{"pll", func() vsync.Corrector { return &vsync.PLLCorrector{} }},       // phase-locked loop
		{"fll", func() vsync.Corrector { return &vsync.FLLCorrector{} }},       // frequency-locked loop (bias-immune)
		{"hybrid", func() vsync.Corrector { return &vsync.HybridCorrector{} }}, // FLL-aided PLL
		{"hybrid+conf", func() vsync.Corrector { return vsync.ConfidenceGated{Inner: &vsync.HybridCorrector{}} }},
		{"servo", func() vsync.Corrector { return &vsync.ServoCorrector{} }}, // synthesis of every finding
	}
}

// table runs every strategy against every scenario, in order.
func table(scs []sim.Scenario, tun vsync.Tunables) [][]sim.Result {
	strats := strategies()
	out := make([][]sim.Result, len(scs))
	for i, sc := range scs {
		for _, st := range strats {
			out[i] = append(out[i], sim.Run(sc, st.mk(), tun))
		}
	}
	return out
}

func main() {
	tun := vsync.DefaultTunables()
	strats := strategies()

	// anchorErr is the PRIMARY metric: error against the true server clock.
	// meanDiv (inter-client spread) is kept for continuity but rewards
	// inaction -- a strategy that does nothing scores 0 when clients start
	// aligned. Do not rank on it.
	// Seeks are split because they do not cost the same thing: an in-buffer
	// seek is ~free at any network speed, an out-of-buffer seek costs a full
	// segment fetch and rebuffers for it (docs/BROWSER-FINDINGS.md 2).
	fmt.Printf("%-20s %-16s %9s %9s %6s %6s %8s %6s %5s\n",
		"scenario", "strategy", "anchorErr", "p95Anchor",
		"seek/in", "seek/OUT", "rateTime", "gates", "BAD")
	fmt.Println(strings.Repeat("-", 104))

	scs := scenarios()
	for i, rows := range table(scs, tun) {
		for j, r := range rows {
			fmt.Printf("%-20s %-16s %9.0f %9.0f %6d %6d %8.0f %6d %5d\n",
				scs[i].Name, strats[j].name, r.MeanAnchorErrMs, r.P95AnchorErrMs,
				r.InBufferSeeks, r.OutOfBufferSeeks, r.RateTimeMs,
				r.GatesOpened, r.Misdetections+r.SpuriousCmds)
			if len(r.ConvergeMs) > 0 {
				fmt.Printf("%-20s %-15s   converge: %v ms\n", "", "", r.ConvergeMs)
			}
		}
		fmt.Println()
	}
	controlRun(tun)
}
