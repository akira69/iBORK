package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSharedElectricityRate(t *testing.T) {
	const route = "/api/electricity-rate"
	s, _ := testServer(t)
	cookie, csrf := login(t, s)
	s.cfg.Origin = "https://localhost:8080"
	web := func(method, body, token string) *httptest.ResponseRecorder {
		return request(s, method, route, body, cookie, token, s.cfg.Origin)
	}
	const initial = `{"usdPerKwh":0.2}`
	const free = `{"usdPerKwh":0}`
	if w := web("GET", "", ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != initial {
		t.Fatal("initial web rate without a paired panel", w.Code, w.Body)
	}
	var stored []byte
	if err := s.SetElectricityRate(nil, func(data []byte) error { stored = data; return nil }); err != nil {
		t.Fatal(err)
	}
	if w := web("PUT", free, ""); w.Code != 403 {
		t.Fatal("missing CSRF accepted", w.Code)
	}
	key := token()
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	snapshotRate := func() float64 {
		t.Helper()
		w := panelRequest(s, "GET", "/api/v1/panel", "", "Bearer "+key)
		var data struct {
			Rate *float64 `json:"usdPerKwh"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil || data.Rate == nil {
			t.Fatal("panel snapshot omitted rate", w.Code)
		}
		return *data.Rate
	}
	if snapshotRate() != 0.2 {
		t.Fatal("wrong initial panel rate")
	}
	panelWrite := httptest.NewRequest("PUT", s.cfg.Origin+route, strings.NewReader(free))
	panelWrite.Header.Set("Origin", s.cfg.Origin)
	panelWrite.Header.Set("Authorization", "Bearer "+key)
	denied := httptest.NewRecorder()
	s.ServeHTTP(denied, panelWrite)
	if denied.Code != 401 {
		t.Fatal("web session required to write rate", denied.Code)
	}
	for _, bad := range []string{`{}`, `{"usdPerKwh":null}`, `{"usdPerKwh":"0.5"}`, `{"usdPerKwh":0,"usdPerKwh":1}`, `{"usdPerKwh":-1}`, `{"usdPerKwh":1000.01}`, `{"usdPerKwh":1e999}`} {
		if w := web("PUT", bad, csrf); w.Code != 400 {
			t.Errorf("accepted %s: %d", bad, w.Code)
		}
	}
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("PUT", route, strings.NewReader(free))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.electricityRateSettings(w, r, expired)
	if w.Code != 408 || stored != nil {
		t.Fatal("invalid or expired request wrote settings")
	}
	for _, val := range []string{free, `{"usdPerKwh":0.2917}`} {
		w := web("PUT", val, csrf)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != val || string(stored) != val {
			t.Fatal("save", w.Code, w.Body)
		}
		var expected electricityRate
		if json.Unmarshal(stored, &expected) != nil || snapshotRate() != expected.USDPerKwh {
			t.Fatal("cached snapshot retained old rate")
		}
	}
	restarted, _ := testServer(t)
	if err := restarted.SetElectricityRate([]byte(`{"usdPerKwh":null}`), nil); err == nil {
		t.Fatal("accepted corrupt stored rate")
	}
	if err := restarted.SetElectricityRate(stored, nil); err != nil || restarted.currentRate().USDPerKwh != 0.2917 {
		t.Fatal("restore", err)
	}
	s.saveRate = func([]byte) error { return errors.New("storage unavailable") }
	if w := web("PUT", free, csrf); w.Code != 503 || snapshotRate() != 0.2917 {
		t.Fatal("failed write changed the effective rate", w.Code)
	}
}
