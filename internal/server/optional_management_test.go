package server

import (
	"net/http"
	"testing"
)

func TestKVMOnlyManagementRoutesUnavailable(t *testing.T) {
	primary, _ := testServer(t)
	cfg := primary.cfg
	cfg.DeviceID = "standalone"
	cfg.BMCHost = ""
	cfg.BMCPort = 0
	cfg.BMCUsername = ""
	if err := primary.AddDevice(cfg, nil); err != nil {
		t.Fatal(err)
	}
	cookie, csrf := login(t, primary)
	for _, path := range []string{"power", "energy", "sensors", "inventory", "events", "boot", "events/clear", "cooling", "diagnostics", "sol"} {
		t.Run(path, func(t *testing.T) {
			method := "GET"
			if path == "boot" || path == "events/clear" || path == "diagnostics" {
				method = "POST"
			}
			route := "/api/devices/standalone/" + path
			if w := request(primary, method, route, `{}`, nil, "", cfg.Origin); w.Code != 401 {
				t.Fatal("missing auth guard", w.Code)
			}
			if method == "POST" {
				if w := request(primary, method, route, `{}`, cookie, "wrong", cfg.Origin); w.Code != 403 {
					t.Fatal("missing CSRF guard", w.Code)
				}
			}
			if path == "sol" {
				if w := request(primary, method, route, "", cookie, "", "https://evil.invalid"); w.Code != 403 {
					t.Fatal("missing SOL origin guard", w.Code)
				}
			}
			defer func() {
				if recover() != nil {
					t.Error("nil management provider panicked")
				}
			}()
			w := request(primary, method, route, `{}`, cookie, csrf, cfg.Origin)
			if w.Code != http.StatusConflict {
				t.Fatalf("got %d want 409", w.Code)
			}
		})
	}
}
