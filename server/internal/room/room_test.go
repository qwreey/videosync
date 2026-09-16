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
