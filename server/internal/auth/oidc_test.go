package auth

import (
	"crypto/sha256"
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

// fakeIdP is an OpenID provider in-process, over TLS, with no network. It
// checks what a real one checks on the token call -- client authentication,
// the redirect URI, the PKCE verifier -- so a relying party that skips any of
// them fails here, not in a user's browser.
type fakeIdP struct {
	t   *testing.T
	srv *httptest.Server

	mu    sync.Mutex
	codes map[string]grant
	// claims is applied to every ID token; a test edits it to lie.
	claims func(c map[string]any)
	// meta is applied to the discovery document.
	meta       func(m map[string]any)
	tokenCalls int
	// postOnly advertises client_secret_post and refuses Basic.
	postOnly bool
}

type grant struct {
	challenge, nonce, redirect string
}

const (
	clientID     = "videosync"
	clientSecret = "s3cret:with/colon"
)

func newIdP(t *testing.T) *fakeIdP {
	idp := &fakeIdP{t: t, codes: map[string]grant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		m := map[string]any{
			"issuer":                 idp.srv.URL,
			"authorization_endpoint": idp.srv.URL + "/authorize",
			"token_endpoint":         idp.srv.URL + "/token",
		}
		if idp.postOnly {
			m["token_endpoint_auth_methods_supported"] = []string{"client_secret_post"}
		}
		if idp.meta != nil {
			idp.meta(m)
		}
		json.NewEncoder(w).Encode(m)
	})
	mux.HandleFunc("POST /token", idp.token)
	idp.srv = httptest.NewTLSServer(mux)
	t.Cleanup(idp.srv.Close)
	return idp
}

func (idp *fakeIdP) fail(w http.ResponseWriter, code int, e string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": e})
}

func (idp *fakeIdP) token(w http.ResponseWriter, r *http.Request) {
	idp.mu.Lock()
	defer idp.mu.Unlock()
	idp.tokenCalls++
	r.ParseForm()
	id, secret, ok := r.BasicAuth()
	if idp.postOnly {
		if ok {
			idp.fail(w, 401, "invalid_client")
			return
		}
		id, secret = r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	} else {
		id, _ = url.QueryUnescape(id)
		secret, _ = url.QueryUnescape(secret)
	}
	if id != clientID || secret != clientSecret {
		idp.fail(w, 401, "invalid_client")
		return
	}
	g, found := idp.codes[r.PostForm.Get("code")]
	delete(idp.codes, r.PostForm.Get("code"))
	if !found || r.PostForm.Get("grant_type") != "authorization_code" {
		idp.fail(w, 400, "invalid_grant")
		return
	}
	if r.PostForm.Get("redirect_uri") != g.redirect {
		idp.fail(w, 400, "invalid_grant")
		return
	}
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
		idp.fail(w, 400, "invalid_grant")
		return
	}
	now := time.Unix(1_800_000_000, 0).Unix()
	c := map[string]any{
		"iss": idp.srv.URL, "sub": "user-1", "aud": clientID,
		"exp": now + 300, "iat": now, "nonce": g.nonce,
		"email": "Alice@Example.org", "email_verified": true, "groups": []string{"friends"},
	}
	if idp.claims != nil {
		idp.claims(c)
	}
	json.NewEncoder(w).Encode(map[string]any{
		"access_token": "at", "token_type": "Bearer", "id_token": jwt(map[string]any{"alg": "RS256"}, c),
	})
}

func jwt(hdr, claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return enc(hdr) + "." + enc(claims) + ".c2lnbmF0dXJl"
}

// authorize plays the IdP's login page: it reads the authorization request the
// relying party redirected to, and answers with a code.
func (idp *fakeIdP) authorize(t *testing.T, location string) (state, code string) {
	t.Helper()
	u, err := url.Parse(location)
	if err != nil || !strings.HasPrefix(location, idp.srv.URL+"/authorize?") {
		t.Fatalf("redirected to %q, not the IdP", location)
	}
	q := u.Query()
	for k, want := range map[string]string{
		"response_type": "code", "client_id": clientID, "code_challenge_method": "S256",
	} {
		if q.Get(k) != want {
			t.Fatalf("authorization request %s = %q, want %q", k, q.Get(k), want)
		}
	}
	for _, k := range []string{"state", "nonce", "code_challenge", "redirect_uri"} {
		if q.Get(k) == "" {
			t.Fatalf("authorization request has no %s", k)
		}
	}
	if !strings.Contains(" "+q.Get("scope")+" ", " openid ") {
		t.Fatalf("scope = %q", q.Get("scope"))
	}
	code = randomToken(8)
	idp.mu.Lock()
	idp.codes[code] = grant{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), redirect: q.Get("redirect_uri")}
	idp.mu.Unlock()
	return q.Get("state"), code
}

func oidcRig(t *testing.T, idp *fakeIdP, tune func(*Config)) *rig {
	return newRig(t, func(c *Config) {
		c.Methods = []string{MethodOIDC}
		c.Keys = nil
		c.PublicURL = "https://sync.example"
		c.OIDC = OIDCConfig{
			Issuer: idp.srv.URL, ClientID: clientID, ClientSecret: clientSecret,
			HTTPClient: idp.srv.Client(),
		}
		if tune != nil {
			tune(c)
		}
	})
}

// browser is one browser tab working through a login: it keeps the flow
// cookie and follows exactly the redirects a user would.
type browser struct {
	t      *testing.T
	g      *rig
	f      loginFlow
	cookie *http.Cookie
}

func (g *rig) startBrowser(t *testing.T) *browser {
	f := g.begin(client)
	page, cookie := g.openPage(f, client, nil)
	if page.code != 200 || !strings.Contains(page.raw, "/auth/oidc/start?flow=") {
		t.Fatalf("login page: %d\n%s", page.code, page.raw)
	}
	return &browser{t: t, g: g, f: f, cookie: cookie}
}

func (b *browser) get(path string, withCookie bool) reply {
	hdr := map[string]string{}
	if withCookie && b.cookie != nil {
		hdr["Cookie"] = b.cookie.Name + "=" + b.cookie.Value
	}
	return b.g.do("GET", path, client, "", hdr)
}

// toIdP presses the login button and returns where it redirected.
func (b *browser) toIdP() string {
	b.t.Helper()
	r := b.get("/auth/oidc/start?flow="+flowID(b.t, b.f.LoginURL), true)
	if r.code != http.StatusFound {
		b.t.Fatalf("start: %d %s", r.code, r.raw)
	}
	return r.hdr.Get("Location")
}

func (b *browser) callback(state, code string) reply {
	return b.get("/auth/oidc/callback?"+url.Values{"state": {state}, "code": {code}}.Encode(), true)
}

func TestAnOIDCLoginEndsWithADeviceTokenForThePoller(t *testing.T) {
	for _, postOnly := range []bool{false, true} {
		idp := newIdP(t)
		idp.postOnly = postOnly
		g := oidcRig(t, idp, nil)
		b := g.startBrowser(t)
		loc := b.toIdP()
		if q, _ := url.Parse(loc); q.Query().Get("redirect_uri") != "https://sync.example/auth/oidc/callback" {
			t.Fatalf("redirect_uri = %q: it must be exactly the registered one", q.Query().Get("redirect_uri"))
		}
		state, code := idp.authorize(t, loc)
		r := b.callback(state, code)
		if r.code != 200 {
			t.Fatalf("postOnly=%v: callback %d\n%s", postOnly, r.code, r.raw)
		}
		p := g.poll(b.f.PollID)
		// No preferred_username in the token, so the device is named by email.
		if p.code != 200 || p.body["token"] == nil || p.body["sub"] != "Alice@Example.org" {
			t.Fatalf("poll: %d %s", p.code, p.raw)
		}
		if tr := g.ticket(p.body["token"].(string)); tr.code != 200 {
			t.Fatalf("an OIDC device cannot buy a ticket: %d", tr.code)
		}
		// Replaying the callback from history does nothing.
		if again := b.callback(state, code); again.code == 200 {
			t.Fatal("a spent state completed a login again")
		}
	}
}

func TestTheCallbackBelongsToTheBrowserThatStartedIt(t *testing.T) {
	idp := newIdP(t)
	g := oidcRig(t, idp, nil)
	b := g.startBrowser(t)
	state, code := idp.authorize(t, b.toIdP())
	// Login CSRF: the callback arrives in a browser without this flow's cookie.
	if r := b.get("/auth/oidc/callback?"+url.Values{"state": {state}, "code": {code}}.Encode(), false); r.code == 200 {
		t.Fatal("a callback without the flow cookie was accepted")
	}
	if p := g.poll(b.f.PollID); p.body["token"] != nil {
		t.Fatal("a token came out of it")
	}
	// Nor can a forwarded link skip the page and go straight to the IdP.
	c := g.startBrowser(t)
	if r := c.get("/auth/oidc/start?flow="+flowID(t, c.f.LoginURL), false); r.code == http.StatusFound {
		t.Fatal("started an IdP round trip for a browser that never opened the page")
	}
}

// login runs one complete login against an IdP that has been told to lie in
// some way, and returns what the poller saw.
func loginWith(t *testing.T, idp *fakeIdP, tune func(*Config)) reply {
	t.Helper()
	g := oidcRig(t, idp, tune)
	b := g.startBrowser(t)
	state, code := idp.authorize(t, b.toIdP())
	cb := b.callback(state, code)
	p := g.poll(b.f.PollID)
	if cb.code == 200 && p.code != 200 {
		t.Fatalf("callback said done, poll said %d", p.code)
	}
	return p
}

func TestIDTokenClaimsAreChecked(t *testing.T) {
	now := time.Unix(1_800_000_000, 0).Unix()
	for name, lie := range map[string]func(c map[string]any){
		"another issuer":        func(c map[string]any) { c["iss"] = "https://evil.example" },
		"another audience":      func(c map[string]any) { c["aud"] = "someone-else" },
		"shared audience":       func(c map[string]any) { c["aud"] = []string{clientID, "other"} },
		"azp for someone else":  func(c map[string]any) { c["aud"] = []string{clientID, "other"}; c["azp"] = "other" },
		"expired":               func(c map[string]any) { c["exp"] = now - 120 },
		"issued long ago":       func(c map[string]any) { c["iat"] = now - 3600 },
		"issued in the future":  func(c map[string]any) { c["iat"] = now + 3600 },
		"another login's nonce": func(c map[string]any) { c["nonce"] = "replayed" },
		"no nonce":              func(c map[string]any) { delete(c, "nonce") },
		"no subject":            func(c map[string]any) { c["sub"] = "" },
	} {
		idp := newIdP(t)
		idp.claims = lie
		if p := loginWith(t, idp, nil); p.body["token"] != nil || p.code != 403 {
			t.Errorf("%s: poll %d %s", name, p.code, p.raw)
		}
	}
	// Control: the same rig with an honest token logs in, and an audience list
	// is fine when azp names us.
	honest := newIdP(t)
	honest.claims = func(c map[string]any) { c["aud"] = []string{clientID, "other"}; c["azp"] = clientID }
	if p := loginWith(t, honest, nil); p.body["token"] == nil {
		t.Fatalf("control: %d %s", p.code, p.raw)
	}
}

func TestAnUnsignedIDTokenIsRefused(t *testing.T) {
	c := map[string]any{"iss": "https://idp", "sub": "x", "aud": clientID, "exp": 2e9, "iat": 1.8e9, "nonce": "n"}
	rp := &relyingParty{cfg: OIDCConfig{ClientID: clientID}}
	now := time.Unix(1_800_000_000, 0)
	if _, err := rp.checkIDToken(jwt(map[string]any{"alg": "none"}, c), "n", "https://idp", now); err == nil {
		t.Fatal("alg none accepted")
	}
	if _, err := rp.checkIDToken(jwt(map[string]any{"alg": "ES256"}, c), "n", "https://idp", now); err != nil {
		t.Fatalf("control: %v", err)
	}
}

func TestTheAllowlistDecidesWhoMayLogIn(t *testing.T) {
	for _, tc := range []struct {
		allow []string
		lie   func(c map[string]any)
		ok    bool
	}{
		{allow: []string{"email:alice@example.org"}, ok: true},
		{allow: []string{"alice@example.org"}, ok: true},
		{allow: []string{"sub:user-1"}, ok: true},
		{allow: []string{"group:friends"}, ok: true},
		{allow: []string{"group:admins", "sub:user-2"}, ok: false},
		// An address the IdP says it has not verified is anyone's to type.
		{allow: []string{"email:alice@example.org"}, lie: func(c map[string]any) { c["email_verified"] = false }, ok: false},
	} {
		idp := newIdP(t)
		idp.claims = tc.lie
		p := loginWith(t, idp, func(c *Config) { c.OIDC.Allow = tc.allow })
		if got := p.body["token"] != nil; got != tc.ok {
			t.Errorf("allow %v: logged in = %v, want %v (%d %s)", tc.allow, got, tc.ok, p.code, p.raw)
		}
		if !tc.ok && p.body["error"] != "login_denied" {
			t.Errorf("allow %v: a refused login should say so to the poller, got %v", tc.allow, p.body)
		}
	}
}

func TestGroupsAreAskedForOnlyWhenTheAllowlistNeedsThem(t *testing.T) {
	for allow, want := range map[string]bool{"group:friends": true, "sub:x": false} {
		idp := newIdP(t)
		g := oidcRig(t, idp, func(c *Config) { c.OIDC.Allow = []string{allow} })
		u, _ := url.Parse(g.startBrowser(t).toIdP())
		if got := strings.Contains(u.Query().Get("scope"), "groups"); got != want {
			t.Errorf("allow %s: scope %q", allow, u.Query().Get("scope"))
		}
	}
}

func TestAnIdPErrorIsReportedToThePoller(t *testing.T) {
	idp := newIdP(t)
	g := oidcRig(t, idp, nil)
	b := g.startBrowser(t)
	state, _ := idp.authorize(t, b.toIdP())
	r := b.get("/auth/oidc/callback?"+url.Values{"state": {state}, "error": {"access_denied"}}.Encode(), true)
	if r.code == 200 {
		t.Fatal("an IdP refusal rendered as success")
	}
	if p := g.poll(b.f.PollID); p.code != 403 || !strings.Contains(p.raw, "access_denied") {
		t.Fatalf("poll: %d %s", p.code, p.raw)
	}
	if idp.tokenCalls != 0 {
		t.Fatal("called the token endpoint for a refused login")
	}
}

func TestDiscoveryIsCheckedBeforeAnyoneIsSentAnywhere(t *testing.T) {
	for name, lie := range map[string]func(m map[string]any){
		"another issuer":   func(m map[string]any) { m["issuer"] = "https://evil.example" },
		"plaintext tokens": func(m map[string]any) { m["token_endpoint"] = "http://idp.example/token" },
		"plaintext login":  func(m map[string]any) { m["authorization_endpoint"] = "http://idp.example/authorize" },
	} {
		idp := newIdP(t)
		idp.meta = lie
		g := oidcRig(t, idp, nil)
		b := g.startBrowser(t)
		r := b.get("/auth/oidc/start?flow="+flowID(t, b.f.LoginURL), true)
		if r.code == http.StatusFound {
			t.Errorf("%s: redirected to %s", name, r.hdr.Get("Location"))
		}
	}
}

func TestAnIssuerWithATrailingSlashIsComparedExactly(t *testing.T) {
	idp := newIdP(t)
	// The document names the issuer with a slash; the operator configured it
	// without. Discovery §4.3 says those are different issuers.
	idp.meta = func(m map[string]any) { m["issuer"] = idp.srv.URL + "/" }
	g := oidcRig(t, idp, nil)
	b := g.startBrowser(t)
	if r := b.get("/auth/oidc/start?flow="+flowID(t, b.f.LoginURL), true); r.code == http.StatusFound {
		t.Fatal("accepted a discovery document for a different issuer string")
	}
}
