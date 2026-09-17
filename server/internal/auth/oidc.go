package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// OIDC with this server as the only relying party: a confidential client doing
// the authorization-code flow with PKCE (research/design-auth-oidc.md §4.1).
// Clients never see an IdP token; they get this server's device token through
// the same begin/poll flow the proxy login uses.
//
// The ID token is taken from the token endpoint over a verified TLS connection
// and its signature is NOT checked. OIDC Core §3.1.3.7 allows exactly that for
// this flow -- TLS server validation stands in for the signature -- and it is
// the reason every IdP URL is required to be https. The claims are still
// checked in full: iss, aud, azp, exp, iat, nonce. JWKS verification is the
// later hardening the design names.
type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	// Allow, when non-empty, is who may log in: `sub:<id>`, `email:<addr>`,
	// `group:<name>`, or a bare value matched against sub and email. Empty
	// means anyone the IdP authenticates for this client.
	Allow []string
	// HTTPClient reaches the IdP. Nil means a client with a timeout; a test
	// passes one that trusts its own certificate.
	HTTPClient *http.Client
}

type discovery struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	TokenAuthMethods      []string `json:"token_endpoint_auth_methods_supported"`
}

type relyingParty struct {
	cfg      OIDCConfig
	redirect string
	client   *http.Client

	mu      sync.Mutex
	meta    *discovery
	fetched time.Time
}

const (
	discoveryTTL = time.Hour
	maxIdPBody   = 1 << 20
)

func newRelyingParty(cfg OIDCConfig, redirect string) (*relyingParty, error) {
	if cfg.Issuer == "" || cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("-auth oidc needs -oidc-issuer, -oidc-client-id and -oidc-client-secret-file")
	}
	u, err := url.Parse(cfg.Issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		// Not a style preference: the unsigned-ID-token path is only sound
		// over a validated TLS connection to the IdP.
		return nil, fmt.Errorf("-oidc-issuer %q must be an https URL", cfg.Issuer)
	}
	c := cfg.HTTPClient
	if c == nil {
		c = &http.Client{Timeout: 10 * time.Second}
	}
	// A redirect from the token endpoint is somewhere we did not decide to
	// send the client secret.
	cc := *c
	cc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &relyingParty{cfg: cfg, redirect: redirect, client: &cc}, nil
}

func (rp *relyingParty) discover(ctx context.Context, now time.Time) (*discovery, error) {
	rp.mu.Lock()
	if rp.meta != nil && now.Sub(rp.fetched) < discoveryTTL {
		m := rp.meta
		rp.mu.Unlock()
		return m, nil
	}
	rp.mu.Unlock()

	// Discovery appends to the issuer as given; the trailing slash is part of
	// the issuer's identity and must survive in the comparison below.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimSuffix(rp.cfg.Issuer, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		return nil, err
	}
	resp, err := rp.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc discovery: HTTP %d", resp.StatusCode)
	}
	var d discovery
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxIdPBody)).Decode(&d); err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	// OIDC Discovery §4.3: exactly equal, or the document is not this issuer's.
	if d.Issuer != rp.cfg.Issuer {
		return nil, fmt.Errorf("oidc discovery: issuer is %q, configured %q", d.Issuer, rp.cfg.Issuer)
	}
	for _, e := range []string{d.AuthorizationEndpoint, d.TokenEndpoint} {
		u, err := url.Parse(e)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, fmt.Errorf("oidc discovery: endpoint %q is not https", e)
		}
	}
	rp.mu.Lock()
	rp.meta, rp.fetched = &d, now
	rp.mu.Unlock()
	return &d, nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (rp *relyingParty) wantsGroups() bool {
	return slices.ContainsFunc(rp.cfg.Allow, func(a string) bool { return strings.HasPrefix(a, "group:") })
}

func (rp *relyingParty) authURL(d *discovery, state, nonce, verifier string) string {
	scope := "openid email profile"
	if rp.wantsGroups() {
		// Only when asked for: some IdPs refuse a scope the client was not
		// configured with, and `groups` is not a standard one.
		scope += " groups"
	}
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {rp.cfg.ClientID},
		"redirect_uri":          {rp.redirect},
		"scope":                 {scope},
		"state":                 {state},
		"nonce":                 {nonce},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	sep := "?"
	if strings.Contains(d.AuthorizationEndpoint, "?") {
		sep = "&"
	}
	return d.AuthorizationEndpoint + sep + q.Encode()
}

// exchange trades the code for an ID token and returns its checked claims.
func (rp *relyingParty) exchange(ctx context.Context, d *discovery, code, verifier, nonce string, now time.Time) (idClaims, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {rp.redirect},
		"code_verifier": {verifier},
	}
	// client_secret_basic is the default every IdP must support (RFC 6749
	// §2.3.1); post only when the IdP says basic is not on offer.
	usePost := len(d.TokenAuthMethods) > 0 &&
		!slices.Contains(d.TokenAuthMethods, "client_secret_basic") &&
		slices.Contains(d.TokenAuthMethods, "client_secret_post")
	if usePost {
		form.Set("client_id", rp.cfg.ClientID)
		form.Set("client_secret", rp.cfg.ClientSecret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return idClaims{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if !usePost {
		// Form-encoded first, as RFC 6749 §2.3.1 says; a secret with a colon
		// in it would otherwise split in the wrong place.
		req.SetBasicAuth(url.QueryEscape(rp.cfg.ClientID), url.QueryEscape(rp.cfg.ClientSecret))
	}
	resp, err := rp.client.Do(req)
	if err != nil {
		return idClaims{}, fmt.Errorf("token endpoint: %w", err)
	}
	defer resp.Body.Close()
	var body struct {
		IDToken string `json:"id_token"`
		Error   string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxIdPBody)).Decode(&body); err != nil {
		return idClaims{}, fmt.Errorf("token endpoint: HTTP %d, unreadable body", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK || body.IDToken == "" {
		return idClaims{}, fmt.Errorf("token endpoint: HTTP %d %s", resp.StatusCode, body.Error)
	}
	return rp.checkIDToken(body.IDToken, nonce, d.Issuer, now)
}

type idClaims struct {
	Iss           string          `json:"iss"`
	Sub           string          `json:"sub"`
	Aud           json.RawMessage `json:"aud"`
	Azp           string          `json:"azp"`
	Exp           float64         `json:"exp"`
	Iat           float64         `json:"iat"`
	Nonce         string          `json:"nonce"`
	Email         string          `json:"email"`
	EmailVerified *bool           `json:"email_verified"`
	Username      string          `json:"preferred_username"`
	Groups        []string        `json:"groups"`
}

func (c idClaims) audiences() ([]string, error) {
	var one string
	if err := json.Unmarshal(c.Aud, &one); err == nil {
		return []string{one}, nil
	}
	var many []string
	if err := json.Unmarshal(c.Aud, &many); err != nil {
		return nil, errors.New("aud is neither a string nor an array")
	}
	return many, nil
}

// checkIDToken is OIDC Core §3.1.3.7 minus the signature (see the package
// comment on why that is allowed here).
func (rp *relyingParty) checkIDToken(tok, nonce, issuer string, now time.Time) (idClaims, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return idClaims{}, errors.New("id_token is not a JWS")
	}
	var hdr struct {
		Alg string `json:"alg"`
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &hdr) != nil {
		return idClaims{}, errors.New("id_token header unreadable")
	}
	// An unsigned token is never what an honest IdP sends from this flow.
	if hdr.Alg == "" || strings.EqualFold(hdr.Alg, "none") {
		return idClaims{}, errors.New("id_token is unsigned")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return idClaims{}, errors.New("id_token payload unreadable")
	}
	var c idClaims
	if err := json.Unmarshal(pb, &c); err != nil {
		return idClaims{}, errors.New("id_token payload unreadable")
	}
	if c.Iss != issuer {
		return idClaims{}, fmt.Errorf("id_token iss %q is not %q", c.Iss, issuer)
	}
	aud, err := c.audiences()
	if err != nil {
		return idClaims{}, err
	}
	if !slices.Contains(aud, rp.cfg.ClientID) {
		return idClaims{}, errors.New("id_token is not for this client")
	}
	// With several audiences the token is also someone else's; azp says
	// which party it was actually issued to.
	if (len(aud) > 1 || c.Azp != "") && c.Azp != rp.cfg.ClientID {
		return idClaims{}, errors.New("id_token azp is not this client")
	}
	nowS := float64(now.Unix())
	skew := clockSkew.Seconds()
	if c.Exp == 0 || nowS > c.Exp+skew {
		return idClaims{}, errors.New("id_token expired")
	}
	// Issued for this login, which began minutes ago at most.
	if c.Iat == 0 || c.Iat > nowS+skew || c.Iat < nowS-skew-(10*time.Minute).Seconds() {
		return idClaims{}, errors.New("id_token iat is out of range")
	}
	if nonce == "" || c.Nonce != nonce {
		return idClaims{}, errors.New("id_token nonce does not match this login")
	}
	if c.Sub == "" {
		return idClaims{}, errors.New("id_token has no sub")
	}
	return c, nil
}

// allowed applies -oidc-allow. An email counts only if the IdP says it is
// verified. Not merely "has not said it is unverified": some IdPs (Entra ID)
// omit the claim while letting users set their own address, and an allowlist
// entry matched by whoever typed that address is the nOAuth bug. Such an IdP
// can still be allowlisted by `sub:` or `group:`.
func (rp *relyingParty) allowed(c idClaims) bool {
	if len(rp.cfg.Allow) == 0 {
		return true
	}
	email := ""
	if c.Email != "" && c.EmailVerified != nil && *c.EmailVerified {
		email = strings.ToLower(c.Email)
	}
	for _, a := range rp.cfg.Allow {
		kind, val, typed := strings.Cut(a, ":")
		if !typed || (kind != "sub" && kind != "email" && kind != "group") {
			kind, val = "", a
		}
		switch kind {
		case "sub":
			if val == c.Sub {
				return true
			}
		case "email":
			if email != "" && strings.ToLower(val) == email {
				return true
			}
		case "group":
			if slices.Contains(c.Groups, val) {
				return true
			}
		default:
			if val == c.Sub || (email != "" && strings.ToLower(val) == email) {
				return true
			}
		}
	}
	return false
}

// displayName is what the device token calls this person. Display only: no
// decision is ever made on it.
func (c idClaims) displayName() string {
	switch {
	case c.Username != "":
		return c.Username
	case c.Email != "":
		return c.Email
	}
	return c.Sub
}

// --- handlers -----------------------------------------------------------------

func (s *Server) loginExpired(w http.ResponseWriter) {
	s.render(w, http.StatusNotFound, pageData{
		Title:   "로그인 링크가 만료됐어요",
		Message: "VideoSync 패널에서 로그인을 다시 시작하세요.",
	})
}

func (s *Server) handleOIDCStart(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		http.NotFound(w, r)
		return
	}
	// The flow cookie is Lax, so it rides along on ANY top-level GET here --
	// including one a foreign page makes, by navigating the login tab it
	// opened (it got the flow from the unauthenticated begin). With a live IdP
	// session the round trip then completes without the user doing anything,
	// and that page polls for their device token. The key and password forms
	// are POSTs under CrossOriginProtection; this is a GET, because a form
	// whose POST redirects to the IdP would need the IdP in the page's CSP
	// form-action. So check what CrossOriginProtection would: only the login
	// page's own link (same-origin) or a URL the user typed (none) starts a
	// round trip. same-site is refused too -- a sibling subdomain is not this
	// server. A browser that sends no fetch metadata is let through, as
	// CrossOriginProtection does; every browser that does send it is covered.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		s.render(w, http.StatusForbidden, pageData{
			Title:   "로그인할 수 없어요",
			Message: "이 로그인은 VideoSync 로그인 페이지의 버튼으로만 시작할 수 있어요.",
		})
		return
	}
	id := r.URL.Query().Get("flow")
	now := s.cfg.Now()
	if _, ok := s.flows.pending(id, now); !ok {
		s.loginExpired(w)
		return
	}
	d, err := s.oidc.discover(r.Context(), now)
	if err != nil {
		s.cfg.Logf("auth: %v", err)
		s.render(w, http.StatusBadGateway, pageData{
			Title:   "로그인 서버에 연결하지 못했어요",
			Message: "서버 관리자에게 알려주세요 (OIDC discovery 실패).",
		})
		return
	}
	state, nonce, verifier := randomToken(24), randomToken(24), randomToken(48)
	if !s.flows.startOIDC(id, flowCookie(r, id), state, nonce, verifier, now) {
		// No cookie means this browser did not open the login page for this
		// flow -- a link passed around, or cookies blocked.
		s.loginExpired(w)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, s.oidc.authURL(d, state, nonce, verifier), http.StatusFound)
}

func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	now := s.cfg.Now()
	f, ok := s.flows.takeState(q.Get("state"), now)
	if !ok || !bindingOK(f.binding, flowCookie(r, f.id)) {
		s.loginExpired(w)
		return
	}
	fail := func(status int, msg string) {
		s.flows.finish(f.id, f.binding, "", "", msg, now)
		s.render(w, status, pageData{Title: "로그인하지 못했어요", Message: msg})
	}
	if e := q.Get("error"); e != "" {
		// The IdP's own words; the template escapes them.
		fail(http.StatusForbidden, "로그인 서버가 거절했어요: "+e)
		return
	}
	d, err := s.oidc.discover(r.Context(), now)
	if err != nil {
		s.cfg.Logf("auth: %v", err)
		fail(http.StatusBadGateway, "로그인 서버에 연결하지 못했어요.")
		return
	}
	c, err := s.oidc.exchange(r.Context(), d, q.Get("code"), f.verifier, f.nonce, now)
	if err != nil {
		s.cfg.Logf("auth: oidc login refused: %v", err)
		fail(http.StatusBadGateway, "로그인 결과를 확인하지 못했어요. 서버 로그를 확인하세요.")
		return
	}
	if !s.oidc.allowed(c) {
		s.cfg.Logf("auth: oidc login by sub=%q email=%q is not in -oidc-allow", c.Sub, c.Email)
		fail(http.StatusForbidden, "이 계정은 이 서버를 쓸 수 없어요.")
		return
	}
	if !s.flows.finish(f.id, f.binding, c.displayName(), MethodOIDC, "", now) {
		s.loginExpired(w)
		return
	}
	s.render(w, http.StatusOK, doneData())
}
