// Package sim is a deterministic, virtual-clock simulation of a sync room.
// No real time, no goroutines, no wall-clock: the same seed always produces
// the same run, so competing strategies can be compared rather than argued
// about. See CLAUDE.md "PoC sequencing" (Risk A).
package sim

import (
	"container/heap"
	"math/rand"
)

// Msg is anything one participant sends another.
type Msg interface{ isMsg() }

type envelope struct {
	deliverAt int64
	seqNo     int // tie-break, keeps ordering deterministic
	to        string
	from      string
	msg       Msg
}

type pq []envelope

func (p pq) Len() int { return len(p) }
func (p pq) Less(i, j int) bool {
	if p[i].deliverAt != p[j].deliverAt {
		return p[i].deliverAt < p[j].deliverAt
	}
	return p[i].seqNo < p[j].seqNo
}
func (p pq) Swap(i, j int)       { p[i], p[j] = p[j], p[i] }
func (p *pq) Push(x interface{}) { *p = append(*p, x.(envelope)) }
func (p *pq) Pop() interface{} {
	old := *p
	n := len(old)
	e := old[n-1]
	*p = old[:n-1]
	return e
}

// Link describes one client's network path. Uplink and downlink are separate
// so we can inject one-way asymmetry -- the failure mode min-RTT clock sync
// cannot detect no matter how many samples it takes (docs/PROTOCOL.md 1).
type Link struct {
	UpMs, DownMs int64
	JitterMs     int64
	LossPct      float64
}

// Network delivers messages after the configured delay.
type Network struct {
	q     pq
	rng   *rand.Rand
	seqNo int
	links map[string]Link
}

func NewNetwork(seed int64) *Network {
	return &Network{rng: rand.New(rand.NewSource(seed)), links: map[string]Link{}}
}

func (n *Network) SetLink(clientID string, l Link) { n.links[clientID] = l }

func (n *Network) jitter(base, j int64) int64 {
	if j <= 0 {
		return base
	}
	// Symmetric jitter around base, never negative.
	d := base + int64(n.rng.Float64()*float64(2*j)) - j
	if d < 0 {
		return 0
	}
	return d
}

// Send queues a message. `client` names whose link governs the delay;
// `up` selects the uplink (client->server) vs downlink direction.
func (n *Network) Send(now int64, client, from, to string, up bool, m Msg) {
	l := n.links[client]
	if l.LossPct > 0 && n.rng.Float64()*100 < l.LossPct {
		return
	}
	base := l.DownMs
	if up {
		base = l.UpMs
	}
	n.seqNo++
	heap.Push(&n.q, envelope{
		deliverAt: now + n.jitter(base, l.JitterMs),
		seqNo:     n.seqNo,
		to:        to,
		from:      from,
		msg:       m,
	})
}

// Due pops every message deliverable at or before now, in deterministic order.
func (n *Network) Due(now int64) []envelope {
	var out []envelope
	for n.q.Len() > 0 && n.q[0].deliverAt <= now {
		out = append(out, heap.Pop(&n.q).(envelope))
	}
	return out
}
