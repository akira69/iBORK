package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/akira69/iBORK/internal/management"
)

type namedProvider struct {
	fakeProvider
	state string
}

func (p *namedProvider) Power(context.Context) (management.PowerState, error) {
	return management.PowerState{State: p.state}, nil
}

func TestDeviceRoutingKeepsStateAndActionsIsolated(t *testing.T) {
	s, primary := testServer(t)
	cookie, csrf := login(t, s)
	other := &namedProvider{state: "off"}
	cfg := s.cfg
	cfg.DeviceID = "dell"
	cfg.ServerName = "Rack Dell"
	cfg.JetURL = ""
	cfg.BMCHost = "192.0.2.2"
	if err := s.AddDevice(cfg, other); err != nil {
		t.Fatal(err)
	}
	if w := request(s, "GET", "/api/devices", "", nil, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w := request(s, "GET", "/api/devices", "", cookie, "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Rack Dell") || strings.Contains(w.Body.String(), "Password") {
		t.Fatal(w.Code, w.Body.String())
	}
	for path, want := range map[string]string{"/api/power": "on", "/api/devices/dell/power": "off"} {
		w = request(s, "GET", path, "", cookie, "", "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), want) {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	w = request(s, "POST", "/api/devices/dell/power", `{"action":"off","confirm":"off"}`, cookie, csrf, s.cfg.Origin)
	if w.Code != http.StatusOK || other.calls != 1 || primary.calls != 0 {
		t.Fatal(w.Code, w.Body.String(), other.calls, primary.calls)
	}
	w = request(s, "GET", "/api/devices/missing/power", "", cookie, "", "")
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
	w = request(s, "GET", "/api/devices/dell/jetkvm/status", "", cookie, "", "")
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	for _, path := range []string{"/api/devices/dell/logout", "/api/devices/dell/devices", "/api/devices/dell/../power"} {
		if w := request(s, "GET", path, "", cookie, "", ""); w.Code != 404 {
			t.Fatalf("unexpected device route allowed: %s %d", path, w.Code)
		}
	}
	if w := request(s, "POST", "/api/devices/dell/power", `{"action":"off","confirm":"off"}`, cookie, "", s.cfg.Origin); w.Code != 403 || other.calls != 1 {
		t.Fatal("device action bypassed CSRF", w.Code, other.calls)
	}
	request(s, "POST", "/api/logout", "{}", cookie, csrf, s.cfg.Origin)
	if w := request(s, "GET", "/api/devices/dell/power", "", cookie, "", ""); w.Code != 401 {
		t.Fatal("device accepted logged-out session", w.Code)
	}
}
