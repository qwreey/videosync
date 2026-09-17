package provider

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.TrimSpace(fmt.Sprintf(format, args...)))
}

func (l *logSink) has(sub string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, s := range l.lines {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func builtin(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testdata, "..", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func write(t *testing.T, dir, name string, body []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func index(t *testing.T, s *Store) Index {
	t.Helper()
	var idx Index
	if err := json.Unmarshal(s.IndexJSON(), &idx); err != nil {
		t.Fatal(err)
	}
	return idx
}

func TestStoreServesValidFilesAndSkipsTheRest(t *testing.T) {
	dir := t.TempDir()
	laftel := builtin(t, "laftel.json")
	write(t, dir, "laftel.json", laftel)
	write(t, dir, "youtube.json", builtin(t, "youtube.json"))
	write(t, dir, "broken.json", []byte(`{"schema":1,"id":"broken"}`))
	write(t, dir, "copy-of-laftel.json", laftel) // same id, sorts first
	write(t, dir, "notes.txt", []byte("not a descriptor"))
	write(t, dir, "huge.json", []byte(`{"notes":"`+strings.Repeat("x", MaxBytes)+`"}`))
	if err := os.Mkdir(filepath.Join(dir, "sub.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	var log logSink
	s := Open(dir, log.logf)

	idx := index(t, s)
	if idx.Schema != 1 || len(idx.Providers) != 2 {
		t.Fatalf("index: %+v", idx)
	}
	for _, want := range []string{"skipping broken.json", "skipping huge.json", "already served by copy-of-laftel.json"} {
		if !log.has(want) {
			t.Errorf("no log line %q in %q", want, log.lines)
		}
	}
	e, ok := s.Get("laftel")
	if !ok {
		t.Fatal("laftel not served")
	}
	sum := sha256.Sum256(laftel)
	if string(e.Body) != string(laftel) || e.SHA256 != hex.EncodeToString(sum[:]) {
		t.Error("the served bytes or their hash differ from the file")
	}
	var row IndexEntry
	for _, r := range idx.Providers {
		if r.ID == "laftel" {
			row = r
		}
	}
	if row.SHA256 != e.SHA256 || row.Name != "Laftel" || row.Version != "1.0.0" || len(row.Hosts) != 2 {
		t.Errorf("index row: %+v", row)
	}
	if _, ok := s.Get("broken"); ok {
		t.Error("an invalid descriptor is served")
	}
}

func TestStoreReloadsOnChange(t *testing.T) {
	dir := t.TempDir()
	var log logSink
	s := Open(dir, log.logf)
	if n := len(index(t, s).Providers); n != 0 {
		t.Fatalf("empty dir serves %d", n)
	}
	if s.ReloadIfChanged() {
		t.Error("reloaded with nothing changed")
	}
	write(t, dir, "laftel.json", builtin(t, "laftel.json"))
	if !s.ReloadIfChanged() {
		t.Fatal("a new file was not noticed")
	}
	if _, ok := s.Get("laftel"); !ok {
		t.Fatal("new file not served")
	}
	before, _ := s.Get("laftel")

	// An edit that keeps the file valid replaces it; one that breaks it
	// withdraws it rather than serving the stale copy under a new mtime.
	changed := strings.Replace(string(builtin(t, "laftel.json")), `"version": "1.0.0"`, `"version": "1.0.1"`, 1)
	write(t, dir, "laftel.json", []byte(changed))
	future := time.Now().Add(time.Minute)
	os.Chtimes(filepath.Join(dir, "laftel.json"), future, future)
	if !s.ReloadIfChanged() {
		t.Fatal("an edit was not noticed")
	}
	after, _ := s.Get("laftel")
	if after.SHA256 == before.SHA256 || after.Version != "1.0.1" {
		t.Errorf("edit not served: %+v", after)
	}
	write(t, dir, "laftel.json", []byte(`{}`))
	if !s.ReloadIfChanged() {
		t.Fatal("a breaking edit was not noticed")
	}
	if _, ok := s.Get("laftel"); ok {
		t.Error("a now-invalid file is still served")
	}

	os.Remove(filepath.Join(dir, "laftel.json"))
	s.ReloadIfChanged()
	if n := len(index(t, s).Providers); n != 0 {
		t.Errorf("removed file still indexed")
	}
}

func TestStoreWatchPolls(t *testing.T) {
	dir := t.TempDir()
	s := Open(dir, nil)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { s.Watch(10*time.Millisecond, stop); close(done) }()
	write(t, dir, "youtube.json", builtin(t, "youtube.json"))
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, ok := s.Get("yt"); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the poll never picked the file up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(stop)
	<-done
}

func TestStoreOnAMissingDirectory(t *testing.T) {
	var log logSink
	s := Open(filepath.Join(t.TempDir(), "nope"), log.logf)
	if n := len(index(t, s).Providers); n != 0 {
		t.Errorf("serves %d", n)
	}
	if !log.has("cannot read") {
		t.Errorf("no log line: %q", log.lines)
	}
	if s.ReloadIfChanged() {
		t.Error("a directory that is still missing triggered a reload on every poll")
	}
	e := Empty()
	if string(e.IndexJSON()) != `{"schema":1,"providers":[]}` {
		t.Errorf("empty index: %s", e.IndexJSON())
	}
}

func TestADirectoryOffersAtMostMaxFiles(t *testing.T) {
	var vec struct {
		Base map[string]any `json:"base"`
	}
	raw, err := os.ReadFile(filepath.Join(testdata, "descriptors.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &vec); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	const files, limit = 258, 256 // the limit the design states
	for i := range files {
		d := map[string]any{}
		for k, v := range vec.Base {
			d[k] = v
		}
		d["id"] = fmt.Sprintf("p%03d", i)
		d["keyPrefix"] = "example" // the base's examples name that prefix
		b, _ := json.Marshal(d)
		write(t, dir, fmt.Sprintf("p%03d.json", i), b)
	}
	logs := &logSink{}
	s := Open(dir, logs.logf)
	idx := index(t, s)
	if len(idx.Providers) != limit {
		t.Fatalf("%d offered from %d files", len(idx.Providers), files)
	}
	if _, ok := s.Get(fmt.Sprintf("p%03d", limit)); ok {
		t.Fatal("a file past the limit was served")
	}
	if _, ok := s.Get(fmt.Sprintf("p%03d", limit-1)); !ok {
		t.Fatal("the last file within the limit was not served")
	}
	if !logs.has("serving the first") {
		t.Fatal("the operator was not told")
	}
}

func TestStorePollFollowsSymlinks(t *testing.T) {
	// The layout a Kubernetes ConfigMap mount has: the listed name is a
	// link through ..data, and an update swaps ..data. The link itself
	// never changes, so a stamp built from it never does either.
	dir := t.TempDir()
	link := func(target, name string) {
		t.Helper()
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	v1 := filepath.Join(dir, "..2024_01")
	os.Mkdir(v1, 0o755)
	write(t, v1, "laftel.json", builtin(t, "laftel.json"))
	link("..2024_01", "..data")
	link(filepath.Join("..data", "laftel.json"), "laftel.json")
	s := Open(dir, nil)
	if e, ok := s.Get("laftel"); !ok || e.Version != "1.0.0" {
		t.Fatalf("first load: %+v %v", e, ok)
	}
	if s.ReloadIfChanged() {
		t.Error("reloaded with nothing changed")
	}

	v2 := filepath.Join(dir, "..2024_02")
	os.Mkdir(v2, 0o755)
	changed := strings.Replace(string(builtin(t, "laftel.json")), `"version": "1.0.0"`, `"version": "1.20.0"`, 1) // a new size, as a real update has
	write(t, v2, "laftel.json", []byte(changed))
	link("..2024_02", "..data_tmp")
	if err := os.Rename(filepath.Join(dir, "..data_tmp"), filepath.Join(dir, "..data")); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(v1)
	if !s.ReloadIfChanged() {
		t.Fatal("the swap was not noticed")
	}
	if e, _ := s.Get("laftel"); e == nil || e.Version != "1.20.0" {
		t.Errorf("after the swap: %+v", e)
	}

	// A link that dangles is reported, and noticed when it resolves again.
	var log logSink
	s = Open(dir, log.logf)
	os.Rename(filepath.Join(dir, "..data"), filepath.Join(dir, "..data_gone"))
	if !s.ReloadIfChanged() {
		t.Fatal("a link that now dangles was not noticed")
	}
	if _, ok := s.Get("laftel"); ok || !log.has("skipping laftel.json") {
		t.Errorf("dangling link: served %v, log %q", ok, log.lines)
	}
	if s.ReloadIfChanged() {
		t.Error("a link that still dangles reloaded again")
	}
	os.Rename(filepath.Join(dir, "..data_gone"), filepath.Join(dir, "..data"))
	if !s.ReloadIfChanged() {
		t.Fatal("a link that resolves again was not noticed")
	}
	if _, ok := s.Get("laftel"); !ok {
		t.Error("not served once the link resolves")
	}
}
