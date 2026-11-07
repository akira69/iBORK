package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func dashboardFixture() (*Grant, Dashboard) {
	g := &Grant{Servers: map[string]string{"one": "One"}, DashboardDevices: map[string]DashboardDevice{"one": {Name: "One", Sensors: true, Management: true, JetKVM: true}}}
	g.ReadDashboardSensors = func(ctx context.Context, id string) ([]DashboardSensor, error) {
		return []DashboardSensor{{ID: "cpu", Name: "CPU1", Unit: "C", Type: "temperature", Valid: true}, {ID: "fan", Name: "Fan1", Unit: "RPM", Type: "fan", Valid: true}}, ctx.Err()
	}
	d := Dashboard{Instance: "tab-a", Target: "fleet", Title: "Central", Revision: "r1", Mode: "fleet", Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{}}, Catalog: []DashboardKind{{Kind: "sensor", Title: "Sensor", MinW: 2, MinH: 1, W: 3, H: 1}, {Kind: "jetkvm", Title: "Console", MinW: 6, MinH: 4, W: 8, H: 6}}}
	return g, d
}

func TestDashboardSensorsTimeoutAndPreservedOfflineBindings(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g, d := dashboardFixture()
		if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
			t.Fatal(err)
		}
		g.ReadDashboardSensors = func(ctx context.Context, _ string) ([]DashboardSensor, error) { <-ctx.Done(); return nil, ctx.Err() }
		start := time.Now()
		if _, err := g.Call(context.Background(), "dashboard_sensors", []byte(`{"deviceId":"one"}`)); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if time.Since(start) != 5*time.Second {
			t.Fatal("sensor timeout not bounded")
		}
		w := DashboardWidget{ID: "fan-card", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"fan"}, Aggregate: "max"}
		d.Layout.Widgets = []DashboardWidget{w}
		d.Revision = "r2"
		if err := g.PublishDashboard(context.Background(), d, "r1"); err != nil {
			t.Fatal(err)
		}
		w.X = 3
		p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: "r2", Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{w}}}
		raw, _ := json.Marshal(p)
		if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
			t.Fatal("moving an offline binding failed", err)
		}
		p.ExpectedRevision = g.Dashboard.Revision
		p.Layout.Widgets[0].SensorIDs = []string{"new-fan"}
		raw, _ = json.Marshal(p)
		if _, err := g.Call(context.Background(), "propose_dashboard", raw); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("new unavailable binding accepted", err)
		}
		if g.Dashboard.Revision != p.ExpectedRevision {
			t.Fatal("timed-out proposal changed preview")
		}
	})
}

func TestDashboardLimitsAndFixedInventory(t *testing.T) {
	g, d := dashboardFixture()
	d.Mode = "wall"
	d.Layout.Widgets = []DashboardWidget{{ID: "console-one", Kind: "jetkvm", W: 6, H: 4, DeviceIDs: []string{"one"}}}
	if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
		t.Fatal(err)
	}
	layout := DashboardLayout{Version: 1, Widgets: []DashboardWidget{d.Layout.Widgets[0]}}
	layout.Widgets[0].X = 6
	p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: layout}
	raw, _ := json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal(err)
	}
	p.ExpectedRevision = g.Dashboard.Revision
	p.Layout.Widgets = []DashboardWidget{}
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
		t.Fatal("wall inventory removed")
	}
	g, d = dashboardFixture()
	d.Catalog[0].MinH = 0
	if err := g.PublishDashboard(context.Background(), d, ""); err == nil {
		t.Fatal("browser weakened geometry")
	}
	d.Catalog[0].MinH = 1
	d.Layout.Widgets = make([]DashboardWidget, 25)
	if err := g.PublishDashboard(context.Background(), d, ""); err == nil {
		t.Fatal("excessive widgets")
	}
	if err := arguments([]byte(`{"message":"`+strings.Repeat("x", 2048)+`"}`), &struct{ Message string }{}); err == nil {
		t.Fatal("legacy argument limit enlarged")
	}
}

func TestDashboardProposalOwnershipRevisionAndIdempotency(t *testing.T) {
	g, d := dashboardFixture()
	ctx := context.Background()
	if err := g.PublishDashboard(ctx, d, ""); err != nil {
		t.Fatal(err)
	}
	other := d
	other.Instance = "other"
	if err := g.PublishDashboard(ctx, other, "r1"); err == nil {
		t.Fatal("another tab replaced context")
	}
	proposal := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: "r1", Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{{ID: "reading", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"cpu"}}}}}
	call := func(p DashboardProposal) error {
		raw, _ := json.Marshal(p)
		_, err := g.Call(ctx, "propose_dashboard", raw)
		return err
	}
	if err := call(proposal); err != nil {
		t.Fatal(err)
	}
	revision := g.Dashboard.Revision
	if revision == "r1" || !g.Dashboard.Draft {
		t.Fatal("no draft revision")
	}
	if err := call(proposal); err != nil || g.Dashboard.Revision != revision {
		t.Fatal("identical retry was not idempotent", err)
	}
	proposal.Layout.Widgets[0].X = 1
	if err := call(proposal); err == nil {
		t.Fatal("stale proposal accepted")
	}
	proposal.ExpectedRevision = revision
	proposal.Instance = "other"
	if err := call(proposal); err == nil {
		t.Fatal("cross-instance proposal")
	}
	proposal.Instance = d.Instance
	proposal.Target = "other"
	if err := call(proposal); err == nil {
		t.Fatal("cross-target proposal")
	}
	if err := g.PublishDashboard(ctx, d, "r1"); err == nil {
		t.Fatal("stale browser overwrote draft")
	}
	if g.Dashboard.Revision != revision {
		t.Fatal("rejected edit changed draft")
	}
}

func TestDashboardValidationAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*DashboardWidget)
	}{
		{"geometry", func(w *DashboardWidget) { w.X = 12 }},
		{"overflow", func(w *DashboardWidget) { w.X = math.MaxInt }},
		{"unknown device", func(w *DashboardWidget) { w.DeviceIDs = []string{"unknown"} }},
		{"unknown sensor", func(w *DashboardWidget) { w.SensorIDs = []string{"unknown"} }},
		{"fan aggregate", func(w *DashboardWidget) { w.Aggregate = "max" }},
		{"unknown kind", func(w *DashboardWidget) { w.Kind = "shell" }},
		{"title", func(w *DashboardWidget) { w.Title = strings.Repeat("x", 101) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			g, d := dashboardFixture()
			if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
				t.Fatal(err)
			}
			w := DashboardWidget{ID: "reading", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"cpu"}}
			test.change(&w)
			p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{w}}}
			raw, _ := json.Marshal(p)
			if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
				t.Fatal("invalid proposal accepted")
			}
			if g.Dashboard.Revision != "r1" {
				t.Fatal("invalid proposal mutated draft")
			}
		})
	}
	g, d := dashboardFixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.PublishDashboard(ctx, d, ""); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := g.Call(ctx, "dashboard_context", nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := g.Call(context.Background(), "dashboard_context", nil); err == nil {
		t.Fatal("missing context accepted")
	}
}

func TestDashboardFullSizeAndPartialPower(t *testing.T) {
	g, d := dashboardFixture()
	d.Catalog = append(d.Catalog, DashboardKind{Kind: "power-now", Title: "Power", MinW: 2, MinH: 1, W: 3, H: 1})
	g.DashboardDevices["unmetered"] = DashboardDevice{Name: "Unmetered"}
	d.Layout.Widgets = []DashboardWidget{{ID: "fleet-power", Kind: "power-now", W: 3, H: 1, DeviceIDs: []string{"one", "unmetered"}}}
	if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
		t.Fatal(err)
	}
	layout := DashboardLayout{Version: 1, Widgets: append([]DashboardWidget{}, d.Layout.Widgets...)}
	for i := 0; i < 23; i++ {
		layout.Widgets = append(layout.Widgets, DashboardWidget{ID: fmt.Sprintf("cpu-%d", i), Kind: "sensor", Title: "CPU temperature", W: 3, H: 1, Y: i + 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"cpu"}})
	}
	p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: layout}
	raw, _ := json.Marshal(p)
	if len(raw) < 2048 {
		t.Fatal("fixture must exceed the legacy tool bound")
	}
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal(err)
	}
	if len(g.Dashboard.Layout.Widgets) != 24 {
		t.Fatal("lost widget")
	}
	ctx, cancel := context.WithCancel(context.Background())
	g.ReadDashboardSensors = func(context.Context, string) ([]DashboardSensor, error) {
		cancel()
		return []DashboardSensor{{ID: "new", Unit: "C"}}, nil
	}
	p.ExpectedRevision = g.Dashboard.Revision
	p.Layout.Widgets[1].SensorIDs = []string{"new"}
	raw, _ = json.Marshal(p)
	if _, err := g.Call(ctx, "propose_dashboard", raw); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if g.Dashboard.Revision != p.ExpectedRevision {
		t.Fatal("cancellation changed revision")
	}
}

func TestDashboardProposalRejectsOverlapButPublishesSavedGeometry(t *testing.T) {
	g, d := dashboardFixture()
	d.Layout.Widgets = []DashboardWidget{
		{ID: "cpu-a", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"cpu"}},
		{ID: "cpu-b", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"one"}, SensorIDs: []string{"cpu"}},
	}
	if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
		t.Fatal("saved overlap prevented publication", err)
	}
	p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: d.Layout}
	raw, _ := json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
		t.Fatal("unchanged overlapping proposal bypassed validation")
	}
	p.Layout.Widgets = append([]DashboardWidget{}, d.Layout.Widgets...)
	p.Layout.Widgets[1].X = 1
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
		t.Fatal("overlapping proposal accepted")
	}
	if g.Dashboard.Revision != d.Revision {
		t.Fatal("rejected overlap changed draft")
	}
	p.Layout.Widgets[1].X = 3
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal("touching edges rejected", err)
	}
}

func TestDashboardPreservesUnavailableSavedBindings(t *testing.T) {
	g, d := dashboardFixture()
	g.DashboardDevices["one"] = DashboardDevice{Name: "One"}
	d.Layout.Widgets = []DashboardWidget{{ID: "console-one", Kind: "jetkvm", W: 6, H: 4, DeviceIDs: []string{"one"}}}
	if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
		t.Fatal("saved unavailable source prevented publication", err)
	}
	p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: DashboardLayout{Version: 1, Widgets: append([]DashboardWidget{}, d.Layout.Widgets...)}}
	p.Layout.Widgets[0].Y = 4
	raw, _ := json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal("existing unavailable source could not move", err)
	}
	delete(g.DashboardDevices, "one")
	p.ExpectedRevision = g.Dashboard.Revision
	p.Layout.Widgets[0].Y = 8
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal("existing removed source could not move", err)
	}
	p.ExpectedRevision = g.Dashboard.Revision
	p.Layout.Widgets[0].ID = "new-console"
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
		t.Fatal("new unsupported source accepted")
	}
	// Expiry clears the server grant while the mounted browser still knows its previous revision.
	g.Dashboard = nil
	d.Revision = "after-expiry"
	if err := g.PublishDashboard(context.Background(), d, "old-expired-revision"); err != nil {
		t.Fatal("expired session could not republish", err)
	}
}

func TestDashboardProposalScopeMatchesSurface(t *testing.T) {
	for _, mode := range []string{"device", "fixed", "fleet", "wall"} {
		t.Run(mode, func(t *testing.T) {
			g, d := dashboardFixture()
			d.Mode = mode
			d.DeviceID = "one"
			w := DashboardWidget{ID: "cpu-reading", Kind: "sensor", W: 3, H: 1, SensorID: "cpu"}
			if mode == "device" || mode == "fixed" {
				w.DeviceIDs = []string{"one"}
			}
			d.Layout.Widgets = []DashboardWidget{w}
			if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
				t.Fatal("saved context should remain publishable", err)
			}
			w.Y = 1
			p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{w}}}
			raw, _ := json.Marshal(p)
			if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
				t.Fatal("proposal scope incompatible with dashboard accepted")
			}
			if g.Dashboard.Revision != d.Revision {
				t.Fatal("rejected scope changed preview")
			}
			if mode == "device" || mode == "fixed" {
				w.DeviceIDs = nil
			} else {
				w.DeviceIDs = []string{"one"}
			}
			d.Revision = "corrected"
			d.Layout.Widgets = []DashboardWidget{w}
			if err := g.PublishDashboard(context.Background(), d, "r1"); err != nil {
				t.Fatal(err)
			}
			w.Y++
			p.ExpectedRevision = d.Revision
			p.Layout.Widgets = []DashboardWidget{w}
			raw, _ = json.Marshal(p)
			if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
				t.Fatal("compatible scope rejected", err)
			}
		})
	}
}

func TestDashboardProposalRejectsDuplicateConsoleSurface(t *testing.T) {
	g, d := dashboardFixture()
	device := g.DashboardDevices["one"]
	device.VNC = true
	g.DashboardDevices["one"] = device
	g.DashboardDevices["two"] = DashboardDevice{Name: "Two", JetKVM: true}
	d.Catalog = append(d.Catalog, DashboardKind{Kind: "vnc", Title: "VNC", MinW: 6, MinH: 4, W: 6, H: 4})
	if err := g.PublishDashboard(context.Background(), d, ""); err != nil {
		t.Fatal(err)
	}
	p := DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: DashboardLayout{Version: 1, Widgets: []DashboardWidget{
		{ID: "console-a", Kind: "jetkvm", W: 6, H: 4, DeviceIDs: []string{"one"}},
		{ID: "console-b", Kind: "jetkvm", X: 6, W: 6, H: 4, DeviceIDs: []string{"one"}},
	}}}
	raw, _ := json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err == nil {
		t.Fatal("same console surface proposed twice")
	}
	if g.Dashboard.Revision != d.Revision {
		t.Fatal("duplicate console changed preview")
	}
	p.Layout.Widgets[1].Kind = "vnc"
	p.Layout.Widgets = append(p.Layout.Widgets, DashboardWidget{ID: "console-c", Kind: "jetkvm", Y: 4, W: 6, H: 4, DeviceIDs: []string{"two"}})
	raw, _ = json.Marshal(p)
	if _, err := g.Call(context.Background(), "propose_dashboard", raw); err != nil {
		t.Fatal("distinct server/provider surfaces rejected", err)
	}
}
