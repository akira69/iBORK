package server

import (
	"context"
	"net/http"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// SetPasswordSettings is called before serving requests; save accepts only a hash.
func (s *Server) SetPasswordSettings(save func(string) error, reload func()) {
	s.savePassword, s.reload = save, reload
}

// Serialize configuration writes so a reload cannot race another settings save.
func (s *Server) beginSettingsChange(w http.ResponseWriter) bool {
	if !s.settingsMu.TryLock() {
		fail(w, 409, "Another settings change is in progress")
		return false
	}
	s.mu.Lock()
	closing := s.closing
	s.mu.Unlock()
	if closing {
		s.settingsMu.Unlock()
		fail(w, 503, "Settings reload in progress; retry shortly")
		return false
	}
	return true
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, sessionContext context.Context) {
	if r.Method != "POST" {
		fail(w, 405, "Method not allowed")
		return
	}
	if s.savePassword == nil || s.reload == nil {
		fail(w, 503, "Password settings unavailable")
		return
	}
	if !s.beginSettingsChange(w) {
		return
	}
	defer s.settingsMu.Unlock()
	if r.Context().Err() != nil || sessionContext.Err() != nil {
		fail(w, 408, "Request expired; retry after signing in")
		return
	}
	var input struct {
		Current string `json:"currentPassword"`
		New     string `json:"newPassword"`
	}
	if !decode(w, r, &input) {
		return
	}
	if utf8.RuneCountInString(input.New) < 12 || len(input.New) > 72 {
		fail(w, 400, "Use at least 12 characters and no more than 72 UTF-8 bytes")
		return
	}
	if !s.allowPasswordAttempt(w) {
		return
	}
	if len(input.Current) > 72 || bcrypt.CompareHashAndPassword([]byte(s.cfg.PasswordHash), []byte(input.Current)) != nil {
		fail(w, 400, "Current password is incorrect")
		return
	}
	password := []byte(input.New)
	hash, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
	clear(password)
	if err != nil {
		fail(w, 500, "Could not prepare password change")
		return
	}
	if r.Context().Err() != nil || sessionContext.Err() != nil {
		fail(w, 408, "Request expired; retry after signing in")
		return
	}
	if err := s.savePassword(string(hash)); err != nil {
		fail(w, 503, "Could not save password; current password is unchanged")
		return
	}
	s.CloseSessions()
	s.setCookie(w, "", -1)
	reply(w, 200, map[string]bool{"saved": true, "signInRequired": true})
	s.reload()
}
