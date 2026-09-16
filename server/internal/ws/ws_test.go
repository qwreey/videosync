package ws

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// --- a deliberately dumb test client ---------------------------------------
//
// It writes frames byte by byte rather than through a library, because the
// point of these tests is the framing itself.

type testClient struct {
	c  net.Conn
	br *bufio.Reader
}

func dial(t *testing.T, srv *httptest.Server) *testClient {
	t.Helper()
	u := strings.TrimPrefix(srv.URL, "http://")
	c, err := net.Dial("tcp", u)
	if err != nil {
		t.Fatal(err)
	}
	key := NewClientKey()
	req := "GET /ws HTTP/1.1\r\nHost: " + u + "\r\nUpgrade: websocket\r\n" +
		"Connection: keep-alive, Upgrade\r\nSec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := io.WriteString(c, req); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("status %d, want 101", resp.StatusCode)
	}
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != AcceptKey(key) {
		t.Fatalf("accept key %q, want %q", got, AcceptKey(key))
	}
	t.Cleanup(func() { c.Close() })
	return &testClient{c: c, br: br}
}

// write emits one frame. mask=false deliberately violates RFC 6455 so the
// server's enforcement can be tested.
func (tc *testClient) write(t *testing.T, fin bool, op byte, mask bool, data []byte) {
	t.Helper()
	var hdr []byte
	b0 := op
	if fin {
		b0 |= 0x80
	}
	hdr = append(hdr, b0)
	n := len(data)
	m := byte(0)
	if mask {
		m = 0x80
	}
	switch {
	case n < 126:
		hdr = append(hdr, m|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, m|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, m|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		hdr = append(hdr, b[:]...)
	}
	body := append([]byte(nil), data...)
	if mask {
		k := []byte{0xA1, 0xB2, 0xC3, 0xD4}
		hdr = append(hdr, k...)
		for i := range body {
			body[i] ^= k[i%4]
		}
	}
	tc.c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := tc.c.Write(append(hdr, body...)); err != nil {
		t.Fatal(err)
	}
}

func (tc *testClient) read(t *testing.T) (byte, []byte) {
	t.Helper()
	tc.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var hdr [2]byte
	if _, err := io.ReadFull(tc.br, hdr[:]); err != nil {
		t.Fatal(err)
	}
	if hdr[1]&0x80 != 0 {
		t.Fatal("server frame is masked; RFC 6455 forbids it")
	}
	var n int64
	switch l := hdr[1] & 0x7F; {
	case l < 126:
		n = int64(l)
	case l == 126:
		var b [2]byte
		io.ReadFull(tc.br, b[:])
		n = int64(binary.BigEndian.Uint16(b[:]))
	default:
		var b [8]byte
		io.ReadFull(tc.br, b[:])
		n = int64(binary.BigEndian.Uint64(b[:]))
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(tc.br, buf); err != nil {
		t.Fatal(err)
	}
	return hdr[0] & 0x0F, buf
}

// echoServer echoes every data message and reports why the read loop ended.
func echoServer(t *testing.T, tune func(*Conn)) (*httptest.Server, chan error) {
	t.Helper()
	// Buffered generously and never blocking: a handler goroutine parked on an
	// unread error channel would keep httptest.Server.Close waiting forever.
	errc := make(chan error, 16)
	report := func(err error) {
		select {
		case errc <- err:
		default:
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrade(w, r)
		if err != nil {
			http.Error(w, err.Error(), 400)
			report(err)
			return
		}
		if tune != nil {
			tune(c)
		}
		defer c.Close(CloseNormal, "")
		for {
			op, data, err := c.ReadMessage()
			if err != nil {
				report(err)
				return
			}
			if err := c.WriteMessage(op, data); err != nil {
				report(err)
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv, errc
}

func TestAcceptKeyMatchesRFC6455Example(t *testing.T) {
	// RFC 6455 section 1.3.
	if got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept key %q", got)
	}
}

func TestHandshakeRejectsBadRequests(t *testing.T) {
	cases := []struct{ name, extra string }{
		{"no upgrade header", "Connection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n"},
		{"wrong version", "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 8\r\n"},
		{"no key", "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"},
	}
	srv, _ := echoServer(t, nil)
	u := strings.TrimPrefix(srv.URL, "http://")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := net.Dial("tcp", u)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			io.WriteString(c, "GET /ws HTTP/1.1\r\nHost: "+u+"\r\n"+tc.extra+"\r\n")
			resp, err := http.ReadResponse(bufio.NewReader(c), nil)
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode == 101 {
				t.Fatal("upgraded despite an invalid handshake")
			}
		})
	}
}

func TestRoundTripAtEveryLengthEncoding(t *testing.T) {
	srv, _ := echoServer(t, func(c *Conn) { c.MaxMessageSize = 1 << 20 })
	tc := dial(t, srv)
	// 7-bit, 16-bit and 64-bit payload length encodings.
	for _, n := range []int{0, 5, 125, 126, 1000, 0xFFFF, 0x10000} {
		payload := make([]byte, n)
		for i := range payload {
			payload[i] = byte('a' + i%26)
		}
		tc.write(t, true, OpText, true, payload)
		op, got := tc.read(t)
		if op != OpText || len(got) != n || string(got) != string(payload) {
			t.Fatalf("n=%d: op=%d len=%d", n, op, len(got))
		}
	}
}

func TestFragmentedMessageIsReassembled(t *testing.T) {
	srv, _ := echoServer(t, nil)
	tc := dial(t, srv)
	tc.write(t, false, OpText, true, []byte("he"))
	tc.write(t, false, OpContinuation, true, []byte("ll"))
	tc.write(t, true, OpContinuation, true, []byte("o"))
	op, got := tc.read(t)
	if op != OpText || string(got) != "hello" {
		t.Fatalf("op=%d got=%q", op, got)
	}
}

func TestPingIsAnsweredMidFragment(t *testing.T) {
	// A control frame may be injected between fragments; it must not corrupt
	// the message being reassembled.
	srv, _ := echoServer(t, nil)
	tc := dial(t, srv)
	tc.write(t, false, OpText, true, []byte("ab"))
	tc.write(t, true, OpPing, true, []byte("hi"))
	op, got := tc.read(t)
	if op != OpPong || string(got) != "hi" {
		t.Fatalf("op=%d got=%q, want pong hi", op, got)
	}
	tc.write(t, true, OpContinuation, true, []byte("cd"))
	op, got = tc.read(t)
	if op != OpText || string(got) != "abcd" {
		t.Fatalf("op=%d got=%q", op, got)
	}
}

func TestUnmaskedClientFrameIsRejected(t *testing.T) {
	srv, errc := echoServer(t, nil)
	tc := dial(t, srv)
	tc.write(t, true, OpText, false, []byte("nope"))
	op, body := tc.read(t)
	if op != OpClose {
		t.Fatalf("op=%d, want close", op)
	}
	if code := binary.BigEndian.Uint16(body); code != CloseProtocolError {
		t.Fatalf("close code %d, want %d", code, CloseProtocolError)
	}
	if err := <-errc; !errors.Is(err, ErrBadFrame) {
		t.Fatalf("server error %v, want ErrBadFrame", err)
	}
}

func TestOversizeMessageIsRefusedNotAllocated(t *testing.T) {
	srv, errc := echoServer(t, func(c *Conn) { c.MaxMessageSize = 64 })
	tc := dial(t, srv)
	tc.write(t, true, OpText, true, make([]byte, 200))
	op, body := tc.read(t)
	if op != OpClose || binary.BigEndian.Uint16(body) != CloseMessageTooBig {
		t.Fatalf("op=%d body=%v, want close 1009", op, body)
	}
	if err := <-errc; !errors.Is(err, ErrMessageSize) {
		t.Fatalf("server error %v, want ErrMessageSize", err)
	}
}

func TestFragmentsCannotExceedTheSizeCapEither(t *testing.T) {
	// The per-frame check alone is not enough: a peer can stay under it and
	// still exhaust memory by sending many fragments.
	srv, errc := echoServer(t, func(c *Conn) { c.MaxMessageSize = 100 })
	tc := dial(t, srv)
	tc.write(t, false, OpText, true, make([]byte, 60))
	tc.write(t, true, OpContinuation, true, make([]byte, 60))
	if op, body := tc.read(t); op != OpClose || binary.BigEndian.Uint16(body) != CloseMessageTooBig {
		t.Fatalf("op=%d, want close 1009", op)
	}
	if err := <-errc; !errors.Is(err, ErrMessageSize) {
		t.Fatalf("server error %v, want ErrMessageSize", err)
	}
}

func TestOversizeControlFrameIsRejected(t *testing.T) {
	srv, errc := echoServer(t, nil)
	tc := dial(t, srv)
	tc.write(t, true, OpPing, true, make([]byte, 200))
	if op, _ := tc.read(t); op != OpClose {
		t.Fatalf("op=%d, want close", op)
	}
	if err := <-errc; !errors.Is(err, ErrBadFrame) {
		t.Fatalf("server error %v", err)
	}
}

func TestCloseHandshakeIsEchoed(t *testing.T) {
	srv, errc := echoServer(t, nil)
	tc := dial(t, srv)
	body := make([]byte, 2)
	binary.BigEndian.PutUint16(body, CloseGoingAway)
	tc.write(t, true, OpClose, true, body)
	if op, b := tc.read(t); op != OpClose || binary.BigEndian.Uint16(b) != CloseGoingAway {
		t.Fatalf("op=%d body=%v", op, b)
	}
	if err := <-errc; !errors.Is(err, ErrClosed) {
		t.Fatalf("server error %v, want ErrClosed", err)
	}
}

func TestReadDeadlineFiresOnASilentPeer(t *testing.T) {
	// After Hijack, net/http's timeouts no longer apply: without our own
	// deadline a dead peer pins the goroutine forever.
	srv, errc := echoServer(t, func(c *Conn) { c.ReadTimeout = 100 * time.Millisecond })
	dial(t, srv)
	select {
	case err := <-errc:
		var ne net.Error
		if !errors.As(err, &ne) || !ne.Timeout() {
			t.Fatalf("error %v, want a timeout", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("read never timed out")
	}
}

func TestReadBeforeIsNotExtendedByControlFramesOrFragments(t *testing.T) {
	// ReadTimeout is per frame, so a peer that pings, or dribbles out an
	// unfinished message, never lets it fire. ReadBefore is the absolute bound
	// the pre-hello wait needs.
	for name, dribble := range map[string]func(*testing.T, *testClient){
		"pings":     func(t *testing.T, tc *testClient) { tc.write(t, true, OpPing, true, nil) },
		"fragments": func(t *testing.T, tc *testClient) { tc.write(t, false, OpContinuation, true, []byte("x")) },
	} {
		t.Run(name, func(t *testing.T) {
			srv, errc := echoServer(t, func(c *Conn) {
				c.ReadTimeout = 200 * time.Millisecond
				c.ReadBefore = time.Now().Add(300 * time.Millisecond)
			})
			tc := dial(t, srv)
			if name == "fragments" {
				tc.write(t, false, OpText, true, []byte("x"))
			}
			began := time.Now()
			for time.Since(began) < 3*time.Second {
				select {
				case err := <-errc:
					var ne net.Error
					if !errors.As(err, &ne) || !ne.Timeout() {
						t.Fatalf("error %v, want a timeout", err)
					}
					return
				case <-time.After(50 * time.Millisecond):
					dribble(t, tc)
				}
			}
			t.Fatal("a peer that keeps sending frames outlived ReadBefore by seconds")
		})
	}
}

func TestDialAddressKeepsIPv6LiteralsValid(t *testing.T) {
	// url.URL.Host keeps an IPv6 literal's brackets, so joining it with a
	// default port bracketed it twice: "[[::1]]:80", which no dialer accepts.
	for raw, want := range map[string]string{
		"ws://[::1]/ws":          "[::1]:80",
		"wss://[2001:db8::1]/ws": "[2001:db8::1]:443",
		"ws://[::1]:8080/ws":     "[::1]:8080",
		"ws://example.com/ws":    "example.com:80",
		"https://example.com/ws": "example.com:443",
		"ws://127.0.0.1:9/ws":    "127.0.0.1:9",
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		got := dialAddr(u, u.Scheme == "wss" || u.Scheme == "https")
		if got != want {
			t.Errorf("%s: dial address %q, want %q", raw, got, want)
		}
		if _, _, err := net.SplitHostPort(got); err != nil {
			t.Errorf("%s: %q is not a dialable address: %v", raw, got, err)
		}
	}
}

func TestConcurrentWritesDoNotInterleave(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrade(w, r)
		if err != nil {
			return
		}
		defer c.Close(CloseNormal, "")
		done := make(chan struct{})
		for i := 0; i < 8; i++ {
			go func(i int) {
				defer func() { done <- struct{}{} }()
				for j := 0; j < 50; j++ {
					c.WriteText([]byte(strings.Repeat(string(rune('a'+i)), 300)))
				}
			}(i)
		}
		for i := 0; i < 8; i++ {
			<-done
		}
		time.Sleep(50 * time.Millisecond)
	}))
	t.Cleanup(srv.Close)
	tc := dial(t, srv)
	for i := 0; i < 400; i++ {
		op, body := tc.read(t)
		if op != OpText {
			t.Fatalf("frame %d: op=%d", i, op)
		}
		if len(body) != 300 || strings.Count(string(body), string(body[0])) != 300 {
			t.Fatalf("frame %d: interleaved payload %q", i, body[:20])
		}
	}
}

func TestDialerRoundTripsThroughOurOwnServer(t *testing.T) {
	srv, _ := echoServer(t, nil)
	c, err := Dial(srv.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(CloseNormal, "")
	for _, s := range []string{"", "hi", strings.Repeat("x", 200), strings.Repeat("y", 70000)} {
		if err := c.WriteText([]byte(s)); err != nil {
			t.Fatal(err)
		}
		op, got, err := c.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if op != OpText || string(got) != s {
			t.Fatalf("len %d: op=%d got %d bytes", len(s), op, len(got))
		}
	}
}

func TestDialerMasksEveryFrameWithAFreshKey(t *testing.T) {
	// Masking is the client's obligation and a constant key would defeat its
	// only purpose. Assert on the bytes, not on our own helper.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	keys := make(chan [4]byte, 4)
	go func() {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		defer nc.Close()
		br := bufio.NewReader(nc)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		io.WriteString(nc, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"+
			"Connection: Upgrade\r\nSec-WebSocket-Accept: "+
			AcceptKey(req.Header.Get("Sec-WebSocket-Key"))+"\r\n\r\n")
		for i := 0; i < 4; i++ {
			var hdr [2]byte
			if _, err := io.ReadFull(br, hdr[:]); err != nil {
				return
			}
			if hdr[1]&0x80 == 0 {
				t.Error("client frame is not masked")
				return
			}
			var k [4]byte
			io.ReadFull(br, k[:])
			io.CopyN(io.Discard, br, int64(hdr[1]&0x7F))
			keys <- k
		}
	}()
	c, err := Dial("ws://"+ln.Addr().String()+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(CloseNormal, "")
	for i := 0; i < 4; i++ {
		if err := c.WriteText([]byte("same payload every time")); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[[4]byte]bool{}
	for i := 0; i < 4; i++ {
		select {
		case k := <-keys:
			seen[k] = true
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for frames")
		}
	}
	if len(seen) < 3 {
		t.Fatalf("only %d distinct mask keys in 4 frames", len(seen))
	}
}
