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
	"github.com/qwreey/videosync/server/internal/provider"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		os.Exit(hashPassword(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	addr := flag.String("addr", ":8787", "listen address")
	origins := flag.String("allowed-origins", "", "comma-separated Origin allowlist for the WebSocket upgrade (empty = any)")
	idle := flag.Duration("idle-ttl", 3*time.Minute, "delete a room this long after its last member leaves")
	maxMembers := flag.Int("max-members", 32, "members per room")
	maxRooms := flag.Int("max-rooms", 10000, "rooms held in memory")
	verbose := flag.Bool("verbose", false,
		"log every frame in and out, plus joins and leaves. Off by default; worth having on "+
			"for a live session, because without it the server records nothing per connection "+
			"and a frame the client never sent looks exactly like one the server dropped")
	tlsCert := flag.String("tls-cert", "", "PEM certificate chain; serving https/wss")
	tlsKey := flag.String("tls-key", "", "PEM private key for -tls-cert")
	af := registerAuthFlags()
	providersDir := flag.String("providers", "",
		"directory of provider descriptor *.json files to offer at /api/providers (D7). Each is validated "+
			"as a client would; an invalid one is logged and skipped. Reloaded on SIGHUP and when a file changes")
	providersPoll := flag.Duration("providers-poll", 5*time.Second,
		"how often to check -providers for changed files (0: only on SIGHUP)")
	flag.Parse()

	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatal("-tls-cert and -tls-key must be given together")
	}

	cfg := hub.DefaultConfig()
	cfg.IdleTTL = *idle
	cfg.MaxMembersPerRoom = *maxMembers
	cfg.MaxRooms = *maxRooms
	cfg.Verbose = *verbose

	stopWatch := make(chan struct{})
	defer close(stopWatch)
	var providers *provider.Store
	if *providersDir != "" {
		providers = provider.Open(*providersDir, log.Printf)
		cfg.Providers = providers
		go providers.Watch(*providersPoll, stopWatch)
	}

	hcfg := hub.DefaultHTTPConfig()
	if *origins != "" {
		hcfg.AllowedOrigins = strings.Split(*origins, ",")
	}

	authServer, notes, err := af.build()
	if err != nil {
		log.Fatal(err)
	}
	for _, n := range notes {
		log.Print(n)
	}
	hcfg.Auth = authServer

	h := hub.New(cfg, hub.NewClock())
	defer h.Close()

	// SIGHUP rereads -providers. Without that flag it keeps its default
	// meaning, which is what a self-hoster running under nohup expects.
	// Registered before the listener starts: a signal sent as soon as the
	// server answers must not find the default action still in place.
	if providers != nil {
		hup := make(chan os.Signal, 1)
		signal.Notify(hup, syscall.SIGHUP)
		go func() {
			for range hup {
				log.Print("SIGHUP: reloading providers")
				providers.Reload()
			}
		}()
	}

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
