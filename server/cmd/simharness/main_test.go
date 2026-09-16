package main

import (
	"reflect"
	"testing"

	"github.com/qwreey/videosync/server/internal/sim"
	vsync "github.com/qwreey/videosync/server/internal/sync"
)

// A row in the table is a claim about one strategy in one scenario, so it must
// not depend on which scenarios ran before it. Several correctors keep
// per-client state keyed by member id, every scenario reuses the ids a/b/c, and
// a finished run never tells the corrector anybody left -- so an instance
// shared across runs starts each scenario with the previous one's integrators
// already wound up.
func TestTableRowsDoNotDependOnScenarioOrder(t *testing.T) {
	tun := vsync.DefaultTunables()
	scs := scenarios()
	rev := make([]sim.Scenario, len(scs))
	for i := range scs {
		rev[len(scs)-1-i] = scs[i]
	}
	fwd := table(scs, tun)
	bwd := table(rev, tun)
	strats := strategies()
	for i := range scs {
		for j := range strats {
			a, b := fwd[i][j], bwd[len(scs)-1-i][j]
			if !reflect.DeepEqual(a, b) {
				t.Errorf("%s / %s depends on what ran before it: anchorErr %.0f forwards, %.0f backwards",
					scs[i].Name, strats[j].name, a.MeanAnchorErrMs, b.MeanAnchorErrMs)
			}
		}
	}
}
