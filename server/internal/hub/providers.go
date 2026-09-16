package hub

import (
	"net/http"
	"strings"

	"github.com/qwreey/videosync/server/internal/provider"
)

// providerRoutes serves the descriptors this server offers (D7):
//
//	GET /api/providers            the index, fetched whole
//	GET /api/providers/<id>.json  the exact bytes the index hashes
//
// The index is small and a client takes all of it rather than asking about
// the host it is on, which would tell the server what its users browse. What
// is served here is inert until a user adopts it; the server does not use
// descriptors for anything itself.
//
// CORS as for /api/rooms: every caller is on another origin.
func (h *Hub) providerRoutes(mux *http.ServeMux, cfg HTTPConfig) {
	store := h.cfg.Providers
	if store == nil {
		store = provider.Empty()
	}
	serve := func(w http.ResponseWriter, body []byte, etag string) {
		w.Header().Set("Content-Type", "application/json")
		// Revalidate every time: an operator's edit must reach the next
		// client, and the ETag makes that cheap.
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if etag != "" {
			w.Header().Set("ETag", etag)
		}
		w.Write(body)
	}
	mux.HandleFunc("GET /api/providers", cors(cfg.AllowedOrigins, func(w http.ResponseWriter, r *http.Request) {
		serve(w, store.IndexJSON(), "")
	}))
	mux.HandleFunc("GET /api/providers/{file}", cors(cfg.AllowedOrigins, func(w http.ResponseWriter, r *http.Request) {
		id, ok := strings.CutSuffix(r.PathValue("file"), ".json")
		e, found := store.Get(id)
		if !ok || !found {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no such provider"})
			return
		}
		etag := `"` + e.SHA256 + `"`
		if r.Header.Get("If-None-Match") == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		serve(w, e.Body, etag)
	}))
	preflight := cors(cfg.AllowedOrigins, func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("OPTIONS /api/providers", preflight)
	mux.HandleFunc("OPTIONS /api/providers/{file}", preflight)
}
