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
