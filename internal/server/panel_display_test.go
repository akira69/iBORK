package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const displayBody = `{"revision":1,"periods":[{"start":1439,"brightness":100},{"start":0,"brightness":0},{"start":8,"brightness":4},{"start":700,"brightness":71}]}`
const webDisplay = "/api/panel-display"
const nativeDisplay = "/api/v1/panel/display"

func TestDisplayScheduleWebAndSnapshot(t *testing.T) {
	s, _ := testServer(t)
	key := token()
	cookie, csrf := login(t, s)
	s.cfg.Origin = "https://localhost:8080"
	web := func(method, body, csrf string) *httptest.ResponseRecorder {
		return request(s, method, webDisplay, body, cookie, csrf, s.cfg.Origin)
	}
	if w := web("GET", "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if w := panelRequest(s, "GET", webDisplay, "", "Bearer "+key); w.Code != 401 {
		t.Fatal("panel bearer reached web route", w.Code)
	}
	if w := web("PUT", displayBody, ""); w.Code != 403 {
		t.Fatal("CSRF not enforced", w.Code)
	}
	if w := panelRequest(s, "PUT", nativeDisplay, displayBody, "Bearer "+key); w.Code != 403 {
		t.Fatal("PIN disabled but write available", w.Code)
	}
	for _, invalid := range []struct{ from, to string }{
		{`"revision":1,`, ""}, {`"revision":1`, `"revision":0`}, {`"revision":1`, `"revision":4294967296`},
		{`"start":0,`, ""}, {`"start":0`, `"start":null`}, {`"start":0`, `"start":-1`},
		{`"start":0`, `"start":1440`}, {`"start":0`, `"start":8`}, {`"start":0`, `"start":0,"start":5`},
		{`,"brightness":0`, ""}, {`"brightness":0`, `"brightness":null`}, {`"brightness":0`, `"brightness":101`},
		{`"brightness":0`, `"brightness":0.5`}, {`{"start":0,"brightness":0},`, ""},
		{`"periods":`, `"pin":"123456","periods":`},
	} {
		body := strings.Replace(displayBody, invalid.from, invalid.to, 1)
		if w := web("PUT", body, csrf); w.Code != 400 {
			t.Errorf("accepted invalid field %s -> %s: %d", invalid.from, invalid.to, w.Code)
		}
	}
	const initial = `{"revision":1,"periods":[{"start":60,"brightness":0},{"start":300,"brightness":25},{"start":420,"brightness":100},{"start":1140,"brightness":25}]}`
	if w := web("GET", "", ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != initial {
		t.Fatal(w.Code, w.Body)
	}
	snapshot := func() string {
		w := panelRequest(s, "GET", "/api/v1/panel", "", "Bearer "+key)
		var data struct{ DisplaySchedule json.RawMessage }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &data) != nil {
			t.Fatal(w.Code, w.Body)
		}
		return string(data.DisplaySchedule)
	}
	if snapshot() != initial {
		t.Fatal("missing initial snapshot schedule")
	}
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	r := httptest.NewRequestWithContext(expired, "PUT", webDisplay, strings.NewReader(displayBody))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.panel.saveDisplay = func([]byte) error { t.Fatal("expired request persisted"); return nil }
	s.panel.displaySettings(w, r, false)
	if w.Code != 503 {
		t.Fatal("expired request accepted", w.Code)
	}
	s.panel.saveDisplay = func([]byte) error { return errors.New("fixture storage failure") }
	if w := web("PUT", displayBody, csrf); w.Code != 503 || snapshot() != initial {
		t.Fatal("failed save changed schedule", w.Code)
	}
	var saved []byte
	s.panel.saveDisplay = func(data []byte) error { saved = data; return nil }
	results := make(chan int, 2)
	for range 2 {
		go func() { results <- web("PUT", displayBody, csrf).Code }()
	}
	first, second := <-results, <-results
	if !(first == 200 && second == 409 || first == 409 && second == 200) {
		t.Fatal("concurrent writes accepted or lost", first, second)
	}
	expected := strings.Replace(displayBody, `"revision":1`, `"revision":2`, 1)
	if string(saved) != expected || snapshot() != expected {
		t.Fatal("persisted and cached schedules did not advance")
	}
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPanelDisplay([]byte("{}"), nil); err == nil {
		t.Fatal("loaded corrupt settings")
	}
	if err := s.SetPanelDisplay(saved, nil); err != nil || snapshot() != expected {
		t.Fatal("failed to reload persisted schedule", err)
	}
}

func TestDisplayScheduleNativePIN(t *testing.T) {
	s, _ := testServer(t)
	key := token()
	s.cfg.Origin = "https://localhost:8080"
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnablePanel(key, string(hash), nil); err != nil {
		t.Fatal(err)
	}
	s.panel.saveDisplay = func(data []byte) error {
		if strings.Contains(string(data), "pin") {
			t.Fatal("PIN persisted")
		}
		return nil
	}
	put := func(pin, auth string) *httptest.ResponseRecorder {
		return panelRequest(s, "PUT", nativeDisplay, `{"pin":"`+pin+`",`+displayBody[1:], auth)
	}
	if w := put("123456", ""); w.Code != 401 {
		t.Fatal("missing bearer accepted", w.Code)
	}
	if w := request(s, "PUT", nativeDisplay, displayBody, nil, "", ""); w.Code != 403 {
		t.Fatal("plaintext native request accepted", w.Code)
	}
	auth := "Bearer " + key
	if w := put("654321", auth); w.Code != 403 || s.panel.failures != 1 {
		t.Fatal("wrong PIN accepted or limiter bypassed", w.Code)
	}
	if w := put("123456", auth); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
		t.Fatal(w.Code, w.Body)
	}
	if w := put("123456", auth); w.Code != 409 {
		t.Fatal("stale native edit accepted", w.Code)
	}
	s.panel.failures = 5
	if w := put("123456", auth); w.Code != 429 {
		t.Fatal("shared PIN lockout bypassed", w.Code)
	}
}
