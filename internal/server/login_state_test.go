package server

import (
	"testing"
	"time"
)

func TestConnectionReloadPreservesOnlyValidLogins(t *testing.T) {
	for _, mode := range []string{"connection", "expired", "logout", "password", "origin", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := testServer(t)
			cookie, csrf := login(t, s)
			old := s.sessions[cookie.Value]
			if mode == "expired" {
				old.expires = time.Now().Add(-time.Second)
			}
			if mode == "logout" {
				request(s, "POST", "/api/logout", "{}", cookie, csrf, s.cfg.Origin)
			}
			s.loginCount = 7
			s.reloading = mode != "shutdown"
			s.CloseSessions()
			if old.ctx.Err() == nil {
				t.Fatal("old console context was not canceled")
			}
			var state LoginState
			s.SaveLogins(&state)
			cfg := s.cfg
			if mode == "password" {
				other, _ := testServer(t)
				cfg.PasswordHash = other.cfg.PasswordHash
			}
			if mode == "origin" {
				cfg.Origin = "http://other.invalid"
			}
			next, err := NewEmpty(cfg, s.static)
			if err != nil {
				t.Fatal(err)
			}
			defer next.CloseSessions()
			next.RestoreLogins(&state)
			if state.logins != nil {
				t.Fatal("reload state was not consumed")
			}
			if mode != "connection" {
				if len(next.sessions) != 0 {
					t.Fatal("invalid login restored")
				}
				return
			}
			current := next.sessions[cookie.Value]
			if current == nil || current.csrf != csrf || !current.expires.Equal(old.expires) || current.ctx.Err() != nil || next.loginCount != 7 {
				t.Fatal("login changed or expiry/rate limit reset")
			}
			if w := request(next, "GET", "/api/session", "", cookie, "", ""); w.Code != 200 {
				t.Fatal(w.Code)
			}
			if w := request(next, "POST", "/api/logout", "{}", cookie, "bad", cfg.Origin); w.Code != 403 {
				t.Fatal("CSRF bypass", w.Code)
			}
			if w := request(next, "POST", "/api/logout", "{}", cookie, csrf, cfg.Origin); w.Code != 200 {
				t.Fatal("original CSRF lost", w.Code)
			}
		})
	}
}
