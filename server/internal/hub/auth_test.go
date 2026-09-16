package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/auth"
	"github.com/qwreey/videosync/server/internal/room"
)

// D6 on the wire: what a client actually sees from a server with access
// control on, and -- as much -- from one with it off.

const accessKey = "friends-only-access-key"

func startAuth(t *testing.T, scope auth.Scope, tune ...func(*Config)) *fixture {
	t.Helper()
	keys, _, err := auth.ParseKeys(strings.NewReader(accessKey))
	if err != nil {
		t.Fatal(err)
	}
	cfg := auth.DefaultConfig()
	cfg.Methods = []string{auth.MethodToken}
	cfg.Scope = scope
	cfg.Keys = keys
	cfg.Key = auth.RandomKey()
	a, err := auth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	hc := DefaultConfig()
	for _, f := range tune {
		f(&hc)
	}
	h := New(hc, NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.PingInterval = time.Hour
	hcfg.Auth = a
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })
	return &fixture{t: t, hub: h, srv: srv}
}

func (f *fixture) post(path, authz, body string) (int, map[string]any) {
	f.t.Helper()
	req, _ := http.NewRequest("POST", f.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Origin", "https://www.youtube.com")
	if authz != "" {
		req.Header.Set("Authorization", authz)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		f.t.Fatalf("%s: no CORS header -- a userscript could not read this answer", path)
	}
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// ticket goes the whole way a client does: key -> device token -> ticket.
func (f *fixture) ticket() string {
	f.t.Helper()
	code, s := f.post("/api/session", "Bearer "+accessKey, "")
	if code != 200 {
		f.t.Fatalf("session: %d %v", code, s)
	}
	code, tk := f.post("/api/ticket", "Bearer "+s["token"].(string), "")
	if code != 200 {
		f.t.Fatalf("ticket: %d %v", code, tk)
	}
	return tk["ticket"].(string)
}

func (f *fixture) createWith(ticket string) (int, map[string]any) {
	f.t.Helper()
	return f.post("/api/rooms", "", fmt.Sprintf(`{"mediaKey":"yt:abc","ticket":%q}`, ticket))
}

func healthz(t *testing.T, f *fixture) map[string]any {
	t.Helper()
	resp, err := http.Get(f.srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func TestWithAuthOffNothingIsGatedOrAdvertised(t *testing.T) {
	f := start(t, nil)
	if _, has := healthz(t, f)["auth"]; has {
		t.Fatal("a server without -auth advertised an auth section")
	}
	for _, p := range []string{"/api/session", "/api/ticket", "/api/auth/begin"} {
		resp, err := http.Post(f.srv.URL+p, "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 404 && resp.StatusCode != 405 {
			t.Fatalf("%s answered %d with auth off", p, resp.StatusCode)
		}
	}
	// A ticket nobody asked for is ignored, not refused.
	id, secret := f.createRoom("yt:abc")
	if _, _, err := f.dialHello(room.Hello{Room: id, Secret: secret, Name: "a", MediaKey: "yt:abc", Ticket: "junk"}); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightAllowsTheAuthorizationHeader(t *testing.T) {
	// `Access-Control-Allow-Headers: *` does not cover Authorization, so it has
	// to be named, or every authenticated call from a page fails as a bare
	// "Failed to fetch".
	for _, f := range []*fixture{start(t, nil), startAuth(t, auth.ScopeCreate)} {
		for _, p := range []string{"/api/rooms", "/healthz", "/api/ticket", "/api/session", "/api/auth/poll"} {
			req, _ := http.NewRequest("OPTIONS", f.srv.URL+p, nil)
			req.Header.Set("Origin", "https://www.youtube.com")
			req.Header.Set("Access-Control-Request-Method", "POST")
			req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode == 404 && strings.HasPrefix(p, "/api/") && p != "/api/rooms" {
				continue // auth off: the endpoint does not exist
			}
			allowed := strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers"))
			if resp.StatusCode != 204 || !strings.Contains(allowed, "authorization") {
				t.Fatalf("%s preflight: %d, Allow-Headers %q", p, resp.StatusCode, allowed)
			}
			if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
				t.Fatalf("%s: credentials allowed alongside a wildcard origin", p)
			}
		}
	}
}

func TestHealthzAdvertisesWhatToAskFor(t *testing.T) {
	f := startAuth(t, auth.ScopeAll)
	a, _ := healthz(t, f)["auth"].(map[string]any)
	if a == nil || a["scope"] != "all" || fmt.Sprint(a["methods"]) != "[token]" {
		t.Fatalf("healthz auth = %v", a)
	}
}

func TestRoomCreationNeedsAFreshTicket(t *testing.T) {
	f := startAuth(t, auth.ScopeCreate)
	code, body := f.post("/api/rooms", "", `{"mediaKey":"yt:abc"}`)
	if code != 401 || body["error"] != "auth_required" {
		t.Fatalf("no ticket: %d %v", code, body)
	}
	if fmt.Sprint(body["methods"]) != "[token]" {
		t.Fatalf("the refusal should name the methods: %v", body)
	}
	// The access key itself is not a ticket, nor is a device token.
	if code, _ := f.post("/api/rooms", "Bearer "+accessKey, `{"mediaKey":"yt:abc"}`); code != 401 {
		t.Fatalf("created with the raw key: %d", code)
	}
	tk := f.ticket()
	if code, body := f.createWith(tk); code != 201 || body["roomId"] == nil {
		t.Fatalf("with a ticket: %d %v", code, body)
	}
	if code, _ := f.createWith(tk); code != 401 {
		t.Fatalf("a ticket created a second room: %d", code)
	}
	if f.hub.Rooms() != 1 {
		t.Fatalf("rooms = %d", f.hub.Rooms())
	}
}

func TestScopeCreateLetsAnInviteLinkJoinWithoutAnAccount(t *testing.T) {
	f := startAuth(t, auth.ScopeCreate)
	_, body := f.createWith(f.ticket())
	id, secret := body["roomId"].(string), body["secret"].(string)
	if _, _, err := f.dial(id, secret, "friend", "yt:abc"); err != nil {
		t.Fatalf("an invited friend was refused: %v", err)
	}
}

func TestScopeAllRefusesAHelloWithoutATicketAsAuthNotAsTheRoom(t *testing.T) {
	f := startAuth(t, auth.ScopeAll)
	_, body := f.createWith(f.ticket())
	id, secret := body["roomId"].(string), body["secret"].(string)

	refusal := func(h room.Hello) string {
		t.Helper()
		c, first, err := f.dialHello(h)
		if err == nil {
			t.Fatalf("joined with %+v", h)
		}
		// And the socket is closed after it, as for any refusal.
		if _, err := c.read(); err == nil {
			t.Fatal("the socket stayed open after a refusal")
		}
		return fmt.Sprint(first["code"])
	}
	// The panel must be able to tell "sign in" from "check the room ID".
	if got := refusal(room.Hello{Room: id, Secret: secret, Name: "a", MediaKey: "yt:abc"}); got != "auth_required" {
		t.Fatalf("no ticket: %s", got)
	}
	if got := refusal(room.Hello{Room: id, Secret: secret, Name: "a", MediaKey: "yt:abc", Ticket: "forged"}); got != "auth_required" {
		t.Fatalf("forged ticket: %s", got)
	}
	// An authenticated peer learns nothing more about rooms than before.
	if got := refusal(room.Hello{Room: id, Secret: "wrong", Name: "a", MediaKey: "yt:abc", Ticket: f.ticket()}); got != "join_refused" {
		t.Fatalf("ticket, wrong secret: %s", got)
	}

	tk := f.ticket()
	if _, _, err := f.dialHello(room.Hello{Room: id, Secret: secret, Name: "a", MediaKey: "yt:abc", Ticket: tk}); err != nil {
		t.Fatalf("ticket and secret: %v", err)
	}
	if got := refusal(room.Hello{Room: id, Secret: secret, Name: "b", MediaKey: "yt:abc", Ticket: tk}); got != "auth_required" {
		t.Fatalf("a spent ticket: %s", got)
	}
}

func TestTheTicketIsCheckedBeforeTheRoom(t *testing.T) {
	// Otherwise an unauthenticated peer could still probe which room ids
	// exist, by the difference between auth_required and join_refused.
	f := startAuth(t, auth.ScopeAll)
	_, first, _ := f.dialHello(room.Hello{Room: "nope", Secret: "nope", Name: "a"})
	if first["code"] != "auth_required" {
		t.Fatalf("an unauthenticated peer learned about the room: %v", first)
	}
}

func TestOnlyAnExtensionMayAskTheProxyForADevice(t *testing.T) {
	// The proxy-sign-in marker is what keeps a page on a trusted network from
	// reading a device token (auth.DeviceHeader). A page can send it only if
	// the preflight admits it, so the preflight must not -- to a page.
	f := startAuth(t, auth.ScopeCreate)
	for origin, want := range map[string]bool{
		"https://evil.example":               false,
		"https://www.youtube.com":            false,
		"null":                               false,
		"chrome-extension://abcdefghijklmno": true,
		"moz-extension://0000-1111":          true,
	} {
		req, _ := http.NewRequest("OPTIONS", f.srv.URL+"/api/session", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", strings.ToLower(auth.DeviceHeader))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		allowed := strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), strings.ToLower(auth.DeviceHeader))
		if allowed != want {
			t.Errorf("%s: marker allowed = %v (Allow-Headers %q)", origin, allowed, resp.Header.Get("Access-Control-Allow-Headers"))
		}
	}
}

func TestAPageBehindATrustedProxyGetsNoDevice(t *testing.T) {
	// The reviewer's reproduction, end to end: -auth proxy, the test client is
	// the trusted proxy, and a page on another origin posts with no body.
	cfg := auth.DefaultConfig()
	cfg.Methods = []string{auth.MethodProxy}
	cfg.Scope = auth.ScopeCreate
	cfg.Key = auth.RandomKey()
	cfg.TrustedProxies, _ = auth.ParsePrefixes("127.0.0.1/32,::1/128")
	cfg.UserHeader = "Remote-User"
	a, err := auth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	h := New(DefaultConfig(), NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.PingInterval = time.Hour
	hcfg.Auth = a
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	post := func(marked bool) (int, string) {
		req, _ := http.NewRequest("POST", srv.URL+"/api/session", nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Remote-User", "alice")
		if marked {
			req.Header.Set(auth.DeviceHeader, "1")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]any
		json.NewDecoder(resp.Body).Decode(&body)
		tok, _ := body["token"].(string)
		return resp.StatusCode, tok
	}
	if code, tok := post(false); code == 200 || tok != "" {
		t.Fatalf("a simple cross-origin POST read a device token: %d", code)
	}
	if code, tok := post(true); code != 200 || tok == "" {
		t.Fatalf("the privileged side's marked POST was refused: %d", code)
	}
}
