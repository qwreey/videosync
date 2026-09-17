// Package auth is the server-access layer of D6 (docs/design/auth.md): who may
// use this server at all. It is opt-in, and it is a separate question from who
// may be in a room, which stays the room id + rotatable secret (D4).
//
// Several authenticators can be enabled together; any one succeeding is
// enough. Whatever authenticated, the server hands out its OWN credentials: a
// stateless device token the client keeps, and a single-use ticket per
// connection or room creation. Passwords, access keys and IdP tokens never
// leave the request they arrive in.
//
// Standard library only (D2).
package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"time"
)

// Scope is what a ticket is required for.
type Scope string

const (
	// ScopeCreate gates room creation only. A friend with an invite link still
	// joins without an account: the room secret is their credential.
	ScopeCreate Scope = "create"
	// ScopeAll also requires a ticket in `hello`.
	ScopeAll Scope = "all"
)

const (
	MethodToken    = "token"
	MethodPassword = "password"
	MethodProxy    = "proxy"
	MethodOIDC     = "oidc"
)

var knownMethods = []string{MethodToken, MethodPassword, MethodProxy, MethodOIDC}

// clockSkew is how far apart two honest clocks are allowed to be: ours and an
// IdP's, or ours now and ours when a token was minted.
const clockSkew = 60 * time.Second

// ParseMethods reads `-auth`. Empty and `none` both mean off, and `none` may
// not be combined with anything: "none,token" is a typo, not a policy.
func ParseMethods(s string) ([]string, error) {
	var out []string
	sawNone := false
	for _, m := range strings.Split(s, ",") {
		m = strings.ToLower(strings.TrimSpace(m))
		switch {
		case m == "":
		case m == "none":
			sawNone = true
		case slices.Contains(knownMethods, m):
			if !slices.Contains(out, m) {
				out = append(out, m)
			}
		default:
			return nil, fmt.Errorf("unknown -auth method %q (want none, %s)", m, strings.Join(knownMethods, ", "))
		}
	}
	if sawNone && len(out) > 0 {
		return nil, errors.New("-auth none cannot be combined with other methods")
	}
	return out, nil
}

// ParseScope reads `-auth-scope`.
func ParseScope(s string) (Scope, error) {
	switch Scope(s) {
	case "", ScopeCreate:
		return ScopeCreate, nil
	case ScopeAll:
		return ScopeAll, nil
	}
	return "", fmt.Errorf("unknown -auth-scope %q (want create or all)", s)
}

type Config struct {
	// Methods is what ParseMethods returned. Empty means New is not called.
	Methods []string
	Scope   Scope

	// Keys is `-auth-tokens-file`, for MethodToken.
	Keys [][32]byte
	// Users is `-auth-users-file`, for MethodPassword.
	Users map[string]PasswordHash
	// TrustedProxies decides MethodProxy, and whose address a rate limit is
	// charged to. It is meaningful without MethodProxy for the second reason.
	TrustedProxies []netip.Prefix
	// UserHeader, when set, is the header a trusted proxy names the user in; a
	// request through the proxy without it is not authenticated.
	UserHeader string

	// Key signs device tokens. At least 32 bytes.
	Key       []byte
	TokenTTL  time.Duration
	TicketTTL time.Duration
	// FlowTTL bounds a browser login from begin to the last poll.
	FlowTTL time.Duration
	// MaxTickets bounds the outstanding-ticket table.
	MaxTickets int
	// MaxFlows bounds the browser-login table. It is a flood bound, not a
	// quota: one client's share of it is flowShare.
	MaxFlows int

	// PublicURL is where a browser reaches this server. Required for OIDC,
	// because the IdP's redirect must go to exactly the URI registered with
	// it; otherwise login links are built from the request.
	PublicURL string
	OIDC      OIDCConfig

	Now  func() time.Time
	Logf func(format string, args ...any)
}

func DefaultConfig() Config {
	return Config{
		Scope:      ScopeCreate,
		TokenTTL:   30 * 24 * time.Hour,
		TicketTTL:  60 * time.Second,
		FlowTTL:    5 * time.Minute,
		MaxTickets: 100_000,
		MaxFlows:   100_000,
	}
}

type Server struct {
	cfg     Config
	sign    signer
	tickets *tickets
	peers   peers
	flows   *flows
	oidc    *relyingParty

	limSession *limiter
	limTicket  *limiter
	limBegin   *limiter
	limPoll    *limiter

	// kdf caps concurrent password checks. The per-peer limit bounds one
	// address; this bounds what many addresses together can make the CPU do.
	kdf chan struct{}
	// A check waits for a slot at most kdfWait, and at most kdfQueueMax
	// checks wait at once (kdfQueued counts them). Past either the answer is
	// 503 busy. Without a bound the queue is the attack: a handler outlives
	// its client, so every request a /48 of fresh per-/64 buckets gets past
	// the limiter waited its turn and then ran the full hash for nobody,
	// hours of it, ahead of every real sign-in.
	kdfWait     time.Duration
	kdfQueueMax int
	kdfQueued   atomic.Int64
	// dummy is checked for an unknown user, so a miss costs what a hit costs.
	dummy PasswordHash
	cop   *http.CrossOriginProtection
}

// New validates the configuration against the methods it enables and says
// what is missing, rather than starting a server that refuses everyone.
func New(cfg Config) (*Server, error) {
	if len(cfg.Methods) == 0 {
		return nil, errors.New("auth: no methods enabled")
	}
	d := DefaultConfig()
	if cfg.Scope == "" {
		cfg.Scope = d.Scope
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = d.TokenTTL
	}
	if cfg.TicketTTL <= 0 {
		cfg.TicketTTL = d.TicketTTL
	}
	if cfg.FlowTTL <= 0 {
		cfg.FlowTTL = d.FlowTTL
	}
	if cfg.MaxTickets <= 0 {
		cfg.MaxTickets = d.MaxTickets
	}
	if cfg.MaxFlows <= 0 {
		cfg.MaxFlows = d.MaxFlows
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if len(cfg.Key) < 32 {
		return nil, errors.New("auth: the device-token key must be at least 32 bytes")
	}
	has := func(m string) bool { return slices.Contains(cfg.Methods, m) }
	if has(MethodToken) && len(cfg.Keys) == 0 {
		return nil, errors.New("-auth token needs -auth-tokens-file")
	}
	if has(MethodPassword) && len(cfg.Users) == 0 {
		return nil, errors.New("-auth password needs -auth-users-file")
	}
	if has(MethodProxy) && len(cfg.TrustedProxies) == 0 {
		// Without it, "the proxy authenticated this" would be believed from
		// anyone who can reach the port.
		return nil, errors.New("-auth proxy needs -trusted-proxies")
	}
	if cfg.PublicURL != "" {
		u, err := url.Parse(cfg.PublicURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("-public-url %q: want http(s)://host[:port]", cfg.PublicURL)
		}
		// Only the root. The login page's links, the flow cookie's Path=/auth/
		// and the clients' own URLs all assume the server is at /, so a prefix
		// would reach the IdP's redirect and nothing else: every login would
		// end as "link expired". Refused rather than half-supported.
		if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return nil, fmt.Errorf("-public-url %q: the server must be at the root of its origin (no path, query or credentials)", cfg.PublicURL)
		}
		cfg.PublicURL = u.Scheme + "://" + u.Host
	}

	var dh PasswordHash
	if has(MethodPassword) {
		// As slow as the slowest real user, so a miss is not the fast answer.
		iter := 0
		for _, u := range cfg.Users {
			iter = max(iter, u.iter)
		}
		dummy, err := HashPassword("videosync-dummy", iter)
		if err != nil {
			return nil, err
		}
		dh, _ = parseHash(dummy)
	}
	s := &Server{
		cfg:     cfg,
		sign:    signer{key: cfg.Key},
		tickets: newTickets(cfg.TicketTTL, cfg.MaxTickets),
		peers:   peers{trusted: cfg.TrustedProxies},
		flows:   newFlows(cfg.FlowTTL, cfg.MaxFlows),
		// A person retyping a password is well inside this; a guesser is not.
		limSession: newLimiter(0.5, 5),
		// One per connect and room creation, and a reconnect storm is paced
		// by the engine's own backoff.
		limTicket: newLimiter(2, 20),
		limBegin:  newLimiter(0.2, 5),
		// The client polls every couple of seconds, possibly from two tabs.
		limPoll: newLimiter(2, 30),
		kdf:     make(chan struct{}, max(1, runtime.NumCPU()/2)),
		// Long enough for a person behind a few honest retries; a queue this
		// deep drains in seconds at the default iteration count.
		kdfWait:     10 * time.Second,
		kdfQueueMax: 16 * max(1, runtime.NumCPU()/2),
		dummy:       dh,
		cop:         http.NewCrossOriginProtection(),
	}
	if has(MethodOIDC) {
		if cfg.PublicURL == "" {
			return nil, errors.New("-auth oidc needs -public-url: the IdP redirects to <public-url>/auth/oidc/callback, which must be registered with it")
		}
		rp, err := newRelyingParty(cfg.OIDC, cfg.PublicURL+"/auth/oidc/callback")
		if err != nil {
			return nil, err
		}
		s.oidc = rp
	}
	return s, nil
}

func (s *Server) has(m string) bool { return slices.Contains(s.cfg.Methods, m) }

func (s *Server) Methods() []string { return slices.Clone(s.cfg.Methods) }
func (s *Server) Scope() Scope      { return s.cfg.Scope }

// Info is what /healthz advertises, so a client knows what to ask for before
// it has asked for anything.
func (s *Server) Info() map[string]any {
	return map[string]any{"methods": s.Methods(), "scope": s.cfg.Scope}
}

// TicketToJoin reports whether `hello` must carry a ticket.
func (s *Server) TicketToJoin() bool { return s.cfg.Scope == ScopeAll }

// ConsumeTicket spends a ticket. Every gated entry point calls this exactly
// once per request, before it looks at anything else the request says.
func (s *Server) ConsumeTicket(t string) bool { return s.tickets.consume(t, s.cfg.Now()) }

// Admits reports whether the request carries a device token this server
// would issue a ticket for. For read-only endpoints that are gated like room
// creation but fetched several at a time (the provider index and its files):
// a ticket is single-use, so one per file would be N+1 round trips for the
// same answer. The proxy's word does not count here, for the reason it does
// not count on /api/ticket -- a gateway leaves these paths open.
func (s *Server) Admits(r *http.Request) bool {
	_, ok := s.device(r)
	return ok
}

// Refuse is the answer to a gated call without a valid ticket. It names the
// methods so a client that skipped /healthz can still prompt for the right
// thing -- the lesson from code-docker: an unconfigured state explains itself.
func (s *Server) Refuse(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]any{
		"error": "auth_required", "methods": s.Methods(),
		"msg": "this server requires sign-in; get a ticket from POST /api/ticket",
	})
}

// Register adds the endpoints. `api` wraps the cross-origin JSON ones in the
// hub's CORS policy; the /auth pages are for a browser tab on this server's
// own origin and get none.
func (s *Server) Register(mux *http.ServeMux, api func(http.HandlerFunc) http.HandlerFunc) {
	noop := func(http.ResponseWriter, *http.Request) {}
	for path, h := range map[string]http.HandlerFunc{
		"/api/session":    s.handleSession,
		"/api/ticket":     s.handleTicket,
		"/api/auth/begin": s.handleBegin,
		"/api/auth/poll":  s.handlePoll,
	} {
		mux.HandleFunc("POST "+path, api(h))
		// Authorization makes every one of these preflighted from a page.
		mux.HandleFunc("OPTIONS "+path, api(noop))
	}
	mux.HandleFunc("GET /auth/login", s.handleLoginPage)
	mux.Handle("POST /auth/login", s.cop.Handler(http.HandlerFunc(s.handleLoginConfirm)))
	mux.HandleFunc("GET /auth/oidc/start", s.handleOIDCStart)
	mux.HandleFunc("GET /auth/oidc/callback", s.handleOIDCCallback)
}

// --- authenticating a request -----------------------------------------------

// DeviceHeader must accompany a `/api/session` call that the trusted proxy is
// to vouch for. A gateway that lets a request through without a cookie -- an
// address allowlist, a VPN or tailnet identity header, a client certificate --
// lets through ANY page's request from inside that network, and a bodiless
// POST is a simple request: without this, `fetch(server+'/api/session',
// {method:'POST'})` from whatever site the user has open reads a device token
// (Allow-Origin is `*`). A header outside the CORS safelist forces a preflight,
// and the hub's preflight names this header only for an extension origin
// (ExtensionOrigin), which a page cannot claim. The privileged sides that do
// sign in this way -- the extension's worker, and GM_xmlhttpRequest, which is
// not subject to CORS at all -- send it. A page never gets a device token from
// the proxy's word; it has the login tab (`/auth/login`), which is under
// CrossOriginProtection.
const DeviceHeader = "X-VideoSync-Device"

// ExtensionOrigin is whether a request's Origin is a browser extension's. Not
// "null" and not an empty string: a sandboxed frame on any site sends "null".
func ExtensionOrigin(origin string) bool {
	scheme, rest, ok := strings.Cut(origin, "://")
	if !ok || rest == "" {
		return false
	}
	switch strings.ToLower(scheme) {
	case "chrome-extension", "moz-extension", "safari-web-extension":
		return true
	}
	return false
}

// proxyUser is MethodProxy: the TCP peer is a proxy we were told to trust,
// and, when a user header is configured, it named somebody.
func (s *Server) proxyUser(r *http.Request) (string, bool) {
	if !s.has(MethodProxy) || !s.peers.fromTrustedProxy(r) {
		return "", false
	}
	if s.cfg.UserHeader == "" {
		return "proxy", true
	}
	u := strings.TrimSpace(r.Header.Get(s.cfg.UserHeader))
	if u == "" {
		return "", false
	}
	return u, true
}

// errBusy is a password check that did not get a slot: 503, never 401, so
// the client retries rather than treating it as a wrong password.
var errBusy = errors.New("busy")

// checkPassword waits for a kdf slot, but only while its request is still
// wanted and only so long (Server.kdfWait). Whether it waits at all does not
// depend on the user, so busy says nothing about which names exist.
func (s *Server) checkPassword(ctx context.Context, user, pass string) (bool, error) {
	if s.kdfQueued.Add(1) > int64(s.kdfQueueMax) {
		s.kdfQueued.Add(-1)
		return false, errBusy
	}
	wait := time.NewTimer(s.kdfWait)
	defer wait.Stop()
	var err error
	if err = ctx.Err(); err == nil {
		select {
		case s.kdf <- struct{}{}:
		case <-ctx.Done():
			err = ctx.Err()
		case <-wait.C:
			err = errBusy
		}
	}
	s.kdfQueued.Add(-1)
	if err != nil {
		return false, err
	}
	defer func() { <-s.kdf }()
	h, ok := s.cfg.Users[user]
	if !ok {
		s.dummy.check(pass)
		return false, nil
	}
	return h.check(pass), nil
}

// refuseBusy is the API's answer to a check that could not run (nobody reads
// it when the request is gone).
func refuseBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "busy"})
}

// credentials is /api/session: whatever the enabled methods accept, once. A
// non-nil error is a password check that could not run (errBusy), not a wrong
// credential.
func (s *Server) credentials(r *http.Request) (sub, via string, ok bool, err error) {
	if r.Header.Get(DeviceHeader) != "" {
		if u, ok := s.proxyUser(r); ok {
			return u, MethodProxy, true, nil
		}
	}
	kind, val, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	val = strings.TrimSpace(val)
	switch strings.ToLower(kind) {
	case "bearer":
		if s.has(MethodToken) && matchKey(s.cfg.Keys, val) {
			return "key", MethodToken, true, nil
		}
	case "basic":
		raw, derr := base64.StdEncoding.DecodeString(val)
		if derr != nil {
			return "", "", false, nil
		}
		user, pass, found := strings.Cut(string(raw), ":")
		if !found {
			return "", "", false, nil
		}
		if s.has(MethodPassword) && user != "" {
			good, cerr := s.checkPassword(r.Context(), user, pass)
			if good {
				return user, MethodPassword, true, nil
			}
			err = cerr
		}
		// Basic with the key as the password: the one form a proxy-era client
		// or a browser credential prompt can produce.
		if s.has(MethodToken) && matchKey(s.cfg.Keys, pass) {
			return "key", MethodToken, true, nil
		}
	}
	return "", "", false, err
}

// device checks a device token, and that the method that minted it is still
// enabled: turning an authenticator off should turn its devices off too.
func (s *Server) device(r *http.Request) (deviceClaims, bool) {
	kind, val, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(kind, "bearer") {
		return deviceClaims{}, false
	}
	c, err := s.sign.verify(strings.TrimSpace(val), s.cfg.Now().UnixMilli())
	if err != nil || !s.has(c.Via) {
		return deviceClaims{}, false
	}
	return c, true
}

func (s *Server) issueDevice(sub, via string) map[string]any {
	now := s.cfg.Now()
	exp := now.Add(s.cfg.TokenTTL)
	tok := s.sign.sign(deviceClaims{Sub: sub, Via: via, Iat: now.UnixMilli(), Exp: exp.UnixMilli()})
	return map[string]any{"token": tok, "expiresMs": exp.UnixMilli(), "sub": sub}
}

// limited spends from a per-peer bucket and answers 429 when it is empty.
func (s *Server) limited(w http.ResponseWriter, r *http.Request, l *limiter) bool {
	ok, wait := l.allow(s.peers.client(r), s.cfg.Now())
	if ok {
		return false
	}
	ms := max(wait.Milliseconds(), 1)
	w.Header().Set("Retry-After", fmt.Sprint((ms+999)/1000))
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "rate_limited", "retryMs": ms})
	return true
}

// --- handlers -----------------------------------------------------------------

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, r, s.limSession) {
		return
	}
	sub, via, ok, err := s.credentials(r)
	if err != nil {
		refuseBusy(w)
		return
	}
	if !ok {
		// Deliberately no `WWW-Authenticate: Basic`: a browser that sees one
		// may pop its own credential dialog over the page.
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "auth_failed", "methods": s.Methods()})
		return
	}
	writeJSON(w, http.StatusOK, s.issueDevice(sub, via))
}

func (s *Server) handleTicket(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, r, s.limTicket) {
		return
	}
	// A device token only -- never the proxy's say-so, deliberately unlike the
	// session endpoint. A client's ticket request carries its bearer token,
	// which a Basic or cookie gateway in front would reject, so the proxy must
	// let this path through ungated; if passing through the proxy counted as
	// signed in here, that ungated path would sign in everybody. The proxy
	// vouches where it gates: /api/session and /auth/login.
	if _, ok := s.device(r); !ok {
		s.Refuse(w)
		return
	}
	t, exp, err := s.tickets.issue(s.cfg.Now())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "busy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": t, "expiresMs": exp.UnixMilli()})
}

// browserLogin is whether a login tab has anything to offer. Every method
// has one: a key or a password is typed into the tab, on this server's own
// origin, never into the panel, which lives in the site's page.
func (s *Server) browserLogin() bool { return len(s.cfg.Methods) > 0 }

func (s *Server) handleBegin(w http.ResponseWriter, r *http.Request) {
	if !s.browserLogin() {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "no_browser_login", "methods": s.Methods()})
		return
	}
	if s.limited(w, r, s.limBegin) {
		return
	}
	f, wait, err := s.flows.begin(s.peers.client(r), s.cfg.Now())
	if errors.Is(err, errFlowShare) {
		// This client's own doing, and it clears as its flows expire: the
		// panel says "too many attempts" for this, not "server busy".
		ms := max(wait.Milliseconds(), 1)
		w.Header().Set("Retry-After", fmt.Sprint((ms+999)/1000))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "rate_limited", "retryMs": ms})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "busy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"loginUrl":  s.baseURL(r) + "/auth/login?flow=" + url.QueryEscape(f.id),
		"pollId":    f.pollID,
		"code":      f.code,
		"expiresMs": f.exp.UnixMilli(),
	})
}

// baseURL is where the login page is. The configured public URL when there is
// one; otherwise the address the client used, which it can evidently reach.
func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "http"
	if r.TLS != nil || (s.peers.fromTrustedProxy(r) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) handlePoll(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, r, s.limPoll) {
		return
	}
	var body struct {
		PollID string `json:"pollId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad_request"})
		return
	}
	res, f := s.flows.poll(body.PollID, s.cfg.Now())
	switch res {
	case pollPending:
		writeJSON(w, http.StatusOK, map[string]any{"pending": true})
	case pollDone:
		writeJSON(w, http.StatusOK, s.issueDevice(f.sub, f.via))
	case pollDenied:
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "login_denied", "msg": f.denied})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "login_expired"})
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
