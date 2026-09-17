package main

import (
	"bytes"
	"strings"
	"testing"

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

func keys(m map[string]auth.PasswordHash) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
