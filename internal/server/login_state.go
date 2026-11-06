package server

import (
	"context"
	"time"
)

// LoginState carries app logins and credential rate limits across in-process reloads.
// It is never persisted and does not extend cookie or session lifetimes.
type LoginState struct {
	logins               map[string]*session
	origin, passwordHash string
	loginWindow          time.Time
	loginCount           int
	pinWindow            time.Time
	pinFailures          int
}

// SaveLogins is called after HTTP requests and console cleanup have drained.
func (s *Server) SaveLogins(state *LoginState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	*state = LoginState{logins: s.sessions, origin: s.cfg.Origin, passwordHash: s.cfg.PasswordHash, loginWindow: s.loginWindow, loginCount: s.loginCount}
	if s.panel != nil {
		state.pinWindow, state.pinFailures = s.panel.window, s.panel.failures
	}
	s.sessions = make(map[string]*session)
}

// RestoreLogins is called before serving; password changes never retain logins.
func (s *Server) RestoreLogins(state *LoginState) {
	defer func() { *state = LoginState{} }()
	if state.origin != s.cfg.Origin {
		return
	}
	if s.panel != nil {
		s.panel.window, s.panel.failures = state.pinWindow, state.pinFailures
	}
	if state.passwordHash != s.cfg.PasswordHash {
		return
	}
	s.loginWindow, s.loginCount = state.loginWindow, state.loginCount
	for id, old := range state.logins {
		if time.Now().Before(old.expires) {
			ctx, cancel := context.WithDeadline(context.Background(), old.expires)
			s.sessions[id] = &session{csrf: old.csrf, expires: old.expires, ctx: ctx, cancel: cancel}
		}
	}
}
