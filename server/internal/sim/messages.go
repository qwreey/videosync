package sim

import "github.com/qwreey/videosync/server/internal/room"

// The simulation and the real server exchange the SAME frames -- these are
// aliases, not copies, so a protocol change cannot land in one and not the
// other. See internal/room/messages.go for the definitions and the reasoning.
type (
	MsgTimeReq   = room.TimeReq
	MsgTimeReply = room.TimeReply
	MsgCmd       = room.Cmd
	MsgState     = room.State
	MsgAck       = room.Ack
	MsgReport    = room.Report
	MsgCorrect   = room.Correct
	MsgGate      = room.Gate
	MsgError     = room.Error
)
