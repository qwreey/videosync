package hub

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/room"
	"github.com/qwreey/videosync/server/internal/ws"
)

// Lookup checks the secret and lets go of the room lock before join takes it
// again. A rotation in between -- someone cutting off a leaked link -- used to
// let the old secret in anyway, as a full member who never hears the new one.
func TestARotationBetweenLookupAndJoinRefusesTheOldSecret(t *testing.T) {
	f := start(t, nil)
	id, old := f.createRoom("yt:abc")
	live, err := f.hub.Lookup(id, old)
	if err != nil {
		t.Fatal(err)
	}
	// The rotation lands here, exactly as Live.handle performs it.
	live.mu.Lock()
	live.secret = newID()
	live.mu.Unlock()

	_, _, err = live.join(newConn("late", live, nil), room.Hello{Room: id, Secret: old, Name: "x"})
	if err == nil {
		t.Fatal("a hello carrying the rotated-out secret joined the room")
	}
	if code, _ := refusal(err); code.Code != "join_refused" {
		t.Fatalf("refused as %q; a wrong secret must look like an unknown room", code.Code)
	}
	if live.room.Size() != 0 {
		t.Fatalf("the refused joiner is in the room: %d members", live.room.Size())
	}
}

// The sweeper can expire a room between Lookup and join. That room has nobody
// in it, so calling it full sends the client looking for the wrong problem;
// PROTOCOL.md section 2 says an unknown room is join_refused.
func TestJoinRefusalsNameTheRightReason(t *testing.T) {
	for err, want := range map[error]string{
		ErrNoSuchRoom: "join_refused",
		ErrBadSecret:  "join_refused",
		ErrRoomFull:   "room_full",
	} {
		if got, _ := refusal(err); got.Code != want {
			t.Errorf("%v is refused as %q, want %q", err, got.Code, want)
		}
	}

	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	live, err := f.hub.Lookup(id, secret)
	if err != nil {
		t.Fatal(err)
	}
	live.mu.Lock()
	live.dead = true // what the sweeper does, under the same lock
	live.mu.Unlock()
	_, _, err = live.join(newConn("late", live, nil), room.Hello{Room: id, Secret: secret})
	if got, _ := refusal(err); got.Code != "join_refused" {
		t.Fatalf("joining an expired room is refused as %q (%v)", got.Code, err)
	}
}

// HandshakeTimeout is the only thing that bounds a socket that has not said
// hello -- it holds a goroutine and an fd and has shown no credential. It
// used to be a per-frame timeout, so a peer that pinged a little more often
// than that held the socket forever.
func TestHandshakeTimeoutBoundsAPeerThatPingsInsteadOfSayingHello(t *testing.T) {
	h := New(DefaultConfig(), NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.HandshakeTimeout = 300 * time.Millisecond
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	sock, err := ws.Dial(srv.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sock.Close(ws.CloseNormal, "")
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		// Pongs are consumed inside ReadMessage; it returns only when the
		// server hangs up.
		sock.ReadTimeout = 10 * time.Second
		sock.ReadMessage()
	}()
	began := time.Now()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-closed:
			if d := time.Since(began); d > 2*time.Second {
				t.Fatalf("closed only after %v", d)
			}
			return
		case <-tick.C:
			if time.Since(began) > 3*time.Second {
				t.Fatal("a socket that never said hello is still open after 10x HandshakeTimeout")
			}
			sock.Ping()
		}
	}
}

// The other half of the same bound: once the hello is accepted the deadline
// must go. ReadBefore is absolute, so a joined socket that kept it would be
// dropped HandshakeTimeout after joining -- every member, 10 s in, with a
// default that no other test keeps a socket open long enough to reach.
func TestAJoinedSocketOutlivesTheHandshakeTimeout(t *testing.T) {
	const handshake = 300 * time.Millisecond
	h := New(DefaultConfig(), NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.HandshakeTimeout = handshake
	hcfg.PingInterval = time.Hour
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })
	f := &fixture{t: t, hub: h, srv: srv}

	id, secret := f.createRoom("yt:abc")
	a, _, err := f.dial(id, secret, "a", "yt:abc")
	if err != nil {
		t.Fatal(err)
	}
	for i := int64(1); i <= 4; i++ {
		time.Sleep(handshake)
		a.send(room.TimeReq{T0: i})
		if got := a.await("time.reply"); got["t0"] != float64(i) {
			t.Fatalf("time.reply %v, want t0 %d", got, i)
		}
	}
}

// The sweeper marks a room dead under its lock before removing it, because
// Lookup has already let go of both locks when join runs. A join that passed
// Lookup just before the sweep otherwise lands in a room nobody can reach and
// that is never Ticked again. TestJoinRefusalsNameTheRightReason sets the flag
// by hand; this is the sweeper setting it.
func TestAJoinThatLostTheRaceWithTheSweeperIsRefused(t *testing.T) {
	f := start(t, func(c *Config) {
		c.IdleTTL = 30 * time.Millisecond
		c.TickInterval = 10 * time.Millisecond
	})
	id, secret := f.createRoom("yt:abc")
	live, err := f.hub.Lookup(id, secret)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for f.hub.Rooms() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if f.hub.Rooms() != 0 {
		t.Fatal("setup: the idle room was never swept")
	}
	_, _, err = live.join(newConn("late", live, nil), room.Hello{Room: id, Secret: secret, Name: "x"})
	if err == nil {
		t.Fatal("a join that passed Lookup before the sweep landed in the swept room")
	}
	if got, _ := refusal(err); got.Code != "join_refused" {
		t.Fatalf("refused as %q (%v), want join_refused", got.Code, err)
	}
	if live.room.Size() != 0 {
		t.Fatalf("the late joiner is in the swept room: %d members", live.room.Size())
	}
}

// A peer that resets its TCP connection mid-broadcast fails the reader and the
// writer at the same moment, and both call kill. kill runs on goroutines no
// lock serialises, and a panic there is not recovered by net/http: it takes
// the whole server, and every room in it, down with it.
func TestConcurrentKillsDoNotPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := ws.Upgrade(w, r)
		if err != nil {
			return
		}
		time.Sleep(time.Second)
		s.Close(ws.CloseNormal, "")
	}))
	defer srv.Close()
	// One real socket is enough: kill only needs something to Close, and Close
	// on an already-closed socket is harmless.
	sock, err := ws.Dial(srv.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sock.Close(ws.CloseNormal, "")

	for i := 0; i < 5000; i++ {
		c := newConn("c", nil, sock)
		var start, done sync.WaitGroup
		start.Add(1)
		for g := 0; g < 4; g++ {
			done.Add(1)
			go func() {
				defer done.Done()
				start.Wait()
				c.kill(ws.CloseInternalError, "")
			}()
		}
		start.Done()
		done.Wait()
		select {
		case <-c.die:
		default:
			t.Fatal("kill did not close die")
		}
	}
}
