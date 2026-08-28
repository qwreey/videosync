package wire

import (
	"encoding/json"
	"testing"

	"github.com/qwreey/videosync/server/internal/room"
	vsync "github.com/qwreey/videosync/server/internal/sync"
)

func TestEncodeAddsTheDiscriminator(t *testing.T) {
	b, err := Encode(room.Ack{ReqID: "r1", Seq: 7, When: 1234, Kind: "pause",
		Anchor: vsync.Anchor{PositionMs: 5000, AtServerMs: 900, Paused: true, MediaKey: "yt:abc"}})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	if got["t"] != "ack" || got["reqId"] != "r1" || got["when"] != float64(1234) {
		t.Fatalf("bad frame: %s", b)
	}
	// The ack must carry `when`, or the sender never schedules its own command
	// (docs/PROTOCOL.md 3; measured 4743 ms -> 32 ms).
	if _, ok := got["when"]; !ok {
		t.Fatal("ack has no when")
	}
}

func TestEncodeHandlesAnEmptyFrame(t *testing.T) {
	b, err := Encode(room.TimeReq{})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"t":"time","t0":0}` {
		t.Fatalf("got %s", b)
	}
}

func TestDecodeClientRoundTrips(t *testing.T) {
	in := room.Cmd{ReqID: "abc", Kind: "seek", PositionMs: 42000, MediaKey: "yt:x"}
	b, err := Encode(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := DecodeClient(b)
	if err != nil {
		t.Fatal(err)
	}
	if out != room.Msg(in) {
		t.Fatalf("round trip: %#v != %#v", out, in)
	}
}

func TestDecodeClientRefusesServerFrames(t *testing.T) {
	// A client must not be able to inject room state by sending the frames the
	// server is supposed to originate.
	for _, m := range []room.Msg{
		room.State{Seq: 9}, room.Ack{Seq: 9}, room.Correct{Mode: "seek"},
		room.Welcome{}, room.Gate{Waiting: true},
	} {
		b, _ := Encode(m)
		if _, err := DecodeClient(b); err == nil {
			t.Fatalf("accepted a server frame: %s", b)
		}
	}
}

func TestDecodeClientRejectsGarbageWithoutPanicking(t *testing.T) {
	for _, s := range []string{``, `{`, `[]`, `{"t":"nope"}`, `{"t":123}`, `null`, `{"t":"cmd","positionMs":"x"}`} {
		if _, err := DecodeClient([]byte(s)); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}

func TestReportSurvivesTheRoundTrip(t *testing.T) {
	in := room.Report{Report: vsync.Report{
		ResidualMs: -420, SlopeMsPerS: -85, PositionMs: 123456, ReadyState: 4,
		BufferedAheadS: 12.4, LastAppliedSeq: 91, UncertaintyMs: 30, RTTMs: 60,
		ClockSamples: 12, Suspended: false,
	}}
	b, err := Encode(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := DecodeClient(b)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := out.(room.Report)
	if !ok || got.Report != in.Report {
		t.Fatalf("round trip lost fields:\n got %#v\nwant %#v", got.Report, in.Report)
	}
}
