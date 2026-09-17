package room

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// The roster carries whether each member is away and whether it is ready, and
// the panel tags a member from the last roster it got. It used to be sent only
// on join and leave, so a member who went away was never shown as away, and
// one who came back stayed tagged until somebody else joined or left.
func TestTheRosterIsResentWhenAMembersFlagsChange(t *testing.T) {
	r, s := newRoom(&scripted{action: vsync.ActionNone}, vsync.Anchor{AtServerMs: 1})
	r.Join(1, "a", "a")
	r.Join(1, "b", "b")
	count := func() int { return len(of[Members](s, "a")) }
	b := func(ms int64) MemberInfo {
		t.Helper()
		ros := of[Members](s, "a")
		if len(ros) == 0 {
			t.Fatalf("at %d: no roster sent to a", ms)
		}
		for _, m := range ros[len(ros)-1].Members {
			if m.ID == "b" {
				return m
			}
		}
		t.Fatalf("b missing from %+v", ros[len(ros)-1])
		return MemberInfo{}
	}

	r.OnReport(100, "b", report(0, 0))
	if n := count(); n != 0 {
		t.Fatalf("an unchanged member drew %d rosters", n)
	}
	away := report(0, 0)
	away.Suspended = true
	r.OnReport(200, "b", away)
	if m := b(200); !m.Suspended {
		t.Fatalf("b went away and the roster says %+v", m)
	}
	n := count()
	r.OnReport(300, "b", away)
	if count() != n {
		t.Fatal("a heartbeat that changed nothing re-sent the roster")
	}
	r.OnReport(400, "b", report(0, 0))
	if m := b(400); m.Suspended {
		t.Fatalf("b came back and the roster still says %+v", m)
	}
	unready := report(0, 0)
	unready.ReadyState = 1
	r.OnReport(500, "b", unready)
	if m := b(500); m.Ready {
		t.Fatalf("b is buffering and the roster says %+v", m)
	}
	// Everyone hears it, the member itself included, like a leave.
	if got := len(of[Members](s, "b")); got != count() {
		t.Fatalf("b got %d rosters, a got %d", got, count())
	}
}
