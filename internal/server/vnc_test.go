package server

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestVNCConfigValidation(t *testing.T) {
	s, _ := testServer(t)
	valid := s.cfg
	valid.BMCHost, valid.VNCPort, valid.VNCPassword, valid.VNCCertificateSHA256 = "127.0.0.1", 5900, "testpass", strings.Repeat("a", 64)
	for _, tc := range []struct {
		name   string
		change func(*Config)
	}{
		{"port", func(c *Config) { c.VNCPort = 65536 }},
		{"negative port", func(c *Config) { c.VNCPort = -1 }},
		{"host", func(c *Config) { c.BMCHost = "" }},
		{"url", func(c *Config) { c.BMCHost = "https://127.0.0.1" }},
		{"password length", func(c *Config) { c.VNCPassword = "short" }},
		{"password encoding", func(c *Config) { c.VNCPassword = "testpas\n" }},
		{"pin length", func(c *Config) { c.VNCCertificateSHA256 = "ab" }},
		{"pin encoding", func(c *Config) { c.VNCCertificateSHA256 = strings.Repeat("z", 64) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := valid
			tc.change(&cfg)
			if _, err := New(cfg, s.provider, s.static); err == nil {
				t.Fatal("invalid VNC configuration accepted")
			}
		})
	}
	if _, err := New(valid, s.provider, s.static); err != nil {
		t.Fatal(err)
	}
}

func TestVNCAuthenticationOriginCSRFAndMetadata(t *testing.T) {
	s, _ := testServer(t)
	s.cfg.VNCPort, s.cfg.VNCPassword = 5900, "testpass"
	cookie, csrf := login(t, s)
	for _, tc := range []struct {
		method, path, origin, csrf string
		cookie                     *http.Cookie
		status                     int
	}{
		{"GET", "vnc", s.cfg.Origin, "", nil, 401},
		{"GET", "vnc", "", "", cookie, 403},
		{"GET", "vnc", "https://evil.test", "", cookie, 403},
		{"POST", "vnc/session", s.cfg.Origin, csrf, nil, 401},
		{"POST", "vnc/session", s.cfg.Origin, "", cookie, 403},
		{"POST", "vnc/session", "https://evil.test", csrf, cookie, 403},
		{"POST", "vnc/session", s.cfg.Origin, csrf, cookie, 200},
	} {
		w := request(s, tc.method, "/api/devices/default/"+tc.path, "{}", tc.cookie, tc.csrf, tc.origin)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%+v: %d %s", tc, w.Code, w.Body.String())
		}
		if tc.status == 200 && !strings.Contains(w.Body.String(), `"password":"testpass"`) {
			t.Fatal("missing VNC credential")
		}
	}
	for _, path := range []string{"/api/devices", "/api/config"} {
		w := request(s, "GET", path, "", cookie, "", "")
		if strings.Contains(w.Body.String(), "testpass") || (path == "/api/devices" && !strings.Contains(w.Body.String(), `"hasVNC":true`)) {
			t.Fatal("incorrect public VNC metadata", w.Body.String())
		}
	}
	s.cfg.VNCPort = 0
	for _, methodPath := range [][2]string{{"POST", "vnc/session"}, {"GET", "vnc"}} {
		w := request(s, methodPath[0], "/api/devices/default/"+methodPath[1], "{}", cookie, csrf, s.cfg.Origin)
		if w.Code != 409 {
			t.Fatal(w.Code)
		}
	}
}

func vncFixture(t *testing.T, run func(net.Conn)) (*Server, string, *http.Cookie, string) {
	t.Helper()
	return vncTLSFixture(t, run, &tls.Config{MinVersion: tls.VersionTLS12})
}

func vncTLSFixture(t *testing.T, run func(net.Conn), config *tls.Config) (*Server, string, *http.Cookie, string) {
	t.Helper()
	certServer := httptest.NewTLSServer(http.NotFoundHandler())
	certificate := certServer.TLS.Certificates[0]
	certServer.Close()
	if _, ok := certificate.PrivateKey.(*rsa.PrivateKey); !ok {
		t.Fatal("VNC cipher fixtures require an RSA certificate")
	}
	config.Certificates = []tls.Certificate{certificate}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				run(conn)
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	s, _ := testServer(t)
	s.cfg.BMCHost, _, _ = net.SplitHostPort(listener.Addr().String())
	s.cfg.VNCPort = listener.Addr().(*net.TCPAddr).Port
	s.cfg.VNCPassword = "testpass"
	sum := sha256.Sum256(certificate.Certificate[0])
	s.cfg.VNCCertificateSHA256 = hex.EncodeToString(sum[:])
	cookie, csrf := login(t, s)
	ts := httptest.NewServer(s)
	s.cfg.Origin = ts.URL
	t.Cleanup(func() {
		s.CloseSessions()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := s.WaitForSOL(ctx); err != nil {
			t.Error(err)
		}
		ts.Close()
	})
	return s, ts.URL, cookie, csrf
}

func TestVNCTLSCipherCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name    string
		version uint16
		cipher  uint16
	}{
		{"T320 RSA AES256 GCM", tls.VersionTLS12, tls.TLS_RSA_WITH_AES_256_GCM_SHA384},
		{"TLS12 ECDHE AES256 GCM", tls.VersionTLS12, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384},
		{"TLS13", tls.VersionTLS13, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			negotiated := make(chan tls.ConnectionState, 1)
			_, endpoint, cookie, _ := vncTLSFixture(t, func(conn net.Conn) {
				tlsConn := conn.(*tls.Conn)
				if err := tlsConn.Handshake(); err != nil {
					return
				}
				negotiated <- tlsConn.ConnectionState()
				_, _ = io.Copy(conn, conn)
			}, &tls.Config{MinVersion: tc.version, MaxVersion: tc.version, CipherSuites: []uint16{tc.cipher}})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			select {
			case state := <-negotiated:
				if state.Version != tc.version || (tc.cipher != 0 && state.CipherSuite != tc.cipher) {
					t.Fatalf("unexpected TLS negotiation: version %x cipher %x", state.Version, state.CipherSuite)
				}
			case <-ctx.Done():
				t.Fatal("TLS handshake did not complete")
			}
			if err := ws.Write(ctx, websocket.MessageBinary, []byte("RFB 003.008\n")); err != nil {
				t.Fatal(err)
			}
			if _, data, err := ws.Read(ctx); err != nil || string(data) != "RFB 003.008\n" {
				t.Fatalf("relay failed: %q %v", data, err)
			}
		})
	}
}

func dialVNCWebSocket(ctx context.Context, endpoint string, cookie *http.Cookie) (*websocket.Conn, *http.Response, error) {
	header := http.Header{"Origin": []string{endpoint}, "Cookie": []string{cookie.String()}}
	return websocket.Dial(ctx, endpoint+"/api/devices/default/vnc", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{"binary"}})
}

func TestVNCBinaryRelayConcurrentAndCancellation(t *testing.T) {
	s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageBinary, []byte("RFB 003.008\n")); err != nil {
		t.Fatal(err)
	}
	kind, data, err := ws.Read(ctx)
	if err != nil || kind != websocket.MessageBinary || string(data) != "RFB 003.008\n" {
		t.Fatalf("%v %q %v", kind, data, err)
	}
	second, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = second.Read(ctx)
	if websocket.CloseStatus(err) != 4409 {
		t.Fatal("missing busy close", err)
	}
	s.sessions[cookie.Value].cancel()
	if _, _, err := ws.Read(ctx); err == nil {
		t.Fatal("cancelled session still connected")
	}
	if err := s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestVNCCertificateMismatch(t *testing.T) {
	s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	s.cfg.VNCCertificateSHA256 = strings.Repeat("0", 64)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != 4403 {
		t.Fatal("missing certificate close", err)
	}
}

func TestVNCRejectsTextAndOversizedMessages(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind websocket.MessageType
		data []byte
	}{
		{"text", websocket.MessageText, []byte("input")},
		{"large", websocket.MessageBinary, make([]byte, vncMessageLimit+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(io.Discard, conn) })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			_ = ws.Write(ctx, tc.kind, tc.data)
			if _, _, err := ws.Read(ctx); err == nil {
				t.Fatal("invalid message accepted")
			}
			if err := s.WaitForSOL(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestVNCTLSHandshakeDeadline(t *testing.T) {
	s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) {
		// Read TCP directly to leave TLS negotiation deliberately unanswered.
		_, _ = io.Copy(io.Discard, conn.(*tls.Conn).NetConn())
	})
	s.cfg.Timeout = 50 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != 1013 {
		t.Fatal("missing transient close", err)
	}
	if err := s.WaitForSOL(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestVNCLogoutExpiryAndShutdown(t *testing.T) {
	for _, operation := range []string{"logout", "expiry", "shutdown", "disconnect"} {
		t.Run(operation, func(t *testing.T) {
			s, endpoint, cookie, csrf := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(io.Discard, conn) })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if operation == "expiry" {
				sess := s.sessions[cookie.Value]
				sess.cancel()
				sess.ctx, sess.cancel = context.WithTimeout(context.Background(), 150*time.Millisecond)
			}
			ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			switch operation {
			case "logout":
				r := httptest.NewRequest("POST", endpoint+"/api/logout", nil)
				r.Header.Set("Origin", endpoint)
				r.Header.Set("X-CSRF-Token", csrf)
				r.AddCookie(cookie)
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if w.Code != 200 {
					t.Fatal(w.Code)
				}
			case "shutdown":
				s.CloseSessions()
				w := httptest.NewRecorder()
				s.serveVNC(w, httptest.NewRequest("GET", endpoint, nil), context.Background())
				if w.Code != 503 {
					t.Fatal("admitted VNC during shutdown", w.Code)
				}
			case "disconnect":
				_ = ws.CloseNow()
			}
			if _, _, err := ws.Read(ctx); err == nil {
				t.Fatal("session remains connected")
			}
			if err := s.WaitForSOL(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestVNCConfiguredTargetOnly(t *testing.T) {
	s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{endpoint}, "Cookie": []string{cookie.String()}}
	ws, _, err := websocket.Dial(ctx, endpoint+"/api/devices/default/vnc?host=invalid.invalid&port="+strconv.Itoa(s.cfg.VNCPort+1), &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal("query changed upstream target", err)
	}
	_ = ws.CloseNow()
}

func TestVNCStalledWritesAreBounded(t *testing.T) {
	for _, stalled := range []string{"upstream", "browser"} {
		t.Run(stalled, func(t *testing.T) {
			release := make(chan struct{})
			s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) {
				if err := conn.(*tls.Conn).Handshake(); err != nil {
					return
				}
				if stalled == "upstream" {
					<-release
					return
				}
				data := make([]byte, vncMessageLimit)
				for {
					if _, err := conn.Write(data); err != nil {
						return
					}
				}
			})
			defer close(release)
			s.cfg.Timeout = 100 * time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			if stalled == "upstream" {
				written := make(chan struct{})
				go func() {
					defer close(written)
					data := make([]byte, vncMessageLimit)
					for {
						if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
							return
						}
					}
				}()
				if _, _, err := ws.Read(ctx); err == nil {
					t.Error("stalled upstream remained connected")
				}
				<-written
			}
			if err := s.WaitForSOL(ctx); err != nil {
				t.Fatal("write deadline did not release relay", err)
			}
		})
	}
}

func TestVNCTransportPresets(t *testing.T) {
	for _, tc := range []struct {
		name, kind, transport, password, pin string
		valid                                bool
	}{
		{"legacy Dell", "", "", "testpass", strings.Repeat("a", 64), true},
		{"Dell short", "dell", "tls", "short", strings.Repeat("a", 64), false},
		{"Dell TCP", "dell", "tcp", "testpass", "", false},
		{"generic TLS", "generic", "", "a", strings.Repeat("a", 64), true},
		{"generic TCP", "generic", "tcp", "a", "", true},
		{"generic long", "generic", "tcp", "123456789", "", false},
		{"generic empty", "generic", "tcp", "", "", false},
		{"generic Unicode", "generic", "tcp", "é", "", false},
		{"implicit TCP", "generic", "", "testpass", "", false},
		{"TCP with pin", "generic", "tcp", "testpass", strings.Repeat("a", 64), false},
		{"unknown transport", "generic", "udp", "testpass", strings.Repeat("a", 64), false},
		{"unknown kind", "other", "tls", "testpass", strings.Repeat("a", 64), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateVNCConfig(Config{VNCHost: "127.0.0.1", VNCPort: 5900, VNCKind: tc.kind, VNCTransport: tc.transport, VNCPassword: tc.password, VNCCertificateSHA256: tc.pin})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}

func TestVNCTransportNeverDowngrades(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var mu sync.Mutex
	attempts := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			attempts++
			mu.Unlock()
			_, _ = conn.Write([]byte("RFB 003.008\n"))
			_ = conn.Close()
		}
	}()
	cfg := Config{VNCHost: "127.0.0.1", VNCPort: listener.Addr().(*net.TCPAddr).Port, VNCKind: "generic", VNCPassword: "a", VNCCertificateSHA256: strings.Repeat("a", 64), Timeout: time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := dialVNC(ctx, cfg)
	if err == nil {
		conn.Close()
		t.Fatal("plaintext peer accepted in default TLS mode")
	}
	listener.Close()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if attempts != 1 {
		t.Fatalf("expected one TLS attempt, got %d", attempts)
	}
}

func TestVNCGenericTransports(t *testing.T) {
	t.Run("pinned TLS", func(t *testing.T) {
		s, _, _, _ := vncFixture(t, func(conn net.Conn) { _, _ = io.Copy(conn, conn) })
		s.cfg.VNCKind, s.cfg.VNCPassword = "generic", "a"
		conn, err := dialVNC(context.Background(), s.cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		if _, err := conn.Write([]byte("test")); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, 4)
		if _, err := io.ReadFull(conn, data); err != nil || string(data) != "test" {
			t.Fatalf("%q %v", data, err)
		}
	})
	t.Run("explicit TCP", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		done := make(chan struct{})
		go func() {
			defer close(done)
			c, err := listener.Accept()
			if err == nil {
				defer c.Close()
				c.SetDeadline(time.Now().Add(time.Second))
				io.Copy(c, c)
			}
		}()
		cfg := Config{VNCHost: "127.0.0.1", VNCPort: listener.Addr().(*net.TCPAddr).Port, VNCKind: "generic", VNCTransport: "tcp", VNCPassword: "a", Timeout: time.Second}
		conn, err := dialVNC(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		_, _ = conn.Write([]byte("test"))
		data := make([]byte, 4)
		if _, err := io.ReadFull(conn, data); err != nil || string(data) != "test" {
			t.Fatalf("%q %v", data, err)
		}
		conn.Close()
		<-done
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if conn, err := dialVNC(ctx, cfg); err == nil {
			conn.Close()
			t.Fatal("cancelled dial connected")
		}
	})
}
