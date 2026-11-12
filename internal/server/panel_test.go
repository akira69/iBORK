package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"golang.org/x/crypto/bcrypt"
)

func panelRequest(s *Server, method, path, body, auth string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://localhost:8080"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", auth)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestRemoteDisplayObservesOnlyAuthenticatedPanelPolls(t *testing.T) {
	s, _ := testServer(t)
	c, _ := login(t, s)
	const path = "/api/remote-display"
	get := func() *httptest.ResponseRecorder { return request(s, "GET", path, "", c, "", "") }
	if get().Code != 404 {
		t.Fatal("disabled display reported")
	}
	s.cfg.Origin = "https://localhost:8080"
	key := token()
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if panelRequest(s, "GET", path, "", "Bearer "+key).Code != 401 {
		t.Fatal("preview requires dashboard sign-in")
	}
	panelRequest(s, "GET", "/api/v1/panel", "", "Bearer invalid")
	read := func() (bool, int64, map[string]any) {
		t.Helper()
		w := get()
		var status struct {
			Connected bool
			LastSeen  int64
			Snapshot  map[string]any
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil {
			t.Fatal(w.Code, w.Body.String())
		}
		return status.Connected, status.LastSeen, status.Snapshot
	}
	if connected, seen, snap := read(); connected || seen != 0 || snap != nil {
		t.Fatal("invented panel contact")
	}
	if w := panelRequest(s, "GET", "/api/v1/panel?preload=0", "", "Bearer "+key); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if connected, seen, snap := read(); !connected || seen == 0 || snap["details"] == nil || snap["devices"] == nil {
		t.Fatal("missing panel telemetry")
	}
	s.panel.lastSeen = time.Now().Add(-2 * time.Minute)
	if connected, _, snap := read(); connected || snap == nil {
		t.Fatal("status read refreshed stale panel")
	}
}

func TestPanelCredentialsScopeAndSnapshot(t *testing.T) {
	s, _ := testServer(t)
	key := token()
	auth := "Bearer " + key
	const route = "/api/v1/panel"
	if w := panelRequest(s, "GET", route, "", auth); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if s.EnablePanel(key, "", nil) == nil {
		t.Fatal("accepted HTTP origin")
	}
	s.cfg.Origin = "https://localhost:8080"
	if s.EnablePanel("", "", nil) == nil || s.EnablePanel(key, "123456", nil) == nil {
		t.Fatal("accepted invalid credential files")
	}
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if w := panelRequest(s, "GET", route, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := panelRequest(s, "GET", "/api/config", "", auth); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := panelRequest(s, "POST", route+"/power", "{}", auth); w.Code != 403 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("GET", "http://localhost:8080"+route, nil)
	r.Header.Set("Authorization", auth)
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("trusted a non-loopback proxy header")
	}
	r.RemoteAddr = "127.0.0.1:9999"
	s.cfg.History = energy.MemoryOnly()
	cfg := s.cfg
	cfg.DeviceID = "unmetered"
	cfg.History = nil
	if err := s.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var v struct {
		Metered, Total int
		Devices        []struct {
			Controls bool
			Watts    *float64
		}
		Day, Month       []*float64
		DayKwh, MonthKwh *float64
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &v) != nil || v.Metered != 1 || v.Total != 2 || len(v.Day) != 96 || len(v.Month) != 120 || len(v.Devices) != 2 || v.Devices[0].Controls || v.Devices[0].Watts != nil || v.DayKwh != nil || v.MonthKwh != nil || strings.Contains(w.Body.String(), "bmcHost") {
		t.Fatal(w.Code, w.Body.String())
	}
	r.Header.Set("Origin", "https://untrusted.invalid")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("accepted cross-origin request")
	}
}

func TestPanelPINHashFormat(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, variant := range []byte("aby") {
		hash[2] = variant
		if cost, err := PanelPINCost(string(hash)); err != nil || cost != bcrypt.DefaultCost {
			t.Fatal("valid bcrypt variant rejected", string(variant))
		}
	}
	for _, tc := range []struct {
		offset int
		bad    byte
	}{{2, 'z'}, {3, '!'}, {6, '!'}, {7, '@'}, {28, '/'}, {29, '='}, {59, '/'}} {
		corrupt := append([]byte(nil), hash...)
		corrupt[tc.offset] = tc.bad
		if _, err := PanelPINCost(string(corrupt)); err == nil {
			t.Errorf("accepted malformed bcrypt at byte %d", tc.offset)
		}
	}
}

func TestPanelCommandMediaType(t *testing.T) {
	for _, tc := range []struct {
		media string
		valid bool
	}{
		{"application/jsonp", false},
		{"application/json; charset", false},
		{"Application/JSON; charset=utf-8", true},
	} {
		r := httptest.NewRequest("POST", "/api/v1/panel/power", strings.NewReader(`{"id":"rack","action":"on","confirm":"on","pin":"000001"}`))
		r.Header.Set("Content-Type", tc.media)
		w := httptest.NewRecorder()
		var id, action, confirm, pin string
		if ok := decode(w, r, &panelFields{"id": &id, "action": &action, "confirm": &confirm, "pin": &pin}); ok != tc.valid || (!ok && w.Code != 415) {
			t.Errorf("%s: accepted=%t status=%d", tc.media, ok, w.Code)
		}
	}
}

func TestPanelChangePIN(t *testing.T) {
	s, provider := testServer(t)
	s.cfg.Origin = "https://localhost:8080"
	key := token()
	const path = "/api/v1/panel/pin"
	const body = `{"currentPin":"654321","newPin":"000001"}`
	post := func(payload, auth string) int {
		return panelRequest(s, "POST", path, payload, auth).Code
	}
	auth := "Bearer " + key
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	if post(body, auth) != 403 {
		t.Fatal("read-only panel changed PIN")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte("654321"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	var saved string
	saving, release := make(chan struct{}), make(chan struct{})
	save := func(hash string) error {
		close(saving)
		<-release
		saved = hash
		return nil
	}
	if err := s.EnablePanel(key, string(hash), save); err != nil {
		t.Fatal(err)
	}
	if post(body, "") != 401 {
		t.Fatal("missing bearer accepted")
	}
	for _, bad := range []string{
		`{"currentPin":"654321","newPin":"12345"}`,
		`{"currentPin":"654321","newPin":"654321"}`,
		`{"currentPin":"654321","newPin":"123456","newPin":"000001"}`,
		`{"currentPin":"654321","NewPin":"000001"}`,
		`{"newPin":"000001"}`,
	} {
		if code := post(bad, auth); code != 400 {
			t.Fatal("invalid change returned", code)
		}
	}
	for range 5 {
		if post(`{"currentPin":"111111","newPin":"000001"}`, auth) != 403 {
			t.Fatal("wrong PIN accepted")
		}
	}
	power := func(pin string) int {
		payload := `{"id":"default","action":"on","confirm":"on","pin":"` + pin + `"}`
		return panelRequest(s, "POST", "/api/v1/panel/power", payload, auth).Code
	}
	if post(body, auth) != 429 || power("654321") != 429 {
		t.Fatal("PIN limiter not shared")
	}
	s.panel.window = time.Now().Add(-5 * time.Minute)
	s.panel.savePIN = func(string) error { return errors.New("fixture write failure") }
	if post(body, auth) != 503 {
		t.Fatal("save failure ignored")
	}
	s.panel.savePIN = save
	status := make(chan int, 1)
	go func() { status <- post(body, auth) }()
	select {
	case <-saving:
	case <-time.After(3 * time.Second):
		t.Fatal("PIN save did not start")
	}
	concurrent, duringPower := post(body, auth), power("654321")
	close(release)
	if <-status != 200 || concurrent != 429 || duringPower != 429 || bcrypt.CompareHashAndPassword([]byte(saved), []byte("000001")) != nil {
		t.Fatal("non-atomic PIN change or saved value was not bcrypt")
	}
	if power("654321") != 403 || power("000001") != 200 || provider.calls != 1 {
		t.Fatal("power accepted wrong PIN after rotation")
	}
}

func TestPanelCapturedReadingsAndCache(t *testing.T) {
	s, _ := testServer(t)
	s.cfg.Origin = "https://localhost:8080"
	key := token()
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	dir := t.TempDir()
	log := fmt.Sprintf("{\"at\":%d,\"watts\":100}\n{\"at\":%d,\"watts\":200}\n", now.Unix()-60, now.Unix())
	if err := os.WriteFile(filepath.Join(dir, now.Format("2006-01-02")+".jsonl"), []byte(log), 0600); err != nil {
		t.Fatal(err)
	}
	h, err := energy.Open(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.History = h
	cfg := s.cfg
	cfg.DeviceID = "unmetered"
	cfg.History = nil
	if err = s.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	fetch := func() string {
		t.Helper()
		w := panelRequest(s, "GET", "/api/v1/panel", "", "Bearer "+key)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return w.Body.String()
	}
	first := fetch()
	var v struct {
		CapturedAt                             int64
		Devices                                []panelDevice
		Day, Month                             []*float64
		DayHours, MonthHours, DayKwh, MonthKwh float64
	}
	if err = json.Unmarshal([]byte(first), &v); err != nil {
		t.Fatal(err)
	}
	if !v.Devices[0].Metered || v.Devices[1].Metered {
		t.Fatal("meter flags do not match configured sources")
	}
	if v.CapturedAt < now.Unix() || v.Devices[0].Watts == nil || *v.Devices[0].Watts != 200 || v.Devices[1].Watts != nil {
		t.Fatalf("unexpected snapshot: %+v", v)
	}
	if len(v.Day) != 96 || len(v.Month) != 120 {
		t.Fatalf("unexpected chart lengths: day=%d, month=%d", len(v.Day), len(v.Month))
	}
	if *v.Day[95] != 150 || *v.Month[119] != 150 || v.DayHours != 1.0/60 || v.MonthHours != 1.0/60 || v.DayKwh != 0.0025 || v.MonthKwh != 0.0025 {
		t.Fatalf("unexpected coverage: %+v", v)
	}
	s.cfg.History = energy.MemoryOnly()
	if fetch() != first {
		t.Fatal("cache miss on immediate second GET")
	}
	s.panel.capturedAt = now.Add(-11 * time.Second)
	if fetch() == first {
		t.Fatal("cache survived expiration")
	}
}

type interruptedPower struct {
	fakeProvider
	started chan struct{}
}

func (p *interruptedPower) SetPower(ctx context.Context, _ string) error {
	close(p.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestPanelPowerRestrictionsRateLimitAndTimeout(t *testing.T) {
	s, provider := testServer(t)
	s.cfg.Origin = "https://localhost:8080"
	hash, err := bcrypt.GenerateFromPassword([]byte("654321"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	key := token()
	if err = s.EnablePanel(key, string(hash), nil); err != nil {
		t.Fatal(err)
	}
	cfg := s.cfg
	cfg.DeviceID = "other"
	other := &fakeProvider{}
	if err = s.AddDevice(cfg, other); err != nil {
		t.Fatal(err)
	}
	post := func(action, confirm, pin string) int {
		body := `{"id":"other","action":"` + action + `","confirm":"` + confirm + `","pin":"` + pin + `"}`
		return panelRequest(s, "POST", "/api/v1/panel/power", body, "Bearer "+key).Code
	}
	for _, field := range []string{`"id":"default",`, `"ID":"default",`} {
		body := `{` + field + `"id":"other","action":"on","confirm":"on","pin":"654321"}`
		if w := panelRequest(s, "POST", "/api/v1/panel/power", body, "Bearer "+key); w.Code != 400 || other.calls != 0 {
			t.Fatalf("ambiguous target %s returned %d, dispatched %d commands", field, w.Code, other.calls)
		}
	}
	if post("cycle", "cycle", "654321") != 400 || post("on", "soft", "654321") != 400 {
		t.Fatal("accepted invalid action")
	}
	for range 5 {
		if post("on", "on", "000000") != 403 {
			t.Fatal("accepted wrong PIN")
		}
	}
	if post("on", "on", "654321") != 429 || provider.calls+other.calls != 0 {
		t.Fatal("bypassed PIN limiter")
	}
	var saved LoginState
	s.SaveLogins(&saved)
	next, err := New(s.cfg, provider, s.static)
	if err != nil {
		t.Fatal(err)
	}
	if err := next.EnablePanel(key, string(hash), nil); err != nil {
		t.Fatal(err)
	}
	next.RestoreLogins(&saved)
	body := `{"id":"default","action":"on","confirm":"on","pin":"654321"}`
	if w := panelRequest(next, "POST", "/api/v1/panel/power", body, "Bearer "+key); w.Code != 429 || provider.calls != 0 {
		t.Fatal("settings reload cleared PIN lockout", w.Code)
	}
	s.panel.window = time.Now().Add(-5 * time.Minute)
	if post("soft", "soft", "654321") != 200 || other.calls != 1 || provider.calls != 0 {
		t.Fatal("wrong device/action dispatch")
	}
	if post("on", "on", "654321") != 429 {
		t.Fatal("bypassed shared action cooldown")
	}
	d := s.devices["other"]
	d.lastAction = time.Time{}
	d.cfg.Timeout = time.Millisecond
	d.readGate <- struct{}{}
	if post("on", "on", "654321") != 504 || other.calls != 1 {
		t.Fatal("queued command survived timeout")
	}
	<-d.readGate
	pending := &interruptedPower{started: make(chan struct{})}
	d.provider = pending
	d.lastAction = time.Time{}
	d.cfg.Timeout = time.Minute
	status := make(chan int, 1)
	go func() { status <- post("on", "on", "654321") }()
	select {
	case <-pending.started:
	case <-time.After(3 * time.Second):
		t.Fatal("command did not start")
	}
	s.CloseSessions()
	select {
	case code := <-status:
		if code != 504 {
			t.Fatal("unexpected cancellation response", code)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown failed to cancel in-flight command")
	}
	if post("on", "on", "654321") != 503 {
		t.Fatal("accepted command during teardown")
	}
}
