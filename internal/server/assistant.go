package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/akira69/iBORK/internal/assistant"
	"github.com/akira69/iBORK/internal/management"
)

type assistantSession struct {
	mu              sync.Mutex
	grant           assistant.Grant
	historyProvider string
	history         []assistant.Message
	activeUntil     time.Time
	// Pairing fields are protected by Server.mu so logout and revocation take effect during a call.
	hash    [32]byte
	pairCtx context.Context
	revoke  context.CancelFunc
}
type providerSettings struct {
	mu       sync.Mutex
	revision string
	config   assistant.Provider
	save     func([]byte) error
}

func (s *Server) SetAssistantProvider(data []byte, save func([]byte) error) error {
	var p assistant.Provider
	if len(data) > 0 && json.Unmarshal(data, &p) != nil {
		return errors.New("invalid assistant settings")
	}
	s.assistantProvider.revision = token()
	s.assistantProvider.config = p
	s.assistantProvider.save = save
	return nil
}
func (s *Server) modelProvider() (assistant.Provider, string) {
	s.assistantProvider.mu.Lock()
	defer s.assistantProvider.mu.Unlock()
	return s.assistantProvider.config, s.assistantProvider.revision
}
func (s *Server) initGrant(a *assistantSession) {
	if time.Now().Before(a.activeUntil) {
		return
	}
	a.grant = assistant.Grant{Servers: map[string]string{}, DashboardDevices: s.dashboardDevices(), ReadDashboardSensors: s.dashboardSensors}
	for _, id := range s.deviceOrder {
		a.grant.Servers[id] = s.devices[id].cfg.ServerName
	}
	a.history = nil
	a.activeUntil = time.Now().Add(15 * time.Minute)
}
func (s *Server) unpair(a *assistantSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.revoke != nil {
		a.revoke()
	}
	a.hash = [32]byte{}
	a.pairCtx = nil
}
func (s *Server) serveAssistant(w http.ResponseWriter, r *http.Request, sess *session) {
	action := strings.TrimPrefix(r.URL.Path, "/api/assistant/")
	ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
	defer cancel()
	stop := context.AfterFunc(sess.ctx, cancel)
	defer stop()
	if r.Method == "GET" && action == "models" {
		p, _ := s.modelProvider()
		if p.BaseURL == "" {
			fail(w, 400, "Configure a model first")
			return
		}
		catalogCtx, end := context.WithTimeout(ctx, 5*time.Second)
		defer end()
		models, err := p.Models(catalogCtx)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		reply(w, 200, map[string][]string{"models": models})
		return
	}
	a := &sess.assistant
	if action == "revoke" && r.Method == "POST" {
		s.unpair(a)
		reply(w, 200, true)
		return
	}
	if !a.mu.TryLock() {
		fail(w, 409, "Assistant is busy")
		return
	}
	defer a.mu.Unlock()
	s.initGrant(a)
	if action == "chat" || action == "apply" {
		var end context.CancelFunc
		ctx, end = context.WithDeadline(ctx, a.activeUntil)
		defer end()
	}
	if r.Method == "GET" && action == "status" {
		p, revision := s.modelProvider()
		var messages []map[string]string
		if a.historyProvider == revision {
			for _, m := range a.history {
				if m.Role == "user" || m.Role == "assistant" && len(m.Calls) == 0 {
					messages = append(messages, map[string]string{"role": m.Role, "content": m.Content})
				}
			}
		}
		reply(w, 200, map[string]any{"baseUrl": p.BaseURL, "model": p.Model, "hasKey": p.Key != "", "revision": revision, "state": a.grant, "messages": messages})
		return
	}
	if r.Method != "POST" {
		fail(w, 405, "Method not allowed")
		return
	}
	if (action == "chat" || action == "pair" || action == "scope" || action == "reset") && a.grant.Dashboard != nil && r.Header.Get("X-Assistant-Instance") != a.grant.Dashboard.Instance {
		fail(w, 409, "Dashboard belongs to another browser tab")
		return
	}
	switch action {
	case "reset":
		var input struct{}
		if !decode(w, r, &input) {
			return
		}
		a.history = nil
		a.grant.Candidates = nil
		a.grant.Scan = ""
		a.grant.Draft = nil
		a.grant.Layout = nil
		reply(w, 200, a.grant)
	case "dashboard":
		s.publishAssistantDashboard(w, r, a, ctx)
	case "provider":
		var p assistant.Provider
		if !decode(w, r, &p) {
			return
		}
		settings := &s.assistantProvider
		if !settings.mu.TryLock() {
			fail(w, 409, "Provider settings are busy")
			return
		}
		defer settings.mu.Unlock()
		if settings.save == nil {
			fail(w, 503, "Provider storage unavailable")
			return
		}
		if p.BaseURL == settings.config.BaseURL && p.Key == "" {
			p.Key = settings.config.Key
		}
		if err := p.Test(ctx); err != nil {
			fail(w, 400, err.Error())
			return
		}
		data, _ := json.Marshal(p)
		if err := settings.save(data); err != nil {
			fail(w, 500, "Could not save provider")
			return
		}
		settings.config = p
		settings.revision = token()
		a.history = nil
		reply(w, 200, map[string]string{"revision": settings.revision})
	case "scope":
		var input struct{ Scope string }
		if !decode(w, r, &input) {
			return
		}
		if _, err := assistant.Targets(input.Scope); err != nil {
			fail(w, 400, err.Error())
			return
		}
		s.unpair(a)
		a.activeUntil = time.Time{}
		s.initGrant(a)
		a.grant.Scope = input.Scope
		reply(w, 200, a.grant)
	case "pair":
		if !s.secureAssistantRequest(r) {
			fail(w, 400, "MCP pairing requires an HTTPS iBORK origin")
			return
		}
		s.unpair(a)
		secret := token()
		a.activeUntil = time.Now().Add(15 * time.Minute)
		if sess.expires.Before(a.activeUntil) {
			a.activeUntil = sess.expires
		}
		s.mu.Lock()
		a.hash = sha256.Sum256([]byte(secret))
		a.pairCtx, a.revoke = context.WithDeadline(sess.ctx, a.activeUntil)
		s.mu.Unlock()
		reply(w, 200, map[string]any{"token": secret, "expires": a.activeUntil})
	case "chat":
		var input struct {
			Message, Language, Revision string
			Model                       json.RawMessage
		}
		if !decode(w, r, &input) {
			return
		}
		if strings.TrimSpace(input.Message) == "" || len(input.Message) > 2000 || len(input.Language) > 32 {
			fail(w, 400, "Invalid chat message")
			return
		}
		p, revision := s.modelProvider()
		if p.BaseURL == "" {
			fail(w, 400, "Configure a model first")
			return
		}
		if input.Revision != revision {
			fail(w, 409, "Model connection changed. Reopen the assistant before sending.")
			return
		}
		if input.Model != nil {
			var model string
			if json.Unmarshal(input.Model, &model) != nil || !assistant.ValidModelID(model) {
				fail(w, 400, "Invalid model ID")
				return
			}
			p.Model = model
		}
		if a.historyProvider != revision {
			a.history = nil
			a.historyProvider = revision
		}
		history, activity, err := p.Turn(ctx, &a.grant, a.history, input.Message, input.Language)
		result := map[string]any{"activity": activity, "state": a.grant}
		if err != nil {
			result["error"] = err.Error()
		} else {
			result["reply"] = history[len(history)-1].Content
			// Trim only complete turns so a tool result always keeps its initiating call.
			for len(history) > 0 {
				data, _ := json.Marshal(history)
				if len(data) <= 32768 {
					break
				}
				history = history[1:]
				for len(history) > 0 && history[0].Role != "user" {
					history = history[1:]
				}
			}
			a.history = history
		}
		reply(w, 200, result)
	case "apply":
		var input DeviceSettings
		if !decode(w, r, &input) {
			return
		}
		draft := a.grant.Draft
		if draft == nil || r.Header.Get("X-Assistant-Draft") != draft.ID || input.ID != "" || input.Host != draft.Host || input.JetURL != draft.JetURL || (input.Host != "" && input.Port != 623) {
			fail(w, 409, "The proposal changed. Review it again.")
			return
		}
		if s.settings == nil {
			fail(w, 503, "Device settings unavailable")
			return
		}
		if !s.beginSettingsChange(w) {
			return
		}
		defer s.settingsMu.Unlock()
		for _, saved := range s.settings.List() {
			if input.JetURL != "" && strings.TrimRight(saved.JetURL, "/") == input.JetURL {
				fail(w, 409, "This JetKVM is already configured")
				return
			}
		}
		if err := verifyDraft(ctx, input); err != nil {
			fail(w, 400, err.Error())
			return
		}
		if ctx.Err() != nil {
			fail(w, 408, "Verification expired")
			return
		}
		if err := s.settings.Save(input); err != nil {
			fail(w, 400, err.Error())
			return
		}
		a.grant.Draft = nil
		s.finishDeviceSave(w)
	default:
		fail(w, 404, "Unknown assistant route")
	}
}
func verifyDraft(ctx context.Context, d DeviceSettings) error {
	if d.Host != "" {
		var pass, kg string
		if d.Password != nil {
			pass = *d.Password
		}
		if d.KGKey != nil {
			kg = *d.KGKey
		}
		p, err := management.NewIPMI(management.Config{Host: d.Host, Port: d.Port, Username: d.Username, Password: pass, KGKey: kg, Timeout: 5 * time.Second})
		if err != nil {
			return errors.New("Check BMC credentials")
		}
		if _, err = p.Power(ctx); err != nil {
			return errors.New("BMC power status could not be read")
		}
	}
	if d.JetURL != "" {
		var pass string
		if d.JetPassword != nil {
			pass = *d.JetPassword
		}
		j, err := newJetRelay(d.JetURL, pass, 5*time.Second)
		if err != nil || j.check(ctx) != nil {
			return errors.New("JetKVM authentication check failed")
		}
	}
	return nil
}
