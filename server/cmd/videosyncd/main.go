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
	tlsCert := flag.String("tls-cert", "", "PEM certificate chain; serving https/wss")
	tlsKey := flag.String("tls-key", "", "PEM private key for -tls-cert")
	flag.Parse()

	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatal("-tls-cert and -tls-key must be given together")
	}

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
		if *tlsCert != "" {
			log.Printf("videosyncd listening on https://%s", *addr)
			if err := srv.ListenAndServeTLS(*tlsCert, *tlsKey); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("listen: %v", err)
			}
			return
		}
		log.Printf("videosyncd listening on http://%s", *addr)
		// Measured (docs/BROWSER-FINDINGS.md section 8): a page on a public origin
		// cannot reach a loopback or private address by ANY scheme -- the
		// request never leaves the browser and presents as an indefinite hang.
		// TLS does not lift that; a public address does. An extension's service
		// worker is exempt, which is why the extension can talk to a server on
		// the user's own machine and a userscript cannot. Say it at startup
		// rather than let it be discovered as "the server is down".
		log.Print("WARNING: no TLS. For a userscript on a real provider this server also needs " +
			"a PUBLIC address: browsers refuse every request from a public-origin page to " +
			"loopback or a private IP, whatever the scheme. Pass -tls-cert/-tls-key with a real " +
			"certificate, or put it behind a TLS-terminating reverse proxy on a public name. " +
			"A plaintext loopback server is reachable only from a local test page or from the " +
			"browser extension.")
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
