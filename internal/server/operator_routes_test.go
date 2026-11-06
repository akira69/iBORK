package server

import "testing"

func TestOperatorRouteAuthorization(t *testing.T) {
	s, p := testServer(t)
	for _, path := range []string{"cooling", "sol", "diagnostics"} {
		method := "GET"
		if path == "diagnostics" {
			method = "POST"
		}
		if w := request(s, method, "/api/devices/default/"+path, `{"command":"help"}`, nil, "", "http://localhost:8080"); w.Code != 401 {
			t.Fatal(path, w.Code)
		}
	}
	cookie, csrf := login(t, s)
	for _, path := range []string{"/api/sol", "/api/devices/default/sol"} {
		if w := request(s, "GET", path, "", cookie, "", "http://evil.invalid"); w.Code != 403 {
			t.Fatal(path, w.Code)
		}
	}
	if w := request(s, "POST", "/api/devices/default/diagnostics", `{"command":"help"}`, cookie, "bad", "http://localhost:8080"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/devices/default/diagnostics", `{"command":"power off"}`, cookie, csrf, "http://localhost:8080"); w.Code != 400 || p.calls != 0 {
		t.Fatal("mutation allowed", w.Code)
	}
	if w := request(s, "POST", "/api/devices/default/diagnostics", `{"command":"sensor list"}`, cookie, csrf, "http://localhost:8080"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(s, "GET", "/api/devices/missing/cooling", "", cookie, "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
