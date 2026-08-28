package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/room"
	vsync "github.com/qwreey/videosync/server/internal/sync"
	"github.com/qwreey/videosync/server/internal/wire"
	"github.com/qwreey/videosync/server/internal/ws"
)

// --- harness ----------------------------------------------------------------

type fixture struct {
	t   *testing.T
	hub *Hub
	srv *httptest.Server
}

func start(t *testing.T, tune func(*Config)) *fixture {
	t.Helper()
	cfg := DefaultConfig()
	cfg.TickInterval = 50 * time.Millisecond
	if tune != nil {
		tune(&cfg)
	}
	h := New(cfg, NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.PingInterval = time.Hour // no stray pings in the middle of assertions
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })
	return &fixture{t: t, hub: h, srv: srv}
}

func (f *fixture) createRoom(mediaKey string) (id, secret string) {
	f.t.Helper()
	body := strings.NewReader(fmt.Sprintf(`{"mediaKey":%q}`, mediaKey))
	resp, err := http.Post(f.srv.URL+"/api/rooms", "application/json", body)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		f.t.Fatalf("create room: status %d", resp.StatusCode)
	}
	var out struct{ RoomID, Secret string }
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		f.t.Fatal(err)
	}
	return out.RoomID, out.Secret
}

type client struct {
	t    *testing.T
	sock *ws.Conn
	id   string
	seq  uint64
}

// dial opens a socket and completes the hello/welcome handshake.
func (f *fixture) dial(roomID, secret, name, mediaKey string) (*client, map[string]any, error) {
	f.t.Helper()
	sock, err := ws.Dial(f.srv.URL+"/ws", nil)
	if err != nil {
		f.t.Fatal(err)
	}
	sock.ReadTimeout = 5 * time.Second
	c := &client{t: f.t, sock: sock}
	f.t.Cleanup(func() { sock.Close(ws.CloseNormal, "") })
	c.send(room.Hello{Room: roomID, Secret: secret, Name: name, MediaKey: mediaKey})
	first, err := c.read()
	if err != nil {
		return c, nil, err
	}
	if first["t"] == "error" {
		return c, first, fmt.Errorf("join refused: %v", first["code"])
	}
	if first["t"] != "welcome" {
		f.t.Fatalf("first frame is %v, want welcome", first["t"])
	}
	c.id, _ = first["you"].(string)
	return c, first, nil
}

func (c *client) send(m room.Msg) {
	c.t.Helper()
	b, err := wire.Encode(m)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.sock.WriteText(b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) read() (map[string]any, error) {
	_, data, err := c.sock.ReadMessage()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// await returns the next frame of the given type, skipping the rest.
func (c *client) await(t string) map[string]any {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		m, err := c.read()
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", t, err)
		}
		if m["t"] == t {
			return m
		}
	}
	c.t.Fatalf("never saw a %q frame", t)
	return nil
}

// quiet asserts nothing of the given types arrives within d.
func (c *client) quiet(d time.Duration, types ...string) {
	c.t.Helper()
	c.sock.ReadTimeout = d
	defer func() { c.sock.ReadTimeout = 5 * time.Second }()
	for {
		m, err := c.read()
		if err != nil {
			return // the read timeout is the pass condition
		}
		for _, t := range types {
			if m["t"] == t {
				c.t.Fatalf("unexpected %q frame: %v", t, m)
			}
		}
	}
}

func hb(seq uint64, residualMs int64, tune func(*vsync.Report)) room.Report {
	r := vsync.Report{
		ResidualMs: residualMs, PositionMs: 0, ReadyState: 4,
		BufferedAheadS: 30, BufferedBehindS: 30, LastAppliedSeq: seq,
		UncertaintyMs: 10, RTTMs: 40, ClockSamples: 10,
	}
	if tune != nil {
		tune(&r)
	}
	return room.Report{Report: r}
}

func num(m map[string]any, k string) float64 {
	v, ok := m[k].(float64)
	if !ok {
		panic(fmt.Sprintf("field %q missing or not a number in %v", k, m))
	}
	return v
}

// --- the trap this whole protocol exists to avoid ---------------------------

func TestSenderIsAckedWithTheSameWhenEveryoneElseGets(t *testing.T) {
	// docs/PROTOCOL.md section 3. The sender is excluded from the broadcast for echo
	// suppression, which accidentally excluded it from the SCHEDULING the
	// timebase exists to provide. Measured cost of getting this wrong:
	// command-storm mean divergence 4743 ms -> 32 ms, seeks 19 -> 0.
	// The existing simulation tests all passed while the bug was present, so
	// this assertion is written against the wire, not against the model.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members") // b's join

	a.send(room.Cmd{ReqID: "r1", Kind: "pause", PositionMs: 1000})

	ack := a.await("ack")
	st := b.await("state")

	if ack["reqId"] != "r1" {
		t.Fatalf("ack reqId = %v", ack["reqId"])
	}
	if num(ack, "when") != num(st, "when") {
		t.Fatalf("ack when=%v but broadcast when=%v: the sender would transition at a different instant",
			ack["when"], st["when"])
	}
	if num(ack, "seq") != num(st, "seq") {
		t.Fatalf("ack seq=%v, state seq=%v", ack["seq"], st["seq"])
	}
	if num(ack, "when") <= num(ack, "emittedAt") {
		t.Fatal("when is not in the future; there is nothing to schedule against")
	}
	// And the sender must NOT also receive the broadcast, or it would echo.
	a.quiet(300*time.Millisecond, "state")
}

func TestCommandDelayIsClampedEvenWithNoPingData(t *testing.T) {
	// CMD_DELAY = clamp(2*p95_ping, 500, 2000). A brand-new room has no ping
	// samples at all; the floor is what makes that safe.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.send(room.Cmd{ReqID: "r1", Kind: "play"})
	ack := a.await("ack")
	lead := num(ack, "when") - num(ack, "emittedAt")
	if lead < 500 || lead > 2000 {
		t.Fatalf("command lead time %v ms, want it clamped to [500, 2000]", lead)
	}
}

// --- ordering ---------------------------------------------------------------

func TestSeqIsMonotonicUnderConcurrentCommands(t *testing.T) {
	// There is no host, so ordering is the per-room mutex plus a monotonic seq
	// and nothing else (docs/PROTOCOL.md section 3).
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	const senders = 4
	const each = 5

	var wg sync.WaitGroup
	clients := make([]*client, senders)
	for i := range clients {
		c, _, _ := f.dial(id, secret, fmt.Sprintf("c%d", i), "yt:abc")
		clients[i] = c
	}
	// A watcher that sees every broadcast: its `state` seqs must be strictly
	// increasing no matter who sent what.
	watcher, _, _ := f.dial(id, secret, "watch", "yt:abc")

	for _, c := range clients {
		wg.Add(1)
		go func(c *client) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				c.send(room.Cmd{ReqID: fmt.Sprintf("%s-%d", c.id, i), Kind: "play"})
			}
		}(c)
	}
	wg.Wait()

	var last float64
	seen := 0
	for seen < senders*each {
		m := watcher.await("state")
		s := num(m, "seq")
		if s <= last {
			t.Fatalf("seq went backwards: %v after %v", s, last)
		}
		last = s
		seen++
	}
}

// --- the stale-anchor blindness ---------------------------------------------

func TestALaggingLastAppliedSeqTriggersAResend(t *testing.T) {
	// A client on a stale anchor measures its residual against THAT anchor and
	// so reports ~0 while being arbitrarily out of position. lastAppliedSeq is
	// the only signal. Worth 115 603 ms -> 250 ms (POC-FINDINGS 34).
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Cmd{ReqID: "r1", Kind: "seek", PositionMs: 60000})
	a.await("ack")
	b.await("state")

	// b now reports a perfect residual but an old seq: exactly the client that
	// is confidently wrong about what it is syncing to.
	b.send(hb(0, 0, nil))
	resync := b.await("state")
	if resync["kind"] != "resync" {
		t.Fatalf("resend kind = %v, want resync", resync["kind"])
	}
	if num(resync, "seq") != 1 {
		t.Fatalf("resend seq = %v, want the current 1", resync["seq"])
	}
}

func TestAnUpToDateClientIsJudgedNotResent(t *testing.T) {
	// The control for the test above: with a current seq the report reaches
	// the corrector, and a residual well outside the band gets a correction.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.send(hb(0, 4000, nil))
	c := a.await("correct")
	if c["mode"] != "seek" {
		t.Fatalf("mode = %v, want seek for a 4 s gap", c["mode"])
	}
}

// --- the readiness gate -----------------------------------------------------

func TestGateOpensOnBufferingAndClosesOnRecovery(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	// b is buffering: paused == false, readyState < 3, buffer draining.
	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 2; r.BufferedAheadS = 0 }))
	g := a.await("gate")
	if g["waiting"] != true {
		t.Fatalf("gate = %v, want waiting", g)
	}
	on, _ := g["waitingOn"].([]any)
	if len(on) != 1 || on[0] != b.id {
		t.Fatalf("waitingOn = %v, want [%s]", g["waitingOn"], b.id)
	}

	b.send(hb(0, 0, nil))
	g = a.await("gate")
	if g["waiting"] != false {
		t.Fatalf("gate did not close: %v", g)
	}
}

func TestGateIsNotReannouncedOnEveryHeartbeat(t *testing.T) {
	// A Gate frame per report per member is the room's report rate times its
	// size; the gate is announced on CHANGE only.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	buffering := func(r *vsync.Report) { r.ReadyState = 2; r.BufferedAheadS = 0 }
	b.send(hb(0, 0, buffering))
	a.await("gate")
	for i := 0; i < 5; i++ {
		b.send(hb(0, 0, buffering))
	}
	a.quiet(300*time.Millisecond, "gate")
}

func TestAMemberWhoLeavesWhileBufferingReleasesTheGate(t *testing.T) {
	// Jellyfin's anti-hang rule: a dropped connection must not be able to
	// freeze the room for someone who is no longer in it.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1; r.BufferedAheadS = 0 }))
	if g := a.await("gate"); g["waiting"] != true {
		t.Fatal("gate never opened")
	}
	b.sock.Close(ws.CloseGoingAway, "")

	g := a.await("gate")
	if g["waiting"] != false {
		t.Fatalf("gate still held after the member left: %v", g)
	}
}

func TestASuspendedMemberDoesNotHoldTheRoom(t *testing.T) {
	// The browser pauses a hidden tab whose playback was never audible. Such a
	// member is ABSENT, not behind: gating on them waits forever for someone
	// who is not watching (docs/BROWSER-FINDINGS.md 5).
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	b.send(hb(0, 30000, func(r *vsync.Report) {
		r.Suspended = true
		r.Paused = true
		r.ReadyState = 4
	}))
	a.quiet(300*time.Millisecond, "gate")
	b.quiet(100*time.Millisecond, "correct")
}

// --- rooms, secrets, membership ---------------------------------------------

func TestJoinIsRefusedWithoutTheSecret(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	if _, _, err := f.dial(id, "wrong-"+secret, "a", "yt:abc"); err == nil {
		t.Fatal("joined with a wrong secret")
	}
	if _, _, err := f.dial("no-such-room", secret, "a", "yt:abc"); err == nil {
		t.Fatal("joined a room that does not exist")
	}
}

func TestRotationKeepsExistingMembersAndRefusesTheOldSecret(t *testing.T) {
	// The no-host replacement for "kick" (SYNTHESIS 13.2): rotating does not
	// eject anyone -- nothing in this design can -- it stops the forwarded
	// link from working.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Rotate{})
	sa := a.await("secret")
	sb := b.await("secret")
	newSecret, _ := sa["secret"].(string)
	if newSecret == "" || newSecret == secret {
		t.Fatalf("secret not rotated: %v", sa)
	}
	if sb["secret"] != newSecret {
		t.Fatal("members disagree about the new secret")
	}

	if _, _, err := f.dial(id, secret, "c", "yt:abc"); err == nil {
		t.Fatal("the old secret still works")
	}
	if _, _, err := f.dial(id, newSecret, "c", "yt:abc"); err != nil {
		t.Fatalf("the new secret does not work: %v", err)
	}
	// a and b are still in the room and still hear each other.
	b.send(room.Cmd{ReqID: "x", Kind: "pause"})
	a.await("state")
}

func TestRoomIdsAndSecretsAreUnguessable(t *testing.T) {
	f := start(t, nil)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		id, secret := f.createRoom("")
		// 128 bits, base64url, unpadded.
		if len(id) != 22 || len(secret) != 22 {
			t.Fatalf("id %q secret %q: want 22 chars of base64url (128 bits)", id, secret)
		}
		if seen[id] || seen[secret] {
			t.Fatal("repeated id or secret")
		}
		seen[id], seen[secret] = true, true
	}
}

func TestMediaMismatchIsReportedNotRefused(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, err := f.dial(id, secret, "a", "laftel:999")
	if err != nil {
		t.Fatalf("joiner was refused: %v", err)
	}
	m := a.await("media.mismatch")
	if m["roomMediaKey"] != "yt:abc" || m["yours"] != "laftel:999" {
		t.Fatalf("mismatch frame = %v", m)
	}
	// Still a member: it can see room state.
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	b.send(room.Cmd{ReqID: "x", Kind: "pause"})
	a.await("state")
}

func TestFirstMemberNamesTheMedia(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("")
	a, welcome, err := f.dial(id, secret, "a", "yt:xyz")
	if err != nil {
		t.Fatal(err)
	}
	if welcome["mediaKey"] != "yt:xyz" {
		t.Fatalf("welcome mediaKey = %v", welcome["mediaKey"])
	}
	a.quiet(200*time.Millisecond, "media.mismatch")
}

func TestMembershipIsAnnouncedOnJoinAndLeave(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")

	m := a.await("members")
	if m["joined"] != b.id {
		t.Fatalf("joined = %v, want %v", m["joined"], b.id)
	}
	b.sock.Close(ws.CloseGoingAway, "")
	m = a.await("members")
	if m["left"] != b.id {
		t.Fatalf("left = %v, want %v", m["left"], b.id)
	}
}

func TestRoomIsFullIsRefusedCleanly(t *testing.T) {
	f := start(t, func(c *Config) { c.MaxMembersPerRoom = 2 })
	id, secret := f.createRoom("yt:abc")
	f.dial(id, secret, "a", "yt:abc")
	f.dial(id, secret, "b", "yt:abc")
	_, frame, err := f.dial(id, secret, "c", "yt:abc")
	if err == nil {
		t.Fatal("third member joined a room capped at two")
	}
	if frame["code"] != "room_full" {
		t.Fatalf("refusal code = %v", frame["code"])
	}
}

func TestIdleRoomsExpire(t *testing.T) {
	f := start(t, func(c *Config) {
		c.IdleTTL = 100 * time.Millisecond
		c.TickInterval = 20 * time.Millisecond
	})
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.sock.Close(ws.CloseGoingAway, "")

	deadline := time.Now().Add(3 * time.Second)
	for f.hub.Rooms() > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if f.hub.Rooms() != 0 {
		t.Fatal("the room outlived its last member")
	}
	if _, _, err := f.dial(id, secret, "b", "yt:abc"); err == nil {
		t.Fatal("an expired room still accepts joins")
	}
}

func TestAnOccupiedRoomIsNeverSwept(t *testing.T) {
	f := start(t, func(c *Config) {
		c.IdleTTL = 50 * time.Millisecond
		c.TickInterval = 10 * time.Millisecond
	})
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	time.Sleep(300 * time.Millisecond)
	if f.hub.Rooms() != 1 {
		t.Fatal("a room with a member in it was swept")
	}
	a.send(room.Cmd{ReqID: "x", Kind: "pause"})
	a.await("ack")
}

// --- chat and limits --------------------------------------------------------

func TestChatIsBroadcastWithServerStampedIdentity(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.ChatIn{Text: "hello"})
	m := b.await("chat")
	if m["text"] != "hello" || m["from"] != a.id || m["name"] != "a" {
		t.Fatalf("chat frame = %v", m)
	}
	if num(m, "serverMs") == 0 {
		t.Fatal("chat has no server timestamp")
	}
	// The sender sees its own line too -- chat is not echo-suppressed, only
	// state is.
	a.await("chat")
}

func TestChatIsRateLimited(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	for i := 0; i < 10; i++ {
		a.send(room.ChatIn{Text: fmt.Sprintf("line %d", i)})
	}
	// cytube's constants: burst 4, then 1/s. The 5th line in the same instant
	// must be refused, and the refusal must be legible.
	seenChat, sawLimit := 0, false
	a.sock.ReadTimeout = 500 * time.Millisecond
	for {
		m, err := a.read()
		if err != nil {
			break
		}
		switch m["t"] {
		case "chat":
			seenChat++
		case "error":
			if m["code"] == "rate_limited" {
				sawLimit = true
			}
		}
	}
	if seenChat > 5 {
		t.Fatalf("%d chat lines got through a burst of 4", seenChat)
	}
	if !sawLimit {
		t.Fatal("no rate_limited error was sent")
	}
}

func TestOverlongChatIsTruncatedNotRefused(t *testing.T) {
	f := start(t, func(c *Config) { c.MaxChatLen = 16 })
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.send(room.ChatIn{Text: strings.Repeat("가", 20)}) // 3 bytes per rune
	m := a.await("chat")
	got, _ := m["text"].(string)
	if len(got) > 16 || got == "" {
		t.Fatalf("truncated to %d bytes: %q", len(got), got)
	}
	// Truncation must not split a rune: an invalid UTF-8 text frame is a
	// protocol violation, and the JSON above would not have decoded either.
	if strings.ContainsRune(got, '�') {
		t.Fatalf("truncation split a rune: %q", got)
	}
}

func TestCommandsAreRateLimited(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	for i := 0; i < 30; i++ {
		a.send(room.Cmd{ReqID: fmt.Sprintf("r%d", i), Kind: "play"})
	}
	acks, sawLimit := 0, false
	a.sock.ReadTimeout = 500 * time.Millisecond
	for {
		m, err := a.read()
		if err != nil {
			break
		}
		switch m["t"] {
		case "ack":
			acks++
		case "error":
			if m["code"] == "rate_limited" {
				sawLimit = true
			}
		}
	}
	if acks > 12 {
		t.Fatalf("%d commands got through a burst of 10", acks)
	}
	if !sawLimit {
		t.Fatal("no rate_limited error was sent")
	}
}

// --- hostile input ----------------------------------------------------------

func TestAClientCannotInjectServerFrames(t *testing.T) {
	// A `state` from a client would move the room without passing the mutex,
	// and an `ack` would advance someone's lastAppliedSeq behind the server's
	// back. The decoder accepts client-originated types only.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	for _, m := range []room.Msg{
		room.State{Seq: 99, When: 1, Anchor: vsync.Anchor{PositionMs: 999999}},
		room.Ack{Seq: 99},
		room.Correct{Mode: "seek"},
	} {
		a.send(m)
		if e := a.await("error"); e["code"] != "bad_frame" {
			t.Fatalf("frame %s: error code %v", m.Type(), e["code"])
		}
	}
	b.quiet(300*time.Millisecond, "state", "correct")
}

func TestGarbageDoesNotDropTheConnection(t *testing.T) {
	// A client from a newer build sending an unknown frame must not be able to
	// kill its own session.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.sock.WriteText([]byte(`{"t":"from-the-future","x":1}`))
	a.await("error")
	a.sock.WriteText([]byte(`not json at all`))
	a.await("error")
	a.send(room.Cmd{ReqID: "r1", Kind: "pause"})
	a.await("ack")
}

func TestASecondHelloIsRefusedNotReprocessed(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.send(room.Hello{Room: id, Secret: secret, Name: "a-again"})
	if e := a.await("error"); e["code"] != "already_joined" {
		t.Fatalf("error code = %v", e["code"])
	}
}

func TestReportedClientIDIsIgnored(t *testing.T) {
	// Identity comes from the connection. If a report could name someone else,
	// one member could steer another member's corrections.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	r := hb(0, 8000, nil)
	r.ClientID = b.id
	a.send(r)
	// The correction lands on the reporter, not on the named victim.
	a.await("correct")
	b.quiet(300*time.Millisecond, "correct")
}

func TestOriginAllowlistIsEnforced(t *testing.T) {
	cfg := DefaultConfig()
	h := New(cfg, NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.AllowedOrigins = []string{"https://laftel.net"}
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	if _, err := ws.Dial(srv.URL+"/ws", http.Header{"Origin": {"https://evil.example"}}); err == nil {
		t.Fatal("a disallowed origin was upgraded")
	}
	c, err := ws.Dial(srv.URL+"/ws", http.Header{"Origin": {"https://laftel.net"}})
	if err != nil {
		t.Fatalf("the allowed origin was refused: %v", err)
	}
	c.Close(ws.CloseNormal, "")
}

func TestHealthz(t *testing.T) {
	f := start(t, nil)
	resp, err := http.Get(f.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		OK       bool
		Rooms    int
		ServerMs int64
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if !out.OK || out.ServerMs == 0 {
		t.Fatalf("healthz = %+v", out)
	}
}

func TestAMediaCommandRepointsTheRoom(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Cmd{ReqID: "m1", Kind: "media", MediaKey: "laftel:42", PositionMs: 0})
	st := b.await("state")
	anchor, _ := st["anchor"].(map[string]any)
	if anchor["mediaKey"] != "laftel:42" {
		t.Fatalf("anchor mediaKey = %v", anchor["mediaKey"])
	}
	// Nobody has loaded the new media yet, so the room must not be running.
	if anchor["paused"] != true {
		t.Fatalf("new media started unpaused: %v", anchor)
	}
	ack := a.await("ack")
	if num(ack, "seq") != num(st, "seq") {
		t.Fatal("media command did not go through the same ordering as any other")
	}
	// A joiner now sees the new media, not the one the room was created with.
	c, welcome, err := f.dial(id, secret, "c", "laftel:42")
	if err != nil {
		t.Fatal(err)
	}
	if welcome["mediaKey"] != "laftel:42" {
		t.Fatalf("welcome mediaKey = %v", welcome["mediaKey"])
	}
	c.quiet(200*time.Millisecond, "media.mismatch")
}

func TestAnUnknownCommandKindTakesNoSeq(t *testing.T) {
	// Falling through the switch used to burn a seq and broadcast a State that
	// changed nothing -- which still advances every client's lastAppliedSeq,
	// so the room would quietly agree it had transitioned to the same place.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Cmd{ReqID: "bad", Kind: "teleport", PositionMs: 5})
	if e := a.await("error"); e["code"] != "bad_kind" {
		t.Fatalf("error code = %v", e["code"])
	}
	a.send(room.Cmd{ReqID: "bad2", Kind: "media"}) // no mediaKey
	if e := a.await("error"); e["code"] != "bad_cmd" {
		t.Fatalf("error code = %v", e["code"])
	}
	b.quiet(300*time.Millisecond, "state")

	// The next real command is still seq 1: nothing was consumed.
	a.send(room.Cmd{ReqID: "ok", Kind: "pause"})
	if s := num(a.await("ack"), "seq"); s != 1 {
		t.Fatalf("seq = %v after two rejected commands, want 1", s)
	}
}
