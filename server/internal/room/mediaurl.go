package room

import (
	"net/url"
	"strings"
)

// maxMediaURL bounds what a member can make the server store and repeat to
// everyone. A canonical watch URL is well under this.
const maxMediaURL = 512

// MaxMediaKey bounds a mediaKey the same way: it is repeated in every state,
// ack, resync and welcome, to every member, for as long as the room lives.
// A normalised key is a provider id plus a content id or a path, and a path
// long enough to reach this has already lost its mediaUrl to maxMediaURL.
const MaxMediaKey = 512

// SanitizeMediaKey returns k, or "" when it is too long to repeat to
// everyone. "" names nothing, which is what the room had before.
func SanitizeMediaKey(k string) string {
	if len(k) > MaxMediaKey {
		return ""
	}
	return k
}

// SanitizeMediaURL returns u if it is fit to hand to other members as a place
// to navigate to, or "" if it is not.
//
// The URL is advisory: every client checks that it normalises to the room's
// mediaKey before following it, so a member cannot use it to send the room to
// an unrelated site. This is the server's half -- it refuses what no honest
// client sends: another scheme (`javascript:`, `data:`), credentials in the
// authority, a fragment (which is where invite secrets live), and anything
// oversized.
//
// What comes back is u itself, never Go's re-encoding of it. The client's
// check parses with WHATWG rules, which leave "|" and a stray "%" in a path
// as they are; Go writes the first as %7C and refuses the second, and either
// way the room's own URL stopped normalising to the room's key.
func SanitizeMediaURL(u string) string {
	if u == "" || len(u) > maxMediaURL || strings.Contains(u, "#") {
		return ""
	}
	p, err := url.Parse(escapeStrayPercent(u))
	if err != nil || (p.Scheme != "https" && p.Scheme != "http") || p.Host == "" ||
		p.User != nil || p.Opaque != "" || strings.Contains(p.Host, "%") {
		return ""
	}
	return u
}

// escapeStrayPercent writes every "%" that does not start an escape as "%25",
// which is how WHATWG reads it, so that only the check parses it strictly.
func escapeStrayPercent(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && (i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2])) {
			b.WriteString("%25")
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}
