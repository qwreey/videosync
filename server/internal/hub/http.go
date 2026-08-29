package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/qwreey/videosync/server/internal/room"
	"github.com/qwreey/videosync/server/internal/ws"
)

// HTTPConfig is the transport-level policy.
type HTTPConfig struct {
	// AllowedOrigins, when non-empty, restricts the Origin header on the
	// upgrade. The room secret is the real credential -- it travels in the
	// `hello` frame, not in a cookie, so this is not CSRF protection -- but a
	// self-hoster who knows their extension's origin should be able to say so.
	AllowedOrigins []string
	// HandshakeTimeout bounds the wait for `hello` after the upgrade. A socket
	// that never identifies itself holds a goroutine and an fd.
	HandshakeTimeout time.Duration
	PingInterval     time.Duration
	ReadTimeout      time.Duration
	MaxFrameBytes    int64
}

func DefaultHTTPConfig() HTTPConfig {
	return HTTPConfig{
		HandshakeTimeout: 10 * time.Second,
		PingInterval:     30 * time.Second,
		// Comfortably longer than PingInterval: any frame, pong included,
		// refreshes it.
		ReadTimeout:   90 * time.Second,
		MaxFrameBytes: 64 << 10,
	}
}

// cors makes the JSON endpoints reachable from a page on another origin.
//
// This is not a nicety: a userscript or an extension content script always runs
// on the OTT site's origin, never on the sync server's, so EVERY call to
// /api/rooms is cross-origin. Without these headers the browser fetches the
// response and then refuses to let the script read it -- which surfaces as a
// bare "TypeError: Failed to fetch" with no indication that the request
// actually succeeded. (The WebSocket upgrade is not subject to CORS at all; it
// is governed by the Origin allowlist above instead.)
//
// No credentials are involved -- the room secret travels in the `hello` frame,
// never in a cookie -- so a wildcard is safe when no allowlist is configured.
func cors(allowed []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		switch {
		case len(allowed) == 0:
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "" && originAllowed(allowed, origin):
			w.Header().Set("Access-Control-Allow-Origin", origin)
			// The response varies by Origin, so a shared cache must not serve
			// one origin's response to another.
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			// Private Network Access. A page on a public origin -- every OTT
			// site -- reaching a server on localhost or a LAN address is a
			// private-network request, and Chrome refuses it unless the target
			// says it is expecting one. This is a SEPARATE gate from CORS and
			// from mixed content: it applies to https targets too, and a
			// self-hosted sync server on 127.0.0.1 or 192.168.x.y is exactly
			// the case it governs.
			if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// Handler returns the server's whole HTTP surface.
func (h *Hub) Handler(cfg HTTPConfig) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", cors(cfg.AllowedOrigins, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "rooms": h.Rooms(), "serverMs": h.clock.NowMs()})
	}))
	mux.HandleFunc("POST /api/rooms", cors(cfg.AllowedOrigins, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MediaKey string `json:"mediaKey"`
		}
		// An empty body is fine: the first member's `hello` names the media.
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		id, secret, err := h.Create(body.MediaKey)
		if err != nil {
			writeJSON(w, 503, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 201, map[string]any{"roomId": id, "secret": secret})
	}))
	// Preflight. A userscript that sets Content-Type: application/json turns
	// the room-create POST into a preflighted request; one that does not, does
	// not. Answer either way rather than depend on the client's habits.
	mux.HandleFunc("OPTIONS /api/rooms", cors(cfg.AllowedOrigins, func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("OPTIONS /healthz", cors(cfg.AllowedOrigins, func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		h.serveWS(w, r, cfg)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func originAllowed(allowed []string, origin string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(a, origin) {
			return true
		}
	}
	return false
}

func (h *Hub) serveWS(w http.ResponseWriter, r *http.Request, cfg HTTPConfig) {
	if !originAllowed(cfg.AllowedOrigins, r.Header.Get("Origin")) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	sock, err := ws.Upgrade(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sock.MaxMessageSize = cfg.MaxFrameBytes
	sock.ReadTimeout = cfg.HandshakeTimeout

	// The first frame must be `hello`; nothing else is a valid opening move.
	op, data, err := sock.ReadMessage()
	if err != nil || op != ws.OpText {
		sock.Close(ws.CloseProtocolError, "expected hello")
		return
	}
	m, err := wireDecodeHello(data)
	if err != nil {
		sock.Close(ws.CloseProtocolError, "expected hello")
		return
	}

	live, err := h.Lookup(m.Room, m.Secret)
	if err != nil {
		// One message for "no such room" and for "wrong secret": which room ids
		// exist is not something an unauthenticated peer should be able to probe.
		c := &conn{sock: sock}
		c.sendNow(room.Error{Code: "join_refused", Msg: "unknown room or secret"})
		sock.Close(ws.ClosePolicyViolation, "join refused")
		return
	}

	sock.ReadTimeout = cfg.ReadTimeout
	c := newConn(newClientID(), live, sock)
	welcome, extra, err := live.join(c, m)
	if err != nil {
		c.sendNow(room.Error{Code: "room_full"})
		sock.Close(ws.ClosePolicyViolation, "room full")
		return
	}
	// Welcome goes out directly rather than through the outbox: it must be the
	// first frame this member sees, ahead of anything the join itself
	// broadcast.
	if err := c.sendNow(welcome); err != nil {
		live.leave(c)
		sock.Close(ws.CloseInternalError, "")
		return
	}
	for _, e := range extra {
		c.sendNow(e)
	}

	go c.writeLoop(cfg.PingInterval)
	c.readLoop()
}
