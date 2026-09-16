package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

// A device token is what a client keeps instead of a password, a key or an
// IdP session: `base64url(payload).base64url(HMAC-SHA256(payload))`.
//
// Stateless on purpose (D2: one process, nothing on disk). The price is that
// the only revocation is rotating the key, which revokes every device at once
// -- acceptable for rooms of people who know each other, and the design says
// so (docs/design/auth.md).
type deviceClaims struct {
	V   int    `json:"v"`
	Sub string `json:"sub"`
	Via string `json:"via"`
	// Milliseconds, like every other time this server hands out.
	Iat int64 `json:"iat"`
	Exp int64 `json:"exp"`
}

var errBadToken = errors.New("auth: bad device token")

type signer struct{ key []byte }

func (s signer) mac(b []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(b)
	return m.Sum(nil)
}

func (s signer) sign(c deviceClaims) string {
	c.V = 1
	b, _ := json.Marshal(c)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(b) + "." + enc.EncodeToString(s.mac(b))
}

// verify checks the MAC before it parses anything: the payload of a token we
// did not sign is attacker-controlled JSON and is not worth decoding.
func (s signer) verify(tok string, nowMs int64) (deviceClaims, error) {
	p, m, ok := strings.Cut(tok, ".")
	if !ok || p == "" || m == "" {
		return deviceClaims{}, errBadToken
	}
	enc := base64.RawURLEncoding
	body, err := enc.DecodeString(p)
	if err != nil {
		return deviceClaims{}, errBadToken
	}
	sig, err := enc.DecodeString(m)
	if err != nil || !hmac.Equal(sig, s.mac(body)) {
		return deviceClaims{}, errBadToken
	}
	var c deviceClaims
	if err := json.Unmarshal(body, &c); err != nil || c.V != 1 || c.Sub == "" {
		return deviceClaims{}, errBadToken
	}
	// A token from the future means the clock stepped back or the key leaked
	// into another server with a wrong clock; neither is worth trusting.
	if nowMs >= c.Exp || c.Iat > nowMs+clockSkew.Milliseconds() {
		return deviceClaims{}, errBadToken
	}
	return c, nil
}

// randomToken is the one source of every unguessable value here: ticket, flow
// id, poll id, state, nonce, PKCE verifier.
func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// Same stance as hub.newID: every value after this would be predictable.
		panic("auth: crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// tickets are single-use, short-lived, and held in memory. A ticket is what
// crosses the WebSocket (in `hello`) and the room-creation call, so the
// long-lived device token only ever travels to one endpoint.
type tickets struct {
	ttl time.Duration
	max int

	mu        sync.Mutex
	live      map[string]time.Time
	lastSweep time.Time
}

func newTickets(ttl time.Duration, max int) *tickets {
	return &tickets{ttl: ttl, max: max, live: map[string]time.Time{}}
}

var errTooManyTickets = errors.New("auth: too many outstanding tickets")

func (t *tickets) issue(now time.Time) (string, time.Time, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.Sub(t.lastSweep) >= t.ttl || len(t.live) >= t.max {
		t.sweep(now)
	}
	if len(t.live) >= t.max {
		// Every one of them is unexpired, so somebody is minting tickets
		// faster than anyone could use them. Refusing is cheaper than growing.
		return "", time.Time{}, errTooManyTickets
	}
	id := randomToken(24)
	exp := now.Add(t.ttl)
	t.live[id] = exp
	return id, exp, nil
}

func (t *tickets) sweep(now time.Time) {
	for k, exp := range t.live {
		if !now.Before(exp) {
			delete(t.live, k)
		}
	}
	t.lastSweep = now
}

// consume reports whether the ticket was live, and makes sure it is not any
// more. A map lookup by the ticket itself is not a timing oracle worth
// worrying about: the keys are 192 random bits.
func (t *tickets) consume(id string, now time.Time) bool {
	if id == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	exp, ok := t.live[id]
	if !ok {
		return false
	}
	delete(t.live, id)
	return now.Before(exp)
}
