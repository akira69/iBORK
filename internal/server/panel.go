package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"maps"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"golang.org/x/crypto/bcrypt"
)

type panelAccess struct {
	token, pinHash string
	pinCost        int
	savePIN        func(string) error
	ctx            context.Context
	cancel         context.CancelFunc
	pinMu          sync.Mutex
	window         time.Time
	failures       int
	snapshotMu     sync.Mutex
	lastSeen       time.Time
	lastIcons      map[string]panelIcon
	lastDetails    map[string]panelReadings
	capturedAt     time.Time
	snapshot       map[string]any
	chartsAt       time.Time
	charts         map[string]any
	display        displaySchedule // protected by snapshotMu
	saveDisplay    func([]byte) error
	icons          map[string]panelIcon
	saveIcons      func([]byte) error
	layout         *panelLayout
	saveLayout     func([]byte) error
	controlMu      sync.RWMutex // serialize layout changes with admitted panel power commands
}

var panelPIN = regexp.MustCompile(`^[0-9]{6,12}$`)

// The final characters of the 16-byte salt and 23-byte digest have zero padding bits.
var panelHash = regexp.MustCompile(`^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{21}[.Oeu][./A-Za-z0-9]{30}[.CGKOSWaeimquy26]$`)

func ValidPanelPIN(pin []byte) bool { return panelPIN.Match(pin) }

func PanelPINCost(hash string) (int, error) {
	cost, err := bcrypt.Cost([]byte(hash))
	if !panelHash.MatchString(hash) || err != nil || cost < bcrypt.DefaultCost || cost > 14 {
		return 0, errors.New("panel PIN requires a bcrypt hash with cost 10 to 14")
	}
	return cost, nil
}

// EnablePanel is called at startup, before serving requests.
func (s *Server) EnablePanel(token, pinHash string, savePIN func(string) error) error {
	raw, err := hex.DecodeString(token)
	if err != nil || len(raw) != 32 || !strings.HasPrefix(s.cfg.Origin, "https://") {
		return errors.New("panel access requires an HTTPS APP_ORIGIN and a 32-byte hex PANEL_TOKEN_FILE")
	}
	var cost int
	if pinHash != "" {
		cost, err = PanelPINCost(pinHash)
		if err != nil {
			return err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.panel = &panelAccess{token: token, pinHash: pinHash, pinCost: cost, savePIN: savePIN, ctx: ctx, cancel: cancel}
	s.panel.display = displaySchedule{1, []displayPeriod{{60, 0}, {300, 25}, {420, 100}, {1140, 25}}}
	return nil
}

func (s *Server) servePanel(w http.ResponseWriter, r *http.Request) {
	p := s.panel
	if p == nil {
		fail(w, 404, "Panel access is disabled")
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if r.TLS == nil && !(net.ParseIP(host).IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https") {
		fail(w, 403, "HTTPS required")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.cfg.Origin {
		fail(w, 403, "Origin rejected")
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+p.token)) != 1 {
		fail(w, 401, "Panel authorization required")
		return
	}
	s.mu.Lock()
	unavailable := s.closing || s.reloading
	s.mu.Unlock()
	if unavailable {
		fail(w, 503, "Service is restarting")
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/v1/panel":
		if !p.snapshotMu.TryLock() {
			fail(w, 429, "Panel snapshot busy")
			return
		}
		now := time.Now()
		if p.capturedAt.IsZero() {
			p.charts = nil
		}
		if now.Sub(p.capturedAt) >= 10*time.Second {
			p.snapshot = s.panelSnapshot(now)
			p.capturedAt = now
		}
		snapshot := p.snapshot
		query := r.URL.Query()
		if query.Get("charts") != "0" || p.charts == nil {
			if p.charts == nil || p.chartsAt != p.capturedAt {
				p.charts = s.panelCharts(p.capturedAt, snapshot["devices"].([]panelDevice))
				p.chartsAt = p.capturedAt
			}
			snapshot = maps.Clone(snapshot)
			maps.Copy(snapshot, p.charts)
		}
		p.lastDetails = nil
		if revision := query.Get("preload"); revision != "" {
			snapshot = s.preloadPanel(snapshot, revision)
			p.lastDetails = snapshot["details"].(map[string]panelReadings)
		} else if id := query.Get("detail"); id != "" {
			for _, device := range snapshot["devices"].([]panelDevice) {
				if device.ID == id {
					snapshot = maps.Clone(snapshot)
					detail := s.devices[id].panelDetail(p.ctx, device)
					detail.Image = p.icons[id].DetailImage
					snapshot["detail"] = detail
					p.lastDetails = map[string]panelReadings{id: detail}
					break
				}
			}
		}
		p.lastSeen, p.lastIcons = now, p.icons
		p.snapshotMu.Unlock()
		reply(w, 200, snapshot)
	case "POST /api/v1/panel/power":
		s.panelPower(w, r)
	case "POST /api/v1/panel/pin":
		p.changePIN(w, r)
	case "PUT /api/v1/panel/display":
		p.displaySettings(w, r, true)
	default:
		fail(w, 405, "Unsupported panel method")
	}
}

// Show the last panel poll without waking hardware or counting a browser visit as contact.
func (s *Server) remoteDisplay(w http.ResponseWriter, r *http.Request) {
	p := s.panel
	if p == nil {
		fail(w, 404, "Panel access is disabled")
		return
	}
	if r.Method != http.MethodGet {
		fail(w, 405, "Use GET for remote display")
		return
	}
	p.snapshotMu.Lock()
	seen := p.lastSeen
	var snapshot map[string]any
	var stamp int64
	if !seen.IsZero() {
		stamp = seen.Unix()
		snapshot = maps.Clone(p.snapshot)
		maps.Copy(snapshot, p.charts)
		devices := snapshot["devices"].([]panelDevice)
		details := make(map[string]panelReadings, len(devices))
		for _, device := range devices {
			detail := p.lastDetails[device.ID]
			detail.Image = p.lastIcons[device.ID].DetailImage
			details[device.ID] = detail
		}
		snapshot["details"] = details
	}
	p.snapshotMu.Unlock()
	reply(w, 200, map[string]any{"lastSeen": stamp, "connected": !seen.IsZero() && time.Since(seen) < time.Minute, "snapshot": snapshot})
}

// Take a nonblocking reading for every visible device. Artwork travels once per inventory revision.
func (s *Server) preloadPanel(base map[string]any, clientRevision string) map[string]any {
	devices := slices.Clone(base["devices"].([]panelDevice))
	details := make(map[string]panelReadings, len(devices))
	sum := crc32.NewIEEE()
	for _, device := range devices {
		icon := s.panel.icons[device.ID]
		sum.Write([]byte(device.ID + "\x00" + icon.Label + "\x00"))
		sum.Write(icon.Image)
		sum.Write(icon.DetailImage)
		d := s.devices[device.ID]
		detail := d.panelDetail(s.panel.ctx, device)
		d.cacheMu.Lock()
		detail.Pending = d.panelSensorScan.running || d.panelPowerScan.running
		d.cacheMu.Unlock()
		details[device.ID] = detail
	}
	revision := sum.Sum32()
	if revision == 0 {
		revision = 1
	}
	cached := clientRevision == strconv.FormatUint(uint64(revision), 10)
	for i, device := range devices {
		if cached {
			devices[i].Sidebar = nil
		} else {
			detail := details[device.ID]
			detail.Image = s.panel.icons[device.ID].DetailImage
			details[device.ID] = detail
		}
	}
	snapshot := maps.Clone(base)
	snapshot["devices"], snapshot["details"], snapshot["artRevision"] = devices, details, revision
	return snapshot
}

type panelDevice struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Model    string     `json:"model"`
	Metered  bool       `json:"metered"`
	Watts    *float64   `json:"watts"`
	Controls bool       `json:"controls"`
	Widgets  []string   `json:"widgets"`
	Sidebar  *panelIcon `json:"sidebar,omitempty"`
}

func (s *Server) panelSnapshot(now time.Time) map[string]any {
	layout := s.effectiveLayout()
	devices := make([]panelDevice, 0, len(layout.Servers))
	metered := 0
	for _, row := range layout.Servers {
		if !row.Included {
			continue
		}
		id := row.ID
		d := s.devices[id]
		var watts *float64
		if d.cfg.History != nil {
			metered++
			watts = d.cfg.History.LatestWatts(now)
		}
		device := panelDevice{ID: id, Name: d.cfg.ServerName, Model: d.cfg.Model, Watts: watts, Metered: d.cfg.History != nil, Widgets: row.Widgets, Controls: slices.Contains(row.Widgets, "controls")}
		if icon, ok := s.panel.icons[id]; ok {
			icon.DetailImage = nil // Only the selected device receives its full-size icon.
			device.Sidebar = &icon
		}
		devices = append(devices, device)
	}
	return map[string]any{
		"home":            layout.Home,
		"usdPerKwh":       s.currentRate().USDPerKwh,
		"displaySchedule": s.panel.display,
		"canEditDisplay":  s.panel.pinCost != 0,
		"capturedAt":      now.Unix(), "devices": devices, "metered": metered, "total": len(devices),
	}
}

func (s *Server) panelCharts(now time.Time, devices []panelDevice) map[string]any {
	var series [][]energy.Sample
	for _, device := range devices {
		if device.Metered {
			series = append(series, s.devices[device.ID].cfg.History.MonthSnapshot(now).Samples)
		}
	}
	day, dayKwh, dayHours := energy.FleetBuckets(series, now.Unix(), 24*4, 15*60)
	month, monthKwh, monthHours := energy.FleetBuckets(series, now.Unix(), 30*4, 6*3600)
	return map[string]any{
		"day": day, "dayKwh": dayKwh, "dayHours": dayHours,
		"month": month, "monthKwh": monthKwh, "monthHours": monthHours,
	}
}

type panelFields map[string]any

// Each field must appear exactly once so a repeated ID cannot retarget a command.
func (fields panelFields) UnmarshalJSON(data []byte) error {
	invalid := errors.New("expected unique non-null panel fields")
	d := json.NewDecoder(bytes.NewReader(data))
	if open, err := d.Token(); err != nil || open != json.Delim('{') {
		return invalid
	}
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok || fields[name] == nil {
			return invalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(value, []byte("null")) || json.Unmarshal(value, fields[name]) != nil {
			return invalid
		}
		delete(fields, name)
	}
	if len(fields) != 0 {
		return invalid
	}
	return nil
}

func (s *Server) panelPower(w http.ResponseWriter, r *http.Request) {
	p := s.panel
	if p.pinCost == 0 {
		fail(w, 403, "Panel controls are disabled")
		return
	}
	var id, action, confirm, pin string
	if !decode(w, r, &panelFields{"id": &id, "action": &action, "confirm": &confirm, "pin": &pin}) {
		return
	}
	if (action != "on" && action != "soft") || confirm != action {
		fail(w, 400, "Confirm power on or graceful shutdown")
		return
	}
	d := s.devices[id]
	if d == nil || d.provider == nil {
		fail(w, 409, "Power control unavailable for this device")
		return
	}
	if !p.verifyPIN(w, pin) {
		return
	}
	p.controlMu.RLock()
	defer p.controlMu.RUnlock()
	p.snapshotMu.Lock()
	allowed := slices.ContainsFunc(s.effectiveLayout().Servers, func(row panelRow) bool {
		return row.ID == id && row.Included && slices.Contains(row.Widgets, "controls")
	})
	p.snapshotMu.Unlock()
	if !allowed {
		fail(w, 409, "Panel power control is unavailable for this device")
		return
	}
	ctx, cancel := context.WithTimeout(p.ctx, d.cfg.Timeout)
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	if r.Context().Err() != nil {
		upstreamError(w, r.Context().Err())
		return
	}
	d.applyAction(w, ctx, "/api/power", action)
}

func (p *panelAccess) changePIN(w http.ResponseWriter, r *http.Request) {
	if p.pinCost == 0 {
		fail(w, 403, "Panel controls are disabled")
		return
	}
	var current, next string
	if !decode(w, r, &panelFields{"currentPin": &current, "newPin": &next}) {
		return
	}
	if !ValidPanelPIN([]byte(next)) {
		fail(w, 400, "Use 6 to 12 digits for the new PIN")
		return
	}
	if !p.pinMu.TryLock() {
		fail(w, 429, "PIN verification busy")
		return
	}
	defer p.pinMu.Unlock()
	if !p.checkPIN(w, current) {
		return
	}
	if current == next {
		fail(w, 400, "Choose a different PIN")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(next), p.pinCost)
	if r.Context().Err() != nil || p.ctx.Err() != nil {
		fail(w, 503, "PIN change canceled")
		return
	}
	if err != nil || p.savePIN == nil || p.savePIN(string(hash)) != nil {
		fail(w, 503, "Could not save the panel PIN")
		return
	}
	p.pinHash = string(hash)
	reply(w, 200, map[string]bool{"ok": true})
}

// Caller holds pinMu through verification and any credential replacement.
func (p *panelAccess) checkPIN(w http.ResponseWriter, pin string) bool {
	if time.Since(p.window) >= 5*time.Minute {
		p.window, p.failures = time.Now(), 0
	}
	if p.failures >= 5 {
		w.Header().Set("Retry-After", "300")
		fail(w, 429, "Too many PIN attempts")
		return false
	}
	if !ValidPanelPIN([]byte(pin)) || bcrypt.CompareHashAndPassword([]byte(p.pinHash), []byte(pin)) != nil {
		p.failures++
		fail(w, 403, "Invalid panel PIN")
		return false
	}
	return true
}

func (p *panelAccess) verifyPIN(w http.ResponseWriter, pin string) bool {
	if !p.pinMu.TryLock() {
		fail(w, 429, "PIN verification busy")
		return false
	}
	defer p.pinMu.Unlock()
	return p.checkPIN(w, pin)
}
