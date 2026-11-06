package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestPasswordChange(t *testing.T) {
	s, _ := testServer(t)
	saved, reloads := "", 0
	failSave := true
	s.SetPasswordSettings(func(hash string) error {
		if failSave {
			return errors.New("private storage detail")
		}
		saved = hash
		return nil
	}, func() { reloads++ })
	cookie, csrf := login(t, s)
	other, _ := login(t, s)
	oldSession := s.sessions[other.Value]
	body := `{"currentPassword":"test password","newPassword":"new test password"}`
	for _, check := range []struct {
		cookie       *http.Cookie
		csrf, origin string
		status       int
	}{
		{nil, csrf, s.cfg.Origin, 401}, {cookie, "bad", s.cfg.Origin, 403}, {cookie, csrf, "https://evil.invalid", 403},
	} {
		if w := request(s, "POST", "/api/app-password", body, check.cookie, check.csrf, check.origin); w.Code != check.status {
			t.Fatal(w.Code)
		}
	}
	if w := request(s, "GET", "/api/app-password", "", cookie, "", ""); w.Code != 405 {
		t.Fatal(w.Code)
	}
	for _, invalid := range []string{
		`{"currentPassword":"wrong","newPassword":"new test password"}`,
		`{"currentPassword":"test password","newPassword":"short"}`,
		`{"currentPassword":"test password","newPassword":"` + strings.Repeat("界", 25) + `"}`,
		`{"currentPassword":"test password","newPassword":"new test password","path":"/etc/passwd"}`,
	} {
		if w := request(s, "POST", "/api/app-password", invalid, cookie, csrf, s.cfg.Origin); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	if w := request(s, "POST", "/api/app-password", body, cookie, csrf, s.cfg.Origin); w.Code != 503 || strings.Contains(w.Body.String(), "private storage") {
		t.Fatal(w.Code)
	}
	if saved != "" || reloads != 0 || oldSession.ctx.Err() != nil {
		t.Fatal("failed save altered authentication")
	}
	failSave = false
	if w := request(s, "POST", "/api/app-password", body, cookie, csrf, s.cfg.Origin); w.Code != 200 || strings.Contains(w.Body.String(), "new test password") {
		t.Fatal(w.Code)
	}
	if bcrypt.CompareHashAndPassword([]byte(saved), []byte("new test password")) != nil || reloads != 1 {
		t.Fatal("hash not saved")
	}
	if oldSession.ctx.Err() == nil {
		t.Fatal("other console session not cancelled")
	}
	if w := request(s, "GET", "/api/session", "", other, "", ""); w.Code != 401 {
		t.Fatal("old session accepted")
	}
	fresh, err := New(Config{Origin: s.cfg.Origin, PasswordHash: saved, Timeout: s.cfg.Timeout}, s.provider, http.NotFoundHandler())
	if err != nil {
		t.Fatal(err)
	}
	if w := request(fresh, "POST", "/api/login", `{"password":"test password"}`, nil, "", s.cfg.Origin); w.Code != 401 {
		t.Fatal("old password accepted")
	}
	if w := request(fresh, "POST", "/api/login", `{"password":"new test password"}`, nil, "", s.cfg.Origin); w.Code != 200 {
		t.Fatal("new password rejected")
	}
}

func TestPasswordChangeLimitsAndCancellation(t *testing.T) {
	s, _ := testServer(t)
	calls := 0
	s.SetPasswordSettings(func(string) error { calls++; return nil }, func() {})
	cookie, csrf := login(t, s)
	body := `{"currentPassword":"test password","newPassword":"new test password"}`
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("POST", "http://localhost:8080/api/app-password", strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Origin", s.cfg.Origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-CSRF-Token", csrf)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 408 || calls != 0 {
		t.Fatal("cancelled request saved", w.Code)
	}
	s.settingsMu.Lock()
	w = request(s, "POST", "/api/app-password", body, cookie, csrf, s.cfg.Origin)
	s.settingsMu.Unlock()
	if w.Code != 409 || calls != 0 {
		t.Fatal("concurrent change accepted")
	}
	s.mu.Lock()
	s.loginCount = 10
	s.mu.Unlock()
	w = request(s, "POST", "/api/app-password", body, cookie, csrf, s.cfg.Origin)
	if w.Code != 429 || calls != 0 {
		t.Fatal("rate limit bypassed")
	}
	var response map[string]any
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || response["error"] == nil {
		t.Fatal("invalid error")
	}
}
