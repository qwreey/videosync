// Package provider validates and serves provider descriptors (D7,
// docs/design/providers.md).
//
// The server never uses a descriptor to judge anyone: it only checks a file
// before offering it, so a client that adopts it will not reject it. The
// grammar here is a port of client/core/src/providers/template.ts and must
// accept and reject exactly what that does; both suites run
// providers/testdata/*.json for that reason.
package provider

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Limits are part of the grammar; the TypeScript port enforces the same ones.
const (
	maxSegments      = 16
	maxQueryParams   = 8
	maxIDLen         = 128
	maxAnyLen        = 256
	maxIntLen        = 20
	maxLiteralLen    = 128
	maxKeyTemplate   = 256
	maxWatchTemplate = 512
)

var (
	reName  = regexp.MustCompile(`^[a-z][A-Za-z0-9]{0,31}$`)
	reWord  = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)
	reInt   = regexp.MustCompile(`^[0-9]+$`)
	reParam = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,64}$`)
	reLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	reDigit = regexp.MustCompile(`^[0-9]+$`)
)

type segKind int

const (
	segLit segKind = iota
	segCap
	segAlt
	segRest
)

type segment struct {
	kind  segKind
	value string   // literal
	name  string   // capture name
	typ   string   // "id", "int", "any" for segCap
	alts  []string // for segAlt
}

type pathTemplate struct {
	segments []segment
	names    []string
}

type queryParam struct {
	name string
	seg  segment
}

type queryTemplate struct {
	params []queryParam
	names  []string
}

func parseSegment(raw, where string) (segment, error) {
	if raw == "**" {
		return segment{kind: segRest}, nil
	}
	if strings.HasPrefix(raw, "{") {
		if !strings.HasSuffix(raw, "}") || len(raw) < 2 {
			return segment{}, fmt.Errorf("%s: unclosed placeholder %q", where, raw)
		}
		body := raw[1 : len(raw)-1]
		name, typ := body, "id"
		if i := strings.IndexByte(body, ':'); i >= 0 {
			name, typ = body[:i], body[i+1:]
		}
		if !reName.MatchString(name) {
			return segment{}, fmt.Errorf("%s: bad placeholder name %q", where, name)
		}
		switch typ {
		case "id", "int", "any":
			return segment{kind: segCap, name: name, typ: typ}, nil
		}
		alts := strings.Split(typ, "|")
		for _, a := range alts {
			if a == "" || !reWord.MatchString(a) || len(a) > maxLiteralLen {
				return segment{}, fmt.Errorf("%s: bad placeholder type %q", where, typ)
			}
		}
		return segment{kind: segAlt, name: name, alts: alts}, nil
	}
	if !reWord.MatchString(raw) || len(raw) > maxLiteralLen || raw == "." || raw == ".." {
		return segment{}, fmt.Errorf("%s: bad literal segment %q", where, raw)
	}
	return segment{kind: segLit, value: raw}, nil
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func parsePathTemplate(src string) (*pathTemplate, error) {
	if !strings.HasPrefix(src, "/") {
		return nil, fmt.Errorf("path %q: must start with \"/\"", src)
	}
	var parts []string
	if src != "/" {
		parts = strings.Split(src[1:], "/")
	}
	if len(parts) > maxSegments {
		return nil, fmt.Errorf("path %q: more than %d segments", src, maxSegments)
	}
	t := &pathTemplate{}
	for i, p := range parts {
		if p == "" {
			return nil, fmt.Errorf("path %q: empty segment", src)
		}
		seg, err := parseSegment(p, fmt.Sprintf("path %q", src))
		if err != nil {
			return nil, err
		}
		if seg.kind == segRest && i != len(parts)-1 {
			return nil, fmt.Errorf("path %q: \"**\" must be last", src)
		}
		if seg.kind == segCap || seg.kind == segAlt {
			if contains(t.names, seg.name) {
				return nil, fmt.Errorf("path %q: %q captured twice", src, seg.name)
			}
			t.names = append(t.names, seg.name)
		}
		t.segments = append(t.segments, seg)
	}
	return t, nil
}

// parseQueryTemplate takes the decoded JSON object. Keys are visited in sorted
// order; the result does not depend on it.
func parseQueryTemplate(q map[string]any, taken []string) (*queryTemplate, error) {
	if len(q) == 0 {
		return nil, errors.New("query: empty")
	}
	if len(q) > maxQueryParams {
		return nil, fmt.Errorf("query: more than %d parameters", maxQueryParams)
	}
	t := &queryTemplate{}
	for _, k := range sortedKeys(q) {
		if !reParam.MatchString(k) {
			return nil, fmt.Errorf("query: bad parameter name %q", k)
		}
		v, ok := q[k].(string)
		if !ok || v == "" {
			return nil, fmt.Errorf("query %q: value must be a non-empty string", k)
		}
		seg, err := parseSegment(v, fmt.Sprintf("query %q", k))
		if err != nil {
			return nil, err
		}
		if seg.kind == segRest {
			return nil, fmt.Errorf("query %q: \"**\" is a path form", k)
		}
		if seg.kind == segCap || seg.kind == segAlt {
			if contains(t.names, seg.name) || contains(taken, seg.name) {
				return nil, fmt.Errorf("query %q: %q captured twice", k, seg.name)
			}
			t.names = append(t.names, seg.name)
		}
		t.params = append(t.params, queryParam{name: k, seg: seg})
	}
	return t, nil
}

func segmentMatches(seg segment, value string, out map[string]string) bool {
	switch seg.kind {
	case segLit:
		return value == seg.value
	case segAlt:
		if !contains(seg.alts, value) {
			return false
		}
		out[seg.name] = value
		return true
	case segCap:
		var ok bool
		switch seg.typ {
		case "int":
			ok = len(value) <= maxIntLen && reInt.MatchString(value)
		case "id":
			ok = len(value) <= maxIDLen && reWord.MatchString(value)
		default:
			ok = value != "" && utf8.RuneCountInString(value) <= maxAnyLen
		}
		if ok {
			out[seg.name] = value
		}
		return ok
	}
	return false
}

// matchPath matches a percent-encoded pathname. Empty segments are dropped;
// each segment is decoded once and must be valid UTF-8, as
// decodeURIComponent requires.
func matchPath(t *pathTemplate, pathname string) map[string]string {
	var parts []string
	for _, p := range strings.Split(pathname, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	out := map[string]string{}
	i := 0
	for _, seg := range t.segments {
		if seg.kind == segRest {
			return out
		}
		if i >= len(parts) {
			return nil
		}
		raw := parts[i]
		i++
		v, err := url.PathUnescape(raw)
		if err != nil || !utf8.ValidString(v) {
			return nil
		}
		if !segmentMatches(seg, v, out) {
			return nil
		}
	}
	if i != len(parts) {
		return nil
	}
	return out
}

// firstQueryValues reproduces URLSearchParams: split on '&', the first '='
// separates name and value, '+' is a space, a bad escape stays as text, and
// bytes that are not UTF-8 become U+FFFD.
func firstQueryValues(search string) map[string]string {
	out := map[string]string{}
	s := strings.TrimPrefix(search, "?")
	if s == "" {
		return out
	}
	for _, pair := range strings.Split(s, "&") {
		if pair == "" {
			continue
		}
		k, v, _ := strings.Cut(pair, "=")
		k, v = formDecode(k), formDecode(v)
		if _, seen := out[k]; !seen {
			out[k] = v
		}
	}
	return out
}

func unhex(c byte) (byte, bool) {
	switch {
	case '0' <= c && c <= '9':
		return c - '0', true
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10, true
	case 'A' <= c && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

func formDecode(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '+' {
			b = append(b, ' ')
			continue
		}
		if c == '%' && i+2 < len(s) {
			hi, ok1 := unhex(s[i+1])
			lo, ok2 := unhex(s[i+2])
			if ok1 && ok2 {
				b = append(b, hi<<4|lo)
				i += 2
				continue
			}
		}
		b = append(b, c)
	}
	return decodeUTF8WithReplacement(b)
}

// decodeUTF8WithReplacement is the WHATWG "UTF-8 decode without BOM" that
// URLSearchParams uses: one U+FFFD per maximal subpart of an ill-formed
// sequence. strings.ToValidUTF8 gives one for a whole run of bad bytes and
// utf8.DecodeRune one per byte; both disagree with the client on some input.
func decodeUTF8WithReplacement(b []byte) string {
	var out strings.Builder
	var cp rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case 0xC2 <= c && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case 0xE0 <= c && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				} else if c == 0xED {
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0x0F)
			case 0xF0 <= c && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				} else if c == 0xF4 {
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x07)
			default:
				out.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			// The sequence so far is one error; c starts afresh.
			cp, needed, seen, lower, upper = 0, 0, 0, 0x80, 0xBF
			out.WriteRune(utf8.RuneError)
			i--
			continue
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		if seen++; seen == needed {
			out.WriteRune(cp)
			cp, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out.WriteRune(utf8.RuneError)
	}
	return out.String()
}

func matchQuery(t *queryTemplate, search string) map[string]string {
	got := firstQueryValues(search)
	out := map[string]string{}
	for _, p := range t.params {
		v, ok := got[p.name]
		if !ok || v == "" {
			return nil
		}
		if !segmentMatches(p.seg, v, out) {
			return nil
		}
	}
	return out
}

type textPart struct {
	lit    string
	name   string
	isName bool
}

type textTemplate struct {
	parts []textPart
}

func parseTextTemplate(src string, allowed []string, maxLen int) (*textTemplate, error) {
	if src == "" {
		return nil, errors.New("template: must be a non-empty string")
	}
	if utf8.RuneCountInString(src) > maxLen {
		return nil, fmt.Errorf("template %q: longer than %d", src, maxLen)
	}
	t := &textTemplate{}
	i := 0
	for i < len(src) {
		open := strings.IndexByte(src[i:], '{')
		close := strings.IndexByte(src[i:], '}')
		if open < 0 {
			if close >= 0 {
				return nil, fmt.Errorf("template %q: stray \"}\"", src)
			}
			t.parts = append(t.parts, textPart{lit: src[i:]})
			break
		}
		if close >= 0 && close < open {
			return nil, fmt.Errorf("template %q: stray \"}\"", src)
		}
		if open > 0 {
			t.parts = append(t.parts, textPart{lit: src[i : i+open]})
		}
		end := strings.IndexByte(src[i+open:], '}')
		if end < 0 {
			return nil, fmt.Errorf("template %q: unclosed \"{\"", src)
		}
		name := src[i+open+1 : i+open+end]
		if !reName.MatchString(name) {
			return nil, fmt.Errorf("template %q: bad placeholder {%s}", src, name)
		}
		if !contains(allowed, name) {
			return nil, fmt.Errorf("template %q: {%s} is not captured by this rule", src, name)
		}
		t.parts = append(t.parts, textPart{name: name, isName: true})
		i += open + end + 1
	}
	return t, nil
}

// encodeComponent is encodeURIComponent: every byte of the UTF-8 form except
// A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-escaped, upper-case hex.
func encodeComponent(s string) string {
	const hexd = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexd[c>>4])
		b.WriteByte(hexd[c&15])
	}
	return b.String()
}

func substitute(t *textTemplate, caps map[string]string, encode bool) string {
	var b strings.Builder
	for _, p := range t.parts {
		switch {
		case !p.isName:
			b.WriteString(p.lit)
		case encode:
			b.WriteString(encodeComponent(caps[p.name]))
		default:
			b.WriteString(caps[p.name])
		}
	}
	return b.String()
}

// aceLabel reports an IDNA "xn--" label. net/url and Node take any such label
// as text; a browser runs UTS46 and refuses one that is not valid punycode of
// a valid name ("xn--a", "xn--"), so the ports would disagree with it. Telling
// the valid ones apart needs the IDNA tables, so a descriptor may not name an
// IDN host at all. The client's aceLabel is the same rule.
func aceLabel(l string) bool { return strings.HasPrefix(strings.ToLower(l), "xn--") }

// validHostPattern: lowercase ASCII LDH, exact or a leading "*.", at least two
// labels, no wildcard over an address, and no "xn--" label (see aceLabel).
func validHostPattern(p string) bool {
	wild := strings.HasPrefix(p, "*.")
	base := p
	if wild {
		base = p[2:]
	}
	if base == "" || len(base) > 253 {
		return false
	}
	labels := strings.Split(base, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if !reLabel.MatchString(l) || aceLabel(l) {
			return false
		}
	}
	if wild && reDigit.MatchString(labels[len(labels)-1]) {
		return false
	}
	return true
}

func normHost(h string) string {
	h = strings.ToLower(h)
	return strings.TrimSuffix(h, ".")
}

// hostScore: 0 for no claim; an exact host beats any wildcard over the same
// labels, a longer wildcard beats a shorter one.
func hostScore(pattern, hostname string) int {
	h := normHost(hostname)
	if base, ok := strings.CutPrefix(pattern, "*."); ok {
		if strings.HasSuffix(h, "."+base) {
			return len(strings.Split(base, ".")) * 2
		}
		return 0
	}
	if h == pattern {
		return len(strings.Split(pattern, "."))*2 + 1
	}
	return 0
}

func bestHostScore(patterns []string, hostname string) int {
	best := 0
	for _, p := range patterns {
		if s := hostScore(p, hostname); s > best {
			best = s
		}
	}
	return best
}

// coveredBy: whether host (itself a pattern) is claimed by one of patterns. A
// wildcard is covered only by a wildcard over the same or a shorter base.
func coveredBy(host string, patterns []string) bool {
	if contains(patterns, host) {
		return true
	}
	probe := host
	if base, ok := strings.CutPrefix(host, "*."); ok {
		probe = "x." + base
	}
	for _, p := range patterns {
		if strings.HasPrefix(p, "*.") && hostScore(p, probe) > 0 {
			return true
		}
	}
	return false
}
