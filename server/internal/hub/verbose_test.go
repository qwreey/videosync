package hub

import (
	"bytes"
	"log"
	"strings"
	"sync"
	"testing"

	"github.com/qwreey/videosync/server/internal/room"
)

// lockedBuf is a log sink safe to read while connection goroutines write it.
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (w *lockedBuf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *lockedBuf) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}

// -verbose traces every frame, and a room id and its secret are the whole join
// credential. A rotation exists to cut off a leaked link, so the new secret
// must not be written next to the room id for whoever reads the logs.
func TestTheVerboseTraceDoesNotLogARotatedSecret(t *testing.T) {
	var buf lockedBuf
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })

	f := start(t, func(c *Config) { c.Verbose = true })
	id, secret := f.createRoom("yt:abc")
	a, _, err := f.dial(id, secret, "a", "yt:abc")
	if err != nil {
		t.Fatal(err)
	}
	a.send(room.Rotate{})
	fresh, _ := a.await("secret")["secret"].(string)
	if fresh == "" {
		t.Fatal("setup: no new secret")
	}
	// The frame was sent before the reply was read, so it has been logged.
	out := buf.String()
	if !strings.Contains(out, `"t":"secret"`) {
		t.Fatalf("the trace does not record the rotation at all:\n%s", out)
	}
	if strings.Contains(out, fresh) {
		t.Fatalf("the trace logs the rotated secret:\n%s", out)
	}
	if strings.Contains(out, secret) {
		t.Fatalf("the trace logs the room's first secret:\n%s", out)
	}
}
