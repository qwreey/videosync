package hub

import (
	"fmt"
	"strings"
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
		// In the order sent: the sender's ownAck relies on it, and the room
		// ends where the unthrottled sequence would have left it.
		{[]room.Cmd{play, seek(5)}, "[play][seek 5]"},
		{[]room.Cmd{pause(3), seek(5)}, "[pause 3][seek 5]"},
		// What replaces takes the place of the newest.
		{[]room.Cmd{seek(5), play, pause(9)}, "[seek 5][pause 9]"},
		{[]room.Cmd{seek(5), pause(9), play}, "[seek 5][play]"},
		{[]room.Cmd{seek(1), play, seek(2)}, "[play][seek 2]"},
		{[]room.Cmd{play, seek(1), pause(2)}, "[seek 1][pause 2]"},
		// Media resets the timeline, so what came before it is moot...
		{[]room.Cmd{seek(5), play, media("x")}, "[media x]"},
		// ...but nothing after it may drop it.
		{[]room.Cmd{media("x"), seek(5)}, "[media x][seek 5]"},
		{[]room.Cmd{media("x"), play}, "[media x][play]"},
		{[]room.Cmd{media("x"), seek(5), play, seek(6)}, "[media x][play][seek 6]"},
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

// acks reads a's acks until the socket has been quiet for a while.
func acks(a *client) []string {
	a.sock.ReadTimeout = 1500 * time.Millisecond
	defer func() { a.sock.ReadTimeout = 5 * time.Second }()
	var out []string
	for {
		m, err := a.read()
		if err != nil {
			return out
		}
		if m["t"] == "ack" {
			r, _ := m["reqId"].(string)
			out = append(out, r)
		}
	}
}

// tail is the last n entries of s, or all of it.
func tail(s []string, n int) []string {
	return s[max(len(s)-n, 0):]
}

func TestDeferredCommandsAreAckedInTheOrderTheyWereSent(t *testing.T) {
	// engine.ts ownAck forgets every command of ours older than the one acked,
	// and says a play of ours is still coming only if it was sent after it. A
	// batch reordered to [seek][play] acked the seek first, with the play
	// already forgotten-by-order: the presser's paused seek ack was applied as
	// a pause right after they pressed play.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	burst(a, 10, func(i int) int64 { return int64(i) * 1000 })
	a.send(room.Cmd{ReqID: "p", Kind: "play", PositionMs: 10000})
	a.send(room.Cmd{ReqID: "s", Kind: "seek", PositionMs: 42000})

	if got := strings.Join(tail(acks(a), 2), " "); got != "p s" {
		t.Fatalf("acks end %q, want the send order \"p s\"", got)
	}
	an := lastAnchor(t, b)
	if an["paused"] != false || num(an, "positionMs") < 42000 {
		t.Fatalf("the room is at %v; the user played and then sought to 42000", an)
	}
}

// freezeRetry waits until the server has deferred something of member id and
// stops the timer that would apply it, so that the next command the bucket
// admits is the one that carries the deferred batch out.
func freezeRetry(t *testing.T, f *fixture, roomID, id string) {
	t.Helper()
	f.hub.mu.Lock()
	l := f.hub.rooms[roomID]
	f.hub.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		c := l.conns[id]
		if len(c.pending) > 0 && c.retry != nil {
			c.retry.Stop()
			c.retry = time.AfterFunc(time.Hour, func() {})
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()
		time.Sleep(time.Millisecond)
	}
	t.Fatal("nothing was deferred")
}

func TestACommandTheBucketAdmitsCarriesTheDeferredOnesOutFirst(t *testing.T) {
	// The other way a deferred batch leaves: the bucket refills before the
	// retry fires and admits a newer command. What was deferred is older, so
	// it is applied -- not dropped -- and ahead of it.
	for _, tc := range []struct {
		name            string
		deferred, admit room.Cmd
		want            string
	}{
		{"seek then play",
			room.Cmd{ReqID: "s", Kind: "seek", PositionMs: 42000},
			room.Cmd{ReqID: "p", Kind: "play", PositionMs: 42000}, "s p"},
		{"play then seek",
			room.Cmd{ReqID: "p", Kind: "play", PositionMs: 10000},
			room.Cmd{ReqID: "s", Kind: "seek", PositionMs: 42000}, "p s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := start(t, nil)
			id, secret := f.createRoom("yt:abc")
			a, _, _ := f.dial(id, secret, "a", "yt:abc")
			b, _, _ := f.dial(id, secret, "b", "yt:abc")
			a.await("members")

			burst(a, 10, func(i int) int64 { return int64(i) * 1000 })
			a.send(tc.deferred)
			freezeRetry(t, f, id, a.id)
			time.Sleep(250 * time.Millisecond) // one sustained window
			a.send(tc.admit)

			if got := strings.Join(tail(acks(a), 2), " "); got != tc.want {
				t.Fatalf("acks end %q, want %q", got, tc.want)
			}
			an := lastAnchor(t, b)
			if an["paused"] != false || num(an, "positionMs") < 42000 {
				t.Fatalf("the room is at %v; want playing from 42000", an)
			}
		})
	}
}
