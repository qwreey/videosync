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
		// Kept byte for byte, not re-encoded the Go way: a client checks that
		// the URL normalises to the room's key, and its WHATWG parser leaves
		// these as they are. Go writes "|" as %7C and refuses a stray "%"
		// outright, and either made the room's own URL unfollowable.
		"https://site.example/v/foo|bar",
		"https://site.example/50%off/ep1",
		"https://site.example/v/%E4%B8%80%7C",
		"https://site.example/v/100%",
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
		"https://laftel.net/player/1/2#",
		"https://laftel.net/player/1/2%#videosync=room.secret",
		"https://site.example/a\nb",
		"https://si%te.example/a",
		"https://%zz@site.example/a",
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
