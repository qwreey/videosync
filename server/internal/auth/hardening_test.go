package auth

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// Protections the design and PROTOCOL §8 name that nothing else pins: each
// test here fails when its protection is taken out.

func TestEveryBrowserLoginEndpointIsRateLimitedPerClient(t *testing.T) {
	g := newRig(t, func(c *Config) {
		c.Methods = []string{MethodToken, MethodProxy}
		c.TrustedProxies, _ = ParsePrefixes("10.0.0.2")
	})
	tok := g.deviceToken()
	pollBody, _ := json.Marshal(map[string]string{"pollId": "nope"})
	for _, tc := range []struct {
		path, body string
		hdr        map[string]string
	}{
		{"/api/ticket", "", map[string]string{"Authorization": "Bearer " + tok}},
		{"/api/auth/begin", "", nil},
		{"/api/auth/poll", string(pollBody), nil},
	} {
		limited := 0
		for range 80 {
			if g.do("POST", tc.path, client, tc.body, tc.hdr).code == 429 {
				limited++
			}
		}
		if limited == 0 {
			t.Errorf("%s: eighty calls in an instant were all answered", tc.path)
		}
		// Per client: another one is served.
		if r := g.do("POST", tc.path, "198.51.100.99:1", tc.body, tc.hdr); r.code == 429 {
			t.Errorf("%s: a different client was limited", tc.path)
		}
	}
}

// median of a few runs, so one scheduler hiccup does not decide.
func timeIt(n int, f func()) time.Duration {
	var ds []time.Duration
	for range n {
		start := time.Now()
		f()
		ds = append(ds, time.Since(start))
	}
	slices.Sort(ds)
	return ds[len(ds)/2]
}

func TestAnUnknownUserCostsWhatAKnownOneDoes(t *testing.T) {
	const iter = 200_000
	h, err := HashPassword("hunter22", iter)
	if err != nil {
		t.Fatal(err)
	}
	users, err := ParseUsers(strings.NewReader("alice:" + h + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	g := newRig(t, func(c *Config) { c.Methods = []string{MethodPassword}; c.Keys = nil; c.Users = users })
	known := timeIt(5, func() { g.s.checkPassword(context.Background(), "alice", "wrong") })
	unknown := timeIt(5, func() { g.s.checkPassword(context.Background(), "mallory", "wrong") })
	// The same work, give or take the machine: a miss that skipped the hash
	// would be three orders of magnitude faster.
	if unknown < known/3 {
		t.Fatalf("an unknown user took %v, a known one %v: which names exist is readable from the clock", unknown, known)
	}
}

func TestPasswordChecksAreCappedInConcurrency(t *testing.T) {
	g := newRig(t, func(c *Config) { c.Methods = []string{MethodPassword}; c.Keys = nil; c.Users = testUsers(t) })
	if cap(g.s.kdf) < 1 || cap(g.s.kdf) > max(1, runtime.NumCPU()) {
		t.Fatalf("cap %d", cap(g.s.kdf))
	}
	// Take every slot; the next check must wait for one.
	for range cap(g.s.kdf) {
		g.s.kdf <- struct{}{}
	}
	done := make(chan bool)
	go func() {
		ok, _ := g.s.checkPassword(context.Background(), "alice", "hunter22")
		done <- ok
	}()
	select {
	case <-done:
		t.Fatal("a password check ran with every slot taken")
	case <-time.After(100 * time.Millisecond):
	}
	<-g.s.kdf
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("the check that waited gave the wrong answer")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a freed slot did not let the check run")
	}
}

func TestTheRelyingPartyFollowsNoRedirectWithTheSecret(t *testing.T) {
	idp := newIdP(t)
	idp.meta = func(m map[string]any) { m["token_endpoint"] = idp.srv.URL + "/moved" }
	g := oidcRig(t, idp, nil)
	b := g.startBrowser(t)
	state, code := idp.authorize(t, b.toIdP())
	if r := b.callback(state, code); r.code == 200 {
		t.Fatal("a login completed through a redirected token endpoint")
	}
	idp.mu.Lock()
	calls := idp.tokenCalls
	idp.mu.Unlock()
	if calls != 0 {
		t.Fatalf("the client secret followed a redirect to the token endpoint (%d calls)", calls)
	}
	if p := g.poll(b.f.PollID); p.body["token"] != nil {
		t.Fatal("a token came out of it")
	}
}

func TestTheFlowCookieIsSecureWheneverTheBrowserUsesHTTPS(t *testing.T) {
	for _, tc := range []struct {
		name      string
		publicURL string
		tls       bool
		want      bool
	}{
		{"plain http, no public url", "", false, false},
		{"TLS here", "", true, true},
		{"https public url behind a TLS-terminating proxy", "https://sync.example", false, true},
	} {
		g := newRig(t, func(c *Config) {
			c.Methods = []string{MethodToken, MethodProxy}
			c.TrustedProxies, _ = ParsePrefixes("10.0.0.2")
			c.PublicURL = tc.publicURL
		})
		f := g.begin(client)
		req := httptest.NewRequest("GET", "/auth/login?flow="+flowID(t, f.LoginURL), nil)
		req.RemoteAddr = client
		req.TLS = nil
		if tc.tls {
			req.TLS = &tls.ConnectionState{}
		}
		rec := httptest.NewRecorder()
		g.mux.ServeHTTP(rec, req)
		cs := (&http.Response{Header: rec.Header()}).Cookies()
		if len(cs) != 1 {
			t.Fatalf("%s: %d cookies", tc.name, len(cs))
		}
		if cs[0].Secure != tc.want {
			t.Errorf("%s: Secure = %v", tc.name, cs[0].Secure)
		}
	}
}

func TestADeviceTokenFromTheFutureIsRefused(t *testing.T) {
	s := signer{key: []byte(strings.Repeat("k", 32))}
	now := int64(1_800_000_000_000)
	ok := s.sign(deviceClaims{V: 1, Sub: "a", Via: MethodToken, Iat: now, Exp: now + 3_600_000})
	if _, err := s.verify(ok, now); err != nil {
		t.Fatalf("control: %v", err)
	}
	future := s.sign(deviceClaims{V: 1, Sub: "a", Via: MethodToken, Iat: now + time.Hour.Milliseconds(), Exp: now + 2*time.Hour.Milliseconds()})
	if _, err := s.verify(future, now); err == nil {
		t.Fatal("a token issued an hour from now was accepted")
	}
}

func TestTheLoginTableIsBounded(t *testing.T) {
	fs := newFlows(time.Minute, 3)
	now := time.Unix(1_800_000_000, 0)
	for range 3 {
		if _, _, err := fs.begin("", now); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := fs.begin("", now); err == nil {
		t.Fatal("a fourth login began in a table of three")
	}
	// Expired ones make room.
	if _, _, err := fs.begin("", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("expired logins still held the table: %v", err)
	}
	// And the endpoint says so instead of failing oddly.
	g := newRig(t, func(c *Config) {
		c.Methods = []string{MethodToken, MethodProxy}
		c.TrustedProxies, _ = ParsePrefixes("10.0.0.2")
	})
	g.s.flows = newFlows(time.Minute, 1)
	g.begin(client)
	// From somebody else: the first client's own second begin is its share.
	if r := g.do("POST", "/api/auth/begin", "198.51.100.99:1", "", nil); r.code != http.StatusServiceUnavailable || r.body["error"] != "busy" {
		t.Fatalf("a full table answered %d %v", r.code, r.body)
	}
}

// The table is bounded against a flood, not sized for one server's users: a
// thousand people signing in within a TTL, each from their own address, is a
// busy evening, not an attack, and the per-client share is what stops one
// client from holding it.
func TestTheLoginTableHoldsAPopulousServer(t *testing.T) {
	g := newRig(t, nil)
	for i := range 1500 {
		peer := fmt.Sprintf("198.51.%d.%d:1", 100+i/250, i%250+1)
		if r := g.do("POST", "/api/auth/begin", peer, "", nil); r.code != 200 {
			t.Fatalf("login %d of 1500 distinct clients answered %d %s", i+1, r.code, r.raw)
		}
	}
}

// An IPv6 host is routinely given a whole /64 and can source every request
// from a fresh address in it. Keyed by /128, each one was a fresh bucket: the
// guessing limit did nothing, and one host could fill the login table.
func TestAnIPv6ClientIsChargedPerSlash64(t *testing.T) {
	g := newRig(t, nil)
	limited := 0
	for i := range 50 {
		r := g.do("POST", "/api/session", fmt.Sprintf("[2001:db8:0:1::%x]:1", i+1), "",
			map[string]string{"Authorization": "Bearer wrong-key-" + fmt.Sprint(i)})
		if r.code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited == 0 {
		t.Error("fifty wrong keys from one /64 were all checked")
	}
	// Another /64 is somebody else.
	if r := g.do("POST", "/api/session", "[2001:db8:0:2::1]:1", "", map[string]string{"Authorization": "Bearer nope"}); r.code == http.StatusTooManyRequests {
		t.Error("a neighbouring /64 was limited")
	}
	// IPv4 stays per address.
	if r := g.do("POST", "/api/session", "198.51.100.8:1", "", map[string]string{"Authorization": "Bearer nope"}); r.code == http.StatusTooManyRequests {
		t.Error("an unrelated IPv4 client was limited")
	}

	// The same through a trusted proxy, which names the client in a header.
	trusted, _ := ParsePrefixes("10.0.0.2")
	p := peers{trusted: trusted}
	a := p.client(req("10.0.0.2:1", map[string]string{"X-Real-IP": "2001:db8:0:3::1"}))
	b := p.client(req("10.0.0.2:1", map[string]string{"X-Forwarded-For": "2001:db8:0:3::ffff"}))
	c := p.client(req("10.0.0.2:1", map[string]string{"X-Forwarded-For": "2001:db8:0:4::1"}))
	if a != b || a == c {
		t.Errorf("forwarded IPv6 clients: %q %q %q; want the first two equal and the third apart", a, b, c)
	}
}

// The login table is shared by everybody, and begin needs no credentials. One
// client -- even one pacing itself under the begin limit -- must not be able
// to hold every slot, or nobody else can start a login until its flows expire.
func TestOneClientCannotHoldTheWholeLoginTable(t *testing.T) {
	g := newRig(t, nil)
	g.s.flows = newFlows(5*time.Minute, 60)
	got := 0
	var refused *reply
	for range 60 {
		// Slow enough that the begin bucket never says no.
		g.clock.add(5 * time.Second)
		if r := g.do("POST", "/api/auth/begin", client, "", nil); r.code == 200 {
			got++
		} else if refused == nil {
			refused = &r
		}
	}
	if got >= 60 {
		t.Errorf("one client holds all %d login slots", got)
	}
	// Past its share it is told to wait, as it would be by the begin limit:
	// its first flow began at 5 s and lives 5 min, and the refusal came at
	// 5 s x (flowShare+1).
	if refused == nil {
		t.Fatal("no begin was refused")
	}
	wantMs := (5*time.Second + 5*time.Minute - 5*time.Second*time.Duration(flowShare+1)).Milliseconds()
	if refused.code != http.StatusTooManyRequests || refused.body["error"] != "rate_limited" ||
		refused.body["retryMs"] != float64(wantMs) || refused.hdr.Get("Retry-After") != fmt.Sprint(wantMs/1000) {
		t.Errorf("an over-share begin answered %d %v Retry-After=%q; want 429 rate_limited retryMs=%d Retry-After=%d",
			refused.code, refused.body, refused.hdr.Get("Retry-After"), wantMs, wantMs/1000)
	}
	if r := g.do("POST", "/api/auth/begin", "198.51.100.99:1", "", nil); r.code != 200 {
		t.Fatalf("another client could not begin a login: %d %s", r.code, r.raw)
	}
	// Its share comes back as its flows end.
	g.clock.add(5 * time.Minute)
	if r := g.do("POST", "/api/auth/begin", client, "", nil); r.code != 200 {
		t.Fatalf("expired flows still count against their client: %d %s", r.code, r.raw)
	}
}

// endless is a request body that never runs out, counting what was read.
type endless struct{ n int64 }

func (e *endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	e.n += int64(len(p))
	return len(p), nil
}

// POST /auth/login is unauthenticated, and CrossOriginProtection admits a
// request with no Origin or fetch metadata (curl). Parsing its form before
// anything else must not mean reading whatever it sends: multipart file parts
// past 32 MB go to $TMPDIR uncapped, and an urlencoded body is read to 10 MB.
func TestTheLoginFormReadsOnlyAFewKilobytes(t *testing.T) {
	g := newRig(t, nil)
	t.Setenv("TMPDIR", t.TempDir())
	const most = 64 << 10
	for name, tc := range map[string]struct {
		ctype, head string
		want        int
	}{
		// Too long to be one of the page's forms.
		"urlencoded": {"application/x-www-form-urlencoded", "method=token&flow=x&key=", http.StatusBadRequest},
		// Not one of the page's forms at all: refused before a byte is read.
		"multipart": {"multipart/form-data; boundary=B",
			"--B\r\nContent-Disposition: form-data; name=\"key\"; filename=\"k\"\r\n\r\n", http.StatusUnsupportedMediaType},
		"json": {"application/json", `{"key":"`, http.StatusUnsupportedMediaType},
		"none": {"", "method=token&flow=x&key=", http.StatusUnsupportedMediaType},
	} {
		body := &endless{}
		req := httptest.NewRequest("POST", "http://sync.example/auth/login",
			io.MultiReader(strings.NewReader(tc.head), io.LimitReader(body, 256<<20)))
		req.RemoteAddr = client
		req.Header.Set("Content-Type", tc.ctype)
		rec := httptest.NewRecorder()
		g.mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: an endless body answered %d, want %d", name, rec.Code, tc.want)
		}
		if body.n > most {
			t.Errorf("%s: read %d bytes of an unauthenticated body", name, body.n)
		}
		if req.MultipartForm != nil {
			req.MultipartForm.RemoveAll()
		}
	}

	// The cap is 8 KiB: a body just past it is refused as unreadable, and
	// the control -- a well-formed form of a few hundred bytes, whatever its
	// charset parameter -- is read and judged on what it says.
	for _, tc := range []struct {
		name, ctype string
		size        int
		want        int
	}{
		{"just over the cap", "application/x-www-form-urlencoded", 8<<10 + 1, http.StatusBadRequest},
		{"a real form", "application/x-www-form-urlencoded; charset=UTF-8", 300, http.StatusBadRequest},
	} {
		body := "method=nonsense&flow=x&pad=" + strings.Repeat("a", tc.size-len("method=nonsense&flow=x&pad="))
		r := g.do("POST", "/auth/login", client, body, map[string]string{"Content-Type": tc.ctype})
		if r.code != tc.want {
			t.Errorf("%s: answered %d, want %d", tc.name, r.code, tc.want)
		}
		// Only the oversized one fails before the form is read; the real
		// form gets as far as naming an unknown method.
		if read := strings.Contains(r.raw, "알 수 없는 로그인 방법이에요"); read != (tc.size <= 8<<10) {
			t.Errorf("%s: form read = %v", tc.name, read)
		}
	}
}

func passwordOnlyRig(t *testing.T) *rig {
	return newRig(t, func(c *Config) { c.Methods = []string{MethodPassword}; c.Keys = nil; c.Users = testUsers(t) })
}

// holdEveryKDFSlot takes the whole password-check pool until the test ends,
// which is what a queue of attacker-supplied checks looks like from behind.
func holdEveryKDFSlot(t *testing.T, s *Server) {
	t.Helper()
	for range cap(s.kdf) {
		s.kdf <- struct{}{}
	}
	t.Cleanup(func() {
		for range cap(s.kdf) {
			<-s.kdf
		}
	})
}

// startSession serves one Basic /api/session on ctx in the background.
func startSession(g *rig, ctx context.Context, peer string) <-chan int {
	req := httptest.NewRequest("POST", "http://sync.example/api/session", nil).WithContext(ctx)
	req.RemoteAddr = peer
	req.Header.Set("Authorization", basic("mallory", "y"))
	done := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		g.mux.ServeHTTP(rec, req)
		done <- rec.Code
	}()
	return done
}

// answered is the status within d, or -1 if there was none by then.
func answered(done <-chan int, d time.Duration) int {
	select {
	case c := <-done:
		return c
	case <-time.After(d):
		return -1
	}
}

// A handler outlives its client, so a check queued by a request that has
// since gone away used to wait for a slot and then run the whole hash anyway:
// a /48 could queue hours of PBKDF2 ahead of every real sign-in and leave.
func TestAQueuedPasswordCheckGivesUpWhenItsRequestDoes(t *testing.T) {
	g := passwordOnlyRig(t)
	holdEveryKDFSlot(t, g.s)
	ctx, cancel := context.WithCancel(context.Background())
	done := startSession(g, ctx, "198.51.100.10:1")
	if c := answered(done, 50*time.Millisecond); c != -1 {
		t.Fatalf("answered %d with every slot taken", c)
	}
	cancel()
	// The slots are still held: answering at all means it never took one.
	if c := answered(done, 2*time.Second); c == -1 {
		t.Fatal("a cancelled request is still queued for a password check")
	}
}

// The same over a real connection. net/http cancels a request's context when
// its client hangs up only once the handler has read the body to its end, so
// a /api/session that declared a body and left it unread stayed queued for
// the whole wait and then hashed for nobody.
func TestAPasswordCheckGivesUpWhenItsClientHangsUp(t *testing.T) {
	g := passwordOnlyRig(t)
	g.s.kdfWait = time.Minute
	holdEveryKDFSlot(t, g.s)
	srv := httptest.NewServer(g.mux)
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "POST /api/session HTTP/1.1\r\nHost: sync.example\r\nAuthorization: %s\r\n"+
		"Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}", basic("mallory", "y"))
	waitFor := func(n int64) bool {
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
			if g.s.kdfQueued.Load() == n {
				return true
			}
		}
		return false
	}
	if !waitFor(1) {
		t.Fatalf("the check never queued (%d waiting)", g.s.kdfQueued.Load())
	}
	conn.Close()
	if !waitFor(0) {
		t.Fatal("a check whose client hung up is still queued")
	}

	// A body that never arrives is never queued at all.
	conn, err = net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "POST /api/session HTTP/1.1\r\nHost: sync.example\r\nAuthorization: %s\r\n"+
		"Content-Length: 5\r\n\r\n", basic("mallory", "y"))
	time.Sleep(50 * time.Millisecond)
	if n := g.s.kdfQueued.Load(); n != 0 {
		t.Fatalf("a request still sending its body queued a check (%d waiting)", n)
	}
	conn.Close()
}

func TestAPasswordCheckWaitsForASlotOnlySoLong(t *testing.T) {
	g := passwordOnlyRig(t)
	g.s.kdfWait = 50 * time.Millisecond
	holdEveryKDFSlot(t, g.s)
	if c := answered(startSession(g, context.Background(), "198.51.100.10:1"), 2*time.Second); c != http.StatusServiceUnavailable {
		t.Fatalf("a check behind a full pool answered %d, want 503 once its wait ran out", c)
	}

	// The login tab too: it is the same queue.
	g2 := passwordOnlyRig(t)
	g2.s.kdfWait = 50 * time.Millisecond
	f := g2.begin(client)
	_, cookie := g2.openPage(f, client, nil)
	holdEveryKDFSlot(t, g2.s)
	done := make(chan reply, 1)
	go func() {
		done <- g2.submit(f, cookie, url.Values{"method": {"password"}, "user": {"alice"}, "password": {"hunter22"}}, nil)
	}()
	select {
	case r := <-done:
		if r.code != http.StatusServiceUnavailable {
			t.Fatalf("login tab behind a full pool: %d", r.code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the login tab queued without bound")
	}
	// And once the pool frees, the same browser signs in: busy is not a denial.
	for range cap(g2.s.kdf) {
		<-g2.s.kdf
	}
	r := g2.submit(f, cookie, url.Values{"method": {"password"}, "user": {"alice"}, "password": {"hunter22"}}, nil)
	for range cap(g2.s.kdf) {
		g2.s.kdf <- struct{}{}
	}
	if r.code != 200 {
		t.Fatalf("after the pool freed: %d", r.code)
	}
}

func TestThePasswordQueueIsBounded(t *testing.T) {
	g := passwordOnlyRig(t)
	g.s.kdfWait = time.Minute
	holdEveryKDFSlot(t, g.s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Fill the queue, each waiter from its own /64 as a /48 would.
	for i := range g.s.kdfQueueMax {
		startSession(g, ctx, fmt.Sprintf("[2001:db8:0:%x::1]:1", i))
	}
	deadline := time.Now().Add(2 * time.Second)
	for g.s.kdfQueued.Load() < int64(g.s.kdfQueueMax) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if c := answered(startSession(g, context.Background(), "198.51.100.10:1"), 2*time.Second); c != http.StatusServiceUnavailable {
		t.Fatalf("a check past a full queue answered %d, want 503 at once", c)
	}
}
