// Package room holds the transport-neutral room logic: timebase ownership,
// command serialization, judging, gating and chat. It is shared verbatim by
// the deterministic simulation harness (internal/sim) and by the real
// WebSocket server (cmd/videosyncd), so the algorithm cannot drift between
// what we measure and what we ship.
//
// Nothing in this package may know about sockets, JSON, goroutines or the wall
// clock. Every entry point takes the current server time as a parameter.
package room

import (
	"strconv"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Msg is one protocol frame. Type() is both the marker that makes the set
// closed and the `t` discriminator on the wire (docs/PROTOCOL.md).
type Msg interface{ Type() string }

// --- client -> server -------------------------------------------------------

// Hello joins a room. See docs/PROTOCOL.md section 2.
type Hello struct {
	Room     string `json:"room"`
	Secret   string `json:"secret"`
	Name     string `json:"name"`
	MediaKey string `json:"mediaKey"`
	MediaURL string `json:"mediaUrl,omitempty"`
}

// TimeReq is one clock-sync probe. The client does all the arithmetic; the
// server only stamps two of its own timestamps (section 1).
type TimeReq struct {
	T0 int64 `json:"t0"`
}

// Cmd is a user-originated state change. It carries no client id: the sender
// is the connection, never a field the sender controls.
type Cmd struct {
	ReqID      string `json:"reqId"`
	Kind       string `json:"kind"` // play | pause | seek | media
	PositionMs int64  `json:"positionMs"`
	MediaKey   string `json:"mediaKey,omitempty"`
	MediaURL   string `json:"mediaUrl,omitempty"`
	// IfMediaKey makes a `media` command a compare-and-set: it applies only
	// while the room's media is exactly this key, and is otherwise refused
	// with `media_stale` before it takes a seq. nil means unconditional; a
	// pointer because "" is a real condition -- a room that names nothing
	// yet. Two members whose sites both moved on to the next episode send
	// the same continuation; without the condition the second one restarts
	// the room under the first (docs/design/acquire.md). Ignored on every
	// other kind.
	IfMediaKey *string `json:"ifMediaKey,omitempty"`
}

// String keeps `-verbose` logs readable: %+v prints a pointer as an address.
func (c Cmd) String() string {
	cond := "-"
	if c.IfMediaKey != nil {
		cond = strconv.Quote(*c.IfMediaKey)
	}
	return "{ReqID:" + c.ReqID + " Kind:" + c.Kind + " PositionMs:" + strconv.FormatInt(c.PositionMs, 10) +
		" MediaKey:" + c.MediaKey + " MediaURL:" + c.MediaURL + " IfMediaKey:" + cond + "}"
}

// Report is the heartbeat / anomaly report (section 4). vsync.Report is
// embedded so its fields sit at the top level of the frame exactly as
// docs/PROTOCOL.md section 4 shows them. Its ClientID is json:"-": identity
// comes from the connection, and OnReport overwrites the field before use.
type Report struct {
	vsync.Report
}

// ChatIn is a chat line from a client.
type ChatIn struct {
	Text string `json:"text"`
}

// Rotate asks for a new join secret. Any member may send it: rotation is the
// no-host replacement for "kick" (SYNTHESIS 13.2). Existing members keep their
// session and are told the new secret; anyone reconnecting with the old one is
// refused. It does not eject whoever is already connected -- nothing in this
// design can -- it stops the forwarded link from working.
type Rotate struct{}

// --- server -> client -------------------------------------------------------

// MemberInfo is what one member looks like to the others.
type MemberInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Suspended bool   `json:"suspended"`
	Ready     bool   `json:"ready"`
}

// Welcome answers Hello.
type Welcome struct {
	You      string       `json:"you"`
	Seq      uint64       `json:"seq"`
	Anchor   vsync.Anchor `json:"anchor"`
	Members  []MemberInfo `json:"members"`
	ServerMs int64        `json:"serverMs"`
	MediaKey string       `json:"mediaKey"`
}

// TimeReply answers TimeReq.
type TimeReply struct {
	T0    int64 `json:"t0"`
	TRecv int64 `json:"tRecv"`
	TSend int64 `json:"tSend"`
}

// State is the broadcast of a room transition. Everyone but the originator
// gets it; the originator gets Ack, which must carry the same When.
type State struct {
	Seq       uint64       `json:"seq"`
	When      int64        `json:"when"`
	EmittedAt int64        `json:"emittedAt"`
	Anchor    vsync.Anchor `json:"anchor"`
	By        string       `json:"by"`
	Kind      string       `json:"kind"`
}

// Ack is the originator's copy of a State.
//
// When must be present. Excluding the sender from the state broadcast (echo
// suppression) accidentally excluded it from the *scheduling* the timebase
// exists to provide: with no `when` the sender had nothing to schedule against
// and never applied its own transition at all. Measured cost of the bug:
// command-storm mean divergence 4743 ms -> 32 ms (docs/POC-FINDINGS.md 20).
type Ack struct {
	ReqID     string       `json:"reqId"`
	Seq       uint64       `json:"seq"`
	Anchor    vsync.Anchor `json:"anchor"`
	When      int64        `json:"when"`
	EmittedAt int64        `json:"emittedAt"`
	Kind      string       `json:"kind"`
}

// Correct is a unicast judgement about one client. It does NOT change the
// anchor and does NOT consume a seq -- that distinction is what keeps position
// reports from forming a feedback loop (research/SYNTHESIS.md 4c).
type Correct struct {
	Mode string  `json:"mode"` // seek | nudge
	Rate float64 `json:"rate,omitempty"`
	When int64   `json:"when"`
	Why  string  `json:"why,omitempty"`
	// Deliberately carries NO absolute target position. A position computed at
	// send time is stale by one downlink delay on arrival, which silently
	// injects that delay as sync error. The client re-derives Expected() from
	// its own anchor at apply time instead.
}

// Gate is the readiness gate (section 6).
type Gate struct {
	Waiting   bool     `json:"waiting"`
	WaitingOn []string `json:"waitingOn,omitempty"`
	Reason    string   `json:"reason,omitempty"`
}

// Members announces a membership change.
type Members struct {
	Members []MemberInfo `json:"members"`
	Joined  string       `json:"joined,omitempty"`
	Left    string       `json:"left,omitempty"`
}

// ChatOut is a chat line on its way out.
type ChatOut struct {
	From     string `json:"from"`
	Name     string `json:"name"`
	Text     string `json:"text"`
	ServerMs int64  `json:"serverMs"`
}

// MediaMismatch tells a joiner the room is watching something else. The room
// is never forked by a query parameter: mediaKey is the normalized identity.
type MediaMismatch struct {
	RoomMediaKey string `json:"roomMediaKey"`
	Yours        string `json:"yours"`
}

// Secret carries a freshly rotated join secret to the members who are still
// connected, so they can re-share the room link.
type Secret struct {
	Secret  string `json:"secret"`
	Rotated string `json:"rotated"` // client id that rotated it
}

// Error is a refusal. Code is stable and machine-readable; Msg is for humans.
type Error struct {
	Code string `json:"code"`
	Msg  string `json:"msg,omitempty"`
}

func (Hello) Type() string         { return "hello" }
func (TimeReq) Type() string       { return "time" }
func (Cmd) Type() string           { return "cmd" }
func (Report) Type() string        { return "hb" }
func (ChatIn) Type() string        { return "chat" }
func (Rotate) Type() string        { return "rotate" }
func (Secret) Type() string        { return "secret" }
func (Welcome) Type() string       { return "welcome" }
func (TimeReply) Type() string     { return "time.reply" }
func (State) Type() string         { return "state" }
func (Ack) Type() string           { return "ack" }
func (Correct) Type() string       { return "correct" }
func (Gate) Type() string          { return "gate" }
func (Members) Type() string       { return "members" }
func (ChatOut) Type() string       { return "chat" }
func (MediaMismatch) Type() string { return "media.mismatch" }
func (Error) Type() string         { return "error" }
