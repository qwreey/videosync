package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Schema 1 limits; the same as client/core/src/providers/descriptor.ts.
const (
	SchemaVersion  = 1
	MaxBytes       = 16 << 10
	maxRules       = 32
	maxHosts       = 32
	maxSelectors   = 16
	maxSelectorLen = 256
	maxExamples    = 64
	maxContinues   = 8
)

var adapters = []string{"html5"}

// implemented is what a descriptor may list in `requires`: what the client
// honours. The server lists the same names so that it never offers a file
// the client would refuse.
var implemented = []string{
	"hosts", "pageHosts", "canonicalHost", "identity", "identity.hosts", "identity.query", "pathFallback",
	"video", "video.include", "video.exclude", "video.pierceShadow", "video.minIntrinsicArea",
	"video.outclassedFactor", "capabilities", "capabilities.playbackRateNudge", "capabilities.directSeek",
	"seek", "seek.landingToleranceS", "seek.timeoutMs", "continues",
}

var (
	reID      = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)
	reKeyPref = regexp.MustCompile(`^[a-z0-9.-]{2,64}$`)
	reVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	reWatch   = regexp.MustCompile(`^https://([^/?#{}]+)(/[^#]*)?$`)
)

// IdentityRule, Descriptor and friends are the typed form, decoded only after
// the structural check has passed.
type IdentityRule struct {
	Hosts []string          `json:"hosts,omitempty"`
	Path  string            `json:"path"`
	Query map[string]string `json:"query,omitempty"`
	Key   string            `json:"key"`
	Watch string            `json:"watch"`
}

type Example struct {
	URL       *string `json:"url,omitempty"`
	Key       *string `json:"key"`
	Watch     *string `json:"watch,omitempty"`
	From      string  `json:"from,omitempty"`
	To        string  `json:"to,omitempty"`
	Continues *bool   `json:"continues,omitempty"`
}

type Descriptor struct {
	Schema        json.Number       `json:"schema"`
	Requires      []string          `json:"requires,omitempty"`
	ID            string            `json:"id"`
	KeyPrefix     string            `json:"keyPrefix,omitempty"`
	Name          string            `json:"name"`
	Version       string            `json:"version"`
	Adapter       string            `json:"adapter"`
	Hosts         []string          `json:"hosts"`
	PageHosts     []string          `json:"pageHosts,omitempty"`
	CanonicalHost string            `json:"canonicalHost"`
	Identity      []IdentityRule    `json:"identity"`
	PathFallback  bool              `json:"pathFallback"`
	Video         json.RawMessage   `json:"video,omitempty"`
	Ads           json.RawMessage   `json:"ads,omitempty"`
	Capabilities  json.RawMessage   `json:"capabilities,omitempty"`
	Seek          json.RawMessage   `json:"seek,omitempty"`
	Navigation    json.RawMessage   `json:"navigation,omitempty"`
	Continues     []ContinuesRule   `json:"continues,omitempty"`
	Examples      []json.RawMessage `json:"examples"`
	Notes         string            `json:"notes,omitempty"`
}

type ContinuesRule struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// --- structural check, over the untyped tree -------------------------------
//
// Go's decoder matches field names case-insensitively and turns null into a
// zero value; the client does neither. So the shape is checked on the raw
// tree first, exactly as the TypeScript validator does, and the typed decode
// (DisallowUnknownFields) only happens once that has passed.

type problems struct{ list []string }

func (p *problems) add(format string, a ...any) {
	if len(p.list) < 32 {
		p.list = append(p.list, fmt.Sprintf(format, a...))
	}
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func onlyKeys(o map[string]any, allowed []string, where string, p *problems) {
	for _, k := range sortedKeys(o) {
		if !contains(allowed, k) {
			p.add("%s: unknown field %q", where, k)
		}
	}
}

type strOpt struct {
	optional bool
	max      int
	re       *regexp.Regexp
}

func getStr(o map[string]any, k, where string, p *problems, opt strOpt) (string, bool) {
	v, present := o[k]
	if !present {
		if !opt.optional {
			p.add("%s: %q is required", where, k)
		}
		return "", false
	}
	s, ok := v.(string)
	if !ok {
		p.add("%s: %q must be a string", where, k)
		return "", false
	}
	if opt.max > 0 && utf8.RuneCountInString(s) > opt.max {
		p.add("%s: %q is longer than %d", where, k, opt.max)
		return "", false
	}
	if opt.re != nil && !opt.re.MatchString(s) {
		p.add("%s: %q is malformed", where, k)
		return "", false
	}
	return s, true
}

func getBool(o map[string]any, k, where string, p *problems, optional bool) {
	v, present := o[k]
	if !present {
		if !optional {
			p.add("%s: %q is required", where, k)
		}
		return
	}
	if _, ok := v.(bool); !ok {
		p.add("%s: %q must be true or false", where, k)
	}
}

func asNumber(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

func getNum(o map[string]any, k, where string, p *problems, lo, hi float64, integer bool) {
	v, present := o[k]
	if !present {
		return
	}
	f, ok := asNumber(v)
	if !ok || (integer && f != math.Trunc(f)) || f < lo || f > hi {
		kind := "a number"
		if integer {
			kind = "an integer"
		}
		p.add("%s: %q must be %s in [%v, %v]", where, k, kind, lo, hi)
	}
}

func getStrList(o map[string]any, k, where string, p *problems, max int, optional bool) ([]string, bool) {
	v, present := o[k]
	if !present {
		if !optional {
			p.add("%s: %q is required", where, k)
		}
		return nil, false
	}
	arr, ok := v.([]any)
	if !ok {
		p.add("%s: %q must be a list of strings", where, k)
		return nil, false
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, ok := x.(string)
		if !ok {
			p.add("%s: %q must be a list of strings", where, k)
			return nil, false
		}
		out = append(out, s)
	}
	if len(out) > max {
		p.add("%s: %q has more than %d entries", where, k, max)
		return nil, false
	}
	return out, true
}

func checkSelectors(o map[string]any, k, where string, p *problems) {
	list, _ := getStrList(o, k, where, p, maxSelectors, true)
	for _, s := range list {
		switch {
		case s == "" || utf8.RuneCountInString(s) > maxSelectorLen:
			p.add("%s.%s: a selector must be 1..%d characters", where, k, maxSelectorLen)
		// CSS decodes escapes and drops comments before it forms a function
		// token, so `:\has(` and `:/**/has(` are :has( to the engine. Refusing
		// what could spell it differently is the only check that needs no
		// tokenizer; control characters go with them (a newline ends an escape).
		case strings.Contains(s, `\`) || strings.Contains(s, "/*") || strings.IndexFunc(s, unicode.IsControl) >= 0:
			p.add("%s.%s: a selector must not contain a backslash, \"/*\" or a control character", where, k)
		case strings.Contains(strings.ToLower(s), ":has("):
			p.add("%s.%s: \":has(\" is not allowed", where, k)
		}
	}
}

func subObject(o map[string]any, k, where string, p *problems) (map[string]any, bool) {
	v, present := o[k]
	if !present {
		return nil, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		p.add("%s: %q must be an object", where, k)
		return nil, false
	}
	return m, true
}

var topFields = []string{
	"schema", "requires", "id", "keyPrefix", "name", "version", "adapter", "hosts", "pageHosts",
	"canonicalHost", "identity", "pathFallback", "video", "ads", "capabilities", "seek", "navigation",
	"continues", "examples", "notes",
}

func checkStructure(v any, p *problems) {
	o, ok := v.(map[string]any)
	if !ok {
		p.add("descriptor: must be a JSON object")
		return
	}
	const w = "descriptor"
	schema, ok := asNumber(o["schema"])
	if !ok || schema != math.Trunc(schema) || schema < 1 {
		p.add("%s: \"schema\" must be a positive integer", w)
		return
	}
	if schema > SchemaVersion {
		p.add("%s: schema %v is newer than this server understands (%d)", w, schema, SchemaVersion)
		return
	}
	onlyKeys(o, topFields, w, p)
	req, _ := getStrList(o, "requires", w, p, 16, true)
	for _, r := range req {
		if !contains(implemented, r) {
			p.add("%s: requires %q, which clients do not implement", w, r)
		}
	}
	getStr(o, "id", w, p, strOpt{re: reID})
	getStr(o, "keyPrefix", w, p, strOpt{optional: true, re: reKeyPref})
	getStr(o, "name", w, p, strOpt{max: 64})
	getStr(o, "version", w, p, strOpt{re: reVersion})
	if a, ok := getStr(o, "adapter", w, p, strOpt{}); ok && !contains(adapters, a) {
		p.add("%s: unknown adapter %q", w, a)
	}
	hosts, hostsOK := getStrList(o, "hosts", w, p, maxHosts, false)
	if hostsOK && len(hosts) == 0 {
		p.add("%s: \"hosts\" is empty", w)
	}
	for _, h := range hosts {
		if !validHostPattern(h) {
			p.add("%s: bad host %q", w, h)
		}
	}
	page, _ := getStrList(o, "pageHosts", w, p, maxHosts, true)
	for _, h := range page {
		if !validHostPattern(h) {
			p.add("%s: bad page host %q", w, h)
		} else if hostsOK && !coveredBy(h, hosts) {
			p.add("%s: page host %q is not in \"hosts\"", w, h)
		}
	}
	if c, ok := getStr(o, "canonicalHost", w, p, strOpt{}); ok {
		if strings.HasPrefix(c, "*.") || !validHostPattern(c) {
			p.add("%s: bad canonicalHost %q", w, c)
		} else if hostsOK && !coveredBy(c, hosts) {
			p.add("%s: canonicalHost %q is not in \"hosts\"", w, c)
		}
	}
	getBool(o, "pathFallback", w, p, false)

	if ids, ok := o["identity"].([]any); !ok {
		p.add("%s: \"identity\" must be a list", w)
	} else {
		if len(ids) > maxRules {
			p.add("%s: more than %d identity rules", w, maxRules)
		}
		for i, x := range ids {
			rw := fmt.Sprintf("identity[%d]", i)
			r, ok := x.(map[string]any)
			if !ok {
				p.add("%s: must be an object", rw)
				continue
			}
			onlyKeys(r, []string{"hosts", "path", "query", "key", "watch"}, rw, p)
			rh, _ := getStrList(r, "hosts", rw, p, maxHosts, true)
			for _, h := range rh {
				if !validHostPattern(h) {
					p.add("%s: bad host %q", rw, h)
				} else if hostsOK && !coveredBy(h, hosts) {
					p.add("%s: host %q is not in \"hosts\"", rw, h)
				}
			}
			getStr(r, "path", rw, p, strOpt{})
			getStr(r, "key", rw, p, strOpt{})
			getStr(r, "watch", rw, p, strOpt{})
			if q, present := r["query"]; present {
				if _, ok := q.(map[string]any); !ok {
					p.add("%s: \"query\" must be an object", rw)
				}
			}
		}
	}

	if m, ok := subObject(o, "video", w, p); ok {
		onlyKeys(m, []string{"include", "exclude", "pierceShadow", "minIntrinsicArea", "outclassedFactor"}, "video", p)
		checkSelectors(m, "include", "video", p)
		checkSelectors(m, "exclude", "video", p)
		getBool(m, "pierceShadow", "video", p, true)
		getNum(m, "minIntrinsicArea", "video", p, 0, 7680*4320, true)
		getNum(m, "outclassedFactor", "video", p, 1.5, 16, false)
	}
	if m, ok := subObject(o, "ads", w, p); ok {
		onlyKeys(m, []string{"activeWhen"}, "ads", p)
		checkSelectors(m, "activeWhen", "ads", p)
	}
	if m, ok := subObject(o, "capabilities", w, p); ok {
		onlyKeys(m, []string{"playbackRateNudge", "directSeek"}, "capabilities", p)
		getBool(m, "playbackRateNudge", "capabilities", p, true)
		getBool(m, "directSeek", "capabilities", p, true)
	}
	if m, ok := subObject(o, "seek", w, p); ok {
		onlyKeys(m, []string{"landingToleranceS", "timeoutMs", "typicalInBufferMs"}, "seek", p)
		getNum(m, "landingToleranceS", "seek", p, 0.05, 5, false)
		getNum(m, "timeoutMs", "seek", p, 1000, 60000, true)
		getNum(m, "typicalInBufferMs", "seek", p, 0, 60000, true)
	}
	if m, ok := subObject(o, "navigation", w, p); ok {
		onlyKeys(m, []string{"spa", "volatileElement", "siteAutoplaysNext"}, "navigation", p)
		getBool(m, "spa", "navigation", p, true)
		getBool(m, "volatileElement", "navigation", p, true)
		if v, present := m["siteAutoplaysNext"]; present && v != nil {
			getBool(m, "siteAutoplaysNext", "navigation", p, true)
		}
	}
	if c, present := o["continues"]; present {
		arr, ok := c.([]any)
		if !ok {
			p.add("%s: \"continues\" must be a list", w)
		} else {
			if len(arr) > maxContinues {
				p.add("%s: more than %d continues rules", w, maxContinues)
			}
			for i, x := range arr {
				cw := fmt.Sprintf("continues[%d]", i)
				m, ok := x.(map[string]any)
				if !ok {
					p.add("%s: must be an object", cw)
					continue
				}
				onlyKeys(m, []string{"from", "to"}, cw, p)
				getStr(m, "from", cw, p, strOpt{})
				getStr(m, "to", cw, p, strOpt{})
			}
		}
	}
	if ex, ok := o["examples"].([]any); !ok {
		p.add("%s: \"examples\" must be a list", w)
	} else {
		if len(ex) > maxExamples {
			p.add("%s: more than %d examples", w, maxExamples)
		}
		for i, x := range ex {
			ew := fmt.Sprintf("examples[%d]", i)
			e, ok := x.(map[string]any)
			if !ok {
				p.add("%s: must be an object", ew)
				continue
			}
			if _, isURL := e["url"]; isURL {
				onlyKeys(e, []string{"url", "key", "watch"}, ew, p)
				getStr(e, "url", ew, p, strOpt{max: 2048})
				if k, present := e["key"]; !present {
					p.add("%s: \"key\" is required (null for \"names no media\")", ew)
				} else if k != nil {
					getStr(e, "key", ew, p, strOpt{})
				}
				if wv, present := e["watch"]; present && wv != nil {
					getStr(e, "watch", ew, p, strOpt{})
				}
			} else {
				onlyKeys(e, []string{"from", "to", "continues"}, ew, p)
				getStr(e, "from", ew, p, strOpt{})
				getStr(e, "to", ew, p, strOpt{})
				getBool(e, "continues", ew, p, false)
			}
		}
	}
	getStr(o, "notes", w, p, strOpt{optional: true, max: 2048})
}

// --- compiled form ----------------------------------------------------------

type compiledRule struct {
	hosts []string
	path  *pathTemplate
	query *queryTemplate
	key   *textTemplate
	watch *textTemplate
}

type compiledContinues struct{ from, to *pathTemplate }

// Provider is a validated, compiled descriptor.
type Provider struct {
	D         Descriptor
	keyPrefix string
	rules     []compiledRule
	cont      []compiledContinues
}

func compile(d Descriptor, rawIdentity []any) (*Provider, error) {
	pr := &Provider{D: d, keyPrefix: d.KeyPrefix}
	if pr.keyPrefix == "" {
		pr.keyPrefix = d.ID
	}
	for i, r := range d.Identity {
		where := fmt.Sprintf("identity[%d]", i)
		path, err := parsePathTemplate(r.Path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", where, err)
		}
		var query *queryTemplate
		names := append([]string(nil), path.names...)
		if q, ok := rawIdentity[i].(map[string]any)["query"].(map[string]any); ok {
			query, err = parseQueryTemplate(q, path.names)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", where, err)
			}
			names = append(names, query.names...)
		}
		key, err := parseTextTemplate(r.Key, names, maxKeyTemplate)
		if err != nil {
			return nil, fmt.Errorf("%s.key: %w", where, err)
		}
		watch, err := parseTextTemplate(r.Watch, names, maxWatchTemplate)
		if err != nil {
			return nil, fmt.Errorf("%s.watch: %w", where, err)
		}
		if err := checkWatchTemplate(r.Watch, d.Hosts); err != nil {
			return nil, fmt.Errorf("%s.watch: %w", where, err)
		}
		if query == nil && len(path.segments) == 1 && path.segments[0].kind == segRest {
			return nil, fmt.Errorf("%s: \"/**\" with no query would name every page as media", where)
		}
		pr.rules = append(pr.rules, compiledRule{hosts: r.Hosts, path: path, query: query, key: key, watch: watch})
	}
	for i, c := range d.Continues {
		from, err := parsePathTemplate(c.From)
		if err != nil {
			return nil, fmt.Errorf("continues[%d].from: %w", i, err)
		}
		to, err := parsePathTemplate(c.To)
		if err != nil {
			return nil, fmt.Errorf("continues[%d].to: %w", i, err)
		}
		pr.cont = append(pr.cont, compiledContinues{from, to})
	}
	return pr, nil
}

func checkWatchTemplate(src string, hosts []string) error {
	m := reWatch.FindStringSubmatch(src)
	if m == nil {
		return errors.New("must be https://<host>/... with no placeholder in the host")
	}
	host := m[1]
	if !validHostPattern(host) || strings.HasPrefix(host, "*.") {
		return fmt.Errorf("bad host %q", host)
	}
	if !coveredBy(host, hosts) {
		return fmt.Errorf("host %q is not in \"hosts\"", host)
	}
	rest := m[2]
	if _, q, ok := strings.Cut(rest, "?"); ok {
		for _, pair := range strings.Split(q, "&") {
			name, _, _ := strings.Cut(pair, "=")
			if strings.ContainsAny(name, "{}") {
				return errors.New("a placeholder may not name a query parameter")
			}
		}
	}
	return nil
}

// Claims reports how specifically this descriptor claims hostname (0: not at all).
func (pr *Provider) Claims(hostname string) int { return bestHostScore(pr.D.Hosts, hostname) }

// ID is the descriptor's id.
func (pr *Provider) ID() string { return pr.D.ID }

// parsedURL is the part of a WHATWG URL the evaluator reads.
type parsedURL struct {
	scheme, hostname, pathname, search string
}

func parseURL(href string) (parsedURL, bool) {
	u, err := url.Parse(href)
	if err != nil || u.Opaque != "" || u.Host == "" {
		return parsedURL{}, false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return parsedURL{}, false
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	search := ""
	if u.RawQuery != "" {
		search = "?" + u.RawQuery
	}
	return parsedURL{scheme: scheme, hostname: strings.ToLower(u.Hostname()), pathname: path, search: search}, true
}

func (pr *Provider) match(u parsedURL) (*compiledRule, map[string]string) {
	for i := range pr.rules {
		r := &pr.rules[i]
		if r.hosts != nil && bestHostScore(r.hosts, u.hostname) == 0 {
			continue
		}
		caps := matchPath(r.path, u.pathname)
		if caps == nil {
			continue
		}
		if r.query != nil {
			q := matchQuery(r.query, u.search)
			if q == nil {
				continue
			}
			for k, v := range q {
				caps[k] = v
			}
		}
		return r, caps
	}
	return nil, nil
}

func genericPath(u parsedURL) string {
	p := strings.TrimRight(u.pathname, "/")
	return p
}

// keyFor returns the key and whether the page names media at all.
func (pr *Provider) keyFor(u parsedURL) (string, bool) {
	if r, caps := pr.match(u); r != nil {
		return pr.keyPrefix + ":" + substitute(r.key, caps, false), true
	}
	if !pr.D.PathFallback {
		return "", false
	}
	if p := genericPath(u); p != "" {
		return pr.keyPrefix + ":" + p, true
	}
	return "", false
}

func (pr *Provider) rawWatchFor(u parsedURL) string {
	if r, caps := pr.match(u); r != nil {
		return substitute(r.watch, caps, true)
	}
	if !pr.D.PathFallback {
		return ""
	}
	if p := genericPath(u); p != "" {
		return "https://" + pr.D.CanonicalHost + p
	}
	return ""
}

func (pr *Provider) roundTrips(watch, key string) bool {
	w, ok := parseURL(watch)
	if !ok || w.scheme != "https" || pr.Claims(w.hostname) == 0 {
		return false
	}
	k, named := pr.keyFor(w)
	return named && k == key
}

// Evaluate is what an example asserts: the key (named false for "no media")
// and the checked watch URL ("" when there is none), for one URL against this
// descriptor alone.
func (pr *Provider) Evaluate(href string) (key string, named bool, watch string) {
	u, ok := parseURL(href)
	if !ok || pr.Claims(u.hostname) == 0 {
		return "", false, ""
	}
	key, named = pr.keyFor(u)
	if !named {
		return "", false, ""
	}
	if raw := pr.rawWatchFor(u); raw != "" && pr.roundTrips(raw, key) {
		watch = raw
	}
	return key, true, watch
}

func matchBody(t *pathTemplate, body string) map[string]string {
	parts := strings.Split(body, "/")
	for i, s := range parts {
		parts[i] = encodeComponent(s)
	}
	return matchPath(t, strings.Join(parts, "/"))
}

// Continues reports whether media next carries on from prev.
func (pr *Provider) Continues(prev, next string) bool {
	pre := pr.keyPrefix + ":"
	if !strings.HasPrefix(prev, pre) || !strings.HasPrefix(next, pre) || prev == next {
		return false
	}
	a, b := prev[len(pre):], next[len(pre):]
	for _, c := range pr.cont {
		ca := matchBody(c.from, a)
		if ca == nil {
			continue
		}
		cb := matchBody(c.to, b)
		if cb == nil {
			continue
		}
		same := true
		for k, v := range ca {
			if w, ok := cb[k]; ok && w != v {
				same = false
			}
		}
		if same {
			return true
		}
	}
	return false
}

func (pr *Provider) runExamples() []string {
	var out []string
	positive := false
	for i, raw := range pr.D.Examples {
		w := fmt.Sprintf("examples[%d]", i)
		var e Example
		if err := json.Unmarshal(raw, &e); err != nil {
			out = append(out, fmt.Sprintf("%s: %v", w, err))
			continue
		}
		if e.URL != nil {
			if e.Key != nil {
				positive = true
			}
			// `"watch": null` asserts "no watch URL", which a *string cannot
			// tell apart from an absent field. The client compares it, so
			// this port must too, or the server lists what clients refuse.
			var fields map[string]json.RawMessage
			json.Unmarshal(raw, &fields)
			watchNull := string(bytes.TrimSpace(fields["watch"])) == "null"
			key, named, watch := pr.Evaluate(*e.URL)
			switch {
			case named != (e.Key != nil) || (named && key != *e.Key):
				out = append(out, fmt.Sprintf("%s: %s gives key %q (media: %v), expected %v", w, *e.URL, key, named, strOrNull(e.Key)))
			case named && watch == "":
				out = append(out, fmt.Sprintf("%s: %s has no watch URL that names the same media", w, *e.URL))
			case watchNull && watch != "":
				out = append(out, fmt.Sprintf("%s: %s gives watch %q, expected null", w, *e.URL, watch))
			case e.Watch != nil && watch != *e.Watch:
				out = append(out, fmt.Sprintf("%s: %s gives watch %q, expected %q", w, *e.URL, watch, *e.Watch))
			}
			continue
		}
		want := e.Continues != nil && *e.Continues
		if pr.Continues(e.From, e.To) != want {
			out = append(out, fmt.Sprintf("%s: %s -> %s should continue: %v", w, e.From, e.To, want))
		}
	}
	if !positive {
		out = append([]string{"examples: at least one example must name media"}, out...)
	}
	return out
}

func strOrNull(s *string) string {
	if s == nil {
		return "null"
	}
	return fmt.Sprintf("%q", *s)
}

// ValidationError lists everything wrong with a descriptor.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string { return strings.Join(e.Problems, "; ") }

func invalid(ps ...string) error { return &ValidationError{Problems: ps} }

// Parse validates descriptor bytes the way a client will: size, shape,
// templates and examples. It returns the compiled descriptor or a
// *ValidationError.
func Parse(data []byte) (*Provider, error) {
	if len(data) > MaxBytes {
		return nil, invalid(fmt.Sprintf("descriptor: larger than %d bytes", MaxBytes))
	}
	if !utf8.Valid(data) {
		return nil, invalid("descriptor: not UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, invalid(fmt.Sprintf("descriptor: not JSON (%v)", err))
	}
	if dec.More() {
		return nil, invalid("descriptor: trailing data after the JSON value")
	}
	return compileTree(tree)
}

func compileTree(tree any) (*Provider, error) {
	var p problems
	checkStructure(tree, &p)
	if len(p.list) > 0 {
		return nil, invalid(p.list...)
	}
	// The shape is right; now the typed form, with the stdlib's own
	// unknown-field check as a second line.
	norm, err := json.Marshal(tree)
	if err != nil {
		return nil, invalid(err.Error())
	}
	var d Descriptor
	dec := json.NewDecoder(bytes.NewReader(norm))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return nil, invalid(fmt.Sprintf("descriptor: %v", err))
	}
	rawIdentity := tree.(map[string]any)["identity"].([]any)
	pr, err := compile(d, rawIdentity)
	if err != nil {
		return nil, invalid(err.Error())
	}
	if failed := pr.runExamples(); len(failed) > 0 {
		return nil, invalid(failed...)
	}
	return pr, nil
}
