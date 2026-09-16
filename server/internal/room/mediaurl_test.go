package room

import (
	"strings"
	"testing"
)

func TestSanitizeMediaURL(t *testing.T) {
	keep := []string{
		"https://laftel.net/player/45462/93304",
		"https://www.youtube.com/watch?v=aqz-KE-bpKQ",
		"http://127.0.0.1:9000/page.html",
	}
	for _, u := range keep {
		if got := SanitizeMediaURL(u); got != u {
			t.Errorf("SanitizeMediaURL(%q) = %q, want it kept", u, got)
		}
	}
	drop := []string{
		"",
		"javascript:alert(1)",
		"data:text/html,hi",
		"file:///etc/passwd",
		"https://user:pw@laftel.net/player/1/2",
		"https://laftel.net/player/1/2#videosync=room.secret",
		"//laftel.net/player/1/2",
		"laftel.net/player/1/2",
		"https://laftel.net/" + strings.Repeat("a", 600),
	}
	for _, u := range drop {
		if got := SanitizeMediaURL(u); got != "" {
			t.Errorf("SanitizeMediaURL(%q) = %q, want it dropped", u, got)
		}
	}
}
