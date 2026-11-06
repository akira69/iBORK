package meter

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHomeAssistant(t *testing.T) {
	now := time.Unix(1800000000, 0)
	const entity = "sensor.outlet_power"
	stamp := now.Format(time.RFC3339)
	body := func(id, state, class, unit, at string) string {
		return fmt.Sprintf(`{"entity_id":%q,"state":%q,"attributes":{"device_class":%q,"unit_of_measurement":%q},"last_reported":%q}`, id, state, class, unit, at)
	}
	for _, tc := range []struct {
		name, response string
		status         int
		watts          float64
		ok             bool
	}{
		{"kilowatts", body(entity, "0.042", "power", "kW", stamp), 200, 42, true},
		{"zero", body(entity, "0", "power", "W", stamp), 200, 0, true},
		{"stale", body(entity, "42", "power", "W", now.Add(-151*time.Second).Format(time.RFC3339)), 200, 0, false},
		{"future", body(entity, "42", "power", "W", now.Add(time.Second).Format(time.RFC3339)), 200, 0, false},
		{"missing timestamp", body(entity, "0", "power", "W", ""), 200, 0, false},
		{"energy", body(entity, "42", "energy", "kWh", stamp), 200, 0, false},
		{"switch", body("switch.outlet", "on", "", "", stamp), 200, 0, false},
		{"wrong unit", body(entity, "42", "power", "VA", stamp), 200, 0, false},
		{"missing unit", body(entity, "42", "power", "", stamp), 200, 0, false},
		{"cumulative", strings.Replace(body(entity, "42", "power", "W", stamp), `"attributes":{`, `"attributes":{"state_class":"total_increasing",`, 1), 200, 0, false},
		{"wrong entity", body("sensor.other", "42", "power", "W", stamp), 200, 0, false},
		{"unknown", body(entity, "unknown", "power", "W", stamp), 200, 0, false},
		{"unavailable", body(entity, "unavailable", "power", "W", stamp), 200, 0, false},
		{"nan", body(entity, "NaN", "power", "W", stamp), 200, 0, false},
		{"too large", body(entity, "66", "power", "kW", stamp), 200, 0, false},
		{"restored", strings.Replace(body(entity, "42", "power", "W", stamp), `"attributes":{`, `"attributes":{"restored":true,`, 1), 200, 0, false},
		{"unauthorized", "", 401, 0, false}, {"missing entity", "", 404, 0, false},
		{"oversized", strings.Repeat(" ", 256*1024) + body(entity, "0", "power", "W", stamp), 200, 0, false},
		{"redirect", "", 307, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.RequestURI() != "/api/states/"+entity || r.Header.Get("Authorization") != "Bearer test-token" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL)
				}
				if tc.status == 307 {
					w.Header().Set("Location", "/unexpected")
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.response)
			}))
			defer server.Close()
			h, err := NewHomeAssistant(server.URL, entity, "test-token")
			if err != nil {
				t.Fatal(err)
			}
			h.client.Transport = server.Client().Transport
			current := now
			h.now = func() time.Time { return current }
			got, err := h.Read(t.Context())
			if (err == nil) != tc.ok || (tc.ok && (got.Watts != tc.watts || got.At != now.Unix())) {
				t.Fatalf("got %+v, %v", got, err)
			}
			if tc.ok {
				current = current.Add(151 * time.Second)
				if _, err = h.Read(t.Context()); err == nil {
					t.Fatal("reading cached data refreshed it")
				}
			}
		})
	}
}

func TestHomeAssistantTLSAndTimeout(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	h, err := NewHomeAssistant(server.URL, "sensor.outlet", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.Read(t.Context()); err == nil {
		t.Fatal("accepted untrusted TLS server")
	}
	h.client.Transport = server.Client().Transport
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err = h.Read(ctx); err == nil || ctx.Err() == nil {
		t.Fatalf("timeout: %v", err)
	}
	for _, bad := range []string{"http://127.0.0.1", "https://token@host", "https://host/path", "https://host/?q", "https://host:65536", "https://host/#fragment"} {
		if err := ValidateHomeAssistant(bad, "sensor.test"); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if _, err := NewHomeAssistant("https://ha", "sensor.ok", ""); err == nil {
		t.Error("missing token accepted")
	}
	for _, id := range []string{"switch.plug", "sensor.foo/bar", "sensor.", "sensor.A"} {
		if err := ValidateHomeAssistant("https://host", id); err == nil {
			t.Errorf("accepted %q", id)
		}
	}
}
