package auth

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// ParsePrefixes reads `-trusted-proxies`: CIDRs, or bare addresses meaning
// exactly that host.
func ParsePrefixes(list string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, s := range strings.Split(list, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q: not an address or CIDR", s)
		}
		a = a.Unmap()
		out = append(out, netip.PrefixFrom(a, a.BitLen()))
	}
	return out, nil
}

// peers answers "who sent this request" for two purposes that must agree:
// whether a proxy vouches for it, and whose rate-limit bucket it spends.
type peers struct{ trusted []netip.Prefix }

func (p peers) isTrusted(a netip.Addr) bool {
	a = a.Unmap()
	for _, pr := range p.trusted {
		if pr.Contains(a) {
			return true
		}
	}
	return false
}

func remoteAddr(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

// fromTrustedProxy is about the TCP peer only. Every forwarded header is
// something a client can write, so none of them can make a request trusted.
func (p peers) fromTrustedProxy(r *http.Request) bool {
	a, ok := remoteAddr(r)
	return ok && len(p.trusted) > 0 && p.isTrusted(a)
}

// client is the address a rate limit should be charged to. Anywhere but
// behind a trusted proxy the headers are ignored, or a client could pick a
// fresh bucket per request.
//
// Behind one, the proxy may say who the client is in either of two headers,
// and nothing here knows which one it writes:
//   - X-Forwarded-For: the rightmost entry that is not itself a trusted proxy,
//     since everything left of it was written by whoever connected.
//   - X-Real-IP: nginx's habit when told to set only this one -- in which case
//     the visitor's own X-Forwarded-For arrives untouched.
// A proxy that writes one of them passes the other through as the visitor
// sent it. So when both are present they must agree; when they do not, one
// of them is the visitor's invention and there is no telling which, and the
// request is charged to the proxy's own bucket, which a guesser cannot
// multiply. (A proxy that writes neither makes both the visitor's: the README
// says the proxy must set one.)
func (p peers) client(r *http.Request) string {
	a, ok := remoteAddr(r)
	if !ok {
		return r.RemoteAddr
	}
	if !p.fromTrustedProxy(r) {
		return a.String()
	}
	var real netip.Addr
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		x, err := netip.ParseAddr(v)
		if err != nil {
			return a.String()
		}
		real = x.Unmap()
	}
	xff := r.Header.Values("X-Forwarded-For")
	if len(xff) == 0 {
		if real.IsValid() {
			return real.String()
		}
		return a.String()
	}
	hop := a
	hops := strings.Split(strings.Join(xff, ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		h, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			// Unparseable means somebody wrote it by hand: stop believing the
			// chain here and charge the last hop we could trust.
			break
		}
		h = h.Unmap()
		hop = h
		if !p.isTrusted(h) {
			break
		}
	}
	if real.IsValid() && real != hop {
		return a.String()
	}
	return hop.String()
}

// limiter is a token bucket per peer. The hub's cytube throttle is per
// connection; these endpoints have no connection to hang state on, and the
// thing being protected is a password check or a flow table, not a room.
type limiter struct {
	rate  float64 // tokens per second
	burst float64

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

const maxBuckets = 10_000

func newLimiter(perSecond float64, burst int) *limiter {
	return &limiter{rate: perSecond, burst: float64(burst), buckets: map[string]*bucket{}}
}

// allow spends one token, or says how long until one is there.
func (l *limiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= maxBuckets {
			l.prune(now)
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

// prune drops the buckets that have refilled; they carry no information. If
// that frees nothing, the table is being flooded from many addresses and the
// oldest half goes, which is the best a per-peer limit can do about that.
func (l *limiter) prune(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, k)
		}
	}
	if len(l.buckets) < maxBuckets {
		return
	}
	n := 0
	for k := range l.buckets {
		if n >= maxBuckets/2 {
			break
		}
		delete(l.buckets, k)
		n++
	}
}
