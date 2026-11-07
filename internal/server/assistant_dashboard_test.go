package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/assistant"
	"github.com/akira69/iBORK/internal/management"
)

func dashboardRequest() assistant.Dashboard {
	return assistant.Dashboard{Instance: "tab-a", Target: "central", Title: "Central", Revision: "r1", Mode: "fleet", Layout: assistant.DashboardLayout{Version: 1, Widgets: []assistant.DashboardWidget{}}, Catalog: []assistant.DashboardKind{{Kind: "sensor", Title: "Sensor", MinW: 2, MinH: 1, W: 3, H: 1}}}
}

func TestAssistantDashboardAuthorizationAndMCP(t *testing.T) {
	s, p := testServer(t)
	c, csrf := login(t, s)
	s.cfg.Origin = "https://localhost:8080"
	d := dashboardRequest()
	raw, _ := json.Marshal(d)
	post := func(action, body, instance string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", s.cfg.Origin+"/api/assistant/"+action, strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.AddCookie(c)
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("X-Assistant-Instance", instance)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request(s, "POST", "/api/assistant/dashboard", string(raw), nil, "", s.cfg.Origin); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/assistant/dashboard", string(raw), c, "", s.cfg.Origin); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := post("dashboard", string(raw), ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := post("pair", "{}", "tab-b"); w.Code != 409 {
		t.Fatal("another tab paired", w.Code)
	}
	if w := post("chat", "{}", "tab-b"); w.Code != 409 {
		t.Fatal("another tab chatted", w.Code)
	}
	if w := post("scope", `{"scope":"10.1.2.3"}`, "tab-b"); w.Code != 409 {
		t.Fatal("another tab reset the dashboard", w.Code)
	}
	var pair struct{ Token string }
	w := post("pair", "{}", d.Instance)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &pair) != nil || pair.Token == "" {
		t.Fatal(w.Body.String())
	}
	rpc := func(method string, params any) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		r := httptest.NewRequest("POST", s.cfg.Origin+"/api/assistant/mcp", strings.NewReader(string(body)))
		r.TLS = &tls.ConnectionState{}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+pair.Token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := rpc("tools/call", map[string]any{"name": "dashboard_context"}); !strings.Contains(w.Body.String(), `\"instance\":\"tab-a\"`) {
		t.Fatal(w.Body.String())
	}
	s.sensors = func(context.Context) ([]management.Sensor, error) {
		return []management.Sensor{{ID: "cpu", Name: "CPU1", Value: "40", Unit: "C", State: "ok"}}, nil
	}
	proposal := assistant.DashboardProposal{Instance: d.Instance, Target: d.Target, ExpectedRevision: d.Revision, Layout: assistant.DashboardLayout{Version: 1, Widgets: []assistant.DashboardWidget{{ID: "cpu-one", Kind: "sensor", W: 3, H: 1, DeviceIDs: []string{"default"}, SensorIDs: []string{"cpu"}}}}}
	if w := rpc("tools/call", map[string]any{"name": "propose_dashboard", "arguments": proposal}); !strings.Contains(w.Body.String(), `"isError":false`) {
		t.Fatal(w.Body.String())
	}
	state := request(s, "GET", "/api/assistant/status", "", c, csrf, s.cfg.Origin)
	if !strings.Contains(state.Body.String(), `"draft":true`) || !strings.Contains(state.Body.String(), "cpu-one") {
		t.Fatal(state.Body.String())
	}
	if w := post("dashboard", `{"instance":"tab-b","release":true}`, ""); w.Code != 409 {
		t.Fatal("foreign release", w.Code)
	}
	if w := post("dashboard", `{"instance":"tab-a","release":true}`, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := rpc("tools/list", nil); w.Code != 401 {
		t.Fatal("release did not revoke MCP", w.Code)
	}
	if p.calls != 0 {
		t.Fatal("proposal executed hardware controls")
	}
}

func TestAssistantDashboardExpiryAndConcurrentPublication(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	d := dashboardRequest()
	raw, _ := json.Marshal(d)
	if w := request(s, "POST", "/api/assistant/dashboard", string(raw), c, csrf, s.cfg.Origin); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, revision := range []string{"r2", "r3"} {
		wg.Add(1)
		go func(revision string) {
			defer wg.Done()
			next := d
			next.Revision = revision
			body, _ := json.Marshal(struct {
				assistant.Dashboard
				ExpectedRevision string `json:"expectedRevision"`
			}{next, "r1"})
			codes <- request(s, "POST", "/api/assistant/dashboard", string(body), c, csrf, s.cfg.Origin).Code
		}(revision)
	}
	wg.Wait()
	close(codes)
	accepted := 0
	for code := range codes {
		if code == 200 {
			accepted++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if accepted != 1 {
		t.Fatal("concurrent revisions both published", accepted)
	}
	a := &s.sessions[c.Value].assistant
	a.mu.Lock()
	a.activeUntil = time.Now().Add(-time.Second)
	a.mu.Unlock()
	w := request(s, "GET", "/api/assistant/status", "", c, csrf, s.cfg.Origin)
	if strings.Contains(w.Body.String(), `"dashboard"`) {
		t.Fatal("expired draft survived", w.Body.String())
	}
	request(s, "POST", "/api/logout", "{}", c, csrf, s.cfg.Origin)
	if w := request(s, "POST", "/api/assistant/dashboard", string(raw), c, csrf, s.cfg.Origin); w.Code != 401 {
		t.Fatal("signed out draft published", w.Code)
	}
}

func TestAssistantDashboardSensorSanitization(t *testing.T) {
	s, _ := testServer(t)
	s.sensors = func(context.Context) ([]management.Sensor, error) {
		return []management.Sensor{{ID: "zero", Name: "Fan\x00 zero", Value: "0", Unit: "RPM", State: "ok"}, {ID: "bad", Name: "Unknown", Value: "NaN", Unit: "RPM"}, {ID: "unavailable", Value: "99", State: "na"}, {ID: "zero", Value: "8"}, {ID: "details", DetailOnly: true}}, nil
	}
	got, err := s.dashboardSensors(context.Background(), "default")
	if err != nil || len(got) != 3 || got[0].Name != "Fan zero" || !got[0].Valid || got[0].Value == nil || *got[0].Value != 0 || got[1].Valid || got[2].Valid {
		t.Fatal(got, err)
	}
	if _, err := s.dashboardSensors(context.Background(), "unknown"); err == nil {
		t.Fatal("unknown source accepted")
	}
}

func TestAssistantDashboardRequestBounds(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	d := dashboardRequest()
	for i := 0; i < 24; i++ {
		d.Layout.Widgets = append(d.Layout.Widgets, assistant.DashboardWidget{ID: fmt.Sprintf("cpu-%d", i), Kind: "sensor", Title: strings.Repeat("x", 100), W: 3, H: 1, Y: i, DeviceIDs: []string{"default"}, SensorIDs: []string{"cpu"}})
	}
	raw, _ := json.Marshal(d)
	if len(raw) < 4096 {
		t.Fatal("fixture must exceed old browser request bound")
	}
	if w := request(s, "POST", "/api/assistant/dashboard", string(raw), c, csrf, s.cfg.Origin); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(s, "POST", "/api/assistant/dashboard", `{"extra":true}`, c, csrf, s.cfg.Origin); w.Code != 400 {
		t.Fatal("unknown field accepted", w.Code)
	}
	if w := request(s, "POST", "/api/assistant/dashboard", `{"title":"`+strings.Repeat("x", assistant.DashboardLimit)+`"}`, c, csrf, s.cfg.Origin); w.Code != 400 {
		t.Fatal("excessive body accepted", w.Code)
	}
}
