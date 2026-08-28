// Package wire is the JSON framing of docs/PROTOCOL.md: `{"t":"<type>", ...}`.
// It is the only place that knows the protocol is JSON, so the room logic
// stays transport-neutral and the simulation can drive the same frames without
// serialising anything.
package wire

import (
	"encoding/json"
	"fmt"

	"github.com/qwreey/videosync/server/internal/room"
)

// Encode marshals a frame and splices in its `t` discriminator. Every frame
// type marshals to a JSON object, so prefixing is safe and avoids a second
// reflection pass over the value.
func Encode(m room.Msg) ([]byte, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || b[0] != '{' {
		return nil, fmt.Errorf("wire: %T does not marshal to an object", m)
	}
	t, err := json.Marshal(m.Type())
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(b)+len(t)+6)
	out = append(out, `{"t":`...)
	out = append(out, t...)
	if len(b) > 2 { // not "{}"
		out = append(out, ',')
		out = append(out, b[1:len(b)-1]...)
	}
	out = append(out, '}')
	return out, nil
}

type discriminator struct {
	T string `json:"t"`
}

// ErrUnknownType is returned for a frame this server does not accept. It is a
// value, not a panic: a client from a newer build must not be able to kill a
// connection by sending a frame we have not heard of.
type ErrUnknownType struct{ T string }

func (e ErrUnknownType) Error() string { return "wire: unknown frame type " + e.T }

// DecodeClient parses a client-to-server frame. Server-to-client types are
// deliberately not accepted here: a client must not be able to inject a
// `state` or an `ack`.
func DecodeClient(b []byte) (room.Msg, error) {
	var d discriminator
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	var m room.Msg
	switch d.T {
	case "hello":
		m = new(room.Hello)
	case "time":
		m = new(room.TimeReq)
	case "cmd":
		m = new(room.Cmd)
	case "hb":
		m = new(room.Report)
	case "chat":
		m = new(room.ChatIn)
	default:
		return nil, ErrUnknownType{T: d.T}
	}
	if err := json.Unmarshal(b, m); err != nil {
		return nil, err
	}
	// Return values, not pointers: the room's entry points take values and
	// nothing downstream should be able to mutate the decoded frame.
	switch v := m.(type) {
	case *room.Hello:
		return *v, nil
	case *room.TimeReq:
		return *v, nil
	case *room.Cmd:
		return *v, nil
	case *room.Report:
		return *v, nil
	case *room.ChatIn:
		return *v, nil
	}
	return nil, ErrUnknownType{T: d.T}
}
