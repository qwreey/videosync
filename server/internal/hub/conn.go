package hub

import (
	"time"

	"github.com/qwreey/videosync/server/internal/room"
	"github.com/qwreey/videosync/server/internal/wire"
	"github.com/qwreey/videosync/server/internal/ws"
)

// outboxDepth is how far behind a member may fall before we give up on them.
// It has to absorb a burst -- a join storm broadcasts Members to everyone, and
// a resync sends State -- without becoming a place where seconds of stale room
// state can queue up.
const outboxDepth = 64

// conn is one member's socket.
type conn struct {
	id   string
	live *Live
	sock *ws.Conn
	out  chan []byte
	die  chan struct{}

	// Per-member rate limiting, cytube's algorithm (SYNTHESIS 13.3). Buckets
	// are separate because the frames have completely different natural rates
	// and starving one to punish another would break the timebase.
	cmd  *throttle
	chat *throttle
	hb   *throttle
	time *throttle
}

func newConn(id string, l *Live, sock *ws.Conn) *conn {
	return &conn{
		id: id, live: l, sock: sock,
		out: make(chan []byte, outboxDepth),
		die: make(chan struct{}),
		// A person cannot out-click 4-then-1/s; a stuck adapter can.
		cmd:  newThrottle(10, 5, 4000),
		chat: newThrottle(4, 1, 4000),
		// EVAL_INTERVAL is 100 ms and HB_INTERVAL 1000 ms, so ~11/s is the
		// designed rate; the cap is generous enough not to bite in a hiccup.
		hb: newThrottle(40, 20, 2000),
		// TIME_SYNC_INTERVAL is 5 s plus 5 rapid samples on connect.
		time: newThrottle(10, 2, 10000),
	}
}

// kill closes the socket. Idempotent, safe from any goroutine, never blocks --
// it is called from Send, which runs with the room mutex held.
func (c *conn) kill(code int, reason string) {
	select {
	case <-c.die:
		return
	default:
	}
	close(c.die)
	go c.sock.Close(code, reason)
}

// sendNow encodes and enqueues outside the room lock, for the handshake frames
// that are produced before the connection is registered.
func (c *conn) sendNow(m room.Msg) error {
	b, err := wire.Encode(m)
	if err != nil {
		return err
	}
	return c.sock.WriteText(b)
}

// writeLoop owns every write after the handshake. Exactly one goroutine writes
// to the socket, so ws.Conn's own mutex is only ever contended by the reader's
// automatic pong.
func (c *conn) writeLoop(pingEvery time.Duration) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		select {
		case <-c.die:
			return
		case b := <-c.out:
			if err := c.sock.WriteText(b); err != nil {
				c.kill(ws.CloseInternalError, "")
				return
			}
		case <-t.C:
			// The peer's pong refreshes our read deadline for free, because
			// any frame does. Without this a member who is watching quietly
			// (paused, no heartbeat suppressed) could hit the read timeout.
			if err := c.sock.Ping(); err != nil {
				c.kill(ws.CloseInternalError, "")
				return
			}
		}
	}
}

// readLoop is the connection's lifetime. It returns when the peer goes away,
// misbehaves, or is killed by the writer.
func (c *conn) readLoop() {
	defer c.live.leave(c)
	defer c.kill(ws.CloseNormal, "")
	for {
		op, data, err := c.sock.ReadMessage()
		if err != nil {
			return
		}
		if op != ws.OpText {
			continue
		}
		m, err := wire.DecodeClient(data)
		if err != nil {
			// A frame from a newer client build must not be able to drop the
			// connection: say so and carry on.
			c.live.mu.Lock()
			c.live.Send(c.id, room.Error{Code: "bad_frame", Msg: err.Error()})
			c.live.mu.Unlock()
			continue
		}
		if _, isHello := m.(room.Hello); isHello {
			c.live.mu.Lock()
			c.live.Send(c.id, room.Error{Code: "already_joined"})
			c.live.mu.Unlock()
			continue
		}
		c.live.handle(c, m)
	}
}
