package hub

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

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
	return f.createRoomAt(mediaKey, "")
}

func (f *fixture) createRoomAt(mediaKey, mediaURL string) (id, secret string) {
	f.t.Helper()
	body := strings.NewReader(fmt.Sprintf(`{"mediaKey":%q,"mediaUrl":%q}`, mediaKey, mediaURL))
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

type client_ = client

type client struct {
	t    *testing.T
	sock *ws.Conn
	id   string
	seq  uint64
}

// dial opens a socket and completes the hello/welcome handshake.
func (f *fixture) dial(roomID, secret, name, mediaKey string) (*client, map[string]any, error) {
	f.t.Helper()
	return f.dialHello(room.Hello{Room: roomID, Secret: secret, Name: name, MediaKey: mediaKey})
}

func (f *fixture) dialHello(h room.Hello) (*client, map[string]any, error) {
	f.t.Helper()
	sock, err := ws.Dial(f.srv.URL+"/ws", nil)
	if err != nil {
		f.t.Fatal(err)
	}
	sock.ReadTimeout = 5 * time.Second
	c := &client{t: f.t, sock: sock}
	f.t.Cleanup(func() { sock.Close(ws.CloseNormal, "") })
	c.send(h)
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

	// `play`, deliberately: a command that leaves the room stopped is applied
	// with no lead (there is nothing left to be simultaneous about), so pause
	// would test the `when` equality below against two zeros.
	a.send(room.Cmd{ReqID: "r1", Kind: "play", PositionMs: 1000})

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
	// samples at all; the floor is what makes that safe. Two members, because
	// a room of one schedules nothing -- see the test below.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")
	a.send(room.Cmd{ReqID: "r1", Kind: "play"})
	ack := a.await("ack")
	lead := num(ack, "when") - num(ack, "emittedAt")
	if lead < 500 || lead > 2000 {
		t.Fatalf("command lead time %v ms, want it clamped to [500, 2000]", lead)
	}
	_ = b
}

func TestPauseStopsWhereThePauserStopped(t *testing.T) {
	// Against the wire, because this is a change in what the protocol MEANS.
	// The pause and the position it happened at are the thing being
	// synchronised. Projecting it to `when` invented a position nobody chose
	// and made the pauser's own picture jump forward into media they never saw.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Cmd{ReqID: "r1", Kind: "play", PositionMs: 0})
	played := a.await("ack")
	b.await("state")
	// Pause once the play is due. Inside its lead nobody has started yet, so
	// the room pauses where the play would have resumed from, whatever the
	// pauser reports -- see TestAPauseInsideASeeksLeadDoesNotUndoTheSeek.
	time.Sleep(time.Duration(num(played, "when")-num(played, "emittedAt")+100) * time.Millisecond)

	a.send(room.Cmd{ReqID: "r2", Kind: "pause", PositionMs: 90_000})
	ack := a.await("ack")
	st := b.await("state")

	if lead := num(ack, "when") - num(ack, "emittedAt"); lead != 0 {
		t.Fatalf("pause scheduled %v ms out; everyone is stopped afterwards, "+
			"so the lead only moves the pauser off what they paused on", lead)
	}
	for _, m := range []map[string]any{ack, st} {
		anchor, ok := m["anchor"].(map[string]any)
		if !ok {
			t.Fatalf("no anchor on %v", m["t"])
		}
		if got := num(anchor, "positionMs"); got != 90_000 {
			t.Fatalf("room paused at %v ms, not the 90000 ms the pauser stopped on", got)
		}
		if anchor["paused"] != true {
			t.Fatalf("anchor is not paused after a pause")
		}
	}
	if num(ack, "when") != num(st, "when") {
		t.Fatalf("ack when=%v, broadcast when=%v", ack["when"], st["when"])
	}
}

func TestASoloRoomSchedulesNothing(t *testing.T) {
	// The delay buys simultaneity between members. Alone there are none, and
	// it is spent entirely on making your own gesture wrong: the anchor moves
	// CMD_DELAY after you press and your player is dragged to meet it. Alone
	// on the 500 ms floor that was measured end to end as pausing at 103.20 s
	// and landing at 103.70 s.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	a.send(room.Cmd{ReqID: "r1", Kind: "play"})
	ack := a.await("ack")
	if lead := num(ack, "when") - num(ack, "emittedAt"); lead != 0 {
		t.Fatalf("lead time %v ms for a room of one; nobody is on the other end of it", lead)
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
	ack := a.await("ack")
	b.await("state")

	// Wait past `when`. Before that, a member that has not applied the command
	// is early, not stale, and resending would make it transition ahead of
	// everyone else -- see TestAMemberIsNotStaleWhileACommandIsMerelyNotDueYET.
	lead := num(ack, "when") - num(ack, "emittedAt")
	time.Sleep(time.Duration(lead+200) * time.Millisecond)

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

func TestBufferingIsAnnouncedWithoutHoldingTheRoom(t *testing.T) {
	// `waitingOn` is who is not ready; `waiting` is whether the room is
	// actually being held. They are different facts. Mid-playback buffering is
	// worth showing in the UI, but stopping the room for it turns one member's
	// 200 ms rebuffer into a room-wide stutter -- correcting that one member is
	// what the judge-don't-aggregate design is for.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 2; r.BufferedAheadS = 0 }))
	g := a.await("gate")
	on, _ := g["waitingOn"].([]any)
	if len(on) != 1 || on[0] != b.id {
		t.Fatalf("waitingOn = %v, want [%s]", g["waitingOn"], b.id)
	}
	if g["waiting"] != false {
		t.Fatalf("the room is held even though no command is pending: %v", g)
	}

	b.send(hb(0, 0, nil))
	g = a.await("gate")
	if on, _ := g["waitingOn"].([]any); len(on) != 0 {
		t.Fatalf("gate did not clear: %v", g)
	}
}

func TestPlayIsHeldUntilEveryoneIsReady(t *testing.T) {
	// The gate acts BEFORE the anchor moves, so it needs no cooperation from
	// any client: there is nothing to obey and nothing that can get stuck.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1; r.BufferedAheadS = 0 }))
	a.await("gate")

	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	g := a.await("gate")
	if g["waiting"] != true {
		t.Fatalf("play was not held: %v", g)
	}
	// Nothing transitioned: no ack for the sender, no broadcast for anyone.
	a.quiet(300*time.Millisecond, "ack", "state")

	b.send(hb(0, 0, nil)) // ready
	ack := a.await("ack")
	if ack["reqId"] != "p1" {
		t.Fatalf("released ack is for %v, want the held command", ack["reqId"])
	}
	st := b.await("state")
	if num(ack, "when") != num(st, "when") || st["kind"] != "play" {
		t.Fatalf("released command did not take the normal path: ack=%v state=%v", ack, st)
	}
	anchor, _ := st["anchor"].(map[string]any)
	if anchor["paused"] != false {
		t.Fatalf("released play left the room paused: %v", anchor)
	}
}

func TestAJoinerIsToldTheGateIsHolding(t *testing.T) {
	// A gate frame goes out only when the gated set changes, and a join does
	// not change it. So a member who arrived while a play was held heard
	// nothing: their own play was held again with no frame, their player
	// re-paused, and the panel said nothing was wrong.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")
	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1; r.BufferedAheadS = 0 }))
	a.await("gate")
	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	if g := a.await("gate"); g["waiting"] != true {
		t.Fatalf("play was not held: %v", g)
	}

	c, _, err := f.dial(id, secret, "c", "yt:abc")
	if err != nil {
		t.Fatal(err)
	}
	g := c.await("gate")
	if g["waiting"] != true {
		t.Fatalf("joiner's gate frame says nothing is held: %v", g)
	}
	if on, _ := g["waitingOn"].([]any); len(on) != 1 || on[0] != b.id {
		t.Fatalf("joiner is told the room waits on %v, want [%s]", g["waitingOn"], b.id)
	}
}

func TestAJoinerIntoAnOpenRoomGetsNoGateFrame(t *testing.T) {
	// The control: nothing to report, nothing sent.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	f.dial(id, secret, "a", "yt:abc")
	c, _, _ := f.dial(id, secret, "c", "yt:abc")
	c.quiet(300*time.Millisecond, "gate")
}

func TestNamesAndMediaKeysAreBounded(t *testing.T) {
	// Both are repeated to every member -- the name in every roster and chat
	// line, the key in every state, ack and welcome -- so, like chat text and
	// mediaUrl, they need a bound of their own. MaxFrameBytes alone let one
	// member make every later frame to everyone ~64 KiB.
	huge := strings.Repeat("가", 10_000) // 30 000 bytes; two of them fit a hello
	f := start(t, nil)

	// A room created with an oversized key is not named by it (under the
	// 4 KiB body cap, which would otherwise hide the question)...
	id, secret := f.createRoom(strings.Repeat("k", 2000))
	a, welcome, err := f.dial(id, secret, huge, huge)
	if err != nil {
		t.Fatal(err)
	}
	// ...and neither is it named by an oversized first hello.
	if k, _ := welcome["mediaKey"].(string); len(k) > room.MaxMediaKey {
		t.Fatalf("room took a %d-byte mediaKey", len(k))
	}
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	for _, mem := range a.await("members")["members"].([]any) {
		name, _ := mem.(map[string]any)["name"].(string)
		if len(name) > f.hub.cfg.MaxNameLen {
			t.Fatalf("roster carries a %d-byte name, cap %d", len(name), f.hub.cfg.MaxNameLen)
		}
		if !utf8.ValidString(name) {
			t.Fatal("the truncated name is not valid UTF-8")
		}
	}
	if f.hub.cfg.MaxNameLen <= 0 {
		t.Fatal("no name cap configured by default")
	}

	// A media command naming an oversized key is refused, and takes no seq.
	a.send(room.Cmd{ReqID: "m", Kind: "media", MediaKey: huge})
	if e := a.await("error"); e["code"] != "bad_cmd" {
		t.Fatalf("oversized media command answered %v", e)
	}
	b.quiet(200*time.Millisecond, "state")

	// The control: a key of honest size still repoints the room.
	a.send(room.Cmd{ReqID: "m2", Kind: "media", MediaKey: "yt:" + strings.Repeat("x", 100)})
	if st := b.await("state"); st["kind"] != "media" {
		t.Fatalf("media command of normal size did not go through: %v", st)
	}
}

func TestOnlyPlayIsHeld(t *testing.T) {
	// pause and seek go through while a member buffers: they are not the
	// transitions where being unready is fatal, and holding them would make
	// the room unresponsive exactly when someone wants to stop it.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")
	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1; r.BufferedAheadS = 0 }))
	a.await("gate")

	a.send(room.Cmd{ReqID: "s1", Kind: "seek", PositionMs: 5000})
	if ack := a.await("ack"); ack["reqId"] != "s1" {
		t.Fatalf("seek was held: %v", ack)
	}
	a.send(room.Cmd{ReqID: "p1", Kind: "pause"})
	if ack := a.await("ack"); ack["reqId"] != "p1" {
		t.Fatalf("pause was held: %v", ack)
	}
}

func TestALaterCommandSupersedesAHeldOne(t *testing.T) {
	// Holding a queue would let a member who is slow to buffer replay a stale
	// burst of user intent at the room minutes later.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")
	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1; r.BufferedAheadS = 0 }))
	a.await("gate")

	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	a.await("gate")
	a.send(room.Cmd{ReqID: "s1", Kind: "seek", PositionMs: 9000})
	if ack := a.await("ack"); ack["reqId"] != "s1" {
		t.Fatalf("ack = %v, want the seek", ack)
	}
	// Drain b's copy of the seek before asserting on silence, and check the
	// held play consumed no seq: the seek is still the room's first command.
	if st := b.await("state"); num(st, "seq") != 1 || st["kind"] != "seek" {
		t.Fatalf("state = %v, want the seek at seq 1", st)
	}

	// b becomes ready: the superseded play must NOT fire now.
	b.send(hb(1, 0, nil))
	a.quiet(400*time.Millisecond, "ack")
	b.quiet(100*time.Millisecond, "state")
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
	a.await("gate")
	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	if g := a.await("gate"); g["waiting"] != true {
		t.Fatal("the play was not held")
	}
	b.sock.Close(ws.CloseGoingAway, "")

	// The held play must fire, not sit there forever waiting for someone who
	// is no longer in the room.
	if ack := a.await("ack"); ack["reqId"] != "p1" {
		t.Fatalf("ack = %v, want the released play", ack)
	}
}

func TestAMemberWhoIsReadyAgainLeavesTheGateEvenWhileBeingNudged(t *testing.T) {
	// Found on the real Laftel (BROWSER-FINDINGS §15). A presser's own play
	// jump is an in-buffer seek, and the report taken during it said
	// ReadyState 1 with 46 s buffered. That gated them -- and only an
	// ActionNone decision ever cleared the flag, while the servo keeps
	// answering "nudge" for as long as it holds a rate bias, which a paused
	// member never integrates away. So a member with a full buffer stayed
	// "buffering" indefinitely, and the NEXT play anyone pressed was held
	// until that member left the room.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	b.send(hb(0, 0, func(r *vsync.Report) { r.ReadyState = 1 }))
	if g := a.await("gate"); len(g["waitingOn"].([]any)) != 1 {
		t.Fatalf("gate = %v, want b waited on", g)
	}
	// Ready again, but drifting slowly: the servo answers with a nudge, not
	// with "nothing to do".
	drifting := func(r *vsync.Report) { r.SlopeMsPerS = 50 }
	b.send(hb(0, 0, drifting))
	if c := b.await("correct"); c["mode"] != "nudge" {
		t.Fatalf("correct = %v, want a nudge -- otherwise this does not reproduce", c)
	}
	if g := a.await("gate"); g["waitingOn"] != nil {
		t.Fatalf("gate = %v, want nobody waited on once b reports ready", g)
	}

	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	if ack := a.await("ack"); ack["reqId"] != "p1" {
		t.Fatalf("a ready member held the play: %v", ack)
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

	// And a play is not held for them either.
	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	if ack := a.await("ack"); ack["reqId"] != "p1" {
		t.Fatalf("a suspended member held the room: %v", ack)
	}
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
	acks, last := 0, ""
	a.sock.ReadTimeout = 500 * time.Millisecond
	for {
		m, err := a.read()
		if err != nil {
			break
		}
		if m["t"] == "ack" {
			acks++
			last, _ = m["reqId"].(string)
		}
	}
	if acks > 12 {
		t.Fatalf("%d commands got through a burst of 10", acks)
	}
	// What is past the burst is coalesced, not queued: the newest intent is
	// applied once the bucket allows it and everything in between is dropped.
	if last != "r29" {
		t.Fatalf("the last command applied was %q, want the newest, r29", last)
	}
}

func TestTheNewestRateLimitedSeekIsAppliedNotDropped(t *testing.T) {
	// Holding an arrow key is a stream of seeks ~100 ms apart or faster, and
	// past the burst every other one was refused outright. When the last was
	// refused the room stayed on an earlier skip -- and the ack for that
	// earlier skip then sought the user's own player back to it.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	const n = 21
	for i := 1; i <= n; i++ {
		a.send(room.Cmd{ReqID: fmt.Sprintf("s%d", i), Kind: "seek", PositionMs: int64(i) * 5000})
	}
	final := float64(n * 5000)
	deadline := time.Now().Add(3 * time.Second)
	b.sock.ReadTimeout = 3 * time.Second
	var pos float64
	for time.Now().Before(deadline) && pos != final {
		m, err := b.read()
		if err != nil {
			break
		}
		if m["t"] == "state" {
			pos = num(m["anchor"].(map[string]any), "positionMs")
		}
	}
	if pos != final {
		t.Fatalf("the room ended at %v ms; the user stopped at %v ms", pos, final)
	}
	// And the sender's own last ack is for that seek, so its player stays put.
	a.sock.ReadTimeout = time.Second
	var lastAck map[string]any
	for {
		m, err := a.read()
		if err != nil {
			break
		}
		if m["t"] == "ack" {
			lastAck = m
		}
	}
	if lastAck == nil || lastAck["reqId"] != fmt.Sprintf("s%d", n) {
		t.Fatalf("sender's last ack is %v, want s%d", lastAck, n)
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
	//
	// Replies go back on the reporter's own socket whatever the report says,
	// so "a gets the correction" cannot tell the cases apart. What can is who
	// the corrector is asked about: its per-client state is keyed by that id,
	// and a wrong key is one member steering another's servo.
	rec := &askLog{}
	f := start(t, func(c *Config) {
		c.NewCorrector = func() vsync.Corrector { return rec }
	})
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	// Written by hand: vsync.Report.ClientID is json:"-", so encoding a struct
	// would never put the field on the wire at all.
	raw := fmt.Sprintf(`{"t":"hb","clientId":%q,"residualMs":8000,"readyState":4,`+
		`"bufferedAheadS":30,"bufferedBehindS":30,"lastAppliedSeq":0,"uncertaintyMs":10,`+
		`"rttMs":40,"clockSamples":10}`, b.id)
	if err := a.sock.WriteText([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	// The correction lands on the reporter, not on the named victim.
	a.await("correct")
	b.quiet(300*time.Millisecond, "correct")
	if asked := rec.all(); len(asked) == 0 || asked[0] != a.id || len(asked) != 1 {
		t.Fatalf("corrector was asked about %q; want exactly the reporter %q", asked, a.id)
	}
}

// askLog is a corrector that always seeks and records who it was asked about.
type askLog struct {
	mu    sync.Mutex
	asked []string
}

func (c *askLog) Name() string { return "asklog" }
func (c *askLog) Decide(r vsync.Report, _ vsync.Anchor, _ int64, _ vsync.Tunables) vsync.Decision {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.asked = append(c.asked, r.ClientID)
	return vsync.Decision{Action: vsync.ActionSeek, Why: "asklog"}
}
func (c *askLog) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.asked...)
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

func TestOnlyTheFirstMemberNamesTheMedia(t *testing.T) {
	// A member whose adapter has not resolved the page yet joins with an empty
	// mediaKey. If a later joiner could then set it, the anchor would change
	// with no seq and no broadcast -- the members already in the room were told
	// "" in their welcome and would never hear otherwise.
	f := start(t, nil)
	id, secret := f.createRoom("")
	a, wa, err := f.dial(id, secret, "a", "")
	if err != nil {
		t.Fatal(err)
	}
	if wa["mediaKey"] != "" {
		t.Fatalf("welcome mediaKey = %v, want empty", wa["mediaKey"])
	}
	b, wb, err := f.dial(id, secret, "b", "yt:abc")
	if err != nil {
		t.Fatal(err)
	}
	if wb["mediaKey"] != "" {
		t.Fatalf("a later joiner set the room's media silently: %v", wb["mediaKey"])
	}
	a.await("members")
	a.quiet(200*time.Millisecond, "media.mismatch", "state")

	// The documented way to fix it: a `media` command, which takes a seq and
	// reaches everyone.
	b.send(room.Cmd{ReqID: "m1", Kind: "media", MediaKey: "yt:abc"})
	st := a.await("state")
	anchor, _ := st["anchor"].(map[string]any)
	if anchor["mediaKey"] != "yt:abc" {
		t.Fatalf("anchor = %v", anchor)
	}
}

// --- where the room's media can be opened ----------------------------------

func anchorURL(t *testing.T, m map[string]any) any {
	t.Helper()
	a, ok := m["anchor"].(map[string]any)
	if !ok {
		t.Fatalf("no anchor in %v", m)
	}
	return a["mediaUrl"]
}

func TestTheRoomCarriesWhereItsMediaCanBeOpened(t *testing.T) {
	// A joiner on another page can only be taken to the room's media if the
	// room knows where it is: mediaKey is lossy on purpose (`yt:abc`,
	// `laftel:/player/1/2`) and a URL cannot be rebuilt from it.
	const url1 = "https://laftel.net/player/45462/93304"
	const url2 = "https://laftel.net/player/45462/93295"
	f := start(t, nil)
	id, secret := f.createRoomAt("laftel:/player/45462/93304", url1)
	a, wa, _ := f.dial(id, secret, "a", "laftel:/player/45462/93304")
	if got := anchorURL(t, wa); got != url1 {
		t.Fatalf("welcome mediaUrl = %v, want the one the room was created with", got)
	}

	// A later joiner's hello does not change it, any more than its mediaKey does.
	b, wb, _ := f.dialHello(room.Hello{Room: id, Secret: secret, Name: "b",
		MediaKey: "laftel:/player/45462/93295", MediaURL: url2})
	if got := anchorURL(t, wb); got != url1 {
		t.Fatalf("a joiner's hello moved the room's URL to %v", got)
	}
	a.await("members")

	// A media command moves both, for everyone.
	b.send(room.Cmd{ReqID: "m1", Kind: "media", MediaKey: "laftel:/player/45462/93295", MediaURL: url2})
	if got := anchorURL(t, a.await("state")); got != url2 {
		t.Fatalf("state mediaUrl = %v", got)
	}
	if got := anchorURL(t, b.await("ack")); got != url2 {
		t.Fatalf("ack mediaUrl = %v", got)
	}
	// And one that says nothing about where clears it rather than keeping a
	// URL for the media the room just left.
	b.send(room.Cmd{ReqID: "m2", Kind: "media", MediaKey: "yt:abc"})
	if got := anchorURL(t, a.await("state")); got != nil {
		t.Fatalf("state mediaUrl = %v after a media command without one", got)
	}
}

func TestTheFirstMemberNamesWhereTheMediaIs(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoom("")
	_, w, _ := f.dialHello(room.Hello{Room: id, Secret: secret, Name: "a",
		MediaKey: "yt:abc", MediaURL: "https://www.youtube.com/watch?v=abc"})
	if got := anchorURL(t, w); got != "https://www.youtube.com/watch?v=abc" {
		t.Fatalf("welcome mediaUrl = %v", got)
	}
}

func TestARoomNeverRepeatsAURLNoHonestClientSends(t *testing.T) {
	f := start(t, nil)
	id, secret := f.createRoomAt("yt:abc", "javascript:alert(1)")
	a, w, _ := f.dial(id, secret, "a", "yt:abc")
	if got := anchorURL(t, w); got != nil {
		t.Fatalf("stored %v", got)
	}
	a.send(room.Cmd{ReqID: "m1", Kind: "media", MediaKey: "yt:def",
		MediaURL: "https://www.youtube.com/watch?v=def#videosync=room.secret"})
	if got := anchorURL(t, a.await("ack")); got != nil {
		t.Fatalf("stored %v -- a fragment is where invite secrets live", got)
	}
}

func TestApiIsReachableCrossOrigin(t *testing.T) {
	// A userscript or a content script always runs on the OTT site's origin,
	// never on the sync server's, so EVERY /api/rooms call is cross-origin.
	// Without these headers the browser fetches the response and then refuses
	// to let the script read it -- surfacing as a bare "TypeError: Failed to
	// fetch" with no hint that the request actually succeeded. Found by the
	// Risk-B probe, not by any test that mocked a browser.
	f := start(t, nil)
	req, _ := http.NewRequest("POST", f.srv.URL+"/api/rooms", strings.NewReader("{}"))
	req.Header.Set("Origin", "https://www.youtube.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q with no allowlist configured", got)
	}

	// Preflight, for a client that sends Content-Type: application/json.
	pre, _ := http.NewRequest("OPTIONS", f.srv.URL+"/api/rooms", nil)
	pre.Header.Set("Origin", "https://www.youtube.com")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	presp, err := http.DefaultClient.Do(pre)
	if err != nil {
		t.Fatal(err)
	}
	defer presp.Body.Close()
	if presp.StatusCode != 204 {
		t.Fatalf("preflight status %d", presp.StatusCode)
	}
	if !strings.Contains(presp.Header.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight allows %q", presp.Header.Get("Access-Control-Allow-Methods"))
	}
}

func TestCrossOriginIsRestrictedWhenAnAllowlistIsSet(t *testing.T) {
	cfg := DefaultConfig()
	h := New(cfg, NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.AllowedOrigins = []string{"https://laftel.net"}
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	get := func(origin string) *http.Response {
		req, _ := http.NewRequest("POST", srv.URL+"/api/rooms", strings.NewReader("{}"))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	ok := get("https://laftel.net")
	defer ok.Body.Close()
	if got := ok.Header.Get("Access-Control-Allow-Origin"); got != "https://laftel.net" {
		t.Fatalf("allowed origin got %q", got)
	}
	if !strings.Contains(ok.Header.Get("Vary"), "Origin") {
		t.Fatal("no Vary: Origin -- a shared cache could serve one origin's response to another")
	}
	bad := get("https://evil.example")
	defer bad.Body.Close()
	if got := bad.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin got %q", got)
	}
}

func TestServesOverTLS(t *testing.T) {
	// Not a nicety: measured in a real browser (BROWSER-FINDINGS §8), a script
	// on an https page cannot reach an http server AT ALL -- neither `fetch`
	// nor `ws://` -- and the localhost exemption for secure *contexts* does not
	// extend to mixed-content blocking. Every provider we target serves https,
	// so a plaintext server is unreachable from all of them and TLS is the only
	// deployable configuration.
	cfg := DefaultConfig()
	h := New(cfg, NewClock())
	srv := httptest.NewTLSServer(h.Handler(DefaultHTTPConfig()))
	t.Cleanup(func() { srv.Close(); h.Close() })

	// The API over https.
	client := srv.Client()
	resp, err := client.Post(srv.URL+"/api/rooms", "application/json", strings.NewReader(`{"mediaKey":"m"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct{ RoomID, Secret string }
	json.NewDecoder(resp.Body).Decode(&out)
	if out.RoomID == "" {
		t.Fatal("no room over https")
	}

	// And the socket over wss, verified against the server's own certificate --
	// not with verification switched off, which would prove nothing.
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	sock, err := ws.DialTLS(strings.Replace(srv.URL, "https://", "wss://", 1)+"/ws", nil,
		&tls.Config{RootCAs: pool, ServerName: "example.com"})
	if err != nil {
		t.Fatalf("wss dial: %v", err)
	}
	defer sock.Close(ws.CloseNormal, "")
	sock.ReadTimeout = 5 * time.Second
	c := &client_{t: t, sock: sock}
	c.send(room.Hello{Room: out.RoomID, Secret: out.Secret, Name: "a", MediaKey: "m"})
	if m := c.await("welcome"); m["you"] == "" {
		t.Fatalf("welcome over wss = %v", m)
	}
}

func TestAMemberIsNotStaleWhileACommandIsMerelyNotDueYET(t *testing.T) {
	// `lastAppliedSeq` cannot distinguish "missed the command" from "has it
	// scheduled and has not reached `when` yet" -- the client advances it at
	// apply time, which is CMD_DELAY after the broadcast. So for the whole
	// 500-2000 ms scheduling window every member looks stale.
	//
	// Resending is not harmless there: the resend carries `when: now`, the
	// client replaces its correctly-scheduled entry with it, and applies
	// immediately -- CMD_DELAY early, which is exactly the simultaneity the
	// whole timebase exists to provide. With a 1 Hz heartbeat and a 500 ms
	// floor it lands roughly half the time.
	f := start(t, nil)
	id, secret := f.createRoom("yt:abc")
	a, _, _ := f.dial(id, secret, "a", "yt:abc")
	b, _, _ := f.dial(id, secret, "b", "yt:abc")
	a.await("members")

	a.send(room.Cmd{ReqID: "p1", Kind: "play"})
	ack := a.await("ack")
	st := b.await("state")
	lead := num(ack, "when") - num(ack, "emittedAt")
	if lead < 400 {
		t.Fatalf("command lead %v ms is too short for this test to mean anything", lead)
	}

	// b reports honestly: it has the command, it has not applied it.
	b.send(hb(0, 0, nil))
	b.quiet(300*time.Millisecond, "state")
	_ = st

	// The control: once the command is actually due, a member still reporting
	// an old seq IS stale and must be resent to.
	time.Sleep(time.Duration(lead+300) * time.Millisecond)
	b.send(hb(0, 0, nil))
	if resync := b.await("state"); resync["kind"] != "resync" {
		t.Fatalf("no resync after the command came due: %v", resync)
	}
}
