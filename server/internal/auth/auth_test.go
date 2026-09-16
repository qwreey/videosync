package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- harness ----------------------------------------------------------------

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type rig struct {
	t     *testing.T
	s     *Server
	mux   *http.ServeMux
	clock *clock
}

const testKey = "an-access-key-that-is-long-enough"

func testUsers(t *testing.T) map[string]PasswordHash {
	t.Helper()
	h, err := HashPassword("hunter22", minIterations)
	if err != nil {
		t.Fatal(err)
	}
	u, err := ParseUsers(strings.NewReader("alice:" + h + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func newRig(t *testing.T, tune func(*Config)) *rig {
	t.Helper()
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	keys, _, err := ParseKeys(strings.NewReader(testKey))
	if err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.Methods = []string{MethodToken}
	cfg.Keys = keys
	cfg.Key = []byte(strings.Repeat("k", 32))
	cfg.Now = c.now
	if tune != nil {
		tune(&cfg)
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux, func(h http.HandlerFunc) http.HandlerFunc { return h })
	return &rig{t: t, s: s, mux: mux, clock: c}
}

type reply struct {
	code int
	hdr  http.Header
	body map[string]any
	raw  string
}

// do runs one request from `peer`. Every request comes from somewhere: the
// proxy tests are about nothing else.
func (g *rig) do(method, path, peer string, body string, hdr map[string]string) reply {
	g.t.Helper()
	req := httptest.NewRequest(method, "http://sync.example"+path, strings.NewReader(body))
	req.RemoteAddr = peer
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.mux.ServeHTTP(rec, req)
	out := reply{code: rec.Code, hdr: rec.Header(), raw: rec.Body.String()}
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		json.Unmarshal(rec.Body.Bytes(), &out.body)
	}
	return out
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

const client = "198.51.100.7:40000"

func (g *rig) session(hdr map[string]string) reply {
	return g.do("POST", "/api/session", client, "", hdr)
}

func (g *rig) deviceToken() string {
	g.t.Helper()
	r := g.session(map[string]string{"Authorization": "Bearer " + testKey})
	if r.code != 200 {
		g.t.Fatalf("session: %d %s", r.code, r.raw)
	}
	return r.body["token"].(string)
}

func (g *rig) ticket(token string) reply {
	return g.do("POST", "/api/ticket", client, "", map[string]string{"Authorization": "Bearer " + token})
}

// --- configuration ------------------------------------------------------------

func TestMethodsAreParsedStrictly(t *testing.T) {
	for in, want := range map[string]string{"": "", "none": "", "token, password": "token,password", "OIDC,oidc": "oidc"} {
		got, err := ParseMethods(in)
		if err != nil || strings.Join(got, ",") != want {
			t.Errorf("ParseMethods(%q) = %v, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"none,token", "basic", "token,ldap"} {
		if _, err := ParseMethods(bad); err == nil {
			t.Errorf("ParseMethods(%q) accepted", bad)
		}
	}
}

func TestAMethodWithoutItsSettingsRefusesToStart(t *testing.T) {
	// Starting anyway would be a server that refuses everyone, or -- for the
	// proxy -- one that believes a header from anybody.
	base := Config{Key: []byte(strings.Repeat("k", 32))}
	for name, cfg := range map[string]Config{
		"token":    {Methods: []string{MethodToken}},
		"password": {Methods: []string{MethodPassword}},
		"proxy":    {Methods: []string{MethodProxy}},
		"oidc no public url": {Methods: []string{MethodOIDC},
			OIDC: OIDCConfig{Issuer: "https://idp", ClientID: "c", ClientSecret: "s"}},
		"oidc over http": {Methods: []string{MethodOIDC}, PublicURL: "https://sync.example",
			OIDC: OIDCConfig{Issuer: "http://idp", ClientID: "c", ClientSecret: "s"}},
		"short key": {Methods: []string{MethodToken}, Keys: [][32]byte{{1}}, Key: []byte("short")},
	} {
		if cfg.Key == nil {
			cfg.Key = base.Key
		}
		if _, err := New(cfg); err == nil {
			t.Errorf("%s: started", name)
		}
	}
}

// --- device tokens and tickets --------------------------------------------------

func TestADeviceTokenIsBoundToItsKeyAndItsLifetime(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).UnixMilli()
	s := signer{key: []byte(strings.Repeat("a", 32))}
	tok := s.sign(deviceClaims{Sub: "alice", Via: MethodPassword, Iat: now, Exp: now + 1000})
	if c, err := s.verify(tok, now+999); err != nil || c.Sub != "alice" || c.Via != MethodPassword {
		t.Fatalf("own token refused: %v %+v", err, c)
	}
	if _, err := s.verify(tok, now+1000); err == nil {
		t.Fatal("accepted at its expiry")
	}
	// Rotating the key file is the documented way to revoke every device.
	other := signer{key: []byte(strings.Repeat("b", 32))}
	if _, err := other.verify(tok, now); err == nil {
		t.Fatal("a rotated key still accepts old tokens")
	}
	// Changing a single claim without the key.
	body, sig, _ := strings.Cut(tok, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(body)
	forged := strings.Replace(string(raw), `"alice"`, `"mallory"`, 1)
	if _, err := s.verify(base64.RawURLEncoding.EncodeToString([]byte(forged))+"."+sig, now); err == nil {
		t.Fatal("accepted an edited payload")
	}
	for _, junk := range []string{"", ".", "abc", tok + "x", "x." + sig} {
		if _, err := s.verify(junk, now); err == nil {
			t.Fatalf("accepted %q", junk)
		}
	}
}

func TestATicketWorksOnceAndNotAfterItsMinute(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ts := newTickets(60*time.Second, 10)
	a, _, _ := ts.issue(now)
	if !ts.consume(a, now) {
		t.Fatal("fresh ticket refused")
	}
	if ts.consume(a, now) {
		t.Fatal("a ticket was accepted twice")
	}
	b, _, _ := ts.issue(now)
	if ts.consume(b, now.Add(60*time.Second)) {
		t.Fatal("accepted at its expiry")
	}
	if ts.consume("", now) || ts.consume("never-issued", now) {
		t.Fatal("accepted a ticket that was never issued")
	}
}

func TestTheTicketTableIsBounded(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ts := newTickets(60*time.Second, 3)
	for range 3 {
		if _, _, err := ts.issue(now); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := ts.issue(now); err == nil {
		t.Fatal("grew past its bound")
	}
	// Once they have expired they make room again.
	if _, _, err := ts.issue(now.Add(61 * time.Second)); err != nil {
		t.Fatalf("expired tickets were never swept: %v", err)
	}
}

// --- keys and passwords ---------------------------------------------------------

func TestKeysMayBeStoredHashed(t *testing.T) {
	keys, weak, err := ParseKeys(strings.NewReader(
		"# friends\n\nplain-key-number-one\nsha256:" +
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\nshort\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !matchKey(keys, "plain-key-number-one") || !matchKey(keys, "hello") || !matchKey(keys, "short") {
		t.Fatal("a listed key was refused")
	}
	if matchKey(keys, "") || matchKey(keys, "plain-key-number-two") {
		t.Fatal("an unlisted key was accepted")
	}
	if len(weak) != 1 || weak[0] != 5 {
		t.Fatalf("weak = %v, want the short plaintext key on line 5", weak)
	}
	if _, _, err := ParseKeys(strings.NewReader("sha256:abc\n")); err == nil {
		t.Fatal("accepted a truncated hash")
	}
	if _, _, err := ParseKeys(strings.NewReader("# nothing\n")); err == nil {
		t.Fatal("accepted a file with no keys")
	}
}

func TestPasswordHashesRoundTripAndHtpasswdIsNamed(t *testing.T) {
	line, err := HashPassword("correct horse", minIterations)
	if err != nil {
		t.Fatal(err)
	}
	h, err := parseHash(line)
	if err != nil {
		t.Fatal(err)
	}
	if !h.check("correct horse") || h.check("correct horse ") || h.check("") {
		t.Fatal("hash does not check what it hashed")
	}
	again, _ := HashPassword("correct horse", minIterations)
	if again == line {
		t.Fatal("two hashes of one password are equal: no salt")
	}
	_, err = ParseUsers(strings.NewReader("bob:$2y$05$abcdefghijklmnopqrstuv\n"))
	if err == nil || !strings.Contains(err.Error(), "hash-password") {
		t.Fatalf("a bcrypt line should be refused with the way out, got %v", err)
	}
	if _, err := HashPassword("x", 1); err == nil {
		t.Fatal("accepted a trivial iteration count")
	}
}

// --- peers ------------------------------------------------------------------------

func req(peer string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest("POST", "http://sync.example/api/session", nil)
	r.RemoteAddr = peer
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestForwardedHeadersAreBelievedOnlyFromATrustedProxy(t *testing.T) {
	trusted, err := ParsePrefixes("10.0.0.0/8, 127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	p := peers{trusted: trusted}
	spoof := map[string]string{"X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.9"}
	if got := p.client(req("198.51.100.7:1", spoof)); got != "198.51.100.7" {
		t.Fatalf("an untrusted peer chose its own bucket: %s", got)
	}
	if p.fromTrustedProxy(req("198.51.100.7:1", spoof)) {
		t.Fatal("an untrusted peer counted as the proxy")
	}
	// Behind the proxy: the rightmost hop that is not a proxy is the client;
	// whatever the client wrote further left is ignored.
	chain := map[string]string{"X-Forwarded-For": "6.6.6.6, 203.0.113.9, 10.1.2.3"}
	if got := p.client(req("127.0.0.1:1", chain)); got != "203.0.113.9" {
		t.Fatalf("client behind proxy = %s", got)
	}
	if got := p.client(req("127.0.0.1:1", map[string]string{"X-Real-IP": "203.0.113.10"})); got != "203.0.113.10" {
		t.Fatalf("X-Real-IP behind proxy = %s", got)
	}
	if got := p.client(req("[::ffff:127.0.0.1]:1", nil)); got != "127.0.0.1" {
		t.Fatalf("a v4-mapped proxy address was not recognised: %s", got)
	}
	if _, err := ParsePrefixes("10.0.0.0/8,not-an-ip"); err == nil {
		t.Fatal("accepted garbage")
	}
}

func TestTheLimiterAllowsABurstThenPaces(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	l := newLimiter(1, 3)
	for i := range 3 {
		if ok, _ := l.allow("a", now); !ok {
			t.Fatalf("burst refused at %d", i)
		}
	}
	ok, wait := l.allow("a", now)
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("past the burst: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.allow("b", now); !ok {
		t.Fatal("one peer's use spent another's bucket")
	}
	if ok, _ := l.allow("a", now.Add(time.Second)); !ok {
		t.Fatal("did not refill")
	}
}

// --- the HTTP surface ----------------------------------------------------------------

func TestAnAccessKeyBuysADeviceTokenAndTheTokenBuysTickets(t *testing.T) {
	g := newRig(t, nil)
	for _, h := range []string{"Bearer " + testKey, basic("", testKey), basic("anyone", testKey)} {
		r := g.session(map[string]string{"Authorization": h})
		if r.code != 200 || r.body["token"] == "" || r.body["expiresMs"] == nil {
			t.Fatalf("%s: %d %s", h, r.code, r.raw)
		}
	}
	tr := g.ticket(g.deviceToken())
	if tr.code != 200 || tr.body["ticket"] == nil {
		t.Fatalf("ticket: %d %s", tr.code, tr.raw)
	}
	if !g.s.ConsumeTicket(tr.body["ticket"].(string)) {
		t.Fatal("an issued ticket was not accepted")
	}
	if exp := int64(tr.body["expiresMs"].(float64)); exp != g.clock.now().Add(60*time.Second).UnixMilli() {
		t.Fatalf("ticket expiresMs = %d", exp)
	}
}

func TestWrongCredentialsAreRefusedWithoutABrowserPrompt(t *testing.T) {
	g := newRig(t, nil)
	for _, h := range []string{"", "Bearer nope", basic("x", "nope"), "Basic !!!", "Digest x"} {
		r := g.session(map[string]string{"Authorization": h})
		if r.code != 401 || r.body["error"] != "auth_failed" {
			t.Fatalf("%q: %d %s", h, r.code, r.raw)
		}
		if w := r.hdr.Get("WWW-Authenticate"); strings.Contains(strings.ToLower(w), "basic") {
			t.Fatalf("a Basic challenge makes the browser draw its own dialog: %q", w)
		}
	}
}

func TestTheAccessKeyIsNotItselfATicketCredential(t *testing.T) {
	// A ticket is bought with a device token. Accepting the raw key there too
	// would put the long-lived secret on every connect.
	g := newRig(t, nil)
	r := g.ticket(testKey)
	if r.code != 401 || r.body["error"] != "auth_required" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	methods, _ := r.body["methods"].([]any)
	if len(methods) != 1 || methods[0] != MethodToken {
		t.Fatalf("a refusal should name the methods, got %v", r.body["methods"])
	}
}

func TestAPasswordIsCheckedAndOnlyForKnownUsers(t *testing.T) {
	g := newRig(t, func(c *Config) {
		c.Methods = []string{MethodPassword}
		c.Users = testUsers(t)
	})
	ok := g.session(map[string]string{"Authorization": basic("alice", "hunter22")})
	if ok.code != 200 || ok.body["sub"] != "alice" {
		t.Fatalf("%d %s", ok.code, ok.raw)
	}
	for _, h := range []string{basic("alice", "hunter2"), basic("bob", "hunter22"), "Bearer " + testKey} {
		// The key is not accepted either: token is not enabled here.
		if r := g.session(map[string]string{"Authorization": h}); r.code != 401 {
			t.Fatalf("%s: %d", h, r.code)
		}
	}
}

func TestADeviceFromADisabledMethodIsRefused(t *testing.T) {
	a := newRig(t, func(c *Config) { c.Methods = []string{MethodToken, MethodPassword}; c.Users = testUsers(t) })
	tok := a.deviceToken()
	// Same key, token login switched off.
	b := newRig(t, func(c *Config) { c.Methods = []string{MethodPassword}; c.Users = testUsers(t) })
	if r := b.ticket(tok); r.code != 401 {
		t.Fatalf("a token minted by a method that is now off still buys tickets: %d", r.code)
	}
	if r := a.ticket(tok); r.code != 200 {
		t.Fatalf("control: %d", r.code)
	}
}

func TestAnExpiredDeviceTokenIsRefused(t *testing.T) {
	g := newRig(t, func(c *Config) { c.TokenTTL = time.Hour })
	tok := g.deviceToken()
	g.clock.add(time.Hour)
	if r := g.ticket(tok); r.code != 401 {
		t.Fatalf("%d", r.code)
	}
}

func proxyRig(t *testing.T, header string) *rig {
	return newRig(t, func(c *Config) {
		c.Methods = []string{MethodProxy}
		c.Keys = nil
		c.TrustedProxies, _ = ParsePrefixes("10.0.0.2")
		c.UserHeader = header
	})
}

func TestAProxyIsTrustedByAddressNeverByHeader(t *testing.T) {
	g := proxyRig(t, "Remote-User")
	hdr := map[string]string{"Remote-User": "alice"}
	if r := g.do("POST", "/api/ticket", "10.0.0.2:5000", "", hdr); r.code != 200 {
		t.Fatalf("through the proxy: %d %s", r.code, r.raw)
	}
	if r := g.do("POST", "/api/ticket", client, "", hdr); r.code != 401 {
		t.Fatalf("a Remote-User header from anyone was believed: %d", r.code)
	}
	// The proxy passed the request but named nobody: not authenticated.
	if r := g.do("POST", "/api/ticket", "10.0.0.2:5000", "", nil); r.code != 401 {
		t.Fatalf("no user header: %d", r.code)
	}
	s := g.do("POST", "/api/session", "10.0.0.2:5000", "", hdr)
	if s.code != 200 || s.body["sub"] != "alice" {
		t.Fatalf("session through the proxy: %d %s", s.code, s.raw)
	}
	// And the device token it minted works from anywhere.
	if r := g.ticket(s.body["token"].(string)); r.code != 200 {
		t.Fatalf("proxy-minted device token: %d", r.code)
	}
}

func TestAProxyWithoutAUserHeaderVouchesByAddressAlone(t *testing.T) {
	g := proxyRig(t, "")
	if r := g.do("POST", "/api/ticket", "10.0.0.2:5000", "", nil); r.code != 200 {
		t.Fatalf("%d", r.code)
	}
	if r := g.do("POST", "/api/ticket", client, "", nil); r.code != 401 {
		t.Fatalf("%d", r.code)
	}
}

func TestPasswordGuessingIsRateLimitedPerClient(t *testing.T) {
	g := newRig(t, nil)
	bad := map[string]string{"Authorization": "Bearer wrong"}
	limited := 0
	for range 20 {
		if g.session(bad).code == 429 {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("twenty guesses in an instant were all answered")
	}
	r := g.session(bad)
	if r.code != 429 || r.body["retryMs"] == nil || r.hdr.Get("Retry-After") == "" {
		t.Fatalf("%d %v", r.code, r.body)
	}
	// Another client is not punished for it.
	if r := g.do("POST", "/api/session", "198.51.100.8:1", "", map[string]string{"Authorization": "Bearer " + testKey}); r.code != 200 {
		t.Fatalf("a different client was limited: %d", r.code)
	}
	// Nor is this one, forever.
	g.clock.add(time.Minute)
	if r := g.session(map[string]string{"Authorization": "Bearer " + testKey}); r.code != 200 {
		t.Fatalf("still limited after a minute: %d", r.code)
	}
}

func TestSpoofedForwardingDoesNotEscapeTheRateLimit(t *testing.T) {
	g := newRig(t, func(c *Config) { c.TrustedProxies, _ = ParsePrefixes("10.0.0.2") })
	limited := false
	for i := range 20 {
		hdr := map[string]string{"Authorization": "Bearer wrong", "X-Forwarded-For": "203.0.113." + string(rune('0'+i%10))}
		if g.do("POST", "/api/session", client, "", hdr).code == 429 {
			limited = true
		}
	}
	if !limited {
		t.Fatal("a fresh X-Forwarded-For per request bought a fresh bucket")
	}
}

// --- the browser login flow (proxy) -----------------------------------------------

type loginFlow struct {
	LoginURL, PollID, Code string
}

func (g *rig) begin(peer string) loginFlow {
	g.t.Helper()
	r := g.do("POST", "/api/auth/begin", peer, "", nil)
	if r.code != 200 {
		g.t.Fatalf("begin: %d %s", r.code, r.raw)
	}
	return loginFlow{r.body["loginUrl"].(string), r.body["pollId"].(string), r.body["code"].(string)}
}

func (g *rig) poll(id string) reply {
	b, _ := json.Marshal(map[string]string{"pollId": id})
	return g.do("POST", "/api/auth/poll", client, string(b), nil)
}

func flowID(t *testing.T, loginURL string) string {
	t.Helper()
	u, err := url.Parse(loginURL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("flow")
}

// openPage fetches the login page as a browser would and returns the flow
// cookie it set.
func (g *rig) openPage(f loginFlow, peer string, hdr map[string]string) (reply, *http.Cookie) {
	g.t.Helper()
	u, _ := url.Parse(f.LoginURL)
	r := g.do("GET", u.RequestURI(), peer, "", hdr)
	var jar *http.Cookie
	for _, c := range (&http.Response{Header: r.hdr}).Cookies() {
		jar = c
	}
	return r, jar
}

func TestAProxyLoginTabMintsADeviceForThePollerOnce(t *testing.T) {
	g := proxyRig(t, "Remote-User")
	f := g.begin(client)
	if !strings.HasPrefix(f.LoginURL, "http://sync.example/auth/login?flow=") {
		t.Fatalf("loginUrl = %s", f.LoginURL)
	}
	if strings.Contains(f.LoginURL, f.PollID) {
		t.Fatal("the poll id is the flow's bearer secret and must not be in a URL")
	}
	if r := g.poll(f.PollID); r.code != 200 || r.body["pending"] != true {
		t.Fatalf("poll before login: %d %s", r.code, r.raw)
	}

	proxy := "10.0.0.2:5000"
	who := map[string]string{"Remote-User": "alice"}
	page, cookie := g.openPage(f, proxy, who)
	if page.code != 200 || !strings.Contains(page.raw, f.Code) {
		t.Fatalf("the page must show the code the panel shows: %d", page.code)
	}
	if cookie == nil || cookie.Path != "/auth/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("flow cookie = %+v", cookie)
	}
	if page.hdr.Get("X-Frame-Options") != "DENY" {
		t.Fatal("a framed confirm button is a clickjack")
	}

	confirm := func(peer string, withCookie bool, extra map[string]string) reply {
		hdr := map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Remote-User": "alice"}
		if withCookie {
			hdr["Cookie"] = cookie.Name + "=" + cookie.Value
		}
		for k, v := range extra {
			hdr[k] = v
		}
		return g.do("POST", "/auth/login", peer, "flow="+flowID(t, f.LoginURL), hdr)
	}
	// A link someone forwarded: opened in another browser, no cookie.
	if r := confirm(proxy, false, nil); r.code == 200 {
		t.Fatal("confirmed from a browser that never opened this flow's page")
	}
	// A cross-site form post.
	if r := confirm(proxy, true, map[string]string{"Sec-Fetch-Site": "cross-site"}); r.code == 200 {
		t.Fatal("a cross-site POST confirmed the login")
	}
	// Straight to the server, around the proxy.
	if r := confirm(client, true, nil); r.code == 200 {
		t.Fatal("confirmed without the proxy")
	}
	if r := confirm(proxy, true, nil); r.code != 200 {
		t.Fatalf("confirm: %d %s", r.code, r.raw)
	}

	r := g.poll(f.PollID)
	if r.code != 200 || r.body["token"] == nil || r.body["sub"] != "alice" {
		t.Fatalf("poll after login: %d %s", r.code, r.raw)
	}
	if again := g.poll(f.PollID); again.code != 404 {
		t.Fatalf("a finished flow handed out a second token: %d", again.code)
	}
	if tr := g.ticket(r.body["token"].(string)); tr.code != 200 {
		t.Fatalf("the polled device token: %d", tr.code)
	}
}

func TestALoginFlowExpires(t *testing.T) {
	g := proxyRig(t, "")
	f := g.begin(client)
	g.clock.add(5 * time.Minute)
	if r := g.poll(f.PollID); r.code != 404 || r.body["error"] != "login_expired" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if page, _ := g.openPage(f, "10.0.0.2:1", nil); page.code != 404 {
		t.Fatalf("expired login page: %d", page.code)
	}
}

func TestBeginSaysSoWhenThereIsNoBrowserLogin(t *testing.T) {
	g := newRig(t, nil) // token only
	r := g.do("POST", "/api/auth/begin", client, "", nil)
	if r.code != 404 || r.body["error"] != "no_browser_login" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
}

func TestTheLoginURLFollowsThePublicURL(t *testing.T) {
	g := newRig(t, func(c *Config) {
		c.Methods = []string{MethodProxy}
		c.TrustedProxies, _ = ParsePrefixes("10.0.0.2")
		c.PublicURL = "https://sync.example.org/"
	})
	if f := g.begin(client); !strings.HasPrefix(f.LoginURL, "https://sync.example.org/auth/login?flow=") {
		t.Fatalf("loginUrl = %s", f.LoginURL)
	}
	// Behind a TLS-terminating proxy with no public URL, https comes from the
	// proxy's word -- and only from the proxy's.
	h := proxyRig(t, "")
	r := h.do("POST", "/api/auth/begin", "10.0.0.2:1", "", map[string]string{"X-Forwarded-Proto": "https"})
	if !strings.HasPrefix(r.body["loginUrl"].(string), "https://") {
		t.Fatalf("loginUrl = %v", r.body["loginUrl"])
	}
	r = h.do("POST", "/api/auth/begin", client, "", map[string]string{"X-Forwarded-Proto": "https"})
	if !strings.HasPrefix(r.body["loginUrl"].(string), "http://") {
		t.Fatalf("an untrusted X-Forwarded-Proto was believed: %v", r.body["loginUrl"])
	}
}

func TestInfoAdvertisesMethodsAndScope(t *testing.T) {
	g := newRig(t, func(c *Config) { c.Scope = ScopeAll })
	b, _ := json.Marshal(g.s.Info())
	if string(b) != `{"methods":["token"],"scope":"all"}` {
		t.Fatalf("info = %s", b)
	}
	if !g.s.TicketToJoin() {
		t.Fatal("scope all must gate joining")
	}
	if newRig(t, nil).s.TicketToJoin() {
		t.Fatal("scope create must not gate joining")
	}
}
