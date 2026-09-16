package room

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// --- harness ----------------------------------------------------------------

// sent is one frame the room put on the wire, and to whom.
type sent struct {
	to string
	m  Msg
}

type recSink struct{ out []sent }

func (s *recSink) Send(id string, m Msg) { s.out = append(s.out, sent{id, m}) }

// of returns the frames of type T sent to id, in order.
func of[T Msg](s *recSink, id string) []T {
	var out []T
	for _, f := range s.out {
		if v, ok := f.m.(T); ok && f.to == id {
			out = append(out, v)
		}
	}
	return out
}

// scripted decides whatever it is told to, and records who it was asked about.
type scripted struct {
	action vsync.Action
	asked  []string
}

func (c *scripted) Name() string { return "scripted" }
func (c *scripted) Decide(r vsync.Report, _ vsync.Anchor, _ int64, _ vsync.Tunables) vsync.Decision {
	c.asked = append(c.asked, r.ClientID)
	return vsync.Decision{Action: c.action, Why: "scripted"}
}

func newRoom(c vsync.Corrector, start vsync.Anchor) (*Room, *recSink) {
	s := &recSink{}
	return New("r", c, vsync.DefaultTunables(), start, s), s
}

func report(seq uint64, residualMs int64) Report {
	return Report{vsync.Report{
		ResidualMs: residualMs, ReadyState: 4, BufferedAheadS: 30, BufferedBehindS: 30,
		LastAppliedSeq: seq, UncertaintyMs: 10, RTTMs: 40, ClockSamples: 10,
	}}
}

// --- seek cooldown ------------------------------------------------------------

// SEEK_COOLDOWN is the floor between two seeks for one client (PROTOCOL.md
// constants). The check that asks whether the previous seek worked used to
// clear the very timestamp the cooldown is measured from, so the floor was
// really seekCooldownMs/2 plus one report interval.
func TestSeeksToOneClientAreAtLeastTheCooldownApart(t *testing.T) {
	for _, every := range []int64{100, 250, 1000} {
		c := &scripted{action: vsync.ActionSeek}
		r, s := newRoom(c, vsync.Anchor{PositionMs: 0, AtServerMs: 1, Paused: false})
		r.Join(1, "a", "a")
		var at []int64
		for now := int64(1000); now < 30_000; now += every {
			before := len(of[Correct](s, "a"))
			r.OnReport(now, "a", report(0, 5000))
			if len(of[Correct](s, "a")) > before {
				at = append(at, now)
			}
		}
		if len(at) < 2 {
			t.Fatalf("every %d ms: only %d seeks in 29 s -- the test measures nothing", every, len(at))
		}
		for i := 1; i < len(at); i++ {
			if gap := at[i] - at[i-1]; gap < seekCooldownMs {
				t.Fatalf("reports every %d ms: seeks %d ms apart (at %d and %d), floor is %d",
					every, gap, at[i-1], at[i], seekCooldownMs)
			}
		}
	}
}

// --- pause inside another command's lead ------------------------------------

// A seek during playback is not applied until `when`, CMD_DELAY later. A
// member who pauses inside that window is still on the pre-seek timeline, so
// the position it reports belongs to the media the room is about to leave.
// Anchoring the pause there undid a seek the room had already acked, for
// everyone, although the seek came first in seq order.
func TestAPauseInsideASeeksLeadDoesNotUndoTheSeek(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "s", Kind: "seek", PositionMs: 600_000})
	seek := r.Anchor()
	if seek.AtServerMs <= 1000 {
		t.Fatalf("the seek carries no lead (%+v); the test measures nothing", seek)
	}
	// a has not reached `when`, so it is still ~100 s in.
	r.OnCmd(1100, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 101_100})
	got := r.Anchor()
	if !got.Paused {
		t.Fatalf("the pause did not pause: %+v", got)
	}
	if got.PositionMs < seek.PositionMs {
		t.Fatalf("the pause rewound the room to %d ms, before the seek to %d it came after",
			got.PositionMs, seek.PositionMs)
	}
}

// The same window before a `play`: the room is paused at P until `when`, and
// the pause must stay at P rather than at a position projected backwards
// from a start time that has not happened yet.
func TestAPauseInsideAPlaysLeadStaysWhereTheRoomIs(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 50_000, AtServerMs: 0, Paused: true})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "go", Kind: "play"})
	r.OnCmd(1100, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 50_000})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 50_000 {
		t.Fatalf("anchor %+v, want paused at 50000", got)
	}
}

// A `play` that reaches a room which is already playing -- two members
// pressing play close together, or a coalesced play applied after someone
// else's -- changes nothing about the timeline, but its anchor is projected
// to its own `when`. A pause inside that lead must stop where the room
// actually is, not up to CMD_DELAY ahead of it: that is media nobody saw.
func TestAPauseInsideAPlayOnAPlayingRoomDoesNotJumpAhead(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "go", Kind: "play"})
	if play := r.Anchor(); play.AtServerMs <= 1000 || play.PositionMs <= 101_000 {
		t.Fatalf("the play carries no lead (%+v); the test measures nothing", play)
	}
	r.OnCmd(1100, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 101_100})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 101_100 {
		t.Fatalf("anchor %+v, want paused at 101100, where the room was", got)
	}
}

// A play queued behind a seek that has not come due yet: the room is
// committed to the seek's target, and neither the play's projection nor a
// backward projection from a start time still in the future is a position.
func TestAPauseInsideAPlayQueuedBehindASeekStaysAtTheSeekTarget(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "s", Kind: "seek", PositionMs: 600_000})
	r.OnCmd(1050, "b", Cmd{ReqID: "go", Kind: "play"})
	r.OnCmd(1100, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 101_100})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 600_000 {
		t.Fatalf("anchor %+v, want paused at the seek target 600000", got)
	}
}

// Two plays close together on a room that is already playing: the second one
// arrives inside the first one's lead. Neither has happened yet, so the room is
// still on the timeline it had -- not on the first play's anchor, which is
// projected to that play's own `when`.
func TestAPauseInsideTwoPendingPlaysOnAPlayingRoomDoesNotJumpAhead(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "go1", Kind: "play"})
	r.OnCmd(1100, "a", Cmd{ReqID: "go2", Kind: "play"})
	r.OnCmd(1200, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 101_200})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 101_200 {
		t.Fatalf("anchor %+v, want paused at 101200, where the room was", got)
	}
}

// Two plays on a paused room, and a pause after the first has come due but
// before the second has: the room has been running since the first play's
// `when`, so it is that far past the paused position.
func TestAPauseBetweenTwoPlaysCountsTheTimeTheFirstOneRan(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 50_000, AtServerMs: 0, Paused: true})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "go1", Kind: "play"})
	first := r.Anchor().AtServerMs
	r.OnCmd(first-100, "a", Cmd{ReqID: "go2", Kind: "play"})
	if r.Anchor().AtServerMs <= first+100 {
		t.Fatalf("the second play is not due after the first (%d vs %d); the test measures nothing", r.Anchor().AtServerMs, first)
	}
	r.OnCmd(first+100, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 50_100})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 50_100 {
		t.Fatalf("anchor %+v, want paused at 50100: the first play had been running for 100 ms", got)
	}
}

// Outside any lead the pauser's own position is still the one that counts --
// that is the whole point of anchoring a pause where the person stopped.
func TestAPauseOutsideAnyLeadStopsWhereThePauserStopped(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{PositionMs: 100_000, AtServerMs: 0})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	r.OnCmd(1000, "b", Cmd{ReqID: "s", Kind: "seek", PositionMs: 600_000})
	due := r.Anchor().AtServerMs
	r.OnCmd(due+3000, "a", Cmd{ReqID: "p", Kind: "pause", PositionMs: 602_900})
	if got := r.Anchor(); !got.Paused || got.PositionMs != 602_900 {
		t.Fatalf("anchor %+v, want paused at the pauser's 602900", got)
	}
}

// --- the gate and an emptying room -------------------------------------------

// holdPlay leaves a room of a and b with b buffering and a's play held.
func holdPlay(t *testing.T) *Room {
	t.Helper()
	c := &scripted{}
	r, _ := newRoom(c, vsync.Anchor{PositionMs: 10_000, AtServerMs: 0, Paused: true})
	r.Join(0, "a", "a")
	r.Join(0, "b", "b")
	c.action = vsync.ActionGate
	unready := report(0, 0)
	unready.ReadyState = 1
	r.OnReport(100, "b", unready)
	r.OnCmd(200, "a", Cmd{ReqID: "go", Kind: "play"})
	if !r.Held() {
		t.Fatal("the play was not held; the test measures nothing")
	}
	return r
}

// Jellyfin's anti-hang rule releases a held play when the member it waited
// on leaves. When that member was the last one, the play used to go through
// into a room with nobody in it, and the anchor ran for the whole idle TTL:
// whoever came back found the room minutes past where everyone had stopped.
func TestAHeldPlayIsNotReleasedIntoAnEmptyRoom(t *testing.T) {
	r := holdPlay(t)
	r.Leave(300, "a")
	r.Leave(400, "b")
	if got := r.Anchor(); !got.Paused {
		t.Fatalf("an empty room started playing: %+v (seq %d)", got, r.Seq())
	}
	if r.Held() {
		t.Fatal("an empty room still holds a play for whoever joins next")
	}
}

// The control: a room that still has members DOES get the held play when the
// member it waited for leaves.
func TestAHeldPlayIsReleasedWhenTheBufferingMemberLeaves(t *testing.T) {
	r := holdPlay(t)
	r.Leave(300, "b")
	if got := r.Anchor(); got.Paused {
		t.Fatalf("the held play was dropped although a is still here: %+v", got)
	}
}

// --- naming the media, and moving it on, by compare-and-set (D8) ---------------

func ifKey(k string) *string { return &k }

func media(req, key string, cond *string) Cmd {
	return Cmd{ReqID: req, Kind: "media", MediaKey: key, IfMediaKey: cond}
}

// A `media` command whose condition no longer holds is refused before it takes
// a seq: two members whose sites both moved on to the next episode send the
// same continuation, and only the first may move the room -- the second would
// otherwise restart it at 0 under members who are already watching.
func TestAStaleMediaConditionIsRefusedAndTakesNoSeq(t *testing.T) {
	r, s := newRoom(&scripted{}, vsync.Anchor{MediaKey: "ep1", Paused: false, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")

	r.OnCmd(100, "a", media("m1", "ep2", ifKey("ep1")))
	if r.Seq() != 1 || r.Anchor().MediaKey != "ep2" {
		t.Fatalf("the first continuation did not apply: seq %d anchor %+v", r.Seq(), r.Anchor())
	}
	r.OnCmd(110, "b", media("m2", "ep2-other", ifKey("ep1")))
	if r.Seq() != 1 || r.Anchor().MediaKey != "ep2" {
		t.Fatalf("a stale continuation moved the room: seq %d anchor %+v", r.Seq(), r.Anchor())
	}
	errs := of[Error](s, "b")
	if len(errs) != 1 || errs[0].Code != "media_stale" {
		t.Fatalf("b was told %+v, want one media_stale", errs)
	}
	if n := len(of[Ack](s, "b")); n != 0 {
		t.Fatalf("a refused command was acked %d times", n)
	}
	if n := len(of[State](s, "a")); n != 0 {
		t.Fatalf("a refused command was broadcast %d times", n)
	}
}

// The control: the same command with no condition applies, as it always has --
// it is what the "move the room here" button sends.
func TestAnUnconditionalMediaCommandStillApplies(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{MediaKey: "ep1", AtServerMs: 1})
	r.Join(1, "a", "a")
	r.OnCmd(100, "a", media("m1", "ep2", nil))
	r.OnCmd(110, "a", media("m2", "ep3", nil))
	if r.Seq() != 2 || r.Anchor().MediaKey != "ep3" {
		t.Fatalf("seq %d anchor %+v", r.Seq(), r.Anchor())
	}
}

// A room created with no media is named by the first member on media, with
// the condition "still nothing". An empty condition is a condition, not an
// absent one.
func TestARoomThatNamesNothingIsNamedOnce(t *testing.T) {
	r, s := newRoom(&scripted{}, vsync.Anchor{Paused: true})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnCmd(100, "a", Cmd{ReqID: "n1", Kind: "media", MediaKey: "yt:a", PositionMs: 42000, IfMediaKey: ifKey("")})
	r.OnCmd(101, "b", Cmd{ReqID: "n2", Kind: "media", MediaKey: "yt:b", PositionMs: 7000, IfMediaKey: ifKey("")})
	a := r.Anchor()
	if a.MediaKey != "yt:a" || a.PositionMs != 42000 || !a.Paused || r.Seq() != 1 {
		t.Fatalf("anchor %+v seq %d, want yt:a paused at 42 s, one seq", a, r.Seq())
	}
	if e := of[Error](s, "b"); len(e) != 1 || e[0].Code != "media_stale" {
		t.Fatalf("the second namer was told %+v", e)
	}
}

func acquiringReport(seq uint64) Report {
	rep := report(seq, 0)
	rep.Acquiring = true
	return rep
}

// A member that is still acquiring its video -- navigating to the next episode,
// or conforming a player it just found -- is present but not ready. A `play`
// that starts without it makes it join a running room late, which is media it
// never saw.
func TestAnAcquiringMemberHoldsAPlay(t *testing.T) {
	c := &scripted{action: vsync.ActionNone}
	r, s := newRoom(c, vsync.Anchor{MediaKey: "ep2", Paused: true, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	// ReadyState 4: what makes it unready is only that it says so.
	r.OnReport(100, "b", acquiringReport(0))
	r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
	if !r.Held() || !r.Anchor().Paused {
		t.Fatalf("the play went ahead without the acquiring member: held=%v anchor=%+v", r.Held(), r.Anchor())
	}
	for _, id := range c.asked {
		if id == "b" {
			t.Fatal("an acquiring member was judged; its position is not on the room's timeline yet")
		}
	}
	for _, m := range r.MemberList() {
		if m.ID == "b" && m.Ready {
			t.Fatal("an acquiring member is listed as ready")
		}
	}
	r.OnReport(300, "b", report(0, 0))
	if r.Held() || r.Anchor().Paused {
		t.Fatalf("the play was not released once the member arrived: held=%v", r.Held())
	}
	if n := len(of[Ack](s, "a")); n != 1 {
		t.Fatalf("a got %d acks", n)
	}
}

// Bounded like any other unready member: GATE_TIMEOUT waives it.
func TestAnAcquiringMemberIsWaivedAfterTheGateTimeout(t *testing.T) {
	r, _ := newRoom(&scripted{}, vsync.Anchor{MediaKey: "ep2", Paused: true, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnReport(100, "b", acquiringReport(0))
	r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
	r.OnReport(100+GateTimeoutMs/2, "b", acquiringReport(0))
	if !r.Held() {
		t.Fatal("released too early")
	}
	r.OnReport(100+GateTimeoutMs+1000, "b", acquiringReport(0))
	if r.Held() {
		t.Fatal("a member that never arrives held the room past GATE_TIMEOUT")
	}
}

// Nobody has loaded new media when the room moves to it, so a play right
// behind the media command -- the continuation's own -- must wait until every
// member has reported on the new media. Otherwise it races the first
// "acquiring" report and a member still navigating is skipped past the start.
func TestAPlayRightAfterAMediaCommandWaitsForEveryoneToReport(t *testing.T) {
	r, _ := newRoom(&scripted{action: vsync.ActionNone}, vsync.Anchor{MediaKey: "ep1", Paused: false, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnReport(50, "b", report(0, 0))
	r.OnCmd(100, "a", media("m", "ep2", ifKey("ep1")))
	r.OnReport(150, "a", report(1, 0))
	r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
	if !r.Held() {
		t.Fatal("the play went ahead before b had said anything about the new media")
	}
	// b's report on the old seq says nothing about the new media either.
	r.OnReport(210, "b", report(0, 0))
	if !r.Held() {
		t.Fatal("released by a report from before the media change")
	}
	r.OnReport(300, "b", report(1, 0))
	if r.Held() {
		t.Fatal("still held after b reported ready on the new media")
	}
}

// An absent member -- elsewhere, or with its tab suspended -- is not waited for.
func TestAMediaCommandDoesNotWaitForAnAbsentMember(t *testing.T) {
	c := &scripted{action: vsync.ActionNone}
	r, _ := newRoom(c, vsync.Anchor{MediaKey: "ep1", AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnCmd(100, "a", media("m", "ep2", nil))
	r.OnReport(150, "a", report(1, 0))
	rep := report(1, 0)
	rep.Suspended = true
	r.OnReport(160, "b", rep)
	r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
	if r.Held() {
		t.Fatal("held for a member who is not watching")
	}
}

// Nor is one whose tab was already away when the media changed: its next
// report may be a minute off (intensive throttling), and nothing was waiting
// for it before. A member that finished the old media is the control: it is
// on its way to the new one, so the play waits for it.
func TestAMediaCommandDoesNotGateAMemberAlreadyAway(t *testing.T) {
	for _, finished := range []bool{false, true} {
		r, _ := newRoom(&scripted{action: vsync.ActionNone}, vsync.Anchor{MediaKey: "ep1", AtServerMs: 1})
		r.Join(1, "a", "a")
		r.Join(1, "b", "b")
		rep := report(0, 0)
		rep.Suspended = !finished
		rep.Finished = finished
		r.OnReport(50, "b", rep)
		r.OnCmd(100, "a", media("m", "ep2", nil))
		r.OnReport(150, "a", report(1, 0))
		r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
		if r.Held() == !finished {
			t.Fatalf("finished=%v: held=%v", finished, r.Held())
		}
	}
}

// And a member who never reports is waived by GATE_TIMEOUT, like any other.
func TestAMediaCommandDoesNotWaitForeverForASilentMember(t *testing.T) {
	r, _ := newRoom(&scripted{action: vsync.ActionNone}, vsync.Anchor{MediaKey: "ep1", AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	r.OnCmd(100, "a", media("m", "ep2", nil))
	r.OnReport(150, "a", report(1, 0))
	r.OnCmd(200, "a", Cmd{ReqID: "p", Kind: "play"})
	r.Tick(100 + GateTimeoutMs + 1)
	if r.Held() {
		t.Fatal("a silent member held the room past GATE_TIMEOUT")
	}
}

// A member whose video has ended is finished, not behind: the room running on
// past its duration must not seek it, gate on it, or count it as buffering.
func TestAFinishedMemberIsAbsent(t *testing.T) {
	r, s := newRoom(&vsync.ServoCorrector{}, vsync.Anchor{MediaKey: "ep1", Paused: false, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	for now := int64(1000); now < 10_000; now += 500 {
		rep := report(0, -3000-now) // falling further behind: the room runs past the end
		rep.ReadyState = 1
		rep.Finished = true
		r.OnReport(now, "b", rep)
	}
	if n := len(of[Correct](s, "b")); n != 0 {
		t.Fatalf("a finished member was corrected %d times", n)
	}
	if len(r.Gated()) != 0 {
		t.Fatalf("a finished member is gated: %v", r.Gated())
	}
	for _, m := range r.MemberList() {
		if m.ID == "b" && !m.Suspended {
			t.Fatal("a finished member is not listed as absent")
		}
	}
}

// The control for the one above: the same reports without `finished` are
// judged, which is what makes the assertion there mean anything.
func TestAnUnfinishedMemberThatFallsBehindIsJudged(t *testing.T) {
	r, s := newRoom(&vsync.ServoCorrector{}, vsync.Anchor{MediaKey: "ep1", Paused: false, AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	for now := int64(1000); now < 10_000; now += 500 {
		r.OnReport(now, "b", report(0, -3000-now))
	}
	if n := len(of[Correct](s, "b")) + len(r.Gated()); n == 0 {
		t.Fatal("the control was never judged; the test above measures nothing")
	}
}
