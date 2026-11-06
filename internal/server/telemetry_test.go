package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akira69/iBORK/internal/energy"
)

func TestTelemetryDeviceRoutesAndCapabilities(t *testing.T) {
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"label":"Exhaust","type":"fan_speed","unit":"R","value":1799}]`)
	}))
	defer agent.Close()
	s, provider := testServer(t)
	cfg := s.cfg
	cfg.DeviceID, cfg.JetURL, cfg.GlancesURL = "mac", "", agent.URL
	if err := s.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	cfg.DeviceID, cfg.GlancesURL, cfg.History = "meter", "", energy.MemoryOnly()
	if err := s.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	cookie, csrf := login(t, s)
	w := request(s, "GET", "/api/devices", "", cookie, "", "")
	var devices []struct {
		ID                                   string
		HasManagement, HasEnergy, HasSensors bool
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &devices) != nil || len(devices) != 3 {
		t.Fatal(w.Body.String())
	}
	mac, meter := devices[1], devices[2]
	if mac.ID != "mac" || mac.HasManagement || mac.HasEnergy || !mac.HasSensors || meter.ID != "meter" || meter.HasManagement || !meter.HasEnergy || meter.HasSensors {
		t.Fatal(devices)
	}
	for _, tc := range []struct {
		path    string
		status  int
		content string
	}{
		{"mac/sensors", 200, "1799"},
		{"mac/power", 409, "unavailable"},
		{"mac/energy", 409, "No power source"},
		{"meter/energy", 200, "samples"},
		{"meter/sensors", 409, "No sensors"},
		{"meter/inventory", 409, "unavailable"},
	} {
		path := "/api/devices/" + tc.path
		if w := request(s, "GET", path, "", nil, "", ""); w.Code != 401 {
			t.Fatal(path, w.Code)
		}
		w := request(s, "GET", path, "", cookie, "", "")
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.content) {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	if w := request(s, "POST", "/api/devices/mac/power", `{"action":"off","confirm":"off"}`, cookie, csrf, s.cfg.Origin); w.Code != 409 || provider.calls != 0 {
		t.Fatal("telemetry device routed a chassis action")
	}
}

func TestTelemetrySettingsRequestLimit(t *testing.T) {
	s, _ := testServer(t)
	store := &fakeSettings{}
	s.SetDeviceSettings(store, func() {})
	cookie, csrf := login(t, s)
	for _, tc := range []struct{ size, status int }{{32768, 400}, {4096, 200}} {
		body := `{"glancesToken":"` + strings.Repeat("x", tc.size) + `"}`
		if w := request(s, "POST", "/api/device-settings", body, cookie, csrf, s.cfg.Origin); w.Code != tc.status {
			t.Fatalf("size %d returned %d", tc.size, w.Code)
		}
	}
}
