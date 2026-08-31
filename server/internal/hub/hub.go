// Package hub is the server assembly: it owns the room registry, the
// connections, and the policy that internal/room deliberately has no opinion
// about (who may join, how often, and for how long a room exists).
//
// Lock order is Hub.mu then Live.mu, never the reverse.
package hub

import (
	"errors"
	"sync"
	"time"

	"github.com/qwreey/videosync/server/internal/room"
	vsync "github.com/qwreey/videosync/server/internal/sync"
)

var (
	ErrNoSuchRoom = errors.New("no such room")
	ErrBadSecret  = errors.New("bad join secret")
	ErrRoomFull   = errors.New("room is full")
	ErrTooMany    = errors.New("too many rooms")
)

type Config struct {
	Tunables vsync.Tunables
	// NewCorrector is called once per room. ServoCorrector keeps per-client
	// state in a map, so rooms must never share one.
	NewCorrector func() vsync.Corrector

	// IdleTTL expires a room some time after its last member leaves.
	// VideoTogether's model, and the reason no persistence is needed: a leaked
	// URL stops being a room shortly after everyone stops watching.
	IdleTTL time.Duration
	// TickInterval drives readiness-gate expiry and the idle sweep.
	TickInterval time.Duration

	MaxRooms          int
	MaxMembersPerRoom int
	// MaxChatLen truncates rather than refuses, like cytube (320 chars).
	MaxChatLen int
}

func DefaultConfig() Config {
	return Config{
		Tunables:          vsync.DefaultTunables(),
		NewCorrector:      func() vsync.Corrector { return &vsync.ServoCorrector{} },
		IdleTTL:           3 * time.Minute,
		TickInterval:      time.Second,
		MaxRooms:          10000,
		MaxMembersPerRoom: 32,
		MaxChatLen:        320,
	}
}

type Hub struct {
	cfg   Config
	clock *Clock

	mu    sync.Mutex
	rooms map[string]*Live

	stop chan struct{}
	wg   sync.WaitGroup
}

func New(cfg Config, clock *Clock) *Hub {
	h := &Hub{cfg: cfg, clock: clock, rooms: map[string]*Live{}, stop: make(chan struct{})}
	h.wg.Add(1)
	go h.loop()
	return h
}

func (h *Hub) Close() {
	close(h.stop)
	h.wg.Wait()
}

func (h *Hub) Clock() *Clock { return h.clock }

// Create makes a room and returns its id and first join secret.
func (h *Hub) Create(mediaKey string) (id, secret string, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.rooms) >= h.cfg.MaxRooms {
		return "", "", ErrTooMany
	}
	id, secret = newID(), newID()
	now := h.clock.NowMs()
	l := &Live{
		hub: h, id: id, secret: secret,
		conns: map[string]*conn{}, emptySinceMs: now,
	}
	l.room = room.New(id, h.cfg.NewCorrector(), h.cfg.Tunables,
		vsync.Anchor{PositionMs: 0, AtServerMs: now, Paused: true, MediaKey: mediaKey}, l)
	h.rooms[id] = l
	return id, secret, nil
}

// Lookup finds a room and checks the join secret in constant time.
func (h *Hub) Lookup(id, secret string) (*Live, error) {
	h.mu.Lock()
	l := h.rooms[id]
	h.mu.Unlock()
	if l == nil {
		return nil, ErrNoSuchRoom
	}
	l.mu.Lock()
	ok := secretEqual(l.secret, secret)
	l.mu.Unlock()
	if !ok {
		// Deliberately the same shape as ErrNoSuchRoom to the client: whether a
		// room id exists is not something an unauthenticated peer should learn.
		return nil, ErrBadSecret
	}
	return l, nil
}

func (h *Hub) Rooms() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

// loop expires readiness gates and idle rooms.
func (h *Hub) loop() {
	defer h.wg.Done()
	t := time.NewTicker(h.cfg.TickInterval)
	defer t.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-t.C:
			h.sweep()
		}
	}
}

func (h *Hub) sweep() {
	now := h.clock.NowMs()
	h.mu.Lock()
	live := make([]*Live, 0, len(h.rooms))
	for _, l := range h.rooms {
		live = append(live, l)
	}
	h.mu.Unlock()

	var dead []string
	ttl := int64(h.cfg.IdleTTL / time.Millisecond)
	for _, l := range live {
		l.mu.Lock()
		empty := len(l.conns) == 0
		if !empty {
			// A member who buffered and then stopped reporting without closing
			// the socket would otherwise hold the gate indefinitely.
			l.room.Tick(now)
		} else if now-l.emptySinceMs > ttl {
			dead = append(dead, l.id)
		}
		l.mu.Unlock()
	}
	if len(dead) == 0 {
		return
	}
	h.mu.Lock()
	for _, id := range dead {
		// Re-check under the hub lock: someone may have joined in between.
		if l := h.rooms[id]; l != nil {
			l.mu.Lock()
			if len(l.conns) == 0 && now-l.emptySinceMs > ttl {
				// Marked before the delete and under the room's own lock, so a
				// join that is already inside Live.join sees it and is refused
				// rather than landing in a room nobody can reach.
				l.dead = true
				delete(h.rooms, id)
			}
			l.mu.Unlock()
		}
	}
	h.mu.Unlock()
}
