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
// asymmetryScenario is a pure clock-bias stress: three clients all playing at
// exactly 1.0x, starting aligned, on wildly asymmetric one-way paths. Any
// divergence at all is therefore self-inflicted by the corrector.
func asymmetryScenario(seed int64) Scenario {
	return Scenario{
		Name: "latency-asymmetry", Seed: seed, DurationMs: 120000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: Link{UpMs: 25, DownMs: 25, JitterMs: 5}},
			{ID: "b", IntrinsicRate: 1.0, Link: Link{UpMs: 20, DownMs: 1200, JitterMs: 10}},
			{ID: "c", IntrinsicRate: 1.0, Link: Link{UpMs: 1200, DownMs: 20, JitterMs: 10}},
		},
	}
}

// seeds is the sample this file averages over.
//
// A single seed is not evidence here. Both assertions below were originally
// written as "exactly 0 seeks" against seed 5, and passed -- but a scan over 60
// seeds showed that property holds in only about two thirds of them, so the
// test had been passing on luck and any change that shifted the jitter draws
// could turn it red without anything being wrong. Averaging is what makes the
// claim the test states ("gating suppresses bias-driven corrections") the claim
// it actually checks.
var seeds = []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20}

// Under one-way latency asymmetry the min-RTT offset estimate is biased by
// ~half the path difference, undetectably. Acting on it pushes clients that
// were perfectly aligned apart. Confidence gating must refuse to act inside the
// client's own error bound.
func TestConfidenceGatingStopsBiasDrivenSeeks(t *testing.T) {
	tun := vsync.DefaultTunables()
	var gSeeks, uSeeks, gDiv, uDiv float64
	for _, seed := range seeds {
		sc := asymmetryScenario(seed)
		g := Run(sc, vsync.ConfidenceGated{Inner: vsync.StepRampCorrector{}}, tun)
		u := Run(sc, vsync.StepRampCorrector{}, tun)
		gSeeks += float64(g.SeeksIssued)
		uSeeks += float64(u.SeeksIssued)
		gDiv += g.MeanDivergenceMs
		uDiv += u.MeanDivergenceMs
	}
	n := float64(len(seeds))
	gSeeks, uSeeks, gDiv, uDiv = gSeeks/n, uSeeks/n, gDiv/n, uDiv/n

	// The control matters: a low gated number proves nothing unless the same
	// scenario makes the ungated corrector misbehave.
	if uSeeks < 2 {
		t.Fatalf("control: ungated corrector averaged %.1f seeks -- the scenario no longer "+
			"stresses the clock bias", uSeeks)
	}
	if gSeeks > uSeeks/3 {
		t.Errorf("gating barely helped: %.2f seeks/run gated vs %.2f ungated", gSeeks, uSeeks)
	}
	// Divergence here is entirely self-inflicted -- the clients are identical
	// and started together.
	if gDiv > uDiv/4 {
		t.Errorf("gated corrector still created %.0f ms of divergence (ungated %.0f ms)", gDiv, uDiv)
	}
}

func TestSchedulingLaundersClockBias(t *testing.T) {
	// A scheduled command makes each client apply at its OWN biased `when` and
	// derive position from the same biased clock. The errors cancel in the
	// residual -- exactly zero -- and land in real media position instead. No
	// passive channel can see it, which is the finding.
	tun := vsync.DefaultTunables()
	cmds := []Command{
		{AtMs: 30000, ClientID: "a", Kind: "pause"},
		{AtMs: 33000, ClientID: "a", Kind: "play"},
	}
	var quietDiv, cmdDiv, cmdSeeks, cmdBias float64
	for _, seed := range seeds {
		q := asymmetryScenario(seed)
		q.Name = "launder-quiet"
		w := asymmetryScenario(seed)
		w.Name = "launder-cmd"
		w.Commands = cmds

		quiet := Run(q, ConfidenceGatedStepRamp(), tun)
		withCmd := Run(w, ConfidenceGatedStepRamp(), tun)
		quietDiv += quiet.MaxDivergenceMs
		cmdDiv += withCmd.MaxDivergenceMs
		cmdSeeks += float64(withCmd.SeeksIssued)
		cmdBias += float64(withCmd.BiasLearned)
	}
	n := float64(len(seeds))
	quietDiv, cmdDiv, cmdSeeks, cmdBias = quietDiv/n, cmdDiv/n, cmdSeeks/n, cmdBias/n

	if cmdDiv < 500 {
		t.Fatalf("laundering no longer reproduces (%.0f ms) -- if this was fixed on purpose, "+
			"update POC-FINDINGS and this test", cmdDiv)
	}
	// The command is what does it: the same asymmetry with nothing scheduled
	// leaves the room far more aligned.
	if quietDiv > cmdDiv/3 {
		t.Errorf("the command is not the cause: %.0f ms without commands vs %.0f ms with", quietDiv, cmdDiv)
	}
	// And the damage is invisible to the residual channel -- the corrector does
	// not even try. That blindness is the point.
	if cmdSeeks > 0.5 || cmdBias > 0.1 {
		t.Errorf("expected the residual channel to be blind, got %.2f seeks / %.2f biases learned per run",
			cmdSeeks, cmdBias)
	}
}

// The browser probe measured that an in-buffer seek is free (~20 ms at any
// network speed) while an out-of-buffer seek costs a full segment fetch and
// rebuffers for it. The rule that follows is NOT "never seek out of buffer" --
// that version of this test failed a member returning from a 15 s tab
// suspension, who then spent 150 s nudging at the 10% rate clamp. The rule is
// that a seek must be the cheaper of the two options: free when buffered, and
// worth its cost only when the gap exceeds what rate can absorb.
func TestServoPrefersCheapCorrections(t *testing.T) {
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
	base := Run(sc, vsync.ThresholdCorrector{}, tun)

	// The baseline takes every correction as an unconditional seek, so all of
	// its post-stall seeks land outside the drained buffer.
	if base.OutOfBufferSeeks == 0 {
		t.Fatal("control: baseline took no expensive seeks -- scenario no longer exercises the cost")
	}
	if servo.OutOfBufferSeeks >= base.OutOfBufferSeeks {
		t.Errorf("servo took %d expensive seeks vs baseline %d -- it is not preferring cheap ones",
			servo.OutOfBufferSeeks, base.OutOfBufferSeeks)
	}
	if servo.InBufferSeeks == 0 {
		t.Error("servo took no free in-buffer seeks; it should prefer them over nudging a step")
	}
	if servo.MeanAnchorErrMs > base.MeanAnchorErrMs {
		t.Errorf("servo %.0f ms worse than baseline %.0f ms despite cheaper corrections",
			servo.MeanAnchorErrMs, base.MeanAnchorErrMs)
	}
	t.Logf("servo %.0f/%.0f ms with %d free + %d costly seeks; baseline %.0f/%.0f with %d + %d",
		servo.MeanAnchorErrMs, servo.P95AnchorErrMs, servo.InBufferSeeks, servo.OutOfBufferSeeks,
		base.MeanAnchorErrMs, base.P95AnchorErrMs, base.InBufferSeeks, base.OutOfBufferSeeks)
}

// A member returning from a browser tab suspension is many seconds behind.
// Refusing an expensive seek there is worse than paying for it: the rate clamp
// closes at most 10% of real time, so a 15 s gap would take 150 s to absorb.
func TestServoPaysForASeekWhenRateCannotCatchUp(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	sc := Scenario{
		Name: "tab-suspension", Seed: 21, DurationMs: 90000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: good},
			{ID: "b", IntrinsicRate: 1.0, Link: good, Suspends: [][2]int64{{20000, 35000}}},
			{ID: "c", IntrinsicRate: 1.0, Link: good},
		},
	}
	r := Run(sc, &vsync.ServoCorrector{}, tun)
	if r.MeanAnchorErrMs > 200 {
		t.Errorf("member returning from suspension never caught up: mean anchor error %.0f ms "+
			"(a rate-only recovery from a 15 s gap takes 150 s)", r.MeanAnchorErrMs)
	}
	if r.OutOfBufferSeeks == 0 {
		t.Error("expected servo to pay for one expensive seek here; a free correction does not exist")
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

// Chrome pauses a muted video when its tab is hidden and fires a real `pause`
// event (measured: docs/BROWSER-FINDINGS.md 5). A client that treats that as user
// intent pauses the entire room because one member switched tabs -- and
// resumes it when they switch back, even a room someone deliberately paused.
func TestSuspendGuardIsLoadBearing(t *testing.T) {
	tun := vsync.DefaultTunables()
	mk := func(noGuard bool) Scenario {
		good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
		return Scenario{
			Name: "suspension", Seed: 21, DurationMs: 90000,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good, NoSuspendGuard: noGuard,
					// member b keeps switching to another tab with sound off
					Suspends: [][2]int64{{20000, 35000}, {55000, 70000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: good},
			},
		}
	}
	guarded := Run(mk(false), &vsync.ServoCorrector{}, tun)
	if guarded.SpuriousCmds != 0 {
		t.Errorf("guarded client broadcast %d browser-initiated commands", guarded.SpuriousCmds)
	}
	if guarded.RoomPausedBySuspension != 0 {
		t.Errorf("room was paused %d times by a suspended member", guarded.RoomPausedBySuspension)
	}

	// Control: without the guard the bug must actually reproduce, or the test
	// above is asserting nothing.
	naive := Run(mk(true), &vsync.ServoCorrector{}, tun)
	if naive.SpuriousCmds == 0 {
		t.Error("control: no spurious commands without the guard -- scenario does not exercise the bug")
	}
	if naive.RoomPausedBySuspension == 0 {
		t.Error("control: the room was never paused by a suspension -- bug not reproduced")
	}
	t.Logf("guarded: %d spurious cmds / %d room pauses; naive: %d / %d",
		guarded.SpuriousCmds, guarded.RoomPausedBySuspension,
		naive.SpuriousCmds, naive.RoomPausedBySuspension)
}

// A suspended member is absent, not buffering: the readiness gate must not
// hold the room for someone who is not watching.
func TestSuspendedMemberDoesNotGateTheRoom(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	sc := Scenario{
		Name: "suspend-gate", Seed: 22, DurationMs: 60000,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: good},
			{ID: "b", IntrinsicRate: 1.0, Link: good, Suspends: [][2]int64{{15000, 45000}}},
		},
	}
	r := Run(sc, &vsync.ServoCorrector{}, tun)
	if r.GatesOpened != 0 {
		t.Errorf("room gated %d times on a suspended member", r.GatesOpened)
	}
}

// A member that misses a command holds a stale anchor -- and because its
// residual is measured against that same stale anchor, it reports ~0 while
// being arbitrarily out of position. The residual channel is blind to it; only
// the lagging lastAppliedSeq shows it, and no corrector reads that field.
//
// The member here stays connected and simply never receives the frame. That is
// the only way to produce a stale anchor at all: a reconnect is answered with a
// welcome carrying the current seq and anchor (see the next test), and a
// WebSocket does not lose frames on a live connection -- the hub closes a
// connection whose outbox overflows rather than dropping into it. The resend is
// a backstop, and this is the case it backs.
func TestStaleAnchorAfterLostFrames(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	mk := func(noResend bool) Scenario {
		return Scenario{
			Name: "lost-frames", Seed: 31, DurationMs: 90000, NoStaleResend: noResend,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				// Nothing reaches b across the seek, so it never learns the room moved.
				{ID: "b", IntrinsicRate: 1.0, Link: good, DropsDown: [][2]int64{{29000, 31000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: good},
			},
			Commands: []Command{{AtMs: 30000, ClientID: "a", Kind: "seek", PositionMs: 600000}},
		}
	}
	blind := Run(mk(true), &vsync.ServoCorrector{}, tun)
	fixed := Run(mk(false), &vsync.ServoCorrector{}, tun)

	// Max divergence is the wrong lens here: it captures the single instant
	// right after the frames resume, which is huge no matter how fast recovery
	// is. Sustained error is what distinguishes "recovered" from "stranded".
	if blind.MeanAnchorErrMs < 10000 {
		t.Errorf("control: a member that missed a seek should stay far out of position without the "+
			"resend, got mean %.0f ms -- scenario no longer reproduces", blind.MeanAnchorErrMs)
	}
	if fixed.StaleResends == 0 {
		t.Error("no stale resend fired for a member that missed a command")
	}
	if fixed.MeanAnchorErrMs > blind.MeanAnchorErrMs/10 {
		t.Errorf("resend did not recover the member: mean %.0f ms with vs %.0f ms without",
			fixed.MeanAnchorErrMs, blind.MeanAnchorErrMs)
	}
	t.Logf("mean anchor error: blind %.0f ms -> with resend %.0f ms (%d resends)",
		blind.MeanAnchorErrMs, fixed.MeanAnchorErrMs, fixed.StaleResends)
}

// A member that drops and reconnects is a new session: it leaves the room (the
// corrector forgets it, the gate releases it), joins again, and its welcome
// carries the room's current seq and anchor. It is never stale -- it is far out
// of position against an anchor it holds correctly, which is exactly what the
// residual channel can see and correct.
func TestReconnectAdoptsTheRoomsAnchor(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	var resends, issued, errMs float64
	for _, seed := range seeds {
		sc := Scenario{
			Name: "reconnect", Seed: seed, DurationMs: 90000,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				// b is gone across the seek, and its video keeps playing.
				{ID: "b", IntrinsicRate: 1.0, Link: good, Disconnects: [][2]int64{{25000, 40000}}},
				{ID: "c", IntrinsicRate: 1.0, Link: good},
			},
			Commands: []Command{{AtMs: 30000, ClientID: "a", Kind: "seek", PositionMs: 600000}},
		}
		r := Run(sc, &vsync.ServoCorrector{}, tun)
		resends += float64(r.StaleResends)
		issued += float64(r.SeeksIssued)
		errMs += r.MeanAnchorErrMs
	}
	n := float64(len(seeds))
	resends, issued, errMs = resends/n, issued/n, errMs/n
	if resends > 0 {
		t.Errorf("a reconnected member drew %.2f stale resends per run; its welcome is current", resends)
	}
	// The recovery has to be a correction: nothing else can move b 560 s.
	if issued < 1 {
		t.Errorf("the room issued %.2f seeks per run to a member 560 s out of position", issued)
	}
	if errMs > 500 {
		t.Errorf("reconnected member never recovered: mean anchor error %.0f ms", errMs)
	}
	t.Logf("mean over %d seeds: anchor err %.0f ms, %.2f seeks issued, %.2f resends", len(seeds), errMs, issued, resends)
}

// nopCorrector never corrects anything: the control for tests that claim a
// correction happened.
type nopCorrector struct{}

func (nopCorrector) Name() string { return "nop" }
func (nopCorrector) Decide(vsync.Report, vsync.Anchor, int64, vsync.Tunables) vsync.Decision {
	return vsync.Decision{}
}

// A late joiner arrives with zero clock samples, so a confidence-gated
// corrector refuses to act on the member that needs it most. Verify it does
// converge, and record how long it takes.
//
// The joiner's player has not been running before it joined. An earlier
// version let it play from t=0 while "offline", so it arrived already on the
// anchor and a corrector that never corrects anything passed this test with a
// better score than the servo.
func TestLateJoinerConverges(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	mk := func(seed int64) Scenario {
		return Scenario{
			Name: "late-join", Seed: seed, DurationMs: 90000,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good},
				{ID: "c", IntrinsicRate: 1.0, Link: Link{UpMs: 80, DownMs: 80, JitterMs: 30}, JoinAtMs: 30000},
			},
		}
	}
	var servoErr, nopErr, issued float64
	for _, seed := range seeds {
		r := Run(mk(seed), &vsync.ServoCorrector{}, tun)
		servoErr += r.MeanAnchorErrMs
		issued += float64(r.SeeksIssued + r.NudgesIssued)
		nopErr += Run(mk(seed), nopCorrector{}, tun).MeanAnchorErrMs
	}
	n := float64(len(seeds))
	servoErr, nopErr, issued = servoErr/n, nopErr/n, issued/n
	if nopErr < 1000 {
		t.Fatalf("control: a room that never corrects kept the joiner within %.0f ms -- "+
			"the joiner is not arriving out of position", nopErr)
	}
	if issued < 1 {
		t.Errorf("no correction was issued (%.2f per run)", issued)
	}
	if servoErr > 200 {
		t.Errorf("late joiner never converged: mean anchor error %.0f ms (no correction: %.0f ms)",
			servoErr, nopErr)
	}
	t.Logf("with a joiner at t=30s: mean anchor err %.0f ms (no correction: %.0f ms)", servoErr, nopErr)
}

// gateScenario: the room is paused, one member cannot buffer for 25 s, and
// somebody presses play at 10 s.
func gateScenario(stallEnd int64, disabled bool) Scenario {
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	meh := Link{UpMs: 80, DownMs: 80, JitterMs: 30}
	return Scenario{
		Name: "slow-to-buffer", Seed: 51, DurationMs: 90000, StartPaused: true,
		GateDisabled: disabled,
		Clients: []ClientProfile{
			{ID: "a", IntrinsicRate: 1.0, Link: good},
			{ID: "b", IntrinsicRate: 1.0, Link: good},
			{ID: "c", IntrinsicRate: 1.0, Link: meh, Stalls: [][2]int64{{0, stallEnd}}},
		},
		Commands: []Command{{AtMs: 10000, ClientID: "a", Kind: "play"}},
	}
}

// The readiness gate's benefit cannot be seen in anchorErr: that metric
// excludes a stalled client by construction, so a room that starts without
// somebody and later yanks them forward scores *well* on it. The cost the gate
// prevents is media its members never saw.
func TestGateStopsTheRoomSkippingPastASlowMember(t *testing.T) {
	tun := vsync.DefaultTunables()
	on := Run(gateScenario(25000, false), &vsync.ServoCorrector{}, tun)
	if on.SkippedMs != 0 {
		t.Errorf("gate on: %v ms of media was skipped past a member", on.SkippedMs)
	}
	if on.CmdsHeld != 1 {
		t.Errorf("gate on: held %d commands, want 1", on.CmdsHeld)
	}
	// The gate is not free and the test says what it costs, so a future change
	// that makes it cheap by making it useless is visible.
	if on.GateHoldMs < 10000 {
		t.Errorf("gate on: held for only %d ms; the stall lasted 25 s", on.GateHoldMs)
	}

	// The control: without the hold, the same scenario skips the slow member
	// past a large chunk of the media.
	off := Run(gateScenario(25000, true), &vsync.ServoCorrector{}, tun)
	if off.SkippedMs < 5000 {
		t.Errorf("control skipped only %v ms -- the scenario no longer reproduces "+
			"what the gate is for", off.SkippedMs)
	}
	if off.CmdsHeld != 0 {
		t.Errorf("control held %d commands with the gate disabled", off.CmdsHeld)
	}
}

// Anti-hang. Jellyfin's Waiting state has no timeout, so one member who never
// becomes ready stops the room forever. GATE_TIMEOUT drops them and the room
// continues without them.
func TestGateTimeoutResumesARoomHeldByAMemberWhoNeverRecovers(t *testing.T) {
	tun := vsync.DefaultTunables()
	// The stall outlasts the run, so the member is never ready.
	r := Run(gateScenario(90000, false), &vsync.ServoCorrector{}, tun)
	if r.CmdsHeld != 1 {
		t.Fatalf("held %d commands, want 1", r.CmdsHeld)
	}
	// GATE_TIMEOUT is per MEMBER, not per held command: it runs from when that
	// member entered the gate (~t=0 here, as soon as they first reported
	// buffering), not from when the play arrived at t=10 s. So the play is
	// released at ~30 s and was held for ~20 s. Getting this backwards would
	// mean a member could re-enter the gate and restart the clock forever.
	if r.GateHoldMs < 12000 || r.GateHoldMs > 32000 {
		t.Errorf("gate held for %d ms; want release ~20 s in (GATE_TIMEOUT 30 s "+
			"measured from when the member started buffering at ~t=0)", r.GateHoldMs)
	}
	if r.GateHoldMs >= 79000 {
		t.Error("the room was held for the rest of the run: the anti-hang timeout did not fire")
	}
}

// A scripted pause is somebody pressing the button, and the engine sends where
// their player is when they do: the room anchors a pause at that position
// (POC-FINDINGS 40c). A scenario command that left PositionMs unset used to
// reach the room as "pause at 0", so every scripted pause rewound everyone to
// the start -- command-storm's pause at 60 s undid its seek to 300 s.
func TestScriptedPauseStopsWhereThePauserIs(t *testing.T) {
	tun := vsync.DefaultTunables()
	good := Link{UpMs: 25, DownMs: 25, JitterMs: 5}
	for _, seed := range seeds {
		sc := Scenario{
			Name: "pause-position", Seed: seed, DurationMs: 30000,
			Clients: []ClientProfile{
				{ID: "a", IntrinsicRate: 1.0, Link: good},
				{ID: "b", IntrinsicRate: 1.0, Link: good},
			},
			Commands: []Command{
				{AtMs: 5000, ClientID: "a", Kind: "seek", PositionMs: 300000},
				{AtMs: 20000, ClientID: "a", Kind: "pause"},
			},
		}
		r := Run(sc, &vsync.ServoCorrector{}, tun)
		// The pauser had been playing from 300 s for ~15 s when it pressed.
		a := r.FinalAnchor
		if !a.Paused || a.PositionMs < 310000 || a.PositionMs > 320000 {
			t.Fatalf("seed %d: the room paused at %d ms (paused=%v); the pauser was at ~315 s",
				seed, a.PositionMs, a.Paused)
		}
	}
}
