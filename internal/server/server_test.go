package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/akira69/iBORK/internal/management"
	"golang.org/x/crypto/bcrypt"
)

type fakeProvider struct {
	calls int
	fail  bool
}

func (*fakeProvider) Watts(context.Context) (float64, error) { return 100, nil }

func (p *fakeProvider) Power(context.Context) (management.PowerState, error) {
	if p.fail {
		return management.PowerState{}, context.DeadlineExceeded
	}
	return management.PowerState{State: "on"}, nil
}
func (*fakeProvider) Sensors(context.Context) ([]management.Sensor, error) {
	return []management.Sensor{}, nil
}
func (*fakeProvider) Inventory(context.Context) (management.Inventory, error) {
	return management.Inventory{}, nil
}
func (*fakeProvider) Events(context.Context) ([]management.Event, error) {
	return []management.Event{}, nil
}
func (p *fakeProvider) SetPower(context.Context, string) error { p.calls++; return nil }
func (*fakeProvider) SetBoot(context.Context, string) error    { return nil }
func (*fakeProvider) ClearEvents(context.Context) error        { return nil }

func testServer(t *testing.T) (*Server, *fakeProvider) {
	t.Helper()
	hash, _ := bcrypt.GenerateFromPassword([]byte("test password"), bcrypt.MinCost)
	p := &fakeProvider{}
	s, err := New(Config{Origin: "http://localhost:8080", PasswordHash: string(hash), JetURL: "http://192.0.2.14", Timeout: time.Second}, p, http.NotFoundHandler())
	if err != nil {
		t.Fatal(err)
	}
	return s, p
}
func request(s *Server, method, path, body string, cookie *http.Cookie, csrf, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost:8080"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func login(t *testing.T, s *Server) (*http.Cookie, string) {
	t.Helper()
	w := request(s, "POST", "/api/login", `{"password":"test password"}`, nil, "", "http://localhost:8080")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		CSRF string `json:"csrf"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	return w.Result().Cookies()[0], result.CSRF
}
func TestAuthenticationAndConfirmation(t *testing.T) {
	s, p := testServer(t)
	if w := request(s, "GET", "/api/power", "", nil, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	cookie, csrf := login(t, s)
	for _, tc := range []struct {
		body, token, origin string
		status              int
	}{
		{`{"action":"off","confirm":"off"}`, "", "http://localhost:8080", 403},
		{`{"action":"off","confirm":"off"}`, csrf, "https://evil.test", 403},
		{`{"action":"off","confirm":"reset"}`, csrf, "http://localhost:8080", 400},
		{`{"action":"shell","confirm":"shell"}`, csrf, "http://localhost:8080", 400},
		{`{"action":"off","confirm":"off"}`, csrf, "http://localhost:8080", 200},
	} {
		w := request(s, "POST", "/api/power", tc.body, cookie, tc.token, tc.origin)
		if w.Code != tc.status {
			t.Fatalf("%+v: %d %s", tc, w.Code, w.Body.String())
		}
	}
	if p.calls != 1 {
		t.Fatal(p.calls)
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("insecure cookie")
	}
}
func TestExpiryAndLogout(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	request(s, "POST", "/api/logout", "{}", c, csrf, "http://localhost:8080")
	if w := request(s, "GET", "/api/session", "", c, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	c, _ = login(t, s)
	s.mu.Lock()
	s.sessions[c.Value].expires = time.Now().Add(-time.Second)
	s.mu.Unlock()
	if w := request(s, "GET", "/api/power", "", c, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
func TestUpstreamFailureAndSecrets(t *testing.T) {
	s, p := testServer(t)
	c, _ := login(t, s)
	p.fail = true
	if w := request(s, "GET", "/api/power", "", c, "", ""); w.Code != 504 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := request(s, "GET", "/api/config", "", c, "", "")
	if strings.Contains(w.Body.String(), "password") || strings.Contains(w.Body.String(), s.cfg.PasswordHash) {
		t.Fatal("secret leaked")
	}
}
func TestLoginOriginAndRateLimit(t *testing.T) {
	s, _ := testServer(t)
	if w := request(s, "POST", "/api/login", `{"password":"test password"}`, nil, "", "https://evil.test"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	for i := 0; i < 11; i++ {
		w := request(s, "POST", "/api/login", `{"password":"wrong"}`, nil, "", "http://localhost:8080")
		if i == 10 && w.Code != 429 {
			t.Fatal(w.Code)
		}
	}
}

func TestActionRateLimit(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	for i := 0; i < 2; i++ {
		w := request(s, "POST", "/api/power", `{"action":"on","confirm":"on"}`, c, csrf, "http://localhost:8080")
		expected := 200
		if i == 1 {
			expected = 429
		}
		if w.Code != expected {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
}

func TestActionCooldownAfterWaitingForDevice(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, provider := testServer(t)
		s.readGate <- struct{}{}
		first := httptest.NewRecorder()
		go s.applyAction(first, t.Context(), "/api/power", "on")
		synctest.Wait()
		time.Sleep(2 * time.Second) // The preceding device read outlasts the cooldown.
		<-s.readGate
		synctest.Wait()
		second := httptest.NewRecorder()
		s.applyAction(second, t.Context(), "/api/power", "soft")
		if first.Code != 200 || second.Code != 429 || provider.calls != 1 {
			t.Fatalf("returned %d, %d and dispatched %d commands", first.Code, second.Code, provider.calls)
		}
	})
}

func TestReadCacheCoalescesConcurrentLoads(t *testing.T) {
	s, _ := testServer(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	calls := 0
	load := func(context.Context) (any, error) {
		calls++
		if calls == 1 {
			close(entered)
			<-release
		}
		return "cached", nil
	}
	go func() { s.read(httptest.NewRecorder(), context.Background(), "test", time.Minute, load); close(done) }()
	<-entered
	second := make(chan struct{})
	go func() { s.read(httptest.NewRecorder(), context.Background(), "test", time.Minute, load); close(second) }()
	time.Sleep(20 * time.Millisecond)
	close(release)
	<-done
	<-second
	if calls != 1 {
		t.Fatal("duplicate BMC loads", calls)
	}
}

func TestMalformedRequestsAndHeaders(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	for _, body := range []string{`{`, `{"action":"off","confirm":"off","extra":true}`, `{"action":"off","confirm":"off"} {}`, strings.Repeat("x", 5000)} {
		w := request(s, "POST", "/api/power", body, c, csrf, "http://localhost:8080")
		if w.Code != 400 {
			t.Fatalf("unexpected malformed request status %d", w.Code)
		}
	}
	r := httptest.NewRequest("GET", "http://evil.test/api/session", nil)
	r.AddCookie(c)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("host check", w.Code)
	}
	w = request(s, "GET", "/api/session", "", c, "", "")
	for _, directive := range []string{"img-src 'self' data: https:;", "connect-src 'self';", "script-src 'self';"} {
		if !strings.Contains(w.Header().Get("Content-Security-Policy"), directive) {
			t.Fatalf("missing CSP directive %s", directive)
		}
	}
	for key, value := range map[string]string{"Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff"} {
		if w.Header().Get(key) != value {
			t.Fatal(key)
		}
	}
}

func TestEnergyRequiresSessionAndNeverPollsDevice(t *testing.T) {
	s, p := testServer(t)
	history, err := energy.Open(t.TempDir(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.History = history
	if w := request(s, "GET", "/api/energy", "", nil, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	c, _ := login(t, s)
	w := request(s, "GET", "/api/energy", "", c, "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"samples":[]`) || p.calls != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}
