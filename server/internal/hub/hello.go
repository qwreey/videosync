package hub

import (
	"errors"

	"github.com/qwreey/videosync/server/internal/room"
	"github.com/qwreey/videosync/server/internal/wire"
)

// wireDecodeHello insists the first frame is a hello. Accepting anything else
// here would mean a socket could reach the room dispatcher before it has been
// authorised to be in a room at all.
func wireDecodeHello(b []byte) (room.Hello, error) {
	m, err := wire.DecodeClient(b)
	if err != nil {
		return room.Hello{}, err
	}
	h, ok := m.(room.Hello)
	if !ok {
		return room.Hello{}, errors.New("hub: first frame must be hello")
	}
	return h, nil
}
