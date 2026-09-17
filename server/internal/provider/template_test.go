package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The vectors are shared with client/core/test/providers.test.ts.
var testdata = filepath.Join("..", "..", "..", "providers", "testdata")

func readVectors(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testdata, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

type templateVectors struct {
	Path []struct {
		Template string `json:"template"`
		Cases    []struct {
			Path     string             `json:"path"`
			Captures *map[string]string `json:"captures"`
		} `json:"cases"`
	} `json:"path"`
	InvalidPath []string `json:"invalidPath"`
	Query       []struct {
		Template map[string]any `json:"template"`
		Cases    []struct {
			Search   string             `json:"search"`
			Captures *map[string]string `json:"captures"`
		} `json:"cases"`
	} `json:"query"`
	Pathnames []struct {
		URL      string `json:"url"`
		Pathname string `json:"pathname"`
	} `json:"pathnames"`
	URLs []struct {
		URL      string `json:"url"`
		Plain    bool   `json:"plain"`
		Hostname string `json:"hostname"`
		Pathname string `json:"pathname"`
		Search   string `json:"search"`
	} `json:"urls"`
	InvalidQuery []map[string]any `json:"invalidQuery"`
	Substitute   []struct {
		Template string            `json:"template"`
		Captures map[string]string `json:"captures"`
		Encode   bool              `json:"encode"`
		Out      string            `json:"out"`
	} `json:"substitute"`
	Hosts []struct {
		Pattern string `json:"pattern"`
		Host    string `json:"host"`
		Score   int    `json:"score"`
	} `json:"hosts"`
	InvalidHosts []string `json:"invalidHosts"`
	ValidHosts   []string `json:"validHosts"`
}

func capsEqual(got map[string]string, want *map[string]string) bool {
	if want == nil {
		return got == nil
	}
	return got != nil && reflect.DeepEqual(got, *want)
}

func TestTemplateVectors(t *testing.T) {
	var v templateVectors
	readVectors(t, "templates.json", &v)
	if len(v.Path) == 0 || len(v.Query) == 0 || len(v.Pathnames) == 0 || len(v.Hosts) == 0 {
		t.Fatal("vectors did not load")
	}

	for _, g := range v.Path {
		tpl, err := parsePathTemplate(g.Template)
		if err != nil {
			t.Fatalf("%s: %v", g.Template, err)
		}
		for _, c := range g.Cases {
			if got := matchPath(tpl, c.Path); !capsEqual(got, c.Captures) {
				t.Errorf("%s vs %q: got %v, want %v", g.Template, c.Path, got, c.Captures)
			}
		}
	}
	for _, src := range v.InvalidPath {
		if _, err := parsePathTemplate(src); err == nil {
			t.Errorf("path template %q was accepted", src)
		}
	}
	for _, g := range v.Query {
		tpl, err := parseQueryTemplate(g.Template, nil)
		if err != nil {
			t.Fatalf("%v: %v", g.Template, err)
		}
		for _, c := range g.Cases {
			if got := matchQuery(tpl, c.Search); !capsEqual(got, c.Captures) {
				t.Errorf("%v vs %q: got %v, want %v", g.Template, c.Search, got, c.Captures)
			}
		}
	}
	for _, c := range v.Pathnames {
		if u, ok := parseURL(c.URL); !ok || u.pathname != c.Pathname {
			t.Errorf("%s: pathname %q (ok %v), want %q", c.URL, u.pathname, ok, c.Pathname)
		}
	}
	if len(v.URLs) == 0 {
		t.Fatal("url vectors did not load")
	}
	for _, c := range v.URLs {
		if got := plainURL(c.URL); got != c.Plain {
			t.Errorf("%q: plain %v, want %v", c.URL, got, c.Plain)
			continue
		}
		if !c.Plain {
			continue
		}
		u, ok := parseURL(c.URL)
		if !ok || u.hostname != c.Hostname || u.pathname != c.Pathname || u.search != c.Search {
			t.Errorf("%q: parsed (%v) as %q %q %q, want %q %q %q", c.URL, ok, u.hostname, u.pathname, u.search,
				c.Hostname, c.Pathname, c.Search)
		}
	}
	for _, c := range v.Pathnames {
		if !plainURL(c.URL) {
			t.Errorf("%s: a pathname vector is not a plain URL", c.URL)
		}
	}
	for _, q := range v.InvalidQuery {
		if _, err := parseQueryTemplate(q, nil); err == nil {
			t.Errorf("query template %v was accepted", q)
		}
	}
	for _, c := range v.Substitute {
		names := make([]string, 0, len(c.Captures))
		for k := range c.Captures {
			names = append(names, k)
		}
		tpl, err := parseTextTemplate(c.Template, names, 512)
		if err != nil {
			t.Fatalf("%s: %v", c.Template, err)
		}
		if got := substitute(tpl, c.Captures, c.Encode); got != c.Out {
			t.Errorf("%s: got %q, want %q", c.Template, got, c.Out)
		}
	}
	for _, c := range v.Hosts {
		if got := hostScore(c.Pattern, c.Host); got != c.Score {
			t.Errorf("%s vs %s: score %d, want %d", c.Pattern, c.Host, got, c.Score)
		}
	}
	for _, h := range v.InvalidHosts {
		if validHostPattern(h) {
			t.Errorf("host %q was accepted", h)
		}
	}
	for _, h := range v.ValidHosts {
		if !validHostPattern(h) {
			t.Errorf("host %q was refused", h)
		}
	}
}

func TestEncodeComponentIsEncodeURIComponent(t *testing.T) {
	for in, want := range map[string]string{
		"!'()*-._~ /": "!'()*-._~%20%2F",
		"a+b&c=d?e#f": "a%2Bb%26c%3Dd%3Fe%23f",
		"é":           "%C3%A9",
	} {
		if got := encodeComponent(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestMatchingIsLinear(t *testing.T) {
	// The reason there is no regex: a room member chooses the URL.
	tpl, err := parsePathTemplate("/{a:any}/{b:any}/{c:any}/{d:any}/**")
	if err != nil {
		t.Fatal(err)
	}
	hostile := "/" + strings.Repeat("a/", 100_000) + "!"
	start := time.Now()
	for i := 0; i < 10; i++ {
		matchPath(tpl, hostile)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("matching a 200 kB path took %v", d)
	}
}

type descriptorVectors struct {
	Base  map[string]any `json:"base"`
	Cases []struct {
		Name    string         `json:"name"`
		Valid   bool           `json:"valid"`
		Set     map[string]any `json:"set"`
		Control map[string]any `json:"control"`
		Replace any            `json:"replace"`
	} `json:"cases"`
}

func TestDescriptorVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(testdata, "descriptors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v descriptorVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 10 {
		t.Fatal("vectors did not load")
	}
	build := func(layers ...map[string]any) []byte {
		d := map[string]any{}
		for k, x := range v.Base {
			d[k] = x
		}
		for _, l := range layers {
			for k, x := range l {
				if x == nil {
					delete(d, k)
				} else {
					d[k] = x
				}
			}
		}
		b, err := json.Marshal(d)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	controls := 0
	for _, c := range v.Cases {
		var b []byte
		if c.Replace != nil {
			b, _ = json.Marshal(c.Replace)
		} else {
			b = build(c.Set)
		}
		_, err := Parse(b)
		if (err == nil) != c.Valid {
			t.Errorf("%s: valid=%v, got err=%v", c.Name, c.Valid, err)
		}
		if c.Control != nil {
			// Rejected for the named reason alone: take it out and nothing
			// else is wrong.
			controls++
			if _, err := Parse(build(c.Set, c.Control)); err != nil {
				t.Errorf("%s: its control is rejected too: %v", c.Name, err)
			}
		}
	}
	if controls < 10 {
		t.Fatal("the controls did not load")
	}
}

func TestBuiltinDescriptorsAreValid(t *testing.T) {
	// The server must accept what ships in the bundles: an operator mounting
	// providers/ as-is gets every file offered.
	files, err := filepath.Glob(filepath.Join(testdata, "..", "*.json"))
	if err != nil || len(files) < 2 {
		t.Fatalf("built-ins not found: %v %v", files, err)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		pr, err := Parse(b)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		if filepath.Base(f) == "laftel.json" {
			if !pr.Continues("laftel:/player/1/2", "laftel:/player/1/3") || pr.Continues("laftel:/player/1/2", "laftel:/player/2/3") {
				t.Error("laftel continues rule")
			}
			if _, named, _ := pr.Evaluate("https://laftel.net/logout"); named {
				t.Error("laftel names /logout as media")
			}
		}
	}
}

func TestParseRefusesWhatJSONParseRefuses(t *testing.T) {
	for _, s := range []string{`{"schema":1`, `{"schema":1} x`, "\xff", `[]`, `null`} {
		if _, err := Parse([]byte(s)); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
	big := make([]byte, MaxBytes+1)
	if _, err := Parse(big); err == nil {
		t.Error("oversized accepted")
	}
}
