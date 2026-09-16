package sim

import (
	"github.com/qwreey/videosync/server/internal/room"
	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// Server adapts the transport-neutral room.Room onto the simulated network.
// All the logic lives in room.Room, which the real WebSocket server also uses:
// the harness therefore measures the code that ships, not a model of it.
type Server struct {
	*room.Room
	sink *netSink
	// MediaApplied counts `media` commands the room took (a seq each).
	MediaApplied int
}

// netSink turns room output into simulated downlink traffic. `now` and `net`
// are set immediately before each Deliver, which is safe because the
// simulation is single-threaded by construction.
type netSink struct {
	net *Network
	now int64
}

func (s *netSink) Send(clientID string, m room.Msg) {
	s.net.Send(s.now, clientID, "server", clientID, false, m)
}

func NewServer(c vsync.Corrector, t vsync.Tunables, start vsync.Anchor) *Server {
	sink := &netSink{}
	return &Server{Room: room.New("sim", c, t, start, sink), sink: sink}
}

// Connect and Disconnect are the hub's join and leave: membership changes that
// can themselves send frames (a leave releases the gate and announces it).
func (s *Server) Connect(now int64, net *Network, id string) {
	s.sink.net, s.sink.now = net, now
	s.Join(now, id, id)
}

func (s *Server) Disconnect(now int64, net *Network, id string) {
	s.sink.net, s.sink.now = net, now
	s.Leave(now, id)
}

func (s *Server) Deliver(e envelope, net *Network, now int64, clients map[string]*Client) {
	s.sink.net, s.sink.now = net, now
	switch v := e.msg.(type) {
	case MsgTimeReq:
		s.OnTime(now, e.from, v)
	case MsgCmd:
		before := s.Seq()
		s.OnCmd(now, e.from, v)
		if v.Kind == "media" && s.Seq() > before {
			s.MediaApplied++
		}
	case MsgReport:
		s.OnReport(now, e.from, v)
	}
}
