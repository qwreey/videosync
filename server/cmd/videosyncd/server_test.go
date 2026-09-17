package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/hub"
	"github.com/qwreey/videosync/server/internal/ws"
)

// The server's own timeouts, in process: everything before a handler runs is
// unauthenticated, so a connection that stops talking must not hold a
// goroutine and a descriptor forever -- and the bound must not reach a
// WebSocket, which is hijacked out of the request that carried it.

func TestTheServerHasReadAndIdleTimeouts(t *testing.T) {
	d := defaultTimeouts
	if d.header <= 0 || d.read <= 0 || d.idle <= 0 {
		t.Fatalf("defaultTimeouts = %+v: a zero is no limit at all", d)
	}
	if d.read < d.header {
		t.Errorf("read %v < header %v: a request's whole read cannot be shorter than its headers'", d.read, d.header)
	}
}

// scaled is defaultTimeouts shrunk so a test can outwait it.
var scaled = timeouts{header: 200 * time.Millisecond, read: 300 * time.Millisecond, idle: 300 * time.Millisecond}

func serve(t *testing.T) string {
	t.Helper()
	h := hub.New(hub.DefaultConfig(), hub.NewClock())
	t.Cleanup(h.Close)
	srv := newHTTPServer("", h.Handler(hub.DefaultHTTPConfig()), scaled)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().String()
}

// closedByServer reads c until it ends and reports whether the server ended it
// within `within` (rather than the test's own deadline firing).
func closedByServer(t *testing.T, c net.Conn, within time.Duration) bool {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(within))
	_, err := io.Copy(io.Discard, c)
	var ne net.Error
	return !(errors.As(err, &ne) && ne.Timeout())
}

func TestASilentRequestBodyIsDropped(t *testing.T) {
	addr := serve(t)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// Declares 100 bytes, sends one, and goes quiet -- before any ticket check.
	fmt.Fprint(c, "POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
	if !closedByServer(t, c, 10*scaled.read) {
		t.Fatal("a request whose body never arrived still holds its connection")
	}
}

func TestAnIdleKeepAliveConnectionIsClosed(t *testing.T) {
	addr := serve(t)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprint(c, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.Close {
		t.Fatal("the server closed after one request; this test needs a kept-alive connection")
	}
	c.SetReadDeadline(time.Now().Add(10 * scaled.idle))
	_, err = io.Copy(io.Discard, br)
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatal("an idle keep-alive connection was never closed")
	}
}

func TestAWebSocketOutlivesTheRequestTimeout(t *testing.T) {
	addr := serve(t)
	resp, err := http.Post("http://"+addr+"/api/rooms", "application/json", strings.NewReader(`{"mediaKey":"yt:abc"}`))
	if err != nil {
		t.Fatal(err)
	}
	var made struct{ RoomID, Secret string }
	json.NewDecoder(resp.Body).Decode(&made)
	resp.Body.Close()

	c, err := ws.Dial("ws://"+addr+"/ws", http.Header{"Origin": []string{"http://localhost"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ws.CloseNormal, "")
	hello := fmt.Sprintf(`{"t":"hello","room":%q,"secret":%q,"name":"a","mediaKey":"yt:abc"}`, made.RoomID, made.Secret)
	if err := c.WriteText([]byte(hello)); err != nil {
		t.Fatal(err)
	}
	// Well past every request timeout, measured from the upgrade request.
	time.Sleep(5 * max(scaled.read, scaled.idle, scaled.header))
	if err := c.WriteText([]byte(`{"t":"time","t0":7}`)); err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		for {
			_, msg, err := c.ReadMessage()
			if err != nil {
				got <- err
				return
			}
			if strings.Contains(string(msg), `"t0":7`) {
				got <- nil
				return
			}
		}
	}()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("the socket died: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no answer to a time request")
	}
}
