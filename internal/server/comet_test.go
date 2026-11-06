package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type cometFixture struct {
	s               *Server
	url             string
	cookie          *http.Cookie
	logins, logouts atomic.Int32
	packets         chan cometEnvelope
	mode            string
}

func (f *cometFixture) request(path string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", f.url+path, nil)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	r.Header.Set("Origin", origin)
	w := httptest.NewRecorder()
	f.s.ServeHTTP(w, r)
	return w
}

func newCometFixture(t *testing.T, mode string) *cometFixture {
	t.Helper()
	f := &cometFixture{packets: make(chan cometEnvelope, 64), mode: mode}
	device := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Error("token or unexpected query on device URL")
		}
		if r.URL.Path == "/api/auth/login" {
			f.logins.Add(1)
			if r.FormValue("user") != "admin" || r.FormValue("passwd") != "fixture-password" {
				t.Error("wrong device credentials")
			}
			fmt.Fprint(w, `{"result":{"token":"fixture-private-token"}}`)
			return
		}
		if r.Header.Get("Token") != "fixture-private-token" {
			t.Error("missing device token")
			w.WriteHeader(403)
			return
		}
		switch r.URL.Path {
		case "/api/auth/check":
			fmt.Fprint(w, `{}`)
			return
		case "/api/auth/logout":
			f.logouts.Add(1)
			fmt.Fprint(w, `{}`)
			return
		case "/janus/ws", "/api/ws":
		default:
			t.Error("unexpected device endpoint", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if mode == "timeout" {
			<-r.Context().Done()
			return
		}
		if mode == "partial" && r.URL.Path == "/api/ws" {
			w.WriteHeader(503)
			return
		}
		channel := "events"
		var protocols []string
		if r.URL.Path == "/janus/ws" {
			channel = "janus"
			protocols = []string{"janus-protocol"}
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: protocols})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if channel == "events" {
			_ = cometWrite(r.Context(), conn, []byte(`{"event_type":"streamer","event":{"streamer":{"source":{"online":true,"real_resolution":"no_signal"}}}}`))
		}
		for {
			_, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			f.packets <- cometEnvelope{channel, data}
			if channel != "janus" {
				continue
			}
			if mode == "secret" {
				_ = cometWrite(r.Context(), conn, []byte(`{"janus":"error","reason":"fixture-private-\u0074oken"}`))
				continue
			}
			var m cometJanus
			_ = json.Unmarshal(data, &m)
			id := 0
			if m.Janus == "create" {
				id = 101
			}
			if m.Janus == "attach" {
				id = 201
			}
			response := map[string]any{"janus": "ack", "transaction": m.Transaction}
			if id != 0 {
				response["janus"] = "success"
				response["data"] = map[string]int{"id": id}
			}
			_ = cometWrite(r.Context(), conn, cometJSON(response))
		}
	}))
	t.Cleanup(device.Close)
	f.s, _ = testServer(t)
	f.s.cfg.GLURL, f.s.cfg.GLUsername, f.s.cfg.GLPassword = device.URL, "admin", "fixture-password"
	pin := sha256.Sum256(device.Certificate().Raw)
	f.s.cfg.GLCertificateSHA256 = hex.EncodeToString(pin[:])
	f.s.cfg.Timeout = 150 * time.Millisecond
	if mode == "bad-pin" {
		f.s.cfg.GLCertificateSHA256 = strings.Repeat("0", 64)
	}
	f.cookie, _ = login(t, f.s)
	app := httptest.NewServer(f.s)
	f.url, f.s.cfg.Origin = app.URL, app.URL
	t.Cleanup(func() {
		f.s.CloseSessions()
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		if err := f.s.WaitForSOL(ctx); err != nil {
			t.Error("cleanup failed", err)
		}
		app.Close()
	})
	return f
}

func (f *cometFixture) dial(t *testing.T, ctx context.Context) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.url, "http")+"/api/devices/default/glkvm/session", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": {f.cookie.String()}, "Origin": {f.url}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Cookies()) > 0 {
		t.Fatal("upstream cookie leaked")
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

func cometExchange(t *testing.T, ctx context.Context, conn *websocket.Conn, raw string) {
	t.Helper()
	var request cometJanus
	_ = json.Unmarshal([]byte(raw), &request)
	if err := cometWrite(ctx, conn, cometJSON(cometEnvelope{"janus", json.RawMessage(raw)})); err != nil {
		t.Fatal(err)
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "fixture-private") || strings.Contains(string(data), "fixture-password") {
			t.Fatal("secret leaked")
		}
		var msg cometEnvelope
		_ = json.Unmarshal(data, &msg)
		var reply struct {
			Transaction string `json:"transaction"`
		}
		_ = json.Unmarshal(msg.Data, &reply)
		if msg.Channel == "janus" && reply.Transaction == request.Transaction {
			return
		}
	}
}

func TestCometRelayOwnershipAndCleanup(t *testing.T) {
	f := newCometFixture(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn := f.dial(t, ctx)
	_, first, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(first), `"real_resolution":"no_signal"`) {
		t.Fatal("no-signal metadata lost", string(first), err)
	}
	cometExchange(t, ctx, conn, `{"janus":"create","transaction":"create"}`)
	cometExchange(t, ctx, conn, `{"janus":"attach","transaction":"attach","session_id":101,"plugin":"janus.plugin.ustreamer"}`)
	cometExchange(t, ctx, conn, `{"janus":"message","transaction":"features","session_id":101,"handle_id":201,"body":{"request":"features"}}`)
	cometExchange(t, ctx, conn, `{"janus":"message","transaction":"watch","session_id":101,"handle_id":201,"body":{"request":"watch","params":{"orientation":0,"audio":false,"video":true,"mic":false,"camera":false,"video_format":0}}}`)
	cometExchange(t, ctx, conn, `{"janus":"message","transaction":"start","session_id":101,"handle_id":201,"body":{"request":"start"},"jsep":{"type":"answer","sdp":"v=0\r\na=recvonly\r\n"}}`)
	cometExchange(t, ctx, conn, `{"janus":"trickle","transaction":"ice","session_id":101,"handle_id":201,"candidate":{"completed":true}}`)
	// Streaming outlives the short HTTP/handshake timeout.
	time.Sleep(200 * time.Millisecond)
	cometExchange(t, ctx, conn, `{"janus":"keepalive","transaction":"alive","session_id":101}`)
	second := f.dial(t, ctx)
	_, _, err = second.Read(ctx)
	if websocket.CloseStatus(err) != 4409 || f.logins.Load() != 1 {
		t.Fatal("exclusive session failed", err, f.logins.Load())
	}
	w := f.request("/api/devices/default/glkvm/status", f.cookie, "")
	if w.Code != 409 {
		t.Fatal("status overlapped active stream", w.Code)
	}
	if err = cometWrite(ctx, conn, []byte(`{"channel":"events","data":{"event_type":"key","event":{"key":"ControlLeft","state":true,"finish":false}}}`)); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case msg := <-f.packets:
			if msg.Channel == "events" {
				goto pressed
			}
		case <-ctx.Done():
			t.Fatal("key not forwarded")
		}
	}
pressed:
	f.s.CloseSessions()
	_, _, _ = conn.Read(ctx)
	if err = f.s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
	if f.logouts.Load() != 1 {
		t.Fatal("token not logged out")
	}
	released, destroyed := false, false
	for len(f.packets) > 0 {
		msg := <-f.packets
		if msg.Channel == "events" && strings.Contains(string(msg.Data), `"state":false`) {
			released = true
		}
		if msg.Channel == "janus" && strings.Contains(string(msg.Data), `"janus":"destroy"`) {
			destroyed = true
		}
	}
	if !released || !destroyed {
		t.Fatal("incomplete key/Janus cleanup", released, destroyed)
	}
}

func TestCometRelayRejectsInvalidInputAndSecrets(t *testing.T) {
	for _, mode := range []string{"unknown", "foreign-session", "oversize", "binary", "secret"} {
		t.Run(mode, func(t *testing.T) {
			f := newCometFixture(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			conn := f.dial(t, ctx)
			_, _, _ = conn.Read(ctx)
			message := `{"channel":"events","data":{"event_type":"atx","event":{}}}`
			if mode == "foreign-session" {
				message = `{"channel":"janus","data":{"janus":"destroy","session_id":999,"transaction":"x"}}`
			}
			if mode == "secret" {
				message = `{"channel":"janus","data":{"janus":"create","transaction":"x"}}`
			}
			if mode == "oversize" {
				message = strings.Repeat("x", cometMessageLimit+1)
			}
			if mode == "binary" {
				_ = conn.Write(ctx, websocket.MessageBinary, []byte(message))
			} else {
				_ = cometWrite(ctx, conn, []byte(message))
			}
			_, data, err := conn.Read(ctx)
			if len(data) != 0 || err == nil {
				t.Fatal("unsafe message relayed", string(data), err)
			}
			f.s.CloseSessions()
			if err = f.s.WaitForSOL(ctx); err != nil || f.logouts.Load() != 1 {
				t.Fatal("cleanup failed", err)
			}
			if mode != "secret" && len(f.packets) != 0 {
				t.Fatal("rejected message reached device")
			}
		})
	}
}

func TestCometRelayAuthenticationOriginAndFailures(t *testing.T) {
	for _, mode := range []string{"bad-pin", "timeout", "partial"} {
		t.Run(mode, func(t *testing.T) {
			f := newCometFixture(t, mode)
			for _, origin := range []string{"", "https://foreign.invalid"} {
				w := f.request("/api/devices/default/glkvm/session", f.cookie, origin)
				if w.Code != 403 || f.logins.Load() != 0 {
					t.Fatal("origin not checked before device access")
				}
			}
			if w := f.request("/api/devices/default/glkvm/session", nil, f.url); w.Code != 401 {
				t.Fatal("app login not enforced")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			conn := f.dial(t, ctx)
			_, _, err := conn.Read(ctx)
			want := websocket.StatusCode(1013)
			if mode == "bad-pin" {
				want = 4403
			}
			if websocket.CloseStatus(err) != want {
				t.Fatal("wrong redacted failure", err)
			}
			f.s.CloseSessions()
			if err = f.s.WaitForSOL(ctx); err != nil {
				t.Fatal(err)
			}
			if f.logouts.Load() != f.logins.Load() {
				t.Fatal("partial login leaked")
			}
		})
	}
}

func TestCometProtocolAllowlist(t *testing.T) {
	for _, raw := range []string{
		`{"janus":"message","transaction":"x","session_id":101,"handle_id":201,"body":{"request":"watch","params":{"video":true,"audio":true}}}`,
		`{"janus":"message","transaction":"x","session_id":101,"handle_id":201,"body":{"request":"set_params"}}`,
		`{"janus":"message","transaction":"x","session_id":101,"handle_id":201,"body":{"request":"features","uri":"http://arbitrary"}}`,
		`{"janus":"attach","transaction":"x","session_id":101,"plugin":"janus.plugin.videoroom"}`,
		`{"janus":"trickle","transaction":"x","session_id":101,"handle_id":201,"candidate":{"candidate":"garbage"}}`,
		`{"janus":"keepalive","transaction":"x","session_id":102}`,
		`{"janus":"keepalive","transaction":"x","session_id":101,"token":"secret"}`,
		`{"janus":"message","transaction":"x","session_id":101,"handle_id":201,"body":{"request":"start"},"jsep":{"type":"answer","sdp":"v=0\r\na=sendrecv\r\n"}}`,
		`{"janus":"create","transaction":"x"}{}`,
	} {
		p := cometProtocol{session: 101, handle: 201, create: "c"}
		if _, err := p.janusInput([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, key := range []string{"ControlLeft", "KeyA", "F12", "Tab", "NumpadEnter"} {
		if !cometKey.MatchString(key) {
			t.Error("valid key rejected", key)
		}
	}
	for _, key := range []string{"", "Power", "Reset", "KeyAA", "F99", "keyA"} {
		if cometKey.MatchString(key) {
			t.Error("invalid key accepted", key)
		}
	}
}

func TestCometAbruptDisconnectReleasesKeyboard(t *testing.T) {
	f := newCometFixture(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	conn := f.dial(t, ctx)
	_, _, _ = conn.Read(ctx)
	cometExchange(t, ctx, conn, `{"janus":"create","transaction":"create"}`)
	cometExchange(t, ctx, conn, `{"janus":"attach","transaction":"attach","session_id":101,"plugin":"janus.plugin.ustreamer"}`)
	_ = cometWrite(ctx, conn, []byte(`{"channel":"events","data":{"event_type":"key","event":{"key":"KeyB","state":true,"finish":false}}}`))
	for {
		select {
		case msg := <-f.packets:
			if msg.Channel == "events" {
				goto pressed
			}
		case <-ctx.Done():
			t.Fatal("missing key-down")
		}
	}
pressed:
	_ = conn.CloseNow()
	if err := f.s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-f.packets:
		if !strings.Contains(string(msg.Data), `"state":false`) {
			t.Fatal("missing key-up")
		}
	case <-ctx.Done():
		t.Fatal("missing release")
	}
	select {
	case msg := <-f.packets:
		if !strings.Contains(string(msg.Data), `"janus":"destroy"`) {
			t.Fatal("missing destroy")
		}
	case <-ctx.Done():
		t.Fatal("missing Janus cleanup")
	}
	if f.logouts.Load() != 1 {
		t.Fatal("logout missing")
	}
	// The gate is reusable after cleanup, without restarting the server.
	next := f.dial(t, ctx)
	_, _, err := next.Read(ctx)
	if err != nil || f.logins.Load() != 2 {
		t.Fatal("gate did not reopen", err)
	}
}

func TestCometSecretEscapes(t *testing.T) {
	for _, secret := range []string{`p&ss`, `p"ss`, `p\ss`, "p\nss", "<secret>"} {
		for _, value := range []any{map[string]string{"message": "prefix:" + secret}, map[string]string{secret: "value"}} {
			if !cometContainsSecret(cometJSON(value), secret) {
				t.Errorf("secret not detected: %q", secret)
			}
		}
		if cometContainsSecret([]byte(`{"safe":true}`), secret) {
			t.Fatal("false positive")
		}
	}
}

func TestCometUnresponsiveBrowserReleasesKeyboard(t *testing.T) {
	f := newCometFixture(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 19*time.Second)
	defer cancel()
	conn := f.dial(t, ctx)
	_, _, _ = conn.Read(ctx)
	_ = cometWrite(ctx, conn, []byte(`{"channel":"events","data":{"event_type":"key","event":{"key":"ShiftLeft","state":true,"finish":false}}}`))
	select {
	case <-f.packets:
	case <-ctx.Done():
		t.Fatal("missing key-down")
	}
	// No Read means this client deliberately does not process or answer pings.
	if err := f.s.WaitForSOL(ctx); err != nil {
		t.Fatal("silent client retained session", err)
	}
	select {
	case msg := <-f.packets:
		if !strings.Contains(string(msg.Data), `"state":false`) {
			t.Fatal("missing release")
		}
	case <-ctx.Done():
		t.Fatal("missing key-up after liveness failure")
	}
	if f.logouts.Load() != 1 {
		t.Fatal("missing logout after liveness failure")
	}
}
