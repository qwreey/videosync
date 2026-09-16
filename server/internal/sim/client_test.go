package sim

import (
	"testing"

	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// readyClient is a playing client whose clock has settled on a zero offset.
func readyClient(p ClientProfile, pos float64, paused bool) *Client {
	c := NewClient(p, pos, paused)
	c.haveOffset = true
	c.clockSamples = 10
	c.anchor = vsync.Anchor{PositionMs: int64(pos), Paused: paused}
	c.lastKnownPos = pos
	return c
}

// A newer command can be due before an older one: `play` carries CMD_DELAY
// and `pause` carries none, so a pause pressed inside a play's lead arrives
// second and is due first. The engine sorts by `when` and drops anything not
// newer than what it applied; the simulated client applied in arrival order,
// so the older play landed last, the member played against a paused room and
// its lastAppliedSeq went backwards.
func TestScheduledCommandsNeverApplyAnOlderSeqOverANewerOne(t *testing.T) {
	c := readyClient(ClientProfile{ID: "b"}, 5000, true)
	play := vsync.Anchor{PositionMs: 5000, AtServerMs: 5500, Paused: false}
	pause := vsync.Anchor{PositionMs: 5000, AtServerMs: 5200, Paused: true}
	c.Deliver(MsgState{Seq: 1, When: 5500, Anchor: play, Kind: "play"}, 5030)
	c.Deliver(MsgState{Seq: 2, When: 5200, Anchor: pause, Kind: "pause"}, 5230)

	for now := int64(5230); now <= 6000; now += stepMs {
		c.RunScheduled(now)
		if c.lastAppliedSeq == 2 && !c.Paused() {
			t.Fatalf("t=%d: seq 2 is a pause, but the client is playing", now)
		}
		if now >= 5230 && c.lastAppliedSeq != 2 {
			t.Fatalf("t=%d: lastAppliedSeq %d, want 2 (went backwards)", now, c.lastAppliedSeq)
		}
	}
	if !c.Paused() {
		t.Error("the room is paused and the client ended up playing")
	}
}

// The same pair, both already due when the client looks. Sorting by `when` is
// what the engine does and it puts the older play last, so the seq guard is
// what keeps it from winning.
func TestScheduledCommandsDueTogetherApplyInSeqOrder(t *testing.T) {
	c := readyClient(ClientProfile{ID: "b"}, 5000, true)
	c.Deliver(MsgState{Seq: 1, When: 5500,
		Anchor: vsync.Anchor{PositionMs: 5000, AtServerMs: 5500}, Kind: "play"}, 5030)
	c.Deliver(MsgState{Seq: 2, When: 5200,
		Anchor: vsync.Anchor{PositionMs: 5000, AtServerMs: 5200, Paused: true}, Kind: "pause"}, 5230)
	c.RunScheduled(6000)
	if c.lastAppliedSeq != 2 || !c.Paused() {
		t.Errorf("after both were due: seq %d paused=%v, want seq 2 paused", c.lastAppliedSeq, c.Paused())
	}
}
