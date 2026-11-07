package assistant

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
)

//go:embed dashboard-guide.md
var DashboardGuide string

const DashboardLimit = 64 * 1024

type DashboardWidget struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Title      string   `json:"title,omitempty"`
	X          int      `json:"x"`
	Y          int      `json:"y"`
	W          int      `json:"w"`
	H          int      `json:"h"`
	DeviceIDs  []string `json:"deviceIds,omitempty"`
	SensorID   string   `json:"sensorId,omitempty"`
	SensorIDs  []string `json:"sensorIds,omitempty"`
	SensorMode string   `json:"sensorMode,omitempty"`
	Aggregate  string   `json:"aggregate,omitempty"`
}
type DashboardLayout struct {
	Version int               `json:"version"`
	Widgets []DashboardWidget `json:"widgets"`
}
type DashboardKind struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	MinW  int    `json:"minW"`
	MinH  int    `json:"minH"`
	W     int    `json:"w"`
	H     int    `json:"h"`
}
type Dashboard struct {
	Instance string          `json:"instance"`
	Target   string          `json:"target"`
	Title    string          `json:"title"`
	Revision string          `json:"revision"`
	Mode     string          `json:"mode"`
	DeviceID string          `json:"deviceId,omitempty"`
	Layout   DashboardLayout `json:"layout"`
	Catalog  []DashboardKind `json:"catalog"`
	Draft    bool            `json:"draft,omitempty"`
	Summary  string          `json:"summary,omitempty"`
}
type DashboardProposal struct {
	Instance         string          `json:"instance"`
	Target           string          `json:"target"`
	ExpectedRevision string          `json:"expectedRevision"`
	Layout           DashboardLayout `json:"layout"`
}
type DashboardDevice struct {
	Name       string `json:"name"`
	Management bool   `json:"management"`
	Sensors    bool   `json:"sensors"`
	Energy     bool   `json:"energy"`
	JetKVM     bool   `json:"jetkvm"`
	VNC        bool   `json:"vnc"`
	GLInet     bool   `json:"glinet"`
}
type DashboardSensor struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Type  string   `json:"type"`
	Unit  string   `json:"unit"`
	Value *float64 `json:"value,omitempty"`
	Valid bool     `json:"valid"`
}

var widgetID = regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`)
var dashboardDeviceID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
var dashboardMin = map[string][2]int{
	"sensor-cpu": {2, 2}, "sensor-memory": {2, 2}, "sensor-fans": {2, 2}, "sensor-power": {2, 2}, "sensor-storage": {2, 2}, "sensor-board": {2, 2}, "sensor-network": {2, 2}, "sensor-other": {2, 2},
	"power-statistics": {4, 4}, "power-hour": {3, 3}, "power-day": {3, 3}, "power-week": {3, 3}, "power-projections": {3, 2},
	"jetkvm": {3, 4}, "vnc": {3, 4}, "glinet": {3, 4}, "power-control": {3, 3}, "health": {3, 3}, "power-usage": {6, 6}, "sensor": {2, 1}, "cooling": {3, 2}, "fans": {2, 3}, "temperatures": {2, 3}, "psu": {2, 3}, "alerts": {2, 3}, "events": {3, 3}, "inventory": {3, 3}, "connections": {2, 3}, "power-now": {2, 1}, "energy-cost": {3, 3}, "boot": {3, 3}, "media": {3, 3}, "sol": {4, 4}, "diagnostics": {3, 4},
}

func dashboardProposalTool() Tool {
	t := tool("propose_dashboard", "Validate a complete layout and replace the active preview only. Read dashboard_context first. The browser must Apply to save.", []string{"instance", "target", "expectedRevision", "layout"}, "instance", "target", "expectedRevision")
	text := map[string]any{"type": "string"}
	props := map[string]any{"id": text, "kind": text, "title": text, "sensorId": text, "sensorMode": map[string]any{"type": "string", "enum": []string{"fixed", "selectable"}}, "aggregate": map[string]any{"type": "string", "enum": []string{"max"}}}
	for _, field := range []string{"x", "y", "w", "h"} {
		props[field] = map[string]any{"type": "integer"}
	}
	for _, field := range []string{"deviceIds", "sensorIds"} {
		props[field] = map[string]any{"type": "array", "items": text, "maxItems": 64}
	}
	widget := map[string]any{"type": "object", "additionalProperties": false, "required": []string{"id", "kind", "x", "y", "w", "h"}, "properties": props}
	t.Parameters["properties"].(map[string]any)["layout"] = map[string]any{"type": "object", "additionalProperties": false, "required": []string{"version", "widgets"}, "properties": map[string]any{"version": map[string]any{"type": "integer", "enum": []int{1}}, "widgets": map[string]any{"type": "array", "maxItems": 24, "items": widget}}}
	return t
}

func dashboardText(s string, max int) bool {
	return len(s) > 0 && len(s) <= max && strings.IndexFunc(s, unicode.IsControl) < 0
}

func (g *Grant) PublishDashboard(ctx context.Context, d Dashboard, expected string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if g.Dashboard != nil {
		if d.Instance != g.Dashboard.Instance {
			return errors.New("Dashboard belongs to another browser tab; release it there or wait for the assistant session to expire")
		}
		if reflect.DeepEqual(d, *g.Dashboard) {
			return nil
		}
		if expected != g.Dashboard.Revision || d.Revision == expected {
			return errors.New("Dashboard revision changed; refresh assistant status before editing")
		}
	}
	if !dashboardText(d.Instance, 128) || !dashboardText(d.Target, 128) || !dashboardText(d.Revision, 128) || !dashboardText(d.Title, 100) || !slices.Contains([]string{"fleet", "device", "fixed", "wall"}, d.Mode) {
		return errors.New("Invalid dashboard context")
	}
	if d.DeviceID != "" {
		if _, ok := g.DashboardDevices[d.DeviceID]; !ok {
			return errors.New("Unknown dashboard server")
		}
	}
	if d.Mode == "device" && d.DeviceID == "" {
		return errors.New("Device dashboard requires a server")
	}
	if len(d.Catalog) == 0 || len(d.Catalog) > len(dashboardMin) {
		return errors.New("Invalid dashboard catalog")
	}
	seen := map[string]bool{}
	for _, k := range d.Catalog {
		min, ok := dashboardMin[k.Kind]
		if !ok || seen[k.Kind] || !dashboardText(k.Title, 100) || k.MinW < min[0] || k.MinH < min[1] || k.W < k.MinW || k.W > 12 || k.H < k.MinH || k.H > 24 {
			return errors.New("Invalid dashboard widget limits")
		}
		seen[k.Kind] = true
	}
	if err := g.validateDashboard(ctx, &d, d.Layout, false); err != nil {
		return err
	}
	d.Draft = false
	d.Summary = ""
	g.Dashboard = &d
	g.dashboardPrevious = ""
	return nil
}

func (g *Grant) dashboardSensors(ctx context.Context, id string) ([]DashboardSensor, error) {
	device, ok := g.DashboardDevices[id]
	if !ok {
		return nil, errors.New("Unknown server; use dashboard_context")
	}
	if !device.Sensors || g.ReadDashboardSensors == nil {
		return nil, errors.New("Sensor source unavailable for this server")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sensors, err := g.ReadDashboardSensors(ctx, id)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		return nil, errors.New("Sensor readings unavailable; retry when the server is reachable")
	}
	if len(sensors) > 256 {
		sensors = sensors[:256]
	}
	return sensors, nil
}

func (g *Grant) dashboardCall(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	if g.Dashboard == nil {
		return nil, errors.New("Open a dashboard in iBORK and connect Assistant before using dashboard tools")
	}
	switch name {
	case "dashboard_context":
		if err := arguments(raw, &struct{}{}); err != nil {
			return nil, err
		}
		return map[string]any{"dashboard": g.Dashboard, "servers": g.DashboardDevices, "guide": DashboardGuide}, nil
	case "dashboard_sensors":
		var p struct {
			DeviceID string `json:"deviceId"`
		}
		if err := arguments(raw, &p); err != nil {
			return nil, err
		}
		sensors, err := g.dashboardSensors(ctx, p.DeviceID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"deviceId": p.DeviceID, "sensors": sensors}, nil
	case "propose_dashboard":
		var p DashboardProposal
		if err := decodeArguments(raw, &p, DashboardLimit); err != nil {
			return nil, err
		}
		d := g.Dashboard
		if p.ExpectedRevision == "" {
			return nil, errors.New("Expected dashboard revision is required")
		}
		if p.Instance != d.Instance || p.Target != d.Target {
			return nil, errors.New("Dashboard target or browser changed; read dashboard_context again")
		}
		unchanged := reflect.DeepEqual(p.Layout, d.Layout)
		if p.ExpectedRevision != d.Revision && !(unchanged && p.ExpectedRevision == g.dashboardPrevious) {
			return nil, errors.New("Dashboard revision changed; read dashboard_context again")
		}
		if err := g.validateDashboard(ctx, d, p.Layout, true); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if unchanged {
			return d, nil
		}
		added, removed, changed := dashboardChanges(d.Layout, p.Layout)
		next := *d
		next.Layout = p.Layout
		next.Draft = true
		next.Revision = rand.Text()
		next.Summary = fmt.Sprintf("Added %d, removed %d, changed %d widgets. Preview only; use Apply dashboard in the browser to save.", added, removed, changed)
		g.dashboardPrevious = d.Revision
		g.Dashboard = &next
		return &next, nil
	}
	return nil, errors.New("Unknown dashboard tool")
}

func dashboardChanges(old, next DashboardLayout) (added, removed, changed int) {
	previous := map[string]DashboardWidget{}
	for _, w := range old.Widgets {
		previous[w.ID] = w
	}
	for _, w := range next.Widgets {
		if p, ok := previous[w.ID]; !ok {
			added++
		} else if !reflect.DeepEqual(p, w) {
			changed++
		}
		delete(previous, w.ID)
	}
	return added, len(previous), changed
}

func (g *Grant) validateDashboard(ctx context.Context, d *Dashboard, layout DashboardLayout, sensors bool) error {
	if layout.Version != 1 || layout.Widgets == nil || len(layout.Widgets) > 24 {
		return errors.New("Expected version 1 layout with at most 24 widgets")
	}
	data, _ := json.Marshal(layout)
	if len(data) > DashboardLimit {
		return errors.New("Dashboard layout is too large")
	}
	kinds := map[string]DashboardKind{}
	for _, k := range d.Catalog {
		kinds[k.Kind] = k
	}
	ids := map[string]bool{}
	consoles := map[[2]string]bool{}
	readings := map[string][]DashboardSensor{}
	if sensors && (d.Mode == "fixed" || d.Mode == "wall") {
		if len(layout.Widgets) != len(d.Layout.Widgets) {
			return errors.New("This dashboard keeps its existing widget inventory")
		}
		for _, w := range layout.Widgets {
			found := false
			for _, old := range d.Layout.Widgets {
				old.X = w.X
				old.Y = w.Y
				old.W = w.W
				old.H = w.H
				old.Title = w.Title
				if reflect.DeepEqual(old, w) {
					found = true
					break
				}
			}
			if !found {
				return errors.New("This dashboard supports moving and resizing its existing widgets only")
			}
		}
	}
	for index, w := range layout.Widgets {
		k, ok := kinds[w.Kind]
		if !ok || !widgetID.MatchString(w.ID) || ids[w.ID] || (w.Title != "" && !dashboardText(w.Title, 100)) {
			return errors.New("Invalid, duplicate or unsupported dashboard widget")
		}
		ids[w.ID] = true
		if w.X < 0 || w.X > 12 || w.Y < 0 || w.Y > 200 || w.W < k.MinW || w.W > 12 || w.X+w.W > 12 || w.H < k.MinH || w.H > 24 {
			return errors.New("Widget position or size is outside dashboard limits")
		}
		if sensors {
			for _, previous := range layout.Widgets[:index] {
				if w.X < previous.X+previous.W && previous.X < w.X+w.W && w.Y < previous.Y+previous.H && previous.Y < w.Y+w.H {
					return errors.New("Dashboard widgets overlap; arrange separate rectangles before proposing")
				}
			}
		}
		// Existing bindings can outlive a source or its capabilities; only new bindings need discovery.
		preserved := false
		for _, old := range d.Layout.Widgets {
			if old.ID == w.ID && old.Kind == w.Kind && reflect.DeepEqual(old.DeviceIDs, w.DeviceIDs) && old.SensorID == w.SensorID && reflect.DeepEqual(old.SensorIDs, w.SensorIDs) && old.Aggregate == w.Aggregate && old.SensorMode == w.SensorMode {
				preserved = true
				break
			}
		}
		scoped := len(w.DeviceIDs) > 0
		if sensors && scoped != (d.Mode == "fleet" || d.Mode == "wall") {
			return errors.New("Use unscoped widgets on device/fixed dashboards and deviceIds on fleet/wall dashboards")
		}
		console := slices.Contains([]string{"jetkvm", "vnc", "glinet"}, w.Kind)
		if scoped && (!slices.Contains([]string{"sensor", "power-now", "power-hour", "jetkvm", "vnc", "glinet"}, w.Kind) || len(w.DeviceIDs) > 16 || ((w.Kind == "sensor" || console) && len(w.DeviceIDs) != 1)) {
			return errors.New("Unsupported widget server scope")
		}
		if _, reserved := dashboardMin[w.ID]; (scoped || w.Kind == "sensor") && reserved || (!scoped && w.Kind != "sensor" && w.ID != w.Kind) {
			return errors.New("Invalid widget identifier")
		}
		bound := w.DeviceIDs
		if !scoped && d.DeviceID != "" {
			bound = []string{d.DeviceID}
		}
		if len(bound) == 0 && (d.Mode == "fleet" || console || w.Kind == "sensor") {
			return errors.New("Widget requires a server binding")
		}
		if sensors && console {
			key := [2]string{bound[0], w.Kind}
			if consoles[key] {
				return errors.New("Each server console source can appear only once on a dashboard")
			}
			consoles[key] = true
		}
		devices := map[string]bool{}
		for _, id := range bound {
			device, ok := g.DashboardDevices[id]
			if !dashboardDeviceID.MatchString(id) || devices[id] || (!ok && sensors && !preserved) {
				return errors.New("Unknown or duplicate widget server")
			}
			devices[id] = true
			if d.DeviceID != "" && id != d.DeviceID {
				return errors.New("Widget belongs to another server dashboard")
			}
			if !sensors || preserved {
				continue
			}
			available := device.Management
			switch w.Kind {
			case "jetkvm", "media":
				available = device.JetKVM
			case "vnc":
				available = device.VNC
			case "glinet":
				available = device.GLInet
			case "sensor":
				available = device.Sensors
			case "power-now", "power-hour":
				// Unmetered group members remain visible in partial coverage rather than disappearing.
				available = scoped || device.Management || device.Energy
			}
			if !available {
				return errors.New("Server does not support this widget")
			}
		}
		if w.Kind != "sensor" && (w.SensorID != "" || len(w.SensorIDs) > 0 || w.SensorMode != "" || w.Aggregate != "") {
			return errors.New("Sensor bindings require a sensor widget")
		}
		if w.SensorMode != "" && w.SensorMode != "fixed" && w.SensorMode != "selectable" || w.Aggregate != "" && w.Aggregate != "max" || len(w.SensorIDs) > 64 {
			return errors.New("Invalid sensor configuration")
		}
		sensorIDs := append([]string{}, w.SensorIDs...)
		if w.SensorID != "" && !slices.Contains(sensorIDs, w.SensorID) {
			sensorIDs = append(sensorIDs, w.SensorID)
		}
		unique := map[string]bool{}
		for _, id := range sensorIDs {
			if !dashboardText(id, 128) || unique[id] {
				return errors.New("Invalid or duplicate sensor ID")
			}
			unique[id] = true
		}
		if scoped && w.Kind == "sensor" && len(sensorIDs) == 0 {
			return errors.New("Scoped sensor requires selected sensor IDs")
		}
		if w.Aggregate != "" && (len(sensorIDs) == 0 || w.SensorMode == "selectable") {
			return errors.New("Highest fan needs fixed fan sensors")
		}
		if !sensors || len(sensorIDs) == 0 {
			continue
		}
		if preserved {
			continue
		}
		if len(bound) != 1 {
			return errors.New("Sensor requires exactly one server")
		}
		id := bound[0]
		if _, ok := readings[id]; !ok {
			var err error
			readings[id], err = g.dashboardSensors(ctx, id)
			if err != nil {
				return err
			}
		}
		for _, sensorID := range sensorIDs {
			found := false
			for _, reading := range readings[id] {
				if reading.ID == sensorID {
					found = true
					if w.Aggregate == "max" && !strings.EqualFold(reading.Unit, "RPM") {
						return errors.New("Highest fan aggregation only supports RPM sensors")
					}
					break
				}
			}
			if !found {
				return errors.New("Unknown sensor; read dashboard_sensors before selecting bindings")
			}
		}
	}
	return ctx.Err()
}
