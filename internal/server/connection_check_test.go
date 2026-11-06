package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCometConnectionCheck(t *testing.T) {
	for _, mode := range []string{"ok", "bad-pin", "auth", "redirect", "invalid-json", "oversize", "check-fails", "timeout", "logout-fails"} {
		t.Run(mode, func(t *testing.T) {
			var logouts atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/auth/login":
					if r.Method != "POST" || r.FormValue("user") != "admin" || r.FormValue("passwd") != "fixture-password" {
						t.Error("incorrect login")
					}
					switch mode {
					case "auth":
						http.Error(w, "fixture-password", 403)
						return
					case "redirect":
						http.Redirect(w, r, "/must-not-follow", 307)
						return
					case "invalid-json":
						fmt.Fprint(w, "not JSON")
						return
					case "oversize":
						fmt.Fprint(w, strings.Repeat("x", 8193))
						return
					}
					fmt.Fprint(w, `{"result":{"token":"fixture-token"}}`)
				case "/api/auth/check":
					if r.Header.Get("Token") != "fixture-token" {
						t.Error("missing token")
					}
					if mode == "check-fails" {
						http.Error(w, "fixture-token", 403)
						return
					}
					if mode == "timeout" {
						<-r.Context().Done()
						return
					}
					fmt.Fprint(w, `{}`)
				case "/api/auth/logout":
					if r.Method != "POST" || r.Header.Get("Token") != "fixture-token" {
						t.Error("incorrect logout")
					}
					logouts.Add(1)
					if mode == "logout-fails" {
						http.Error(w, "fixture-token", 500)
						return
					}
					fmt.Fprint(w, `{}`)
				default:
					t.Error("unexpected upstream route", r.URL.Path)
				}
			}))
			defer upstream.Close()
			pin := sha256.Sum256(upstream.Certificate().Raw)
			s, _ := testServer(t)
			s.cfg.GLURL, s.cfg.GLUsername, s.cfg.GLPassword = upstream.URL, "admin", "fixture-password"
			s.cfg.GLCertificateSHA256 = hex.EncodeToString(pin[:])
			s.cfg.Timeout = 200 * time.Millisecond
			if mode == "bad-pin" {
				s.cfg.GLCertificateSHA256 = strings.Repeat("0", 64)
			}
			cookie, _ := login(t, s)
			if w := request(s, "GET", "/api/devices/default/glkvm/status", "", nil, "", ""); w.Code != 401 {
				t.Fatal("unauthenticated probe allowed")
			}
			started := time.Now()
			w := request(s, "GET", "/api/devices/default/glkvm/status", "", cookie, "", "")
			want := 502
			if mode == "ok" {
				want = 200
			}
			if w.Code != want || strings.Contains(w.Body.String(), "fixture-") {
				t.Fatal(w.Code, w.Body.String())
			}
			if time.Since(started) > time.Second {
				t.Fatal("probe exceeded timeout bound")
			}
			loggedIn := mode == "ok" || mode == "check-fails" || mode == "timeout" || mode == "logout-fails"
			if loggedIn != (logouts.Load() == 1) {
				t.Fatal("temporary login cleanup missing", logouts.Load())
			}
			if w := request(s, "GET", "/api/session", "", cookie, "", ""); w.Code != 200 {
				t.Fatal("upstream failure expired app login")
			}
		})
	}
}

func TestVNCConnectionCheck(t *testing.T) {
	for _, banner := range []string{"RFB 003.008\n", "not a server", ""} {
		t.Run(fmt.Sprintf("banner-%q", banner), func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan struct{})
			defer close(done)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				if banner == "" {
					<-done
					return
				}
				_, _ = conn.Write([]byte(banner))
			}()
			host, port, _ := net.SplitHostPort(listener.Addr().String())
			number, _ := strconv.Atoi(port)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			err = checkVNC(ctx, Config{VNCHost: host, VNCPort: number, VNCKind: "generic", VNCTransport: "tcp", VNCPassword: "fixture", Timeout: time.Second})
			if (err == nil) != (banner == "RFB 003.008\n") {
				t.Fatal("unexpected result", err)
			}
		})
	}
}

func TestConsoleCheckAvailabilityAndBusy(t *testing.T) {
	s, _ := testServer(t)
	cookie, _ := login(t, s)
	for _, path := range []string{"vnc/status", "glkvm/status"} {
		if w := request(s, "GET", "/api/devices/default/"+path, "", cookie, "", ""); w.Code != 409 {
			t.Fatal(w.Code)
		}
	}
	s.cfg.GLURL = "http://127.0.0.1:1"
	s.glCheckGate <- struct{}{}
	if w := request(s, "GET", "/api/devices/default/glkvm/status", "", cookie, "", ""); w.Code != 409 {
		t.Fatal(w.Code)
	}
}
