package hub

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/qwreey/videosync/server/internal/ws"
)

// A peer that resets its TCP connection mid-broadcast fails the reader and the
// writer at the same moment, and both call kill. kill runs on goroutines no
// lock serialises, and a panic there is not recovered by net/http: it takes
// the whole server, and every room in it, down with it.
func TestConcurrentKillsDoNotPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := ws.Upgrade(w, r)
		if err != nil {
			return
		}
		time.Sleep(time.Second)
		s.Close(ws.CloseNormal, "")
	}))
	defer srv.Close()
	// One real socket is enough: kill only needs something to Close, and Close
	// on an already-closed socket is harmless.
	sock, err := ws.Dial(srv.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sock.Close(ws.CloseNormal, "")

	for i := 0; i < 5000; i++ {
		c := newConn("c", nil, sock)
		var start, done sync.WaitGroup
		start.Add(1)
		for g := 0; g < 4; g++ {
			done.Add(1)
			go func() {
				defer done.Done()
				start.Wait()
				c.kill(ws.CloseInternalError, "")
			}()
		}
		start.Done()
		done.Wait()
		select {
		case <-c.die:
		default:
			t.Fatal("kill did not close die")
		}
	}
}
