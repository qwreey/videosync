package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/auth"
)

// A line hash-password prints must be a line the users file reads back under
// the same name. ParseUsers trims each line and skips '#' lines as comments,
// so a name starting with '#' or with whitespace was printed, exit 0, and then
// silently dropped or renamed: every sign-in as that name was a 401, and a
// file holding only that line refused to start with "no users in file".
func TestEveryNameHashPasswordAcceptsIsReadBackAsItself(t *testing.T) {
	for _, user := range []string{
		"alice", "#alice", " alice", "alice ", "\talice", "a#b", "bob smith", "ㅇㅇ", "a ",
	} {
		var out, errOut bytes.Buffer
		code := hashPassword([]string{"-iterations", "10000", user}, strings.NewReader("pw\n"), &out, &errOut)
		if code != 0 {
			if out.Len() != 0 {
				t.Errorf("%q: refused (%d) but still printed %q", user, code, out.String())
			}
			continue
		}
		users, err := auth.ParseUsers(&out)
		if err != nil {
			t.Errorf("%q: accepted, but the users file reads its line as: %v", user, err)
			continue
		}
		if _, ok := users[user]; !ok || len(users) != 1 {
			t.Errorf("%q: accepted, but the users file holds %v", user, keys(users))
		}
	}
	// The control: ordinary names, including inner spaces and '#', still work.
	for _, user := range []string{"alice", "a#b", "bob smith"} {
		var out bytes.Buffer
		if code := hashPassword([]string{"-iterations", "10000", user}, strings.NewReader("pw\n"), &out, &bytes.Buffer{}); code != 0 {
			t.Errorf("%q refused (%d)", user, code)
		}
	}
}

// testFlags is authFlags with its defaults, without touching flag.CommandLine
// (registerAuthFlags may run once per process).
func testFlags(t *testing.T, set func(*authFlags)) authFlags {
	t.Helper()
	s := func(v string) *string { return &v }
	ttl := 30 * 24 * time.Hour
	keyFile := filepath.Join(t.TempDir(), "keys")
	if err := os.WriteFile(keyFile, []byte("a-long-enough-access-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := authFlags{
		methods: s("token"), scope: s("create"), tokensFile: s(keyFile), usersFile: s(""), keyFile: s(""),
		tokenTTL: &ttl, proxies: s(""), userHeader: s(""), publicURL: s(""), issuer: s(""),
		clientID: s(""), clientSecret: s(""), allow: s(""),
	}
	set(&f)
	return f
}

// Without -public-url the login link is built from the Host header, and
// nginx's proxy_pass sends the upstream's (127.0.0.1:8080) unless told
// otherwise: the panel then opens the visitor's own loopback and sign-in never
// completes. A server that knows it sits behind a proxy says so at startup.
func TestAServerBehindAProxyAsksForItsPublicURL(t *testing.T) {
	warns := func(f authFlags) bool {
		t.Helper()
		_, notes, err := f.build()
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range notes {
			if strings.Contains(n, "-public-url") {
				return true
			}
		}
		return false
	}
	behind := func(f *authFlags) { *f.proxies = "127.0.0.1" }
	if !warns(testFlags(t, behind)) {
		t.Error("-trusted-proxies without -public-url: no word at startup")
	}
	if warns(testFlags(t, func(f *authFlags) { behind(f); *f.publicURL = "https://sync.example.com" })) {
		t.Error("warned with -public-url set")
	}
	if warns(testFlags(t, func(*authFlags) {})) {
		t.Error("warned with no proxy configured")
	}
}

func keys(m map[string]auth.PasswordHash) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
