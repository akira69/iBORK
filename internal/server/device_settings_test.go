package server

import (
	"errors"
	"strings"
	"testing"
)

type fakeSettings struct {
	calls int
	fail  bool
}

func (*fakeSettings) List() []DeviceSettings {
	return []DeviceSettings{{ID: "default", Host: "192.0.2.2", Name: "Test", Port: 623, Username: "ADMIN"}}
}
func (s *fakeSettings) Save(DeviceSettings) error {
	s.calls++
	if s.fail {
		return errors.New("write failed")
	}
	return nil
}
func TestDeviceSettingsAuthorization(t *testing.T) {
	s, _ := testServer(t)
	store := &fakeSettings{}
	reloads := 0
	s.SetDeviceSettings(store, func() { reloads++ })
	if w := request(s, "GET", "/api/device-settings", "", nil, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	cookie, csrf := login(t, s)
	if w := request(s, "GET", "/api/device-settings", "", cookie, "", ""); w.Code != 200 || strings.Contains(w.Body.String(), "password") {
		t.Fatal(w.Body.String())
	}
	for _, origin := range []string{"", "http://evil.invalid"} {
		if w := request(s, "POST", "/api/device-settings", "{}", cookie, csrf, origin); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	if w := request(s, "POST", "/api/device-settings", "{}", cookie, "bad", "http://localhost:8080"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/device-settings", `{"passwordFile":"/etc/passwd"}`, cookie, csrf, "http://localhost:8080"); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if store.calls != 0 {
		t.Fatal("unauthorized settings write")
	}
	store.fail = true
	if w := request(s, "POST", "/api/device-settings", "{}", cookie, csrf, "http://localhost:8080"); w.Code != 400 || reloads != 0 {
		t.Fatal(w.Code, reloads)
	}
	store.fail = false
	if w := request(s, "POST", "/api/device-settings", "{}", cookie, csrf, "http://localhost:8080"); w.Code != 200 || reloads != 1 {
		t.Fatal(w.Code, reloads)
	}
	if w := request(s, "GET", "/api/session", "", cookie, "", ""); w.Code != 503 {
		t.Fatal("reload should temporarily pause requests without expiring the login")
	}
}

func (s *fakeSettings) Remove(string) error { return s.Save(DeviceSettings{}) }

func TestRemoveStandaloneAuthorization(t *testing.T) {
	s, _ := testServer(t)
	store := &fakeSettings{}
	reloads := 0
	s.SetDeviceSettings(store, func() { reloads++ })
	cookie, csrf := login(t, s)
	for _, tc := range []struct {
		body, origin, csrf string
		status             int
	}{
		{`{"id":"jet","confirm":"jet"}`, "", csrf, 403},
		{`{"id":"jet","confirm":"jet"}`, s.cfg.Origin, "", 403},
		{`{"id":"jet","confirm":"other"}`, s.cfg.Origin, csrf, 400},
		{`{"id":"jet","confirm":"jet","passwordFile":"/secret"}`, s.cfg.Origin, csrf, 400},
	} {
		if w := request(s, "DELETE", "/api/device-settings", tc.body, cookie, tc.csrf, tc.origin); w.Code != tc.status {
			t.Fatal(w.Code, tc.status)
		}
	}
	if w := request(s, "DELETE", "/api/device-settings", `{"id":"jet","confirm":"jet"}`, nil, csrf, s.cfg.Origin); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if store.calls != 0 {
		t.Fatal("invalid removal reached store")
	}
	if w := request(s, "DELETE", "/api/device-settings", `{"id":"jet","confirm":"jet"}`, cookie, csrf, s.cfg.Origin); w.Code != 200 || reloads != 1 {
		t.Fatal(w.Code, reloads)
	}
	if w := request(s, "GET", "/api/session", "", cookie, "", ""); w.Code != 503 {
		t.Fatal("removed inventory must pause requests until reload")
	}
}
