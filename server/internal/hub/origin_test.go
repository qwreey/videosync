package hub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/qwreey/videosync/server/internal/ws"
)

// The extension's background opens the socket and makes every API call
// itself, so its requests carry the extension's Origin, never the site's. A
// Firefox install's moz-extension:// UUID is random per install, so no
// operator can list it: an allowlist of sites alone locked every extension
// user out (403 on /ws, no Allow-Origin on /api) while userscript users on the
// same server worked. "<extension scheme>://*" admits that scheme's origins.
func TestAnAllowlistCanAdmitExtensionsByScheme(t *testing.T) {
	h := New(DefaultConfig(), NewClock())
	hcfg := DefaultHTTPConfig()
	hcfg.AllowedOrigins = []string{"https://laftel.net", "moz-extension://*"}
	srv := httptest.NewServer(h.Handler(hcfg))
	t.Cleanup(func() { srv.Close(); h.Close() })

	admitted := func(origin string) (upgrade bool, acao string) {
		t.Helper()
		if c, err := ws.Dial(srv.URL+"/ws", http.Header{"Origin": {origin}}); err == nil {
			upgrade = true
			c.Close(ws.CloseNormal, "")
		}
		req, _ := http.NewRequest("POST", srv.URL+"/api/rooms", strings.NewReader("{}"))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return upgrade, resp.Header.Get("Access-Control-Allow-Origin")
	}
	for origin, want := range map[string]bool{
		"https://laftel.net": true,
		"moz-extension://0c4f2d8e-6b1a-4e7c-9a55-3f1d2b7e8a90": true,
		"MOZ-EXTENSION://0c4f2d8e-6b1a-4e7c-9a55-3f1d2b7e8a90": true,
		// Not listed: a scheme wildcard admits its own scheme only.
		"chrome-extension://abcdefghijklmnopabcdefghijklmnop": false,
		// A page cannot claim the scheme.
		"https://moz-extension.example": false,
		"moz-extension://":              false,
		"null":                          false,
		"https://evil.example":          false,
	} {
		upgrade, acao := admitted(origin)
		if upgrade != want {
			t.Errorf("%s: upgraded = %v, want %v", origin, upgrade, want)
		}
		if (acao == origin) != want || (acao != "" && acao != origin) {
			t.Errorf("%s: Access-Control-Allow-Origin = %q, want admitted = %v", origin, acao, want)
		}
	}
}

// Only the extension schemes take a wildcard: "https://*" is not a pattern,
// and matches nothing but itself.
func TestOnlyExtensionSchemesTakeAWildcard(t *testing.T) {
	if originAllowed([]string{"https://*"}, "https://evil.example") {
		t.Error(`"https://*" admitted a site`)
	}
	if !originAllowed([]string{"chrome-extension://*"}, "chrome-extension://abc") {
		t.Error(`"chrome-extension://*" refused a Chrome extension`)
	}
	if originAllowed([]string{"chrome-extension://*"}, "moz-extension://abc") {
		t.Error(`"chrome-extension://*" admitted a Firefox extension`)
	}
	// A longer listed scheme than the origin's.
	if originAllowed([]string{"safari-web-extension://*"}, "moz-extension://a") {
		t.Error(`"safari-web-extension://*" admitted a Firefox extension`)
	}
}
