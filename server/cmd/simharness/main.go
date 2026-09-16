// Command simharness runs the Risk-A experiments: does the sync algorithm
// converge, and does the derivative classifier beat plain thresholds?
// Deterministic virtual-clock simulation, no browser, no network.
package main

import (
	"flag"
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
			// A member offline across a seek. It leaves, rejoins with a welcome
			// carrying the new anchor, and has to be corrected 560 s forward.
			// (Until POC-FINDINGS 41 the harness kept it joined and dropped its
			// frames, so it came back on a stale anchor -- a state a reconnect
			// cannot produce.)
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
			// D8. A paused room; c arrives on a page whose site resumes from
			// its own history (813 s) and autoplays when the player can play,
			// 1.5 s after the join -- measured on Laftel (BROWSER-FINDINGS 20).
			// a presses play while c is still loading.
			Name: "site-autoplay-join", Seed: 61, DurationMs: 90000, StartPos: 60000, StartPaused: true,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: meh},
				{ID: "c", IntrinsicRate: 1.0, Link: meh, JoinAtMs: 20000,
					SiteAfterMs: 1500, SiteResumeToMs: 813000, SiteAutoplay: true},
			},
			Commands: []sim.Command{{AtMs: 21200, ClientID: "a", Kind: "play"}},
		},
		{
			// D8, the next episode. A playing room reaches the end of "m" at
			// 60 s. a's site moves on after 5 s with the next episode already
			// loaded, b's 60 ms later (a race), c's after 9 s (still on the
			// end screen when the room moves on); d is a throttled background
			// tab. Every continuation is `media` if the room is still on "m".
			Name: "next-episode", Seed: 71, DurationMs: 120000, StartPos: 0,
			Clients: []sim.ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good,
					EndAtMs: 60000, ContinueAfterMs: 5000, LoadMs: 100, NextKey: "m2"},
				{ID: "b", IntrinsicRate: 1.0, Link: meh,
					EndAtMs: 60000, ContinueAfterMs: 5060, LoadMs: 2500, NextKey: "m2"},
				{ID: "c", IntrinsicRate: 1.0, Link: meh,
					EndAtMs: 60000, ContinueAfterMs: 9000, LoadMs: 3000, NextKey: "m2"},
				{ID: "d", IntrinsicRate: 1.0, Link: good,
					Suspends: [][2]int64{{30000, 200000}}, SuspendedReportEveryMs: 60000},
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

	// The readiness gate is the one piece of the design that was shipped as a
	// notification before it was ever measured. Its benefit cannot show up in
	// anchorErr -- that metric excludes a stalled client -- so score it on the
	// media its members were skipped past, and charge it for the delay it
	// imposes.
	// D8: a joiner's site resumes and autoplays. Without the acquisition guard
	// those moves are sent as the member's and the room goes where the site
	// put one member's player.
	fmt.Println("CONTROL: site-autoplay-join, acquisition guard ON vs OFF (mean over seeds 1..10)")
	for _, sc := range scenarios() {
		if sc.Name != "site-autoplay-join" {
			continue
		}
		for _, guard := range []bool{true, false} {
			var spurious, absorbed, held, skipped, finalS float64
			for seed := int64(1); seed <= 10; seed++ {
				v := sc
				v.Seed = seed
				v.Clients = append([]sim.ClientProfile(nil), sc.Clients...)
				for i := range v.Clients {
					v.Clients[i].NoAcquireGuard = !guard
				}
				r := sim.Run(v, &vsync.ServoCorrector{}, tun)
				spurious += float64(r.SiteSpuriousCmds) / 10
				absorbed += float64(r.SiteMovesAbsorbed) / 10
				held += float64(r.CmdsHeld) / 10
				skipped += r.SkippedMs / 10
				finalS += float64(r.FinalAnchor.Expected(v.DurationMs)) / 1000 / 10
			}
			label := "guard ON "
			if !guard {
				label = "guard OFF"
			}
			fmt.Printf("  %s site cmds sent %.1f   absorbed %.1f   held %.1f   skipped %6.0f ms   room ends at %6.1f s\n",
				label, spurious, absorbed, held, skipped, finalS)
		}
	}
	fmt.Println()

	// D8: the next episode. Without the condition every member whose site
	// moved on restarts the room; without "on its way" the member still on
	// the end screen is absent, and the room starts the episode without it.
	fmt.Println("CONTROL: next-episode, compare-and-set and in-transit ON vs OFF (mean over seeds 1..10)")
	for _, sc := range scenarios() {
		if sc.Name != "next-episode" {
			continue
		}
		for _, arm := range []struct {
			label string
			tune  func(*sim.ClientProfile)
		}{
			{"both ON      ", func(*sim.ClientProfile) {}},
			{"no condition ", func(p *sim.ClientProfile) { p.NoMediaCAS = true }},
			{"no in-transit", func(p *sim.ClientProfile) { p.NoTransitGuard = true }},
		} {
			var applied, stale, held, holdMs, late float64
			for seed := int64(1); seed <= 10; seed++ {
				v := sc
				v.Seed = seed
				v.Clients = append([]sim.ClientProfile(nil), sc.Clients...)
				for i := range v.Clients {
					arm.tune(&v.Clients[i])
				}
				r := sim.Run(v, &vsync.ServoCorrector{}, tun)
				applied += float64(r.MediaApplied) / 10
				stale += float64(r.MediaStale) / 10
				held += float64(r.CmdsHeld) / 10
				holdMs += float64(r.GateHoldMs) / 10
				late += r.ArrivedLateMs / 10
			}
			fmt.Printf("  %s media applied %.1f   refused %.1f   plays held %.1f for %5.0f ms   arrived late %5.0f ms\n",
				arm.label, applied, stale, held, holdMs, late)
		}
	}
	fmt.Println()

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
	seeds := flag.Int("seeds", 0, "instead of the table, average every row over seeds 1..N")
	only := flag.String("strategy", "", "with -seeds: only this strategy")
	flag.Parse()
	tun := vsync.DefaultTunables()
	if *seeds > 0 {
		averaged(*seeds, *only, tun)
		return
	}
	strats := strategies()

	// anchorErr is the PRIMARY metric: error against the true server clock.
	// meanDiv (inter-client spread) is kept for continuity but rewards
	// inaction -- a strategy that does nothing scores 0 when clients start
	// aligned. Do not rank on it.
	// Seeks are split because they do not cost the same thing: an in-buffer
	// seek is ~free at any network speed, an out-of-buffer seek costs a full
	// segment fetch and rebuffers for it (docs/BROWSER-FINDINGS.md 2).
	// skipped is the other half of the score: anchorErr excludes a stalled
	// member by construction, so a room that leaves somebody behind and yanks
	// them forward later scores well on it. skipped is what that cost them.
	fmt.Printf("%-20s %-16s %9s %9s %6s %6s %8s %8s %6s %5s\n",
		"scenario", "strategy", "anchorErr", "p95Anchor",
		"seek/in", "seek/OUT", "rateTime", "skipped", "gates", "BAD")
	fmt.Println(strings.Repeat("-", 113))

	scs := scenarios()
	for i, rows := range table(scs, tun) {
		for j, r := range rows {
			fmt.Printf("%-20s %-16s %9.0f %9.0f %6d %6d %8.0f %8.0f %6d %5d\n",
				scs[i].Name, strats[j].name, r.MeanAnchorErrMs, r.P95AnchorErrMs,
				r.InBufferSeeks, r.OutOfBufferSeeks, r.RateTimeMs, r.SkippedMs,
				r.GatesOpened, r.Misdetections+r.SpuriousCmds)
			if len(r.ConvergeMs) > 0 {
				fmt.Printf("%-20s %-15s   converge: %v ms\n", "", "", r.ConvergeMs)
			}
		}
		fmt.Println()
	}
	controlRun(tun)
}

// averaged prints every row as a mean over seeds 1..n. The table above is one
// draw of the jitter, and a single seed is not evidence for a comparison
// (POC-FINDINGS 39): a control-law change can win or lose on it by luck.
func averaged(n int, only string, tun vsync.Tunables) {
	fmt.Printf("mean over seeds 1..%d\n", n)
	fmt.Printf("%-20s %-16s %9s %9s %8s %8s %8s %8s %8s\n",
		"scenario", "strategy", "anchorErr", "p95Anchor",
		"seek/in", "seek/OUT", "rateTime", "skipped", "resends")
	fmt.Println(strings.Repeat("-", 104))
	for _, sc := range scenarios() {
		for _, st := range strategies() {
			if only != "" && st.name != only {
				continue
			}
			var m [7]float64
			for s := 1; s <= n; s++ {
				v := sc
				v.Seed = int64(s)
				r := sim.Run(v, st.mk(), tun)
				for k, x := range []float64{r.MeanAnchorErrMs, r.P95AnchorErrMs,
					float64(r.InBufferSeeks), float64(r.OutOfBufferSeeks), r.RateTimeMs,
					r.SkippedMs, float64(r.StaleResends)} {
					m[k] += x / float64(n)
				}
			}
			fmt.Printf("%-20s %-16s %9.0f %9.0f %8.2f %8.2f %8.0f %8.0f %8.2f\n",
				sc.Name, st.name, m[0], m[1], m[2], m[3], m[4], m[5], m[6])
		}
	}
}
