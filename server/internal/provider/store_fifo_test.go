//go:build linux || darwin

package provider

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestStoreSkipsAFIFOWithoutBlocking(t *testing.T) {
	// Opening a FIFO for reading blocks until a writer appears, and Open
	// runs before the listener starts: a pipe named *.json would hang
	// startup with nothing logged.
	dir := t.TempDir()
	write(t, dir, "laftel.json", builtin(t, "laftel.json"))
	if err := syscall.Mkfifo(filepath.Join(dir, "a.json"), 0o644); err != nil {
		t.Skip("mkfifo:", err)
	}
	var log logSink
	opened := make(chan *Store, 1)
	go func() { opened <- Open(dir, log.logf) }()
	var s *Store
	select {
	case s = <-opened:
	case <-time.After(3 * time.Second):
		t.Fatal("Open blocked on a FIFO")
	}
	if _, ok := s.Get("laftel"); !ok {
		t.Error("the regular file beside it is not served")
	}
	if !log.has("skipping a.json") {
		t.Errorf("the FIFO was not reported: %q", log.lines)
	}
	reloaded := make(chan struct{})
	go func() { s.ReloadIfChanged(); s.Reload(); close(reloaded) }()
	select {
	case <-reloaded:
	case <-time.After(3 * time.Second):
		t.Fatal("a reload blocked on a FIFO")
	}
}
