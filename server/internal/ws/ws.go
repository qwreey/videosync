// Package ws is a minimal RFC 6455 WebSocket server.
//
// Hand-rolled on purpose: the rest of this repo is stdlib-only (the CDP client
// in harness/browser is written the same way), the server is meant to be a
// single self-hostable binary with no supply chain, and the server half of
// RFC 6455 is small enough to test exhaustively. Only what the protocol in
// docs/PROTOCOL.md needs is implemented: text messages, fragmentation,
// ping/pong, close. No extensions, no compression, no client side.
//
// After Upgrade the connection is hijacked, which means net/http's timeouts no
// longer apply to it -- every read and write here sets its own deadline, or a
// dead peer would pin a goroutine forever.
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// guid is RFC 6455 section 1.3's magic constant.
const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Opcodes.
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// Close status codes we use.
const (
	CloseNormal          = 1000
	CloseGoingAway       = 1001
	CloseProtocolError   = 1002
	CloseUnsupported     = 1003
	CloseMessageTooBig   = 1009
	CloseInternalError   = 1011
	ClosePolicyViolation = 1008
)

var (
	ErrClosed      = errors.New("ws: connection closed")
	ErrMessageSize = errors.New("ws: message too large")
	ErrBadFrame    = errors.New("ws: protocol error")
)

// Conn is one WebSocket connection.
//
// Exactly one goroutine may call ReadMessage. Writes are serialised internally,
// so any number of goroutines may call WriteMessage.
type Conn struct {
	raw net.Conn
	br  *bufio.Reader
	// client selects the masking rules: RFC 6455 requires client-to-server
	// frames to be masked and forbids masking server-to-client.
	client bool

	wmu sync.Mutex
	// closedOnce guards the close frame, so a close from the reader and one
	// from a writer do not both go out.
	closeOnce sync.Once

	// MaxMessageSize caps a reassembled message. A peer that ignores it gets
	// closed with 1009 rather than being allowed to allocate without bound.
	MaxMessageSize int64
	// ReadTimeout bounds the wait for the next *frame*, not the next message:
	// it is refreshed before every frame, control frames and fragments
	// included. WriteTimeout bounds one write.
	ReadTimeout, WriteTimeout time.Duration
	// ReadBefore, when set, is an absolute bound no read waits past, however
	// many frames arrive. ReadTimeout alone cannot bound a wait for one
	// particular message: it is refreshed before every frame, and pings,
	// pongs and unfinished fragments are frames that ReadMessage consumes
	// without returning.
	ReadBefore time.Time
}

// Upgrade performs the server side of the opening handshake and takes over the
// connection. On success the caller owns the returned Conn and must Close it.
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if r.ProtoMajor != 1 {
		return nil, fmt.Errorf("ws: hijack needs HTTP/1.x, got HTTP/%d", r.ProtoMajor)
	}
	if !tokenListContains(r.Header.Get("Connection"), "upgrade") {
		return nil, errors.New("ws: missing Connection: upgrade")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("ws: missing Upgrade: websocket")
	}
	if r.Header.Get("Sec-Websocket-Version") != "13" {
		return nil, errors.New("ws: unsupported Sec-WebSocket-Version")
	}
	key := r.Header.Get("Sec-Websocket-Key")
	if key == "" {
		return nil, errors.New("ws: missing Sec-WebSocket-Key")
	}

	h, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("ws: ResponseWriter does not support hijacking")
	}
	raw, brw, err := h.Hijack()
	if err != nil {
		return nil, err
	}
	// Anything already buffered from the peer would be lost if we replaced the
	// reader, and it can only be a framing violation this early.
	if brw.Reader.Buffered() > 0 {
		raw.Close()
		return nil, errors.New("ws: client sent data before the handshake completed")
	}

	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
	raw.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(raw, resp); err != nil {
		raw.Close()
		return nil, err
	}
	raw.SetWriteDeadline(time.Time{})

	return &Conn{
		raw: raw, br: bufio.NewReaderSize(raw, 4096),
		MaxMessageSize: 1 << 20,
		ReadTimeout:    90 * time.Second,
		WriteTimeout:   10 * time.Second,
	}, nil
}

// acceptKey is RFC 6455 section 4.2.2 step 5.
func acceptKey(key string) string {
	h := sha1.Sum([]byte(key + guid))
	return base64.StdEncoding.EncodeToString(h[:])
}

// tokenListContains reports whether a comma-separated header lists tok. Values
// are case-insensitive and browsers send "keep-alive, Upgrade".
func tokenListContains(header, tok string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), tok) {
			return true
		}
	}
	return false
}

// NewClientKey generates a Sec-WebSocket-Key. Only the tests dial out.
func NewClientKey() string {
	var b [16]byte
	rand.Read(b[:])
	return base64.StdEncoding.EncodeToString(b[:])
}

// AcceptKey is exported so a client can verify the handshake.
func AcceptKey(key string) string { return acceptKey(key) }

type frame struct {
	fin    bool
	opcode byte
	data   []byte
}

// readFrame reads one frame. masked says whether the peer must mask: RFC 6455
// requires client-to-server frames to be masked and forbids it server-to-client.
func (c *Conn) readFrame(mustMask bool) (frame, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return frame{}, err
	}
	fin := hdr[0]&0x80 != 0
	if hdr[0]&0x70 != 0 {
		return frame{}, fmt.Errorf("%w: reserved bits set", ErrBadFrame)
	}
	op := hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	if masked != mustMask {
		return frame{}, fmt.Errorf("%w: mask bit wrong for this direction", ErrBadFrame)
	}

	var n int64
	switch l := hdr[1] & 0x7F; {
	case l < 126:
		n = int64(l)
	case l == 126:
		var b [2]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return frame{}, err
		}
		n = int64(binary.BigEndian.Uint16(b[:]))
	default:
		var b [8]byte
		if _, err := io.ReadFull(c.br, b[:]); err != nil {
			return frame{}, err
		}
		u := binary.BigEndian.Uint64(b[:])
		if u > 1<<62 {
			return frame{}, fmt.Errorf("%w: absurd length", ErrBadFrame)
		}
		n = int64(u)
	}

	// A control frame carries at most 125 bytes and is never fragmented.
	// Enforced before allocating anything.
	if op >= 0x8 {
		if n > 125 || !fin {
			return frame{}, fmt.Errorf("%w: bad control frame", ErrBadFrame)
		}
	} else if c.MaxMessageSize > 0 && n > c.MaxMessageSize {
		return frame{}, ErrMessageSize
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, mask[:]); err != nil {
			return frame{}, err
		}
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.br, buf); err != nil {
		return frame{}, err
	}
	if masked {
		for i := range buf {
			buf[i] ^= mask[i%4]
		}
	}
	return frame{fin: fin, opcode: op, data: buf}, nil
}

// ReadMessage returns the next data message, reassembling fragments and
// answering ping/close inline. Only one goroutine may call it.
func (c *Conn) ReadMessage() (opcode byte, payload []byte, err error) {
	var (
		msgOp byte
		buf   []byte
	)
	for {
		deadline := c.ReadBefore
		if c.ReadTimeout > 0 {
			if d := time.Now().Add(c.ReadTimeout); deadline.IsZero() || d.Before(deadline) {
				deadline = d
			}
		}
		// Zero clears it, so dropping ReadBefore really lifts the bound.
		c.raw.SetReadDeadline(deadline)
		f, err := c.readFrame(!c.client)
		if err != nil {
			if errors.Is(err, ErrMessageSize) {
				c.writeClose(CloseMessageTooBig, "message too large")
			} else if errors.Is(err, ErrBadFrame) {
				c.writeClose(CloseProtocolError, "")
			}
			return 0, nil, err
		}
		switch f.opcode {
		case OpPing:
			if err := c.WriteMessage(OpPong, f.data); err != nil {
				return 0, nil, err
			}
		case OpPong:
			// Liveness only; nothing to do.
		case OpClose:
			code := CloseNormal
			if len(f.data) >= 2 {
				code = int(binary.BigEndian.Uint16(f.data))
			}
			c.writeClose(code, "")
			return 0, nil, fmt.Errorf("%w: peer closed (%d)", ErrClosed, code)
		case OpText, OpBinary:
			if msgOp != 0 {
				return 0, nil, fmt.Errorf("%w: new message before the previous one finished", ErrBadFrame)
			}
			msgOp = f.opcode
			buf = f.data
		case OpContinuation:
			if msgOp == 0 {
				return 0, nil, fmt.Errorf("%w: continuation without a start", ErrBadFrame)
			}
			buf = append(buf, f.data...)
		default:
			c.writeClose(CloseProtocolError, "")
			return 0, nil, fmt.Errorf("%w: unknown opcode %d", ErrBadFrame, f.opcode)
		}
		if c.MaxMessageSize > 0 && int64(len(buf)) > c.MaxMessageSize {
			c.writeClose(CloseMessageTooBig, "message too large")
			return 0, nil, ErrMessageSize
		}
		if msgOp != 0 && f.fin && f.opcode < 0x8 {
			return msgOp, buf, nil
		}
	}
}

// WriteMessage writes one unfragmented frame. Safe for concurrent use.
func (c *Conn) WriteMessage(opcode byte, data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.writeFrameLocked(opcode, data)
}

func (c *Conn) writeFrameLocked(opcode byte, data []byte) error {
	var hdr [10]byte
	hdr[0] = 0x80 | opcode // FIN, no RSV
	n := len(data)
	var hl int
	switch {
	case n < 126:
		hdr[1] = byte(n)
		hl = 2
	case n <= 0xFFFF:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:], uint16(n))
		hl = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(n))
		hl = 10
	}
	var k [4]byte
	if c.client {
		hdr[1] |= 0x80
		k = maskKey()
	}
	if c.WriteTimeout > 0 {
		c.raw.SetWriteDeadline(time.Now().Add(c.WriteTimeout))
	}
	// One Write: two syscalls would let a concurrent writer interleave a frame
	// between the header and its payload.
	out := make([]byte, 0, hl+4+n)
	out = append(out, hdr[:hl]...)
	if c.client {
		out = append(out, k[:]...)
	}
	body := len(out)
	out = append(out, data...)
	if c.client {
		maskInPlace(out[body:], k)
	}
	_, err := c.raw.Write(out)
	return err
}

// WriteText is the only kind of message this protocol sends.
func (c *Conn) WriteText(b []byte) error { return c.WriteMessage(OpText, b) }

// Ping sends a ping frame; the peer's pong resets our read deadline for free,
// because any frame does.
func (c *Conn) Ping() error { return c.WriteMessage(OpPing, nil) }

func (c *Conn) writeClose(code int, reason string) {
	c.closeOnce.Do(func() {
		body := make([]byte, 2, 2+len(reason))
		binary.BigEndian.PutUint16(body, uint16(code))
		body = append(body, reason...)
		c.wmu.Lock()
		c.writeFrameLocked(OpClose, body)
		c.wmu.Unlock()
	})
}

// Close sends a close frame and drops the connection. Idempotent.
func (c *Conn) Close(code int, reason string) error {
	c.writeClose(code, reason)
	return c.raw.Close()
}

// RemoteAddr is the peer's address. Nothing limits per address today; behind a
// reverse proxy this is the proxy, so a per-IP limit needs a trusted-proxy
// setting before it can use it.
func (c *Conn) RemoteAddr() net.Addr { return c.raw.RemoteAddr() }
