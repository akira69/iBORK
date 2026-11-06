package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/akira69/iBORK/internal/management"
	"golang.org/x/crypto/bcrypt"
)

func TestPanelLayoutPublication(t *testing.T) {
	s, provider := testServer(t)
	cookie, csrf := login(t, s)
	s.cfg.Origin = "https://localhost:8080"
	key := token()
	const path = "/api/panel-layout"
	web := func(method, body, token string) *httptest.ResponseRecorder {
		return request(s, method, path, body, cookie, token, s.cfg.Origin)
	}
	cfg := s.cfg
	cfg.DeviceID, cfg.History = "meter", energy.MemoryOnly()
	if err := s.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	s.cfg.History = energy.MemoryOnly()
	if w := web("GET", "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err := s.EnablePanel(key, string(hash), nil); err != nil {
		t.Fatal(err)
	}
	const meters = `{"id":"meter","included":true,"widgets":["power"]}`
	const host = `{"id":"default","included":false,"widgets":["fan","controls"]}`
	const body = `{"revision":1,"home":["month","power"],"servers":[` + meters + "," + host + `]}`
	if w := panelRequest(s, "GET", path, "", "Bearer "+key); w.Code != 401 {
		t.Fatal("panel bearer used as web authorization", w.Code)
	}
	if w := web("PUT", body, ""); w.Code != 403 {
		t.Fatal("missing CSRF accepted", w.Code)
	}
	if w := web("GET", "", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"available":["power","temperature","fan","controls"]`) {
		t.Fatal(w.Code, w.Body)
	}
	for _, change := range []struct {
		old, new string
		status   int
	}{
		{`"revision":1`, `"revision":0`, 400}, {`"revision":1`, `"revision":2`, 409},
		{`"month","power"`, "", 400}, {`"month","power"`, `"month","month"`, 400},
		{`"month"`, `"unknown"`, 400}, {meters, host, 400}, {"," + host, "", 409},
		{`"id":"meter"`, `"id":"new"`, 409}, {`"widgets":["power"]`, `"widgets":["fan"]`, 409},
		{`"widgets":["power"]`, `"widgets":["power","power"]`, 400},
		{`"included":false,`, "", 400}, {`"included":true`, `"included":null`, 400},
		{`"widgets":["power"]`, `"widgets":null`, 400}, {`"widgets":["power"]`, `"widgets":[],"available":[]`, 400},
	} {
		if w := web("PUT", strings.Replace(body, change.old, change.new, 1), csrf); w.Code != change.status {
			t.Errorf("%s -> %s: got %d, want %d", change.old, change.new, w.Code, change.status)
		}
	}
	native := func(detail string) string {
		w := panelRequest(s, "GET", "/api/v1/panel"+detail, "", "Bearer "+key)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		return w.Body.String()
	}
	initial := native("")
	if !strings.Contains(initial, `"metered":2`) {
		t.Fatal(initial)
	}
	s.panel.saveLayout = func([]byte) error { return errors.New("disk full") }
	if w := web("PUT", body, csrf); w.Code != 503 || native("") != initial {
		t.Fatal("failed save changed layout", w.Code)
	}
	var saved []byte
	s.panel.saveLayout = func(data []byte) error { saved = data; return nil }
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { results <- web("PUT", body, csrf) }()
	}
	first, second := <-results, <-results
	if second.Code == 200 {
		first, second = second, first
	}
	if first.Code != 200 || second.Code != 409 || !strings.Contains(first.Body.String(), `"revision":2`) || !strings.Contains(first.Body.String(), `"available":["power"]`) {
		t.Fatal(first.Code, second.Code, first.Body)
	}
	layoutWithSensors := saved
	compacted := native("?detail=default")
	if strings.Contains(compacted, `"id":"default"`) || strings.Contains(compacted, `"detail":`) || !strings.Contains(compacted, `"metered":1`) || !strings.Contains(compacted, `"home":["month","power"]`) {
		t.Fatal("hidden devices or their energy remained in telemetry", compacted)
	}
	power := func() int {
		return panelRequest(s, "POST", "/api/v1/panel/power", `{"id":"default","action":"on","confirm":"on","pin":"123456"}`, "Bearer "+key).Code
	}
	if power() != 409 || provider.calls != 0 {
		t.Fatal("hidden server accepted panel power")
	}
	custom := strings.NewReplacer(`"revision":1`, `"revision":2`, `"included":false`, `"included":true`, `["fan","controls"]`, `[]`).Replace(body)
	if w := web("PUT", custom, csrf); w.Code != 200 || power() != 409 || provider.calls != 0 {
		t.Fatal("hidden power widget accepted panel power", w.Code)
	}
	if got := native(""); strings.Index(got, `"id":"default"`) < strings.Index(got, `"id":"meter"`) {
		t.Fatal("device order lost", got)
	}
	// Reload into a fleet where the meter was removed, sensors vanished and a server was added.
	next, _ := testServer(t)
	next.cfg.Origin = s.cfg.Origin
	next.sensors = nil
	cfg.DeviceID = "new"
	if err := next.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	if err := next.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := next.SetPanelLayout(layoutWithSensors, nil); err != nil {
		t.Fatal(err)
	}
	rows := next.effectiveLayout().Servers
	if len(rows) != 2 || rows[0].ID != "default" || len(rows[0].Available) != 0 || len(rows[0].Widgets) != 0 || rows[1].ID != "new" || rows[1].Included {
		t.Fatal("incorrect reconciliation", rows)
	}
}

func TestPanelDetailRefresh(t *testing.T) {
	s, _ := testServer(t)
	key := token()
	s.cfg.Origin = "https://localhost:8080"
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	s.cfg.Timeout = 3 * time.Second
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s.sensors = func(ctx context.Context) ([]management.Sensor, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
		}
		return []management.Sensor{
			{Unit: "degrees C", Value: "38"}, {Unit: "degrees F", Value: "122"}, {Unit: "degrees C", Value: "250", DetailOnly: true},
			{Unit: "degrees C", Value: "Infinity"}, {Unit: "degrees C", Value: "200", State: "unavailable"},
			{Unit: "RPM", Value: "2000"}, {Unit: "RPM", Value: "1200"}, {Unit: "RPM", Value: "-1"}, {Unit: "RPM", Value: "9000", State: "unavailable"},
		}, nil
	}
	get := func(id string) *panelReadings {
		t.Helper()
		w := panelRequest(s, "GET", "/api/v1/panel?detail="+id, "", "Bearer "+key)
		var snap struct{ Detail *panelReadings }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &snap) != nil {
			t.Fatal(w.Code, w.Body)
		}
		return snap.Detail
	}
	if get("missing") != nil || get("") != nil || calls.Load() != 0 {
		t.Fatal("polled an unrequested device")
	}
	start := time.Now()
	if d := get("default"); d == nil || d.Temperature != nil || d.Fan != nil || d.FanMax != nil || time.Since(start) >= time.Second {
		t.Fatal("cold detail did not promptly return null readings", d)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sensor scan did not start")
	}
	for range 8 {
		_ = get("default")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for {
		d := get("default")
		if d != nil && d.Temperature != nil && *d.Temperature == 50 && d.Fan != nil && *d.Fan == 1200 && d.FanMax != nil && *d.FanMax == 2000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sensor cache did not fill", d)
		}
		time.Sleep(time.Millisecond)
	}
	_, err := s.readSensors(context.Background())
	if err != nil || calls.Load() != 1 || get("") != nil || get("missing") != nil {
		t.Fatal("concurrent poll cache or detail isolation failed", calls.Load(), err)
	}
}

func TestPanelDetailFailedReadsBackOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, _ := testServer(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		calls := 0
		s.sensors = func(ctx context.Context) ([]management.Sensor, error) {
			calls++
			<-ctx.Done()
			return nil, ctx.Err()
		}
		widgets := panelDevice{ID: "default", Widgets: []string{"power"}}
		_ = s.panelDetail(ctx, widgets)
		synctest.Wait()
		if calls != 0 {
			t.Fatal("disabled widgets triggered a scan")
		}
		widgets.Widgets = []string{"fan"}
		_ = s.panelDetail(ctx, widgets)
		time.Sleep(s.cfg.Timeout)
		synctest.Wait()
		for range 3 {
			_ = s.panelDetail(ctx, widgets)
		}
		synctest.Wait()
		if calls != 1 || s.panelSensorScan.running {
			t.Fatal("timed-out refresh did not back off", calls)
		}
		time.Sleep(sensorTTL)
		_ = s.panelDetail(ctx, widgets)
		synctest.Wait()
		cancel()
		synctest.Wait()
		_ = s.panelDetail(ctx, widgets)
		if calls != 2 || s.panelSensorScan.running {
			t.Fatal("shutdown left a refresh running", calls)
		}
	})
}

func TestPanelDetailThirtySecondPolls(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, _ := testServer(t)
		calls := 0
		s.sensors = func(context.Context) ([]management.Sensor, error) {
			calls++
			switch calls {
			case 1:
				return []management.Sensor{{Unit: "degrees C", Value: "35"}}, nil
			case 2:
				return []management.Sensor{{Unit: "degrees C", Value: "40"}}, nil
			default:
				return nil, errors.New("fixture offline")
			}
		}
		read := func(want float64) {
			t.Helper()
			reading := s.panelDetail(context.Background(), panelDevice{ID: "default", Widgets: []string{"temperature"}}).Temperature
			if (want == 0 && reading != nil) || (want != 0 && (reading == nil || *reading != want)) {
				t.Fatalf("reading %v, want %v", reading, want)
			}
			synctest.Wait()
		}
		read(0) // first scan completes at t=0
		for _, want := range []float64{35, 40, 40, 0} {
			time.Sleep(30 * time.Second)
			read(want) // second scan succeeds at t=30; subsequent refreshes fail
		}
		if calls != 5 {
			t.Fatal("unexpected refresh count", calls)
		}
	})
}

func TestPanelSwitchRestingState(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, _ := testServer(t)
		device := panelDevice{ID: "default", Controls: true}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		read := func() string { return s.panelDetail(ctx, device).PowerState }
		if read() != "" {
			t.Fatal("cold switch showed a position")
		}
		synctest.Wait()
		if read() != "on" {
			t.Fatal("missing chassis state")
		}
		s.cache["power"] = cached{value: management.PowerState{State: "off"}, expires: time.Now().Add(powerTTL)}
		if read() != "off" {
			t.Fatal("standby server showed on")
		}
		device.Controls = false
		if read() != "" {
			t.Fatal("power state without a switch")
		}
		device.Controls = true
		cancel()
		time.Sleep(41 * time.Second)
		if read() != "" {
			t.Fatal("expired power state shown")
		}
	})
}
