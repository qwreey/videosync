package provider

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// maxFiles bounds how many descriptors one directory may offer. The index is
// fetched whole by every client that connects, so it stays small.
const maxFiles = 256

// Entry is one servable descriptor: the exact bytes, and what the index says
// about them. Clients hash the bytes they receive and compare with SHA256, so
// nothing is re-encoded on the way out.
type Entry struct {
	ID      string
	Name    string
	Version string
	SHA256  string
	Hosts   []string
	Body    []byte
	File    string
}

// IndexEntry is one row of GET /api/providers.
type IndexEntry struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Version string   `json:"version"`
	SHA256  string   `json:"sha256"`
	Hosts   []string `json:"hosts"`
}

// Index is the body of GET /api/providers.
type Index struct {
	Schema    int          `json:"schema"`
	Providers []IndexEntry `json:"providers"`
}

// Store serves a directory of descriptors. Every file is validated the way a
// client would validate it before it is offered; an invalid one is logged and
// left out, never half-served.
type Store struct {
	dir  string
	logf func(format string, args ...any)

	mu      sync.RWMutex
	byID    map[string]*Entry
	index   []byte
	stamp   string // what the directory looked like at the last load
	loadErr error
}

// Open loads dir. A directory that cannot be read is not fatal: the store
// serves an empty index and says why, and a later reload may succeed.
func Open(dir string, logf func(format string, args ...any)) *Store {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	s := &Store{dir: dir, logf: logf}
	s.Reload()
	return s
}

// Empty is a store with nothing in it, for a server started without
// -providers.
func Empty() *Store {
	s := &Store{byID: map[string]*Entry{}}
	s.index, _ = json.Marshal(Index{Schema: SchemaVersion, Providers: []IndexEntry{}})
	return s
}

// dirStamp summarises the directory's *.json files by name, size and mtime,
// so a poll can tell whether anything changed without reading them.
func (s *Store) dirStamp() (string, []string, error) {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return "", nil, err
	}
	var names []string
	var b strings.Builder
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		names = append(names, e.Name())
		fmt.Fprintf(&b, "%s\x00%d\x00%d\n", e.Name(), info.Size(), info.ModTime().UnixNano())
	}
	sort.Strings(names)
	return b.String(), names, nil
}

// Reload rereads the directory and swaps the result in whole.
func (s *Store) Reload() {
	stamp, names, err := s.dirStamp()
	if err != nil {
		s.logf("providers: cannot read %s: %v", s.dir, err)
		s.swap(stamp, map[string]*Entry{}, err)
		return
	}
	if len(names) > maxFiles {
		s.logf("providers: %d files in %s, serving the first %d", len(names), s.dir, maxFiles)
		names = names[:maxFiles]
	}
	byID := map[string]*Entry{}
	for _, name := range names {
		e, err := s.loadFile(name)
		if err != nil {
			s.logf("providers: skipping %s: %v", name, err)
			continue
		}
		if prev, dup := byID[e.ID]; dup {
			s.logf("providers: skipping %s: id %q is already served by %s", name, e.ID, prev.File)
			continue
		}
		byID[e.ID] = e
	}
	s.swap(stamp, byID, nil)
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	s.logf("providers: serving %d from %s: %s", len(ids), s.dir, strings.Join(ids, ", "))
}

func (s *Store) loadFile(name string) (*Entry, error) {
	f, err := os.Open(filepath.Join(s.dir, name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file")
	}
	body, err := io.ReadAll(io.LimitReader(f, MaxBytes+1))
	if err != nil {
		return nil, err
	}
	pr, err := Parse(body)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	return &Entry{
		ID: pr.D.ID, Name: pr.D.Name, Version: pr.D.Version, SHA256: hex.EncodeToString(sum[:]),
		Hosts: pr.D.Hosts, Body: body, File: name,
	}, nil
}

func (s *Store) swap(stamp string, byID map[string]*Entry, loadErr error) {
	idx := Index{Schema: SchemaVersion, Providers: []IndexEntry{}}
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		e := byID[id]
		idx.Providers = append(idx.Providers, IndexEntry{ID: e.ID, Name: e.Name, Version: e.Version, SHA256: e.SHA256, Hosts: e.Hosts})
	}
	body, _ := json.Marshal(idx)
	s.mu.Lock()
	s.byID, s.index, s.stamp, s.loadErr = byID, body, stamp, loadErr
	s.mu.Unlock()
}

// ReloadIfChanged rereads the directory when a file was added, removed, or
// changed size or mtime since the last load, and reports whether it did.
func (s *Store) ReloadIfChanged() bool {
	if s.dir == "" {
		return false
	}
	stamp, _, err := s.dirStamp()
	s.mu.RLock()
	same := err == nil && stamp == s.stamp && s.loadErr == nil
	failedSame := err != nil && s.loadErr != nil
	s.mu.RUnlock()
	if same || failedSame {
		return false
	}
	s.Reload()
	return true
}

// Watch polls the directory every interval until stop is closed. Polling, not
// inotify: stdlib only, and a bind-mounted volume does not always deliver
// change events into a container anyway.
func (s *Store) Watch(interval time.Duration, stop <-chan struct{}) {
	if s.dir == "" || interval <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			s.ReloadIfChanged()
		}
	}
}

// IndexJSON is the body of GET /api/providers.
func (s *Store) IndexJSON() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.index
}

// Get returns the descriptor with this id.
func (s *Store) Get(id string) (*Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.byID[id]
	return e, ok
}
