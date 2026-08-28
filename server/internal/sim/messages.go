package sim

import vsync "github.com/qwreey/videosync/server/internal/sync"

type MsgTimeReq struct {
	ClientID string
	T0       int64 // client clock
}
type MsgTimeReply struct {
	T0            int64
	TRecv, TSend  int64 // server clock
}
type MsgCmd struct {
	ClientID   string
	ReqID      int
	Kind       string // play | pause | seek
	PositionMs int64
}
type MsgState struct {
	Seq       uint64
	When      int64 // server clock
	EmittedAt int64
	Anchor    vsync.Anchor
	By        string
	Kind      string
}
type MsgAck struct {
	ReqID  int
	Seq    uint64
	Anchor vsync.Anchor
	// When must be present. Excluding the sender from the state broadcast
	// (echo suppression) accidentally excluded it from the *scheduling* the
	// timebase exists to provide: with no `when` the sender had nothing to
	// schedule against and never applied its own transition at all.
	When      int64
	EmittedAt int64
	Kind      string
}
type MsgReport struct{ R vsync.Report }
type MsgCorrect struct {
	Mode string // seek | nudge
	Rate float64
	When int64
	Why  string
	// Deliberately carries NO absolute target position. A position computed at
	// send time is stale by one downlink delay on arrival, which silently
	// injects that delay as sync error -- it made every seek in the harness
	// land ~DownMs behind and confounded the round-2 conclusion. The client
	// re-derives Expected() from its own anchor at apply time instead.
}
type MsgGate struct {
	Waiting   bool
	WaitingOn []string
}

func (MsgTimeReq) isMsg()   {}
func (MsgTimeReply) isMsg() {}
func (MsgCmd) isMsg()       {}
func (MsgState) isMsg()     {}
func (MsgAck) isMsg()       {}
func (MsgReport) isMsg()    {}
func (MsgCorrect) isMsg()   {}
func (MsgGate) isMsg()      {}
