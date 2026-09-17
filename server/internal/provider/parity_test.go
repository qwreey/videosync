package provider

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// Cases where this port must give the answer a browser gives. The expected
// values were read from Node's URL and URLSearchParams, which implement the
// WHATWG algorithms the client runs; a mismatch means the server lists a
// descriptor every client refuses, or refuses one they would take.

func TestParseRefusesTrailingDataLikeJSONParse(t *testing.T) {
	yt := builtin(t, "youtube.json")
	// json.Decoder.More reports false before '}' and ']', so those were let
	// through; JSON.parse refuses every non-space byte after the value.
	for _, suffix := range []string{"}", "]", "}}", " ]", "\n}", "x", "{}", "0"} {
		if _, err := Parse(append(bytes.Clone(yt), suffix...)); err == nil {
			t.Errorf("trailing %q accepted", suffix)
		}
	}
	// Control: trailing whitespace is fine for JSON.parse too.
	for _, suffix := range []string{"", "\n", " \t\r\n"} {
		if _, err := Parse(append(bytes.Clone(yt), suffix...)); err != nil {
			t.Errorf("trailing %q refused: %v", suffix, err)
		}
	}
}

// The per-byte U+FFFD decoding of query values and the dot-segment cases
// of pathnames are in providers/testdata/templates.json, which the client
// suite checks against URLSearchParams and URL too.

func TestExamplesWithDotSegmentsKeyLikeTheClient(t *testing.T) {
	// Examples the client accepts (checked against
	// parseDescriptor) are accepted here too.
	for _, ex := range []string{
		`{"url":"https://www.youtube.com/watch/../watch?v=abc","key":"yt:abc"}`,
		`{"url":"https://www.youtube.com/x/..","key":null}`,
	} {
		if _, err := Parse(withExample(t, ex)); err != nil {
			t.Errorf("%s: refused: %v", ex, err)
		}
	}
}

// withExample is youtube.json with one more example appended.
func withExample(t *testing.T, example string) []byte {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal(builtin(t, "youtube.json"), &d); err != nil {
		t.Fatal(err)
	}
	var e any
	if err := json.Unmarshal([]byte(example), &e); err != nil {
		t.Fatal(err)
	}
	d["examples"] = append(d["examples"].([]any), e)
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestExampleExpectingAnEmptyWatchNeverPasses(t *testing.T) {
	// The client's evaluate gives null for "no watch URL" and never "", so
	// an example asserting "" fails there whatever the URL.
	for _, ex := range []string{
		`{"url":"https://www.youtube.com/results?search_query=x","key":null,"watch":""}`,
		`{"url":"https://www.youtube.com/watch?v=abc","key":"yt:abc","watch":""}`,
		`{"url":"https://example.org/","key":null,"watch":""}`,
	} {
		_, err := Parse(withExample(t, ex))
		if err == nil || !strings.Contains(err.Error(), "expected \"\"") && !strings.Contains(err.Error(), "no watch URL") {
			t.Errorf("%s: accepted or refused for another reason: %v", ex, err)
		}
	}
	// Controls: the same URLs with assertions the client accepts.
	for _, ex := range []string{
		`{"url":"https://www.youtube.com/results?search_query=x","key":null,"watch":null}`,
		`{"url":"https://www.youtube.com/results?search_query=x","key":null}`,
		`{"url":"https://www.youtube.com/watch?v=abc","key":"yt:abc","watch":"https://www.youtube.com/watch?v=abc"}`,
	} {
		if _, err := Parse(withExample(t, ex)); err != nil {
			t.Errorf("%s: refused: %v", ex, err)
		}
	}
}
