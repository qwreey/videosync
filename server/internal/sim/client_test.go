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

// The detector must measure elapsed time, not assume its own interval
// (CLAUDE.md). The harness evaluated twice at every whole second -- once for
// the 10 Hz loop and once for the heartbeat -- and a detector that
// dead-reckons a fixed step per call then saw either a frozen player (a stall
// flagged every second) or, with the stall guard off, a playhead that had
// moved 100 ms further than it had.
func TestDetectorMeasuresElapsedTimeNotItsOwnCadence(t *testing.T) {
	tun := vsync.DefaultTunables()
	cadences := []struct {
		name  string
		evals func(now int64) int // how many evaluations happen at this tick
	}{
		{"10 Hz plus a heartbeat at the same instant", func(now int64) int {
			n := 0
			if now%100 == 0 {
				n++
			}
			if now%1000 == 0 {
				n++
			}
			return n
		}},
		{"off-cadence, every 370 ms", func(now int64) int {
			if now%370 == 0 {
				return 1
			}
			return 0
		}},
	}
	for _, cd := range cadences {
		for _, noGuard := range []bool{false, true} {
			c := readyClient(ClientProfile{ID: "a", NoStallInference: noGuard}, 0, false)
			c.anchor = vsync.Anchor{PositionMs: 0, AtServerMs: 0}
			stalls := 0
			var worst float64
			for now := int64(0); now <= 20000; now += stepMs {
				c.Advance(now, stepMs)
				for i := 0; i < cd.evals(now); i++ {
					c.Evaluate(now, tun, i > 0)
					if c.stallSuspected {
						stalls++
					}
					if d := c.lastKnownPos - c.posMs; d > worst || -d > worst {
						worst = max(d, -d)
					}
				}
			}
			if stalls > 0 {
				t.Errorf("%s (guard off=%v): a player running at 1.0x was suspected stalled %d times",
					cd.name, noGuard, stalls)
			}
			if worst > 50 {
				t.Errorf("%s (guard off=%v): the detector's idea of the playhead drifted %.0f ms from the real one",
					cd.name, noGuard, worst)
			}
		}
	}
}

// A scheduled seek pays for the buffer exactly like a corrective one. Moving
// the playhead from 30 s to 300 s without touching the buffer model left the
// member playing at 1.0x while reporting readyState 2 and nothing buffered for
// about 90 s -- every corrector gated on it and the detector assumed a stall.
func TestScheduledSeekOutsideTheBufferRebuffersOnce(t *testing.T) {
	c := readyClient(ClientProfile{ID: "b", Link: Link{UpMs: 80, DownMs: 80}}, 30000, false)
	c.Deliver(MsgState{Seq: 1, When: 30000,
		Anchor: vsync.Anchor{PositionMs: 300000, AtServerMs: 30000}, Kind: "seek"}, 30000)

	settle := int64(30000 + c.segFetchMs() + 1000)
	for now := int64(30000); now <= 60000; now += stepMs {
		c.RunScheduled(now)
		before := c.Pos()
		c.Advance(now, stepMs)
		playing := c.Pos() > before
		if now >= settle && c.readyState < 3 {
			t.Fatalf("t=%d: readyState %d with %.2f s buffered, %d ms after a %d ms segment fetch",
				now, c.readyState, c.bufferedS, now-30000, c.segFetchMs())
		}
		if playing && now < 30000+c.segFetchMs() {
			t.Fatalf("t=%d: playing during the fetch an out-of-buffer seek costs", now)
		}
	}
	if c.OutOfBufferSeeks != 1 {
		t.Errorf("out-of-buffer seeks %d, want 1", c.OutOfBufferSeeks)
	}
	// A pause is not a seek: it re-anchors where the player already is.
	c.Deliver(MsgState{Seq: 2, When: 60000,
		Anchor: vsync.Anchor{PositionMs: int64(c.Pos()), AtServerMs: 60000, Paused: true}, Kind: "pause"}, 60000)
	c.RunScheduled(60000)
	if c.OutOfBufferSeeks != 1 {
		t.Errorf("a pause in place was charged as a seek: %d", c.OutOfBufferSeeks)
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
