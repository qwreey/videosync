package room

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Guards that are correct today and that no other test would miss: each test
// here fails when the named line is removed.

// resyncs counts the stale-anchor resends sent to id.
func resyncs(s *recSink, id string) int {
	n := 0
	for _, st := range of[State](s, id) {
		if st.Kind == "resync" {
			n++
		}
	}
	return n
}

// A command that leaves the room stopped carries no lead, so it is due the
// instant it is applied -- and a remote member cannot have applied it until it
// has arrived. The stale-anchor check waits the member's own round trip
// before calling it stale (room.go `now >= r.lastCmdWhen+m.RTTMs`). Without
// that grace every pause drew a resend from every member (POC-FINDINGS 40a);
// a play is no test of it, because its CMD_DELAY lead supplies a grace of its
// own.
func TestALeadFreeCommandIsNotCalledStaleBeforeItCanHaveArrived(t *testing.T) {
	const rttMs = 200
	for _, tc := range []struct {
		name  string
		start vsync.Anchor
		cmd   Cmd
	}{
		{"pause", vsync.Anchor{PositionMs: 100_000, AtServerMs: 0, MediaKey: "ep1"},
			Cmd{ReqID: "c", Kind: "pause", PositionMs: 101_000}},
		{"seek onto a paused room", vsync.Anchor{PositionMs: 100_000, Paused: true, MediaKey: "ep1"},
			Cmd{ReqID: "c", Kind: "seek", PositionMs: 400_000}},
		{"media", vsync.Anchor{PositionMs: 100_000, AtServerMs: 0, MediaKey: "ep1"},
			Cmd{ReqID: "c", Kind: "media", MediaKey: "ep2"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &scripted{}
			r, s := newRoom(c, tc.start)
			r.Join(0, "a", "a")
			r.Join(0, "b", "b")
			rtt(r, 900, rttMs, "a", "b")
			r.OnCmd(1000, "a", tc.cmd)
			if r.Anchor().AtServerMs != 1000 {
				t.Fatalf("setup: the %s is due at %d, not at once; the test measures nothing", tc.name, r.Anchor().AtServerMs)
			}
			old := r.Seq() - 1

			// Inside b's round trip: the command may still be on its way.
			rep := report(old, 0)
			rep.RTTMs = rttMs
			r.OnReport(1000+rttMs-50, "b", rep)
			if n := resyncs(s, "b"); n != 0 {
				t.Fatalf("resent the anchor %d time(s) to a member the %s cannot have reached yet", n, tc.name)
			}
			if r.JudgingDeferred != 1 {
				t.Fatalf("JudgingDeferred = %d, want the early report deferred", r.JudgingDeferred)
			}

			// Past it, the same report means the member missed the command.
			r.OnReport(1000+rttMs+100, "b", rep)
			if n := resyncs(s, "b"); n != 1 {
				t.Fatalf("%d resends to a member still on the old seq a round trip after the %s, want 1", n, tc.name)
			}
		})
	}
}

// GATE_TIMEOUT waives a member who never recovers, and the waiver latches
// until that member reports ready (Member.gateWaived). Without the latch the
// member's next unready report reopens the gate at a fresh gatedAt, and every
// later play is held for another GATE_TIMEOUT.
func TestAWaivedMemberDoesNotHoldTheNextPlayAgain(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{MediaKey: "ep2", Paused: true, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnReport(100, "b", acquiringReport(0))
	r.OnCmd(200, "a", Cmd{ReqID: "p1", Kind: "play"})
	if !r.Held() {
		t.Fatal("setup: the first play was not held")
	}
	now := int64(100 + GateTimeoutMs + 1000)
	r.OnReport(now, "b", acquiringReport(0))
	if r.Held() {
		t.Fatal("setup: the first play is still held past GATE_TIMEOUT")
	}
	// b never gets there, and keeps saying so.
	for i := 0; i < 5; i++ {
		now += 1000
		r.OnReport(now, "b", acquiringReport(r.Seq()))
	}
	now += 500
	r.OnCmd(now, "a", Cmd{ReqID: "s", Kind: "pause"})
	now += 500
	r.OnReport(now, "b", acquiringReport(r.Seq()))
	r.OnCmd(now+100, "a", Cmd{ReqID: "p2", Kind: "play"})
	if r.Held() {
		t.Fatalf("the second play is held again for a member already waived (gated %v)", r.Gated())
	}
	if r.Anchor().Paused {
		t.Fatal("the second play did not start the room")
	}
}

// nudger always asks for the same rate.
type nudger struct{ rate float64 }

func (nudger) Name() string { return "nudger" }
func (c nudger) Decide(vsync.Report, vsync.Anchor, int64, vsync.Tunables) vsync.Decision {
	return vsync.Decision{Action: vsync.ActionNudge, Rate: c.rate, Why: "nudger"}
}

// A continuous control law asks for a rate on every report. Sending each one
// put a `correct` on the wire at the report rate -- 17 in a 20 s browser
// session, each firing a `ratechange` the detector watches (Member.lastRate).
// A rate the member already holds is re-stated only every rateRefreshMs, in
// case the `correct` that set it was lost; a different rate goes out at once.
func TestARateTheMemberAlreadyHoldsIsNotResentOnEveryReport(t *testing.T) {
	c := &nudger{rate: 1.02}
	r, s := newRoom(c, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	const until = 20_000
	for now := int64(1000); now <= until; now += 250 {
		r.OnReport(now, "a", report(0, 0))
	}
	nudges := len(of[Correct](s, "a"))
	// One, then one refresh per rateRefreshMs, with a little slack.
	if max := 2 + until/rateRefreshMs; nudges > max {
		t.Fatalf("%d nudges to the same rate in %d s of reports every 250 ms, want at most %d", nudges, until/1000, max)
	}
	if nudges < 2 {
		t.Fatalf("%d nudges: the rate was never re-stated, so a lost correct would never be repaired", nudges)
	}
	if r.NudgesSuppressed == 0 {
		t.Fatal("NudgesSuppressed stayed 0")
	}

	c.rate = 1.04
	r.OnReport(until+250, "a", report(0, 0))
	got := of[Correct](s, "a")
	if len(got) != nudges+1 || got[len(got)-1].Rate != 1.04 {
		t.Fatalf("a new rate inside the refresh window was not sent: %+v", got[nudges:])
	}
}
