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
	srv := newHTTPServer("", http.NotFoundHandler(), d)
	if srv.ReadHeaderTimeout != d.header || srv.ReadTimeout != d.read || srv.IdleTimeout != d.idle {
		t.Errorf("newHTTPServer set header %v read %v idle %v, want %+v", srv.ReadHeaderTimeout, srv.ReadTimeout, srv.IdleTimeout, d)
	}
}

// scaled is defaultTimeouts shrunk so a test can outwait it.
var scaled = timeouts{header: 200 * time.Millisecond, read: 300 * time.Millisecond, idle: 300 * time.Millisecond}

func serve(t *testing.T, to timeouts) string {
	t.Helper()
	h := hub.New(hub.DefaultConfig(), hub.NewClock())
	t.Cleanup(h.Close)
	srv := newHTTPServer("", h.Handler(hub.DefaultHTTPConfig()), to)
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
	addr := serve(t, scaled)
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

// net/http falls back to ReadTimeout for an idle connection when IdleTimeout
// is zero, so with the two equal this would pass without IdleTimeout at all.
// ReadTimeout here is far longer than the wait, so only IdleTimeout can close
// the connection in time.
func TestAnIdleKeepAliveConnectionIsClosed(t *testing.T) {
	to := scaled
	to.read = time.Minute
	addr := serve(t, to)
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
	c.SetReadDeadline(time.Now().Add(10 * to.idle))
	_, err = io.Copy(io.Discard, br)
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatal("an idle keep-alive connection was never closed")
	}
}

// What keeps the socket alive here is net/http's Hijack, which clears the
// connection's deadlines as it hands it over; this passes even if
// ws.Conn.ReadMessage never set one. ws.Conn's own deadline is guarded in
// internal/ws (TestReadDeadlineFiresOnASilentPeer).
func TestAWebSocketOutlivesTheRequestTimeout(t *testing.T) {
	addr := serve(t, scaled)
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

// "a, b" is how a person writes a list, and -oidc-allow already accepts it.
// An entry kept with its space matches no Origin, so that site's /ws upgrade
// is refused and its fetches get no CORS header, with nothing said at
// startup; an empty entry matches a request with no Origin at all.
func TestAllowedOriginsAreTrimmedAndBlanksDropped(t *testing.T) {
	got, err := parseOrigins(" https://www.youtube.com, https://laftel.net ,,")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "https://www.youtube.com|https://laftel.net" {
		t.Fatalf("parseOrigins = %q", got)
	}
	if got, err := parseOrigins(""); err != nil || got != nil {
		t.Fatalf("empty flag = %q, %v; want nil (any origin)", got, err)
	}
	// A flag that names only blanks was meant to restrict something; reading
	// it as "any origin" would widen what the operator asked for.
	if _, err := parseOrigins(" , "); err == nil {
		t.Fatal("a list of blanks was accepted")
	}
}

// Only "*" and "<extension scheme>://*" are patterns. Anything else with a
// star is compared literally and matches nothing. Such a value used to start
// the server, so it still does -- refusing to start would break a config that
// ran yesterday -- but it says so, and the entry still admits nothing: a list
// of only such entries restricts, it never widens to "any".
func TestAllowedOriginsWarnAboutAPatternThatMatchesNothing(t *testing.T) {
	for _, bad := range []string{"https://*.example.com", "https://*", "*.example.com"} {
		allowed, err := parseOrigins("https://laftel.net, " + bad)
		if err != nil {
			t.Errorf("%q: %v", bad, err)
			continue
		}
		if n := strings.Join(originsNotes(allowed), "\n"); !strings.Contains(n, bad) {
			t.Errorf("%q: no warning names it (%q)", bad, n)
		}
		only, err := parseOrigins(bad)
		if err != nil || len(only) == 0 {
			t.Errorf("%q alone = %q, %v; want a list that admits nothing", bad, only, err)
		}
	}
	for _, good := range []string{"*", "moz-extension://*", "chrome-extension://*", "safari-web-extension://*"} {
		allowed, err := parseOrigins("https://laftel.net, " + good)
		if err != nil {
			t.Errorf("%q: %v", good, err)
		}
		if n := strings.Join(originsNotes(allowed), "\n"); strings.Contains(n, good) {
			t.Errorf("%q: warned about a real pattern (%q)", good, n)
		}
	}
}

// The extension's calls carry the extension's Origin. A list of sites alone
// locks every extension user out while userscript users work, so the server
// says so when it starts that way.
func TestAnAllowlistWithoutExtensionsSaysSo(t *testing.T) {
	for list, want := range map[string]bool{
		"https://www.youtube.com, https://laftel.net":                      true,
		"https://laftel.net, moz-extension://*":                            true, // Chrome is still out
		"https://laftel.net, moz-extension://*, chrome-extension://*":      false,
		"https://laftel.net, moz-extension://*, chrome-extension://abcdef": false,
		"*": false,
		"":  false,
	} {
		allowed, err := parseOrigins(list)
		if err != nil {
			t.Fatal(err)
		}
		if got := len(originsNotes(allowed)) > 0; got != want {
			t.Errorf("%q: warned = %v, want %v (%q)", list, got, want, originsNotes(allowed))
		}
	}
}
