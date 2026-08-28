// Command videosyncd is the VideoSync sync server: one self-hostable binary,
// no dependencies, in-memory state.
//
// It shares internal/room with the simulation harness (cmd/simharness), so the
// correction law running here is literally the one the harness measures.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/qwreey/videosync/server/internal/hub"
)

func main() {
	addr := flag.String("addr", ":8787", "listen address")
	origins := flag.String("allowed-origins", "", "comma-separated Origin allowlist for the WebSocket upgrade (empty = any)")
	idle := flag.Duration("idle-ttl", 3*time.Minute, "delete a room this long after its last member leaves")
	maxMembers := flag.Int("max-members", 32, "members per room")
	maxRooms := flag.Int("max-rooms", 10000, "rooms held in memory")
	flag.Parse()

	cfg := hub.DefaultConfig()
	cfg.IdleTTL = *idle
	cfg.MaxMembersPerRoom = *maxMembers
	cfg.MaxRooms = *maxRooms

	hcfg := hub.DefaultHTTPConfig()
	if *origins != "" {
		hcfg.AllowedOrigins = strings.Split(*origins, ",")
	}

	h := hub.New(cfg, hub.NewClock())
	defer h.Close()

	srv := &http.Server{
		Addr:    *addr,
		Handler: h.Handler(hcfg),
		// No WriteTimeout: a hijacked WebSocket outlives any request deadline,
		// and the connection sets its own (internal/ws).
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("videosyncd listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Print("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}
