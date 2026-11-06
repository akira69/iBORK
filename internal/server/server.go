package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/akira69/iBORK/internal/glances"
	"github.com/akira69/iBORK/internal/management"
	"golang.org/x/crypto/bcrypt"
)

type Config struct {
	DeviceID, ServerName, Manufacturer, Model                       string
	History                                                         *energy.History
	Origin, PasswordHash, JetURL, JetPassword, BMCHost, BMCUsername string
	BMCPort                                                         int
	VNCPort                                                         int
	VNCHost, VNCKind, VNCTransport                                  string
	GLURL, GLUsername, GLPassword, GLCertificateSHA256              string
	GlancesURL, GlancesToken                                        string
	VNCPassword, VNCCertificateSHA256                               string
	Timeout                                                         time.Duration
}
type session struct {
	assistant assistantSession
	csrf      string
	expires   time.Time
	ctx       context.Context
	cancel    context.CancelFunc
}
type cached struct {
	value   any
	expires time.Time
}
type Server struct {
	assistantProvider providerSettings
	panel             *panelAccess
	settingsMu        sync.Mutex
	rate              electricityRate // protected by mu
	saveRate          func([]byte) error
	savePassword      func(string) error
	settings          DeviceSettingsStore
	reload            func()
	devices           map[string]*Server
	deviceOrder       []string
	cfg               Config
	provider          management.Provider
	sensors           func(context.Context) ([]management.Sensor, error)
	static            http.Handler
	mu                sync.Mutex
	closing           bool
	reloading         bool
	sessions          map[string]*session
	loginWindow       time.Time
	loginCount        int
	cacheMu           sync.Mutex
	cache             map[string]cached
	jet               *jetRelay
	readGate          chan struct{}
	solGate           chan struct{}
	vncGate           chan struct{}
	jetGate           chan struct{}
	glCheckGate       chan struct{}
	lastAction        time.Time

	panelSensorScan, panelPowerScan panelRefresh // protected by cacheMu
}

func New(cfg Config, p management.Provider, static http.Handler) (*Server, error) {
	origin, err := url.Parse(cfg.Origin)
	if err != nil || origin.Host == "" || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return nil, errors.New("APP_ORIGIN must be an exact http(s) origin")
	}
	if _, err = bcrypt.Cost([]byte(cfg.PasswordHash)); err != nil {
		return nil, errors.New("APP_PASSWORD_HASH_FILE must contain a bcrypt hash")
	}
	if cfg.Timeout <= 0 || cfg.Timeout > 60*time.Second {
		return nil, errors.New("timeout must be between 1 and 60 seconds")
	}
	if err := validateVNCConfig(cfg); err != nil {
		return nil, err
	}
	var jet *jetRelay
	if cfg.JetURL != "" {
		jet, err = newJetRelay(cfg.JetURL, cfg.JetPassword, cfg.Timeout)
		if err != nil {
			return nil, err
		}
	}
	if cfg.DeviceID == "" {
		cfg.DeviceID = "default"
	}
	if !deviceIDPattern.MatchString(cfg.DeviceID) {
		return nil, errors.New("invalid device ID")
	}
	if cfg.ServerName == "" {
		cfg.ServerName = "IPMI server"
	}
	s := &Server{cfg: cfg, provider: p, static: static, sessions: make(map[string]*session), cache: make(map[string]cached), jet: jet, readGate: make(chan struct{}, 1), solGate: make(chan struct{}, 1), vncGate: make(chan struct{}, 1), jetGate: make(chan struct{}, 1)}
	s.rate.USDPerKwh = 0.20
	s.devices = map[string]*Server{cfg.DeviceID: s}
	if cfg.GlancesURL != "" {
		agent, err := glances.New(cfg.GlancesURL, cfg.GlancesToken, cfg.Timeout)
		if err != nil {
			return nil, err
		}
		s.sensors = agent.Sensors
	} else if p != nil {
		s.sensors = p.Sensors
	}
	s.glCheckGate = make(chan struct{}, 1)
	s.deviceOrder = []string{cfg.DeviceID}
	return s, nil
}

// NewEmpty keeps authentication and app settings available after the final device is removed.
func NewEmpty(cfg Config, static http.Handler) (*Server, error) {
	s, err := New(cfg, nil, static)
	if err != nil {
		return nil, err
	}
	s.devices = map[string]*Server{}
	s.deviceOrder = nil
	return s, nil
}

var deviceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// AddDevice is called during startup, before the HTTP server accepts requests.
func (s *Server) AddDevice(cfg Config, p management.Provider) error {
	if !deviceIDPattern.MatchString(cfg.DeviceID) || s.devices[cfg.DeviceID] != nil || len(s.devices) >= 16 {
		return errors.New("invalid, duplicate or excessive device profile")
	}
	cfg.Origin, cfg.PasswordHash = s.cfg.Origin, s.cfg.PasswordHash
	device, err := New(cfg, p, s.static)
	if err != nil {
		return err
	}
	s.devices[cfg.DeviceID] = device
	s.deviceOrder = append(s.deviceOrder, cfg.DeviceID)
	return nil
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure randomness unavailable")
	}
	return hex.EncodeToString(b)
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, dest any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		fail(w, 415, "JSON required")
		return false
	}
	limit := int64(4096)
	switch dest.(type) {
	case *DeviceSettings:
		limit = 16 * 1024
	case *panelIconList:
		limit = PanelIconConfigLimit
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(dest); err != nil {
		fail(w, 400, "Invalid request")
		return false
	}
	if d.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "Invalid request")
		return false
	}
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if strings.HasPrefix(s.cfg.Origin, "https:") {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	}
	origin, _ := url.Parse(s.cfg.Origin)
	if r.Host != origin.Host {
		fail(w, 403, "Unexpected host")
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		s.static.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == "/api/assistant/mcp" {
		s.serveMCP(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/v1/panel", "/api/v1/panel/power", "/api/v1/panel/pin", "/api/v1/panel/display":
		s.servePanel(w, r)
		return
	}
	if r.Method != "GET" && r.Header.Get("Origin") != s.cfg.Origin {
		fail(w, 403, "Origin rejected")
		return
	}
	if r.URL.Path == "/api/login" && r.Method == "POST" {
		s.login(w, r)
		return
	}
	cookie, err := r.Cookie("jsm_session")
	if err != nil {
		fail(w, 401, "Sign in required")
		return
	}
	s.mu.Lock()
	if s.reloading {
		s.mu.Unlock()
		fail(w, 503, "Connection settings are reloading; retry shortly")
		return
	}
	sess := s.sessions[cookie.Value]
	if sess != nil && time.Now().After(sess.expires) {
		sess.cancel()
		delete(s.sessions, cookie.Value)
		sess = nil
	}
	s.mu.Unlock()
	if sess == nil {
		fail(w, 401, "Session expired; sign in again")
		return
	}
	if r.Method != "GET" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(sess.csrf)) != 1 {
		fail(w, 403, "CSRF token rejected")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/assistant/") {
		s.serveAssistant(w, r, sess)
		return
	}
	if r.URL.Path == "/api/device-settings" {
		s.deviceSettings(w, r)
		return
	}
	if r.URL.Path == "/api/electricity-rate" {
		s.electricityRateSettings(w, r, sess.ctx)
		return
	}
	if r.URL.Path == "/api/panel-display" {
		s.panel.displaySettings(w, r, false)
		return
	}
	if r.URL.Path == "/api/remote-display" {
		s.remoteDisplay(w, r)
		return
	}
	if r.URL.Path == "/api/panel-layout" {
		s.panelLayoutSettings(w, r, sess.ctx)
		return
	}
	if r.URL.Path == "/api/panel-icons" {
		s.panelIcons(w, r)
		return
	}
	if r.URL.Path == "/api/app-password" {
		s.changePassword(w, r, sess.ctx)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/api/devices" {
		devices := make([]map[string]any, 0, len(s.devices))
		for _, id := range s.deviceOrder {
			device := s.devices[id]
			cfg := device.cfg
			devices = append(devices, map[string]any{"id": id, "name": cfg.ServerName, "manufacturer": cfg.Manufacturer, "model": cfg.Model, "bmcHost": cfg.BMCHost, "bmcPort": cfg.BMCPort, "hasJetKVM": cfg.JetURL != "", "hasVNC": cfg.VNCPort != 0, "hasManagement": device.provider != nil, "hasSensors": device.sensors != nil, "hasEnergy": cfg.History != nil, "consoleSources": consoleSources(cfg)})
		}
		reply(w, 200, devices)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/devices/") {
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/devices/"), "/", 2)
		if len(parts) != 2 || s.devices[parts[0]] == nil {
			fail(w, 404, "Device not found")
			return
		}
		switch parts[1] {
		case "config", "power", "energy", "sensors", "inventory", "events", "boot", "events/clear", "jetkvm/status", "jetkvm/signaling", "cooling", "diagnostics", "sol", "vnc", "vnc/session", "vnc/status", "glkvm/status", "glkvm/session":
		default:
			fail(w, 404, "Device route not found")
			return
		}
		s = s.devices[parts[0]]
		r = r.Clone(r.Context())
		r.URL.Path = "/api/" + parts[1]
	}
	if s.provider == nil {
		switch r.URL.Path {
		case "/api/power", "/api/inventory", "/api/events", "/api/boot", "/api/events/clear", "/api/cooling", "/api/diagnostics", "/api/sol":
			if r.URL.Path == "/api/sol" && r.Header.Get("Origin") != s.cfg.Origin {
				fail(w, 403, "Origin rejected")
				return
			}
			fail(w, 409, "IPMI management is unavailable for this device")
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/jetkvm/") && s.jet == nil {
		fail(w, 409, "No JetKVM paired with this device")
		return
	}
	if r.URL.Path == "/api/sol" && r.Method == "GET" {
		if r.Header.Get("Origin") != s.cfg.Origin {
			fail(w, 403, "Origin rejected")
			return
		}
		s.serveSOL(w, r, sess.ctx)
		return
	}
	if r.URL.Path == "/api/vnc" && r.Method == "GET" {
		if r.Header.Get("Origin") != s.cfg.Origin {
			fail(w, 403, "Origin rejected")
			return
		}
		s.serveVNC(w, r, sess.ctx)
		return
	}
	if r.URL.Path == "/api/jetkvm/signaling" && r.Method == "GET" {
		if r.Header.Get("Origin") != s.cfg.Origin {
			fail(w, 403, "Origin rejected")
			return
		}
		s.serveJet(w, r, sess.ctx)
		return
	}
	if r.URL.Path == "/api/glkvm/session" && r.Method == "GET" {
		if r.Header.Get("Origin") != s.cfg.Origin {
			fail(w, 403, "Origin rejected")
			return
		}
		s.serveComet(w, r, sess.ctx)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Timeout)
	defer cancel()
	stop := context.AfterFunc(sess.ctx, cancel)
	defer stop()
	switch r.Method + " " + r.URL.Path {
	case "GET /api/vnc/status", "GET /api/glkvm/status":
		s.checkConsole(w, r, ctx)
	case "POST /api/vnc/session":
		if s.cfg.VNCPort == 0 {
			fail(w, 409, "VNC is unavailable for this device")
		} else if ctx.Err() != nil {
			fail(w, 401, "Session expired; sign in again")
		} else {
			reply(w, 200, map[string]string{"password": s.cfg.VNCPassword})
		}
	case "GET /api/cooling":
		s.serveCooling(w, r, ctx)
	case "POST /api/diagnostics":
		s.serveDiagnostics(w, r, ctx)
	case "GET /api/session":
		reply(w, 200, map[string]any{"csrf": sess.csrf, "expires": sess.expires})
	case "POST /api/logout":
		s.mu.Lock()
		sess.cancel()
		delete(s.sessions, cookie.Value)
		s.mu.Unlock()
		s.setCookie(w, "", -1)
		reply(w, 200, map[string]bool{"ok": true})
	case "GET /api/config":
		reply(w, 200, map[string]any{"deviceId": s.cfg.DeviceID, "manufacturer": s.cfg.Manufacturer, "model": s.cfg.Model, "jetUrl": s.cfg.JetURL, "glUrl": s.cfg.GLURL, "glUsername": s.cfg.GLUsername, "vncHost": vncHost(s.cfg), "vncPort": s.cfg.VNCPort, "vncTransport": s.cfg.VNCTransport, "bmcHost": s.cfg.BMCHost, "bmcUsername": s.cfg.BMCUsername, "bmcPort": s.cfg.BMCPort, "timeoutSeconds": s.cfg.Timeout.Seconds(), "serverName": s.cfg.ServerName, "credentials": "Managed by service credential files"})
	case "GET /api/power":
		value, err := s.readPower(ctx)
		replyRead(w, value, err)
	case "GET /api/energy":
		if s.cfg.History == nil && s.provider == nil {
			fail(w, 409, "No power source configured for this device")
		} else if s.cfg.History == nil {
			fail(w, 503, "Power history collector is not configured")
		} else {
			reply(w, 200, s.cfg.History.Snapshot(time.Now()))
		}
	case "GET /api/sensors":
		if s.sensors == nil {
			fail(w, 409, "No sensors configured for this device")
		} else {
			value, err := s.readSensors(ctx)
			replyRead(w, value, err)
		}
	case "GET /api/inventory":
		s.read(w, ctx, "inventory", time.Hour, func(ctx context.Context) (any, error) { return s.provider.Inventory(ctx) })
	case "GET /api/events":
		s.read(w, ctx, "events", 5*time.Second, func(ctx context.Context) (any, error) { return s.provider.Events(ctx) })
	case "GET /api/jetkvm/status":
		if err := s.jet.check(ctx); err != nil {
			upstreamError(w, err)
		} else {
			reply(w, 200, map[string]string{"state": "reachable"})
		}
	case "POST /api/power", "POST /api/boot", "POST /api/events/clear":
		s.action(w, r, ctx)
	default:
		fail(w, 404, "API route not found")
	}
}
func (s *Server) setCookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: "jsm_session", Value: value, Path: "/", MaxAge: age, HttpOnly: true, Secure: strings.HasPrefix(s.cfg.Origin, "https:"), SameSite: http.SameSiteStrictMode})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.allowPasswordAttempt(w) {
		return
	}
	now := time.Now()
	var body struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Password) > 72 || bcrypt.CompareHashAndPassword([]byte(s.cfg.PasswordHash), []byte(body.Password)) != nil {
		fail(w, 401, "Invalid password")
		return
	}
	id, csrf := token(), token()
	expires := now.Add(30 * time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), expires)
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		cancel()
		fail(w, http.StatusServiceUnavailable, "Server is shutting down")
		return
	}
	for key, old := range s.sessions {
		if now.After(old.expires) {
			old.cancel()
			delete(s.sessions, key)
		}
	}
	if len(s.sessions) >= 32 {
		s.mu.Unlock()
		cancel()
		fail(w, 429, "Too many active sessions")
		return
	}
	s.sessions[id] = &session{csrf: csrf, expires: expires, ctx: ctx, cancel: cancel}
	s.mu.Unlock()
	s.setCookie(w, id, 1800)
	reply(w, 200, map[string]any{"csrf": csrf, "expires": expires})
}
func (s *Server) allowPasswordAttempt(w http.ResponseWriter) bool {
	s.mu.Lock()
	now := time.Now()
	if now.Sub(s.loginWindow) > time.Minute {
		s.loginWindow = now
		s.loginCount = 0
	}
	s.loginCount++
	limited := s.loginCount > 10
	s.mu.Unlock()
	if limited {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "Too many sign-in attempts; retry in one minute")
		return false
	}
	return true
}
func upstreamError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		fail(w, 504, "Device timed out; check connection and credentials")
	} else {
		fail(w, 502, "Device unavailable; check connection, credentials and permissions")
	}
}
func (s *Server) read(w http.ResponseWriter, ctx context.Context, key string, ttl time.Duration, load func(context.Context) (any, error)) {
	value, err := s.cachedRead(ctx, key, ttl, load)
	replyRead(w, value, err)
}

func replyRead(w http.ResponseWriter, value any, err error) {
	if err != nil {
		upstreamError(w, err)
		return
	}
	reply(w, 200, value)
}

func (s *Server) cachedRead(ctx context.Context, key string, ttl time.Duration, load func(context.Context) (any, error)) (any, error) {
	select {
	case s.readGate <- struct{}{}:
		defer func() { <-s.readGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.cacheMu.Lock()
	hit, ok := s.cache[key]
	s.cacheMu.Unlock()
	if ok && time.Now().Before(hit.expires) {
		return hit.value, nil
	}
	value, err := load(ctx)
	if err != nil {
		return nil, err
	}
	s.cacheMu.Lock()
	s.cache[key] = cached{value: value, expires: time.Now().Add(ttl)}
	s.cacheMu.Unlock()
	return value, nil
}
func (s *Server) action(w http.ResponseWriter, r *http.Request, ctx context.Context) {
	var body struct {
		Action  string `json:"action"`
		Confirm string `json:"confirm"`
	}
	if !decode(w, r, &body) {
		return
	}
	allowed := map[string]bool{}
	switch r.URL.Path {
	case "/api/power":
		for _, a := range []string{"on", "soft", "off", "reset", "cycle"} {
			allowed[a] = true
		}
	case "/api/boot":
		for _, a := range []string{"default", "bios", "pxe", "disk", "cdrom"} {
			allowed[a] = true
		}
	case "/api/events/clear":
		allowed["clear"] = true
	}
	if !allowed[body.Action] || body.Confirm != body.Action {
		fail(w, 400, "Confirm the exact action")
		return
	}
	s.applyAction(w, ctx, r.URL.Path, body.Action)
}

func (s *Server) applyAction(w http.ResponseWriter, ctx context.Context, path, action string) {
	select {
	case s.readGate <- struct{}{}:
		defer func() { <-s.readGate }()
	case <-ctx.Done():
		upstreamError(w, ctx.Err())
		return
	}
	if ctx.Err() != nil {
		upstreamError(w, ctx.Err())
		return
	}
	if time.Since(s.lastAction) < time.Second {
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "Wait before sending another action")
		return
	}
	var err error
	switch path {
	case "/api/power":
		err = s.provider.SetPower(ctx, action)
	case "/api/boot":
		err = s.provider.SetBoot(ctx, action)
	case "/api/events/clear":
		err = s.provider.ClearEvents(ctx)
	}
	s.lastAction = time.Now()
	if err != nil {
		upstreamError(w, err)
		return
	}
	s.cacheMu.Lock()
	clear(s.cache)
	s.cacheMu.Unlock()
	reply(w, 200, map[string]bool{"ok": true})
}

func consoleSources(cfg Config) []string {
	out := []string{}
	if cfg.JetURL != "" {
		out = append(out, "jetkvm")
	}
	if cfg.VNCPort != 0 {
		out = append(out, "vnc")
	}
	if cfg.GLURL != "" {
		out = append(out, "glinet")
	}
	return out
}
