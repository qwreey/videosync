package hub

import (
	"fmt"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/room"
)

// lastAnchor reads b's frames until it has been quiet for a while and returns
// the anchor of the last `state` it saw.
func lastAnchor(t *testing.T, b *client) map[string]any {
	t.Helper()
	b.sock.ReadTimeout = 1500 * time.Millisecond
	defer func() { b.sock.ReadTimeout = 5 * time.Second }()
	var last map[string]any
	for {
		m, err := b.read()
		if err != nil {
			break
		}
		if m["t"] == "state" {
			last = m
		}
	}
	if last == nil {
		t.Fatal("no state frame at all")
	}
	return last["anchor"].(map[string]any)
}

// burst spends the cmd bucket so that what follows is deferred.
func burst(a *client, n int, pos func(i int) int64) {
	for i := 1; i <= n; i++ {
		a.send(room.Cmd{ReqID: fmt.Sprintf("s%d", i), Kind: "seek", PositionMs: pos(i)})
	}
}

func TestAPlayPressedRightAfterScrubbingStartsWhereTheScrubEnded(t *testing.T) {
	// Holding an arrow key and then pressing space: past the burst the last
	// seek is deferred, and the play -- deferred too -- used to replace it.
	// A play carries no position, so the room started from an earlier skip
	// and the play's own ack sought the presser back to it.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	const n = 12
	burst(a, n, func(i int) int64 { return int64(i) * 5000 })
	a.send(room.Cmd{ReqID: "p", Kind: "play", PositionMs: n * 5000})

	an := lastAnchor(t, b)
	if an["paused"] != false {
		t.Fatalf("the play was lost: %v", an)
	}
	if pos := num(an, "positionMs"); pos < n*5000 {
		t.Fatalf("the room plays from %v ms; the user scrubbed to %v ms", pos, n*5000)
	}
}

func TestADeferredMediaCommandIsNotSupersededByALaterSeek(t *testing.T) {
	// A next-episode `media` that the bucket deferred, then a seek on the new
	// episode: the seek used to replace the media, so the room stayed on the
	// old media and was moved there instead.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	burst(a, 10, func(i int) int64 { return int64(i) * 1000 })
	old := "yt:abc"
	a.send(room.Cmd{ReqID: "m", Kind: "media", MediaKey: "yt:next", IfMediaKey: &old})
	a.send(room.Cmd{ReqID: "s", Kind: "seek", PositionMs: 42000})

	an := lastAnchor(t, b)
	if an["mediaKey"] != "yt:next" {
		t.Fatalf("the media command was dropped: %v", an)
	}
	if pos := num(an, "positionMs"); pos != 42000 {
		t.Fatalf("the seek after it was lost: %v", an)
	}
}

func TestCoalescingKeepsWhatEachCommandContributes(t *testing.T) {
	seek := func(p int64) room.Cmd { return room.Cmd{Kind: "seek", PositionMs: p} }
	play := room.Cmd{Kind: "play", PositionMs: 1}
	pause := func(p int64) room.Cmd { return room.Cmd{Kind: "pause", PositionMs: p} }
	media := func(k string) room.Cmd { return room.Cmd{Kind: "media", MediaKey: k} }
	str := func(cs []room.Cmd) string {
		s := ""
		for _, c := range cs {
			switch c.Kind {
			case "media":
				s += fmt.Sprintf("[media %s]", c.MediaKey)
			case "play":
				s += "[play]"
			default:
				s += fmt.Sprintf("[%s %d]", c.Kind, c.PositionMs)
			}
		}
		return s
	}
	for _, tc := range []struct {
		in   []room.Cmd
		want string
	}{
		{[]room.Cmd{seek(1), seek(2)}, "[seek 2]"},
		{[]room.Cmd{play, play}, "[play]"},
		{[]room.Cmd{seek(5), play}, "[seek 5][play]"},
		{[]room.Cmd{seek(5), pause(7)}, "[seek 5][pause 7]"},
		// A seek after a play is where the playing room goes: the same thing
		// as seeking first.
		{[]room.Cmd{play, seek(5)}, "[seek 5][play]"},
		// Paused, then moved: paused where it was moved to.
		{[]room.Cmd{pause(3), seek(5)}, "[seek 5][pause 5]"},
		{[]room.Cmd{seek(5), play, pause(9)}, "[seek 5][pause 9]"},
		{[]room.Cmd{seek(5), pause(9), play}, "[seek 5][play]"},
		// Media resets the timeline, so what came before it is moot...
		{[]room.Cmd{seek(5), play, media("x")}, "[media x]"},
		// ...but nothing after it may drop it.
		{[]room.Cmd{media("x"), seek(5)}, "[media x][seek 5]"},
		{[]room.Cmd{media("x"), play}, "[media x][play]"},
		{[]room.Cmd{media("x"), seek(5), play, seek(6)}, "[media x][seek 6][play]"},
		// Two media: the newer intent wins, as for any other kind.
		{[]room.Cmd{media("x"), seek(5), media("y")}, "[media y]"},
		// A bounded batch, whatever the sender does.
		{[]room.Cmd{media("x"), seek(1), play, seek(2), pause(3), seek(4), play}, "[media x][seek 4][play]"},
	} {
		var got []room.Cmd
		for _, c := range tc.in {
			got = coalesce(got, c)
		}
		if str(got) != tc.want {
			t.Errorf("%s -> %s, want %s", str(tc.in), str(got), tc.want)
		}
	}
}
