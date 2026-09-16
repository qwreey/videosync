package hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/qwreey/videosync/server/internal/auth"
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
	// HandshakeTimeout bounds the whole wait for `hello` after the upgrade,
	// however many frames the peer sends meanwhile. A socket that never
	// identifies itself holds a goroutine and an fd.
	HandshakeTimeout time.Duration
	PingInterval     time.Duration
	ReadTimeout      time.Duration
	MaxFrameBytes    int64
	// Auth is server access control (D6). Nil, the default, is today's server
	// exactly: nothing gated, nothing extra advertised, no extra endpoints.
	Auth *auth.Server
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
// That stays true with access control on: a bearer header is not a CORS
// credential, and nothing under /api reads a cookie. Authorization does have to
// be named in Allow-Headers; a wildcard there would not cover it.
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
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
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
	api := func(next http.HandlerFunc) http.HandlerFunc { return cors(cfg.AllowedOrigins, next) }
	mux.HandleFunc("GET /healthz", api(func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"ok": true, "rooms": h.Rooms(), "serverMs": h.clock.NowMs()}
		if cfg.Auth != nil {
			// Unauthenticated on purpose: the panel reads it to learn what to
			// ask for before it has anything to ask with.
			out["auth"] = cfg.Auth.Info()
		}
		writeJSON(w, 200, out)
	}))
	mux.HandleFunc("POST /api/rooms", api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MediaKey string `json:"mediaKey"`
			MediaURL string `json:"mediaUrl"`
			Ticket   string `json:"ticket"`
		}
		// An empty body is fine: the first member's `hello` names the media.
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		// Gated in every scope (F39): anyone who can reach the port could
		// otherwise fill MaxRooms.
		if cfg.Auth != nil && !cfg.Auth.ConsumeTicket(body.Ticket) {
			cfg.Auth.Refuse(w)
			return
		}
		id, secret, err := h.Create(body.MediaKey, body.MediaURL)
		if err != nil {
			writeJSON(w, 503, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 201, map[string]any{"roomId": id, "secret": secret})
	}))
	// Preflight. A userscript that sets Content-Type: application/json turns
	// the room-create POST into a preflighted request; one that does not, does
	// not. Answer either way rather than depend on the client's habits.
	mux.HandleFunc("OPTIONS /api/rooms", api(func(http.ResponseWriter, *http.Request) {}))
	mux.HandleFunc("OPTIONS /healthz", api(func(http.ResponseWriter, *http.Request) {}))
	if cfg.Auth != nil {
		cfg.Auth.Register(mux, api)
	}
	h.providerRoutes(mux, cfg)
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

// refusal is what a joiner is told when the join itself fails. Only a full
// room is room_full. Everything else -- a room the sweeper expired after
// Lookup found it, a secret rotated after Lookup checked it -- gets the same
// join_refused as a failed Lookup, for the same reason: which room ids exist
// is not something an unauthenticated peer should learn.
func refusal(err error) (room.Error, string) {
	if errors.Is(err, ErrRoomFull) {
		return room.Error{Code: "room_full"}, "room full"
	}
	return room.Error{Code: "join_refused", Msg: "unknown room or secret"}, "join refused"
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
	// An absolute bound, not just a per-frame one: ReadTimeout is refreshed by
	// every ping and every unfinished fragment, so on its own it let a peer
	// that never says hello keep the socket for as long as it kept talking.
	sock.ReadTimeout = cfg.HandshakeTimeout
	if cfg.HandshakeTimeout > 0 {
		sock.ReadBefore = time.Now().Add(cfg.HandshakeTimeout)
	}

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

	// Before the room is looked up, so a peer without a ticket learns nothing
	// about which rooms exist. Its own code, not join_refused: the panel has to
	// tell "sign in" apart from "check the room ID".
	if cfg.Auth != nil && cfg.Auth.TicketToJoin() && !cfg.Auth.ConsumeTicket(m.Ticket) {
		c := &conn{sock: sock}
		c.sendNow(room.Error{Code: "auth_required", Msg: "this server requires sign-in to join"})
		sock.Close(ws.ClosePolicyViolation, "auth required")
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

	sock.ReadTimeout, sock.ReadBefore = cfg.ReadTimeout, time.Time{}
	c := newConn(newClientID(), live, sock)
	welcome, extra, err := live.join(c, m)
	if err != nil {
		e, reason := refusal(err)
		c.sendNow(e)
		sock.Close(ws.ClosePolicyViolation, reason)
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
