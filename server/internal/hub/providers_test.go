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
	"testing"

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
