package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"sync"
	"time"
)

// A browser login, run entirely by this server: the client asks for a flow,
// opens the login page in a tab, and polls until the page says who logged in.
// It is RFC 8628's shape without its protocol, and it is the one path that
// works for the userscript and both extensions without an identity
// permission and whatever the IdP's COOP says.
//
// The known risk of the shape is phishing: someone sends a victim the login
// link of THEIR flow, and the victim's login mints the attacker a device. The
// page therefore shows the flow's code and asks the user to continue only if
// the panel shows the same one, and a flow lives for minutes and is spent on
// first use.
type flow struct {
	id      string // in the login URL
	pollID  string // only ever in a request body
	code    string // shown in the panel and on the page
	binding string // the flow cookie's value: which browser opened the page
	exp     time.Time

	// OIDC, set by /auth/oidc/start.
	state, nonce, verifier string

	done     bool
	sub, via string
	denied   string
}

type pollResult int

const (
	pollUnknown pollResult = iota
	pollPending
	pollDone
	pollDenied
)

type flows struct {
	ttl time.Duration
	max int

	mu      sync.Mutex
	byID    map[string]*flow
	byPoll  map[string]*flow
	byState map[string]*flow
}

func newFlows(ttl time.Duration, max int) *flows {
	return &flows{
		ttl: ttl, max: max,
		byID: map[string]*flow{}, byPoll: map[string]*flow{}, byState: map[string]*flow{},
	}
}

var errTooManyFlows = errors.New("auth: too many logins in progress")

// codeAlphabet leaves out what reads ambiguously (0/O, 1/I/L) and vowels, so a
// code never spells anything.
const codeAlphabet = "BCDFGHJKMNPQRSTVWXZ23456789"

func newCode() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("auth: crypto/rand unavailable: " + err.Error())
	}
	out := make([]byte, 0, 9)
	for i, c := range b {
		if i == 4 {
			out = append(out, '-')
		}
		// A byte mod 27 is not uniform, and does not need to be: the code is
		// something to compare by eye, not a secret.
		out = append(out, codeAlphabet[int(c)%len(codeAlphabet)])
	}
	return string(out)
}

func (fs *flows) begin(now time.Time) (*flow, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.sweep(now)
	if len(fs.byID) >= fs.max {
		return nil, errTooManyFlows
	}
	f := &flow{
		id: randomToken(16), pollID: randomToken(32), code: newCode(),
		binding: randomToken(24), exp: now.Add(fs.ttl),
	}
	fs.byID[f.id] = f
	fs.byPoll[f.pollID] = f
	return f, nil
}

func (fs *flows) sweep(now time.Time) {
	for _, f := range fs.byID {
		if !now.Before(f.exp) {
			fs.drop(f)
		}
	}
}

func (fs *flows) drop(f *flow) {
	delete(fs.byID, f.id)
	delete(fs.byPoll, f.pollID)
	if f.state != "" {
		delete(fs.byState, f.state)
	}
}

// pending returns a copy of a live, unfinished flow.
func (fs *flows) pending(id string, now time.Time) (flow, bool) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	f := fs.byID[id]
	if f == nil || !now.Before(f.exp) || f.done || f.denied != "" {
		return flow{}, false
	}
	return *f, true
}

// poll hands the result over exactly once: a done or denied flow is gone after
// the poll that reports it.
func (fs *flows) poll(pollID string, now time.Time) (pollResult, flow) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	f := fs.byPoll[pollID]
	if pollID == "" || f == nil {
		return pollUnknown, flow{}
	}
	if !now.Before(f.exp) {
		fs.drop(f)
		return pollUnknown, flow{}
	}
	switch {
	case f.done:
		fs.drop(f)
		return pollDone, *f
	case f.denied != "":
		fs.drop(f)
		return pollDenied, *f
	}
	return pollPending, flow{}
}

// finish completes a pending flow for the browser holding its cookie.
func (fs *flows) finish(id, binding, sub, via, denied string, now time.Time) bool {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	f := fs.byID[id]
	if f == nil || !now.Before(f.exp) || f.done || f.denied != "" || !bindingOK(f.binding, binding) {
		return false
	}
	if denied != "" {
		f.denied = denied
	} else {
		f.done, f.sub, f.via = true, sub, via
	}
	return true
}

func bindingOK(want, got string) bool {
	return got != "" && subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

// startOIDC records the authorization request's one-time values on the flow.
// A second start replaces the first's state, so only the newest IdP round
// trip can come back.
func (fs *flows) startOIDC(id, binding, state, nonce, verifier string, now time.Time) bool {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	f := fs.byID[id]
	if f == nil || !now.Before(f.exp) || f.done || f.denied != "" || !bindingOK(f.binding, binding) {
		return false
	}
	if f.state != "" {
		delete(fs.byState, f.state)
	}
	f.state, f.nonce, f.verifier = state, nonce, verifier
	fs.byState[state] = f
	return true
}

// takeState spends an OIDC state: the callback may be replayed from history,
// and must work at most once.
func (fs *flows) takeState(state string, now time.Time) (flow, bool) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	f := fs.byState[state]
	if state == "" || f == nil {
		return flow{}, false
	}
	delete(fs.byState, state)
	f.state = ""
	if !now.Before(f.exp) || f.done || f.denied != "" {
		return flow{}, false
	}
	return *f, true
}

// --- the login page -------------------------------------------------------------

// The cookie is per flow, so two logins in one browser do not overwrite each
// other's, and lives under /auth/ only: nothing under /api reads cookies, which
// is what keeps `Access-Control-Allow-Origin: *` sound there.
func cookieName(flowID string) string { return "vs_flow_" + flowID }

func (s *Server) setFlowCookie(w http.ResponseWriter, r *http.Request, f flow) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName(f.id), Value: f.binding, Path: "/auth/",
		Expires: f.exp, HttpOnly: true,
		// Lax, not Strict: the IdP's redirect back is a cross-site top-level
		// GET, and Strict would drop the cookie on exactly that request.
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || s.baseURLIsHTTPS(r),
	})
}

func (s *Server) baseURLIsHTTPS(r *http.Request) bool {
	return strings.HasPrefix(s.baseURL(r), "https://")
}

func flowCookie(r *http.Request, flowID string) string {
	c, err := r.Cookie(cookieName(flowID))
	if err != nil {
		return ""
	}
	return c.Value
}

// pageHeaders: this page is the one place a user acts on this server in a
// browser, so it must not be framed (a framed "confirm" is a clickjack) and
// must not leak the flow id onward.
func pageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
}

type pageData struct {
	Title   string
	Message string
	Code    string
	FlowID  string
	OIDC    bool
	// Proxy is set when this request came through the trusted proxy with a
	// user; ProxyUser names them.
	Proxy     bool
	ProxyUser string
	// ProxyMissing: proxy login is enabled but this request did not come
	// through the proxy.
	ProxyMissing bool
	// Key and Password offer the forms for those methods.
	Key, Password bool
	// Error is why the last submission was refused; the forms stay.
	Error string
	Done  bool
}

var page = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VideoSync — {{.Title}}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101116;color:#e9e9ea;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(420px,calc(100% - 32px));background:#17181c;border:1px solid #303138;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 12px}
p{margin:8px 0;color:#c9cbd4}
.code{font:600 28px ui-monospace,monospace;letter-spacing:.12em;text-align:center;padding:12px;margin:16px 0;border:1px solid #303138;border-radius:8px;background:#101116}
a.btn,button{display:block;box-sizing:border-box;width:100%;margin-top:12px;padding:10px;border-radius:8px;border:1px solid #2a5cff;background:#2a5cff;color:#fff;font:600 15px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}
.warn{color:#e0b23a}
form{margin-top:16px}
label{display:block;margin-top:8px;color:#c9cbd4}
input:not([type=hidden]){display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:9px;border-radius:8px;border:1px solid #303138;background:#101116;color:#e9e9ea;font:15px system-ui,sans-serif}
</style></head><body><main>
<h1>{{.Title}}</h1>
{{if .Message}}<p>{{.Message}}</p>{{end}}
{{if .Code}}
<p>VideoSync 패널에 표시된 코드가 아래와 <b>같을 때만</b> 계속하세요. 다르면 이 탭을 닫으세요 — 다른 사람이 보낸 링크일 수 있어요.</p>
<div class="code">{{.Code}}</div>
{{if .OIDC}}<a class="btn" href="/auth/oidc/start?flow={{.FlowID}}">계정으로 로그인</a>{{end}}
{{if .Proxy}}<form method="post" action="/auth/login"><input type="hidden" name="flow" value="{{.FlowID}}"><button type="submit">{{if .ProxyUser}}{{.ProxyUser}}(으)로 {{end}}이 기기 로그인</button></form>{{end}}
{{if .Error}}<p class="warn">{{.Error}}</p>{{end}}
{{if .Password}}<form method="post" action="/auth/login"><input type="hidden" name="flow" value="{{.FlowID}}"><input type="hidden" name="method" value="password">
<label>사용자<input name="user" autocomplete="username" required></label>
<label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">비밀번호로 로그인</button></form>{{end}}
{{if .Key}}<form method="post" action="/auth/login"><input type="hidden" name="flow" value="{{.FlowID}}"><input type="hidden" name="method" value="token">
<label>접속 키<input name="key" type="password" autocomplete="off" required></label>
<button type="submit">접속 키로 로그인</button></form>{{end}}
{{if .ProxyMissing}}<p class="warn">프록시 로그인은 서버 앞의 인증 프록시를 거쳐 이 페이지를 열어야 해요.</p>{{end}}
{{end}}
</main></body></html>
`))

func (s *Server) render(w http.ResponseWriter, status int, d pageData) {
	pageHeaders(w)
	w.WriteHeader(status)
	page.Execute(w, d)
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	f, ok := s.flows.pending(r.URL.Query().Get("flow"), s.cfg.Now())
	if !ok {
		s.render(w, http.StatusNotFound, pageData{
			Title:   "로그인 링크가 만료됐어요",
			Message: "VideoSync 패널에서 로그인을 다시 시작하세요.",
		})
		return
	}
	s.setFlowCookie(w, r, f)
	s.render(w, http.StatusOK, s.loginPage(r, f, ""))
}

func (s *Server) loginPage(r *http.Request, f flow, why string) pageData {
	user, byProxy := s.proxyUser(r)
	if user == "proxy" {
		user = ""
	}
	return pageData{
		Title: "VideoSync 로그인", Code: f.code, FlowID: f.id,
		OIDC:  s.oidc != nil,
		Proxy: byProxy, ProxyUser: user,
		ProxyMissing: s.has(MethodProxy) && !byProxy && s.oidc == nil &&
			!s.has(MethodToken) && !s.has(MethodPassword),
		Key: s.has(MethodToken), Password: s.has(MethodPassword),
		Error: why,
	}
}

func expiredPage() pageData {
	return pageData{
		Title:   "로그인 링크가 만료됐어요",
		Message: "VideoSync 패널에서 로그인을 다시 시작하세요.",
	}
}

// handleLoginConfirm finishes a flow: with a key or a password typed into this
// page, or -- with neither -- on the proxy's word. Every branch is under
// CrossOriginProtection and needs the flow cookie of the browser that opened
// the page, so a link someone forwarded does not sign its sender in.
func (s *Server) handleLoginConfirm(w http.ResponseWriter, r *http.Request) {
	switch r.PostFormValue("method") {
	case "":
		s.confirmProxy(w, r)
	case MethodToken, MethodPassword:
		s.confirmSecret(w, r)
	default:
		s.render(w, http.StatusBadRequest, pageData{Title: "로그인할 수 없어요", Message: "알 수 없는 로그인 방법이에요."})
	}
}

func (s *Server) confirmSecret(w http.ResponseWriter, r *http.Request) {
	id, method := r.PostFormValue("flow"), r.PostFormValue("method")
	now := s.cfg.Now()
	f, ok := s.flows.pending(id, now)
	if !ok || !bindingOK(f.binding, flowCookie(r, id)) {
		s.render(w, http.StatusNotFound, expiredPage())
		return
	}
	if !s.has(method) {
		s.render(w, http.StatusForbidden, s.loginPage(r, f, "이 서버는 그 방법으로 로그인할 수 없어요."))
		return
	}
	// The API's bucket: the page must not be a way around it.
	if ok, wait := s.limSession.allow(s.peers.client(r), now); !ok {
		w.Header().Set("Retry-After", fmt.Sprint((max(wait.Milliseconds(), 1)+999)/1000))
		s.render(w, http.StatusTooManyRequests, s.loginPage(r, f, "시도가 너무 많아요 — 잠시 후 다시 해주세요."))
		return
	}
	var sub string
	switch method {
	case MethodToken:
		if matchKey(s.cfg.Keys, strings.TrimSpace(r.PostFormValue("key"))) {
			sub = "key"
		}
	case MethodPassword:
		if u := r.PostFormValue("user"); u != "" && s.checkPassword(u, r.PostFormValue("password")) {
			sub = u
		}
	}
	if sub == "" {
		s.render(w, http.StatusUnauthorized, s.loginPage(r, f, "키나 비밀번호가 맞지 않아요."))
		return
	}
	if !s.flows.finish(id, flowCookie(r, id), sub, method, "", now) {
		s.render(w, http.StatusNotFound, expiredPage())
		return
	}
	s.render(w, http.StatusOK, doneData())
}

// confirmProxy is the proxy's login: the gateway in front of this page
// already made the user sign in, so the one thing left is their say-so, from
// the browser that opened this flow's page.
func (s *Server) confirmProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PostFormValue("flow")
	user, ok := s.proxyUser(r)
	if !ok {
		s.render(w, http.StatusForbidden, pageData{
			Title:   "로그인할 수 없어요",
			Message: "이 요청은 신뢰하는 프록시를 거치지 않았어요.",
		})
		return
	}
	if !s.flows.finish(id, flowCookie(r, id), user, MethodProxy, "", s.cfg.Now()) {
		s.render(w, http.StatusNotFound, expiredPage())
		return
	}
	s.render(w, http.StatusOK, doneData())
}

func doneData() pageData {
	return pageData{Title: "로그인했어요", Message: "이 탭을 닫고 VideoSync 패널로 돌아가세요.", Done: true}
}
