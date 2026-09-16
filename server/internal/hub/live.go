package hub

import (
	"log"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/qwreey/videosync/server/internal/room"
	"github.com/qwreey/videosync/server/internal/wire"
	"github.com/qwreey/videosync/server/internal/ws"
)

// Live is one running room: the transport-neutral room.Room plus the sockets
// attached to it. Its mutex IS the per-room mutex docs/PROTOCOL.md section 3
// requires -- taking it is what makes command ordering, and therefore `seq`,
// well defined.
type Live struct {
	hub *Hub
	id  string

	mu sync.Mutex
	// dead is set by the sweeper, under l.mu, at the moment the room is removed
	// from the registry. Lookup releases both locks before returning a *Live,
	// so without this a join can land in a room that no longer exists: the
	// joiner would be alone in it forever, nobody else could ever reach that id,
	// and it would never be Ticked, so its readiness gate would never expire.
	dead         bool
	secret       string
	room         *room.Room
	conns        map[string]*conn
	emptySinceMs int64
}

func (l *Live) ID() string { return l.id }

// Send implements room.Sink.
//
// Called with l.mu held, so it must never block. A full outbox means the peer
// is not draining: the connection is closed and its reader turns that into a
// Leave. One slow member must not be able to stall every other member's
// commands behind the room mutex.
func (l *Live) Send(clientID string, m room.Msg) {
	c := l.conns[clientID]
	if c == nil {
		return
	}
	b, err := wire.Encode(m)
	if err != nil {
		return
	}
	if l.hub.cfg.Verbose {
		log.Printf("[%s] -> %s %s", l.id, clientID, b)
	}
	select {
	case c.out <- b:
	default:
		c.kill(ws.ClosePolicyViolation, "outbox overflow")
	}
}

// join attaches a connection. Returns the Welcome to send, or an error.
func (l *Live) join(c *conn, h room.Hello) (room.Welcome, []room.Msg, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.dead {
		return room.Welcome{}, nil, ErrNoSuchRoom
	}
	// Lookup checked the secret, but under a lock it has since released. A
	// rotation in between -- someone cutting off a leaked link -- would
	// otherwise admit the old secret as a full member who never hears the new
	// one. Checked again here, where the check and the join are one step.
	if !secretEqual(l.secret, h.Secret) {
		return room.Welcome{}, nil, ErrBadSecret
	}
	if len(l.conns) >= l.hub.cfg.MaxMembersPerRoom {
		return room.Welcome{}, nil, ErrRoomFull
	}
	now := l.hub.clock.NowMs()
	l.conns[c.id] = c
	l.room.Join(now, c.id, h.Name)
	if l.hub.cfg.Verbose {
		log.Printf("[%s] join %s name=%q mediaKey=%q members=%d",
			l.id, c.id, h.Name, h.MediaKey, len(l.conns))
	}

	var extra []room.Msg
	a := l.room.Anchor()
	switch {
	case a.MediaKey == "" && len(l.conns) == 1:
		// Only the FIRST member names the media, and only by joining. Letting
		// any joiner set it while the key is still empty mutates the anchor
		// with no seq and no broadcast: the members already in the room were
		// told "" in their welcome and would never hear otherwise. A member
		// who arrives before its adapter has resolved the page joins with an
		// empty key and changes it afterwards with a `media` command, which
		// takes a seq and reaches everyone.
		l.room.SetMedia(h.MediaKey, h.MediaURL)
	case a.MediaKey == "":
		// The room has no media yet and this is not the first member: nothing
		// to disagree with, and nothing to announce.
	case h.MediaKey != "" && h.MediaKey != a.MediaKey:
		// Not a refusal: the joiner is in the room and can see the state, they
		// just are not looking at the same thing. mediaKey is the NORMALIZED
		// identity, so this is a real disagreement and not a stray query
		// parameter (docs/PROTOCOL.md section 2).
		extra = append(extra, room.MediaMismatch{RoomMediaKey: a.MediaKey, Yours: h.MediaKey})
	}
	if g, ok := l.room.GateState(); ok {
		// A snapshot, sent right after the welcome. Any change from here on is
		// broadcast into this member's outbox, which drains after it.
		extra = append(extra, g)
	}

	w := room.Welcome{
		You: c.id, Seq: l.room.Seq(), Anchor: l.room.Anchor(),
		Members: l.room.MemberList(), ServerMs: now, MediaKey: l.room.Anchor().MediaKey,
	}
	// Everyone else learns about the new member. The joiner gets the roster in
	// its Welcome instead, so it is excluded here.
	l.room.Broadcast(c.id, room.Members{Members: l.room.MemberList(), Joined: c.id})
	return w, extra, nil
}

func (l *Live) leave(c *conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conns[c.id] != c {
		return // already replaced or removed
	}
	delete(l.conns, c.id)
	now := l.hub.clock.NowMs()
	l.room.Leave(now, c.id)
	if l.hub.cfg.Verbose {
		log.Printf("[%s] leave %s members=%d", l.id, c.id, len(l.conns))
	}
	if len(l.conns) == 0 {
		l.emptySinceMs = now
		return
	}
	l.room.Broadcast("", room.Members{Members: l.room.MemberList(), Left: c.id})
}

// handle dispatches one decoded client frame under the room mutex.
func (l *Live) handle(c *conn, m room.Msg) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.hub.clock.NowMs()
	if l.hub.cfg.Verbose {
		// Logged before the rate limiters, deliberately: a frame the server
		// silently dropped is exactly the case this exists to make visible.
		// The heartbeat bucket drops without telling anybody.
		log.Printf("[%s] <- %s %T %+v", l.id, c.id, m, m)
	}
	switch v := m.(type) {
	case room.TimeReq:
		// Not rate limited by the command bucket: clock sync is 5 s plus a
		// burst of 5 on connect, and starving it would degrade the timebase
		// itself. It has its own, looser allowance.
		if !c.time.allow(now) {
			return
		}
		l.room.OnTime(now, c.id, v)
	case room.Cmd:
		if !c.cmd.allow(now) {
			l.Send(c.id, room.Error{Code: "rate_limited", Msg: "too many commands"})
			return
		}
		l.room.OnCmd(now, c.id, v)
	case room.Report:
		if !c.hb.allow(now) {
			return // silently dropped: a report is advisory, and telling a
			// flooding client about it would only add traffic
		}
		l.room.OnReport(now, c.id, v)
	case room.ChatIn:
		if !c.chat.allow(now) {
			l.Send(c.id, room.Error{Code: "rate_limited", Msg: "too many messages"})
			return
		}
		if n := l.hub.cfg.MaxChatLen; n > 0 && len(v.Text) > n {
			v.Text = truncateUTF8(v.Text, n)
		}
		if strings.TrimSpace(v.Text) == "" {
			return
		}
		l.room.OnChat(now, c.id, v)
	case room.Rotate:
		if !c.cmd.allow(now) {
			l.Send(c.id, room.Error{Code: "rate_limited", Msg: "too many commands"})
			return
		}
		l.secret = newID()
		l.room.Broadcast("", room.Secret{Secret: l.secret, Rotated: c.id})
	}
}

// truncateUTF8 cuts to at most n bytes without splitting a rune -- a truncated
// multi-byte character would make the whole frame invalid UTF-8 and RFC 6455
// requires text frames to be valid UTF-8.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
