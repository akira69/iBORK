package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestJetAuthenticationAndRelayExpiry(t *testing.T) {
	var logins atomic.Int32
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/login-local" {
			logins.Add(1)
			http.SetCookie(w, &http.Cookie{Name: "authToken", Value: "device-secret", Path: "/"})
			w.WriteHeader(200)
			return
		}
		c, err := r.Cookie("authToken")
		if err != nil || c.Value != "device-secret" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/device" {
			w.WriteHeader(200)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			kind, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if conn.Write(r.Context(), kind, data) != nil {
				return
			}
		}
	}))
	defer device.Close()
	relay, err := newJetRelay(device.URL, "device-password", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	session, cancel := context.WithCancel(context.Background())
	defer cancel()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { relay.signal(w, r, session) }))
	defer app.Close()
	ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(app.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if len(response.Cookies()) != 0 {
		t.Fatal("device cookie exposed")
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte("test signaling")); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil || string(data) != "test signaling" {
		t.Fatal(string(data), err)
	}
	if err = relay.check(ctx); err != nil {
		t.Fatal(err)
	}
	if logins.Load() != 1 {
		t.Fatal("repeated upstream login", logins.Load())
	}
	cancel()
	_, _, err = conn.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatal("expected policy close", err)
	}
}

func TestJetFailuresAreBounded(t *testing.T) {
	for _, status := range []int{401, 302, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "http://unexpected.invalid")
				w.WriteHeader(status)
			}))
			defer device.Close()
			relay, _ := newJetRelay(device.URL, "secret", time.Second)
			if relay.check(context.Background()) == nil {
				t.Fatal("unexpected success")
			}
		})
	}
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer device.Close()
	relay, _ := newJetRelay(device.URL, "secret", 30*time.Millisecond)
	start := time.Now()
	if relay.check(context.Background()) == nil {
		t.Fatal("expected timeout")
	}
	if time.Since(start) > time.Second {
		t.Fatal("unbounded timeout")
	}
}

func TestWebsocketRejectsForeignOriginBeforeDeviceAccess(t *testing.T) {
	s, _ := testServer(t)
	c, _ := login(t, s)
	w := request(s, "GET", "/api/jetkvm/signaling", "", c, "", "https://evil.test")
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestJetKVMExclusiveSession(t *testing.T) {
	var calls atomic.Int32
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/device" {
			w.WriteHeader(200)
			return
		}
		calls.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			kind, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if conn.Write(r.Context(), kind, data) != nil {
				return
			}
		}
	}))
	defer device.Close()
	s, _ := testServer(t)
	s.jet, _ = newJetRelay(device.URL, "", time.Second)
	cookie, _ := login(t, s)
	app := httptest.NewServer(s)
	defer app.Close()
	s.cfg.Origin = app.URL
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	dial := func() (*websocket.Conn, *http.Response, error) {
		return websocket.Dial(ctx, "ws"+strings.TrimPrefix(app.URL, "http")+"/api/devices/default/jetkvm/signaling", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{app.URL}, "Cookie": []string{cookie.String()}}})
	}
	conn, _, err := dial()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	second, _, err := dial()
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = second.Read(ctx)
	if websocket.CloseStatus(err) != 4409 {
		t.Fatal("busy close missing", err)
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate upstream connection", calls.Load())
	}
	conn.CloseNow()
	deadline := time.Now().Add(time.Second)
	for {
		next, _, err := dial()
		if err == nil {
			conn = next
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream gate not released")
		}
		time.Sleep(time.Millisecond)
	}
	s.CloseSessions()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("shutdown kept stream")
	}
	if err := s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestJetKVMExclusiveSessionFailedSetupReleasesGate(t *testing.T) {
	var mode atomic.Int32
	device := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/device" {
			if mode.Load() == 0 {
				w.WriteHeader(401)
			} else {
				w.WriteHeader(200)
			}
			return
		}
		if mode.Load() == 1 {
			w.WriteHeader(503)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, _, _ = conn.Read(r.Context())
	}))
	defer device.Close()
	s, _ := testServer(t)
	s.jet, _ = newJetRelay(device.URL, "", time.Second)
	cookie, _ := login(t, s)
	app := httptest.NewServer(s)
	defer app.Close()
	s.cfg.Origin = app.URL
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, code := range []websocket.StatusCode{4401, 1013} {
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(app.URL, "http")+"/api/jetkvm/signaling", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{app.URL}, "Cookie": []string{cookie.String()}}})
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = conn.Read(ctx)
		if websocket.CloseStatus(err) != code {
			t.Fatal("incorrect failure", err)
		}
		if err = s.WaitForSOL(ctx); err != nil {
			t.Fatal("gate leaked", err)
		}
		mode.Add(1)
	}
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(app.URL, "http")+"/api/jetkvm/signaling", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{app.URL}, "Cookie": []string{cookie.String()}}})
	if err != nil {
		t.Fatal(err)
	}
	s.CloseSessions()
	_, _, _ = conn.Read(ctx)
	if err = s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
}
