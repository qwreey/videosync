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
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/qwreey/videosync/server/internal/auth"
	"github.com/qwreey/videosync/server/internal/hub"
	"github.com/qwreey/videosync/server/internal/provider"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		os.Exit(hashPassword(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	addr := flag.String("addr", ":8787", "listen address")
	origins := flag.String("allowed-origins", "",
		"comma-separated Origin allowlist (e.g. \"https://www.youtube.com, https://laftel.net, "+
			"chrome-extension://*, moz-extension://*\") for the WebSocket upgrade and for CORS on the /api "+
			"endpoints (empty = any). The browser extension calls with its own Origin, never the site's: list "+
			"chrome-extension://<id> or chrome-extension://*, and moz-extension://* (a Firefox origin differs per install). "+
			"The only patterns are * and <extension scheme>://* (before review 4 an entry like chrome-extension://* "+
			"matched only itself); any other star, such as https://*.example.com, matches nothing and is warned about at startup")
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
	allowed, err := parseOrigins(*origins)
	if err != nil {
		log.Fatal(err)
	}
	hcfg.AllowedOrigins = allowed
	for _, n := range originsNotes(allowed) {
		log.Print(n)
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

	srv := newHTTPServer(*addr, h.Handler(hcfg), defaultTimeouts)

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

// parseOrigins reads -allowed-origins. Entries are trimmed, as -oidc-allow's
// are: the hub compares them to the Origin header exactly, so " https://b"
// from "a, b" would match nothing and refuse that site with no word at
// startup. Blank entries are dropped, because an empty one matches a request
// that sends no Origin. A flag that names nothing but blanks is an error,
// not "any origin": it was meant to restrict.
func parseOrigins(s string) ([]string, error) {
	if s == "" {
		return nil, nil
	}
	var out []string
	for _, o := range strings.Split(s, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("-allowed-origins %q names no origin (leave it out to allow any)", s)
	}
	return out, nil
}

// deadPattern is an entry with a star that is not one of the hub's patterns
// (hub.originAllowed): it is compared literally and admits nothing.
func deadPattern(o string) bool {
	return strings.Contains(o, "*") && o != "*" && !(strings.HasSuffix(o, "://*") && auth.ExtensionOrigin(o))
}

// originsNotes are the startup warnings for an allowlist. An entry like
// https://*.example.com is not a pattern; it has always started the server and
// matched nothing, and it still does -- refusing it would stop a server that
// ran yesterday -- but now it says so. And a list that leaves out an extension
// build: the extension's background makes every call with its own Origin, so a
// list of sites alone refuses its socket (403) and hides every API answer from
// it (no Allow-Origin) while userscript users on the same server work -- which
// looks like a server that is half down.
func originsNotes(allowed []string) []string {
	var notes []string
	listed := map[string]bool{}
	for _, a := range allowed {
		if a == "*" {
			return nil
		}
		if deadPattern(a) {
			notes = append(notes, fmt.Sprintf("WARNING: -allowed-origins entry %q matches no origin and admits nothing: "+
				"the only patterns are * and <extension scheme>://* (chrome-extension, moz-extension, "+
				"safari-web-extension); list each site exactly", a))
			continue
		}
		if auth.ExtensionOrigin(a) {
			scheme, _, _ := strings.Cut(a, "://")
			listed[strings.ToLower(scheme)] = true
		}
	}
	var missing []string
	for _, s := range []string{"chrome-extension", "moz-extension"} {
		if !listed[s] {
			missing = append(missing, s+"://*")
		}
	}
	if len(allowed) == 0 || len(missing) == 0 {
		return notes
	}
	return append(notes, fmt.Sprintf("WARNING: -allowed-origins admits no %s origin: the browser extension calls with its own Origin, "+
		"so its users cannot connect. Add %s to admit them (a Chrome extension may be listed by its id instead)",
		strings.Join(missing, " or "), strings.Join(missing, ", ")))
}

type timeouts struct{ header, read, idle time.Duration }

// Every body this server reads is a few KiB of JSON or form, so 30 s is
// generous for the slowest link; two minutes idle outlasts a panel's pauses
// between API calls without holding a descriptor per departed browser.
var defaultTimeouts = timeouts{header: 10 * time.Second, read: 30 * time.Second, idle: 2 * time.Minute}

// newHTTPServer bounds everything that happens before a handler can decide
// anything, all of it unauthenticated: without ReadTimeout a body that never
// arrives holds its handler forever (MaxBytesReader caps size, not time), and
// without IdleTimeout -- which falls back to ReadTimeout, and zero there is no
// limit -- neither does a kept-alive connection that never sends again.
func newHTTPServer(addr string, h http.Handler, t timeouts) *http.Server {
	return &http.Server{
		Addr:    addr,
		Handler: h,
		// None of these reaches a WebSocket: net/http's Hijack clears the
		// connection's deadlines (SetDeadline(time.Time{})) as it hands it
		// over, and ws.Conn sets its own from then on (ReadMessage before
		// every frame). No WriteTimeout all the same: it would bound how long
		// a handler may take to answer, and nothing here needs that bound.
		ReadHeaderTimeout: t.header,
		ReadTimeout:       t.read,
		IdleTimeout:       t.idle,
	}
}
