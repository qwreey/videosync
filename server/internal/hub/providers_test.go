package hub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qwreey/videosync/server/internal/auth"
	"github.com/qwreey/videosync/server/internal/provider"
)

func providersDir(t *testing.T) (string, []byte) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "providers", "laftel.json"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "laftel.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.json"), []byte(`{"schema":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir, body
}

func get(t *testing.T, url string, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func TestProvidersIndexAndFiles(t *testing.T) {
	dir, body := providersDir(t)
	f := start(t, func(c *Config) { c.Providers = provider.Open(dir, t.Logf) })

	resp, b := get(t, f.srv.URL+"/api/providers", map[string]string{"Origin": "https://laftel.net"})
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("index: %d, CORS %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
	var idx struct {
		Schema    int `json:"schema"`
		Providers []struct {
			ID, Name, Version, SHA256 string
			Hosts                     []string
		} `json:"providers"`
	}
	if err := json.Unmarshal(b, &idx); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	want := hex.EncodeToString(sum[:])
	if idx.Schema != 1 || len(idx.Providers) != 1 || idx.Providers[0].ID != "laftel" || idx.Providers[0].SHA256 != want {
		t.Fatalf("index: %s", b)
	}

	// The file is the exact bytes the index hashes: a client pins that hash.
	resp, b = get(t, f.srv.URL+"/api/providers/laftel.json", map[string]string{"Origin": "https://laftel.net"})
	if resp.StatusCode != 200 || string(b) != string(body) {
		t.Fatalf("file: %d, %d bytes", resp.StatusCode, len(b))
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Error("the file has no CORS header; a content script could not read it")
	}
	etag := resp.Header.Get("ETag")
	if etag != `"`+want+`"` {
		t.Errorf("ETag %q", etag)
	}
	resp, b = get(t, f.srv.URL+"/api/providers/laftel.json", map[string]string{"If-None-Match": etag})
	if resp.StatusCode != http.StatusNotModified || len(b) != 0 {
		t.Errorf("revalidation: %d", resp.StatusCode)
	}

	for _, path := range []string{"laftel", "bad.json", "nope.json", "..%2Flaftel.json", "laftel.json.json"} {
		if resp, _ := get(t, f.srv.URL+"/api/providers/"+path, nil); resp.StatusCode != 404 {
			t.Errorf("%s: %d", path, resp.StatusCode)
		}
	}
}

func TestProvidersPreflight(t *testing.T) {
	f := start(t, nil)
	for _, path := range []string{"/api/providers", "/api/providers/laftel.json"} {
		req, _ := http.NewRequest("OPTIONS", f.srv.URL+path, nil)
		req.Header.Set("Origin", "https://www.youtube.com")
		req.Header.Set("Access-Control-Request-Method", "GET")
		req.Header.Set("Access-Control-Request-Private-Network", "true")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Private-Network") != "true" ||
			resp.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s: %d %v", path, resp.StatusCode, resp.Header)
		}
	}
}

func TestProvidersWithoutADirectoryOfferNothing(t *testing.T) {
	f := start(t, nil)
	resp, b := get(t, f.srv.URL+"/api/providers", nil)
	if resp.StatusCode != 200 || string(b) != `{"schema":1,"providers":[]}` {
		t.Errorf("%d %s", resp.StatusCode, b)
	}
	if resp, _ := get(t, f.srv.URL+"/api/providers/laftel.json", nil); resp.StatusCode != 404 {
		t.Errorf("file: %d", resp.StatusCode)
	}
}

func TestProvidersHonourTheOriginAllowlist(t *testing.T) {
	dir, _ := providersDir(t)
	cfg := DefaultConfig()
	cfg.Providers = provider.Open(dir, t.Logf)
	h := New(cfg, NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.AllowedOrigins = []string{"chrome-extension://abc"}
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	resp, _ := get(t, srv.URL+"/api/providers", map[string]string{"Origin": "chrome-extension://abc"})
	if resp.Header.Get("Access-Control-Allow-Origin") != "chrome-extension://abc" {
		t.Errorf("allowed origin not echoed: %v", resp.Header)
	}
	resp, _ = get(t, srv.URL+"/api/providers", map[string]string{"Origin": "https://evil.example"})
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("another origin was allowed: %v", resp.Header)
	}
}

func TestProvidersReloadIsVisible(t *testing.T) {
	dir, _ := providersDir(t)
	store := provider.Open(dir, t.Logf)
	f := start(t, func(c *Config) { c.Providers = store })
	yt, err := os.ReadFile(filepath.Join("..", "..", "..", "providers", "youtube.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "youtube.json"), yt, 0o644); err != nil {
		t.Fatal(err)
	}
	if resp, _ := get(t, f.srv.URL+"/api/providers/yt.json", nil); resp.StatusCode != 404 {
		t.Fatal("served before a reload")
	}
	store.Reload() // what SIGHUP does
	if resp, b := get(t, f.srv.URL+"/api/providers/yt.json", nil); resp.StatusCode != 200 || string(b) != string(yt) {
		t.Fatalf("after reload: %d", resp.StatusCode)
	}
}

// With access control on, the listing is gated like room creation, in every
// scope, and a device token is what admits. Off, it stays open (the test
// above).
func TestProvidersAreGatedWithAccessControl(t *testing.T) {
	dir, body := providersDir(t)
	for _, scope := range []auth.Scope{auth.ScopeCreate, auth.ScopeAll} {
		f := startAuth(t, scope, func(c *Config) { c.Providers = provider.Open(dir, t.Logf) })
		for _, p := range []string{"/api/providers", "/api/providers/laftel.json"} {
			resp, b := get(t, f.srv.URL+p, map[string]string{"Origin": "https://laftel.net"})
			if resp.StatusCode != 401 || !strings.Contains(string(b), "auth_required") {
				t.Fatalf("%s %s without a token: %d %s", scope, p, resp.StatusCode, b)
			}
			if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("%s: the refusal is unreadable from a page", p)
			}
			// A key is a credential for /api/session, not a pass here; nor is
			// a ticket, and neither is spent by trying.
			tk := f.ticket()
			for _, bad := range []string{"Bearer " + accessKey, "Bearer " + tk, "Bearer junk"} {
				resp, _ = get(t, f.srv.URL+p, map[string]string{"Authorization": bad})
				if resp.StatusCode != 401 {
					t.Fatalf("%s admitted %q: %d", p, bad, resp.StatusCode)
				}
			}
			if code, out := f.createWith(tk); code != 201 {
				t.Fatalf("the refused listing spent the ticket: %d %v", code, out)
			}
			// The preflight stays open: a gated preflight is a bare "Failed to fetch".
			req, _ := http.NewRequest("OPTIONS", f.srv.URL+p, nil)
			req.Header.Set("Origin", "https://laftel.net")
			req.Header.Set("Access-Control-Request-Headers", "authorization")
			pre, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			pre.Body.Close()
			if pre.StatusCode != 204 {
				t.Fatalf("preflight %s: %d", p, pre.StatusCode)
			}
		}
		code, s := f.post("/api/session", "Bearer "+accessKey, "")
		if code != 200 {
			t.Fatalf("session: %d", code)
		}
		device := map[string]string{"Authorization": "Bearer " + s["token"].(string)}
		resp, b := get(t, f.srv.URL+"/api/providers", device)
		if resp.StatusCode != 200 || !strings.Contains(string(b), `"laftel"`) {
			t.Fatalf("%s index with a device token: %d %s", scope, resp.StatusCode, b)
		}
		resp, b = get(t, f.srv.URL+"/api/providers/laftel.json", device)
		if resp.StatusCode != 200 || string(b) != string(body) {
			t.Fatalf("%s file with a device token: %d", scope, resp.StatusCode)
		}
	}
}
