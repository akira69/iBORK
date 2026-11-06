package glances

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSyntheticSensors(t *testing.T) {
	fixture, err := os.ReadFile("testdata/synthetic-sensors.json")
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/api/4/sensors" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("unexpected Glances request")
		}
		_, _ = w.Write(fixture)
	}))
	defer upstream.Close()
	c, err := New(upstream.URL+"/", "fixture-token", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Sensors(t.Context()); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	c.http.Transport = upstream.Client().Transport
	readings, err := c.Sensors(t.Context())
	if err != nil || len(readings) != 7 {
		t.Fatalf("read %d sensors: %v", len(readings), err)
	}
	ids := make(map[string]bool)
	for _, s := range readings {
		if ids[s.ID] {
			t.Fatalf("sensor ID collision for %q", s.Name)
		}
		ids[s.ID] = true
		switch s.Name {
		case "Core 0", "Package id 0":
			if s.DetailOnly || s.State != "ok" || s.Unit != "degrees C" || s.Warning == nil || *s.Warning != 80 || s.Critical == nil || *s.Critical != 100 {
				t.Fatal(s)
			}
		case "Exhaust", "drivetemp 0":
			if s.DetailOnly || s.Warning != nil || s.Critical != nil || (s.Name == "Exhaust" && (s.Unit != "RPM" || s.Value != "1500")) || (s.Name == "drivetemp 0" && s.Value != "35") {
				t.Fatal(s)
			}
		default:
			if !s.DetailOnly || s.State != "unmapped" {
				t.Fatal(s)
			}
		}
	}
}

func TestGlancesOriginAndDeadline(t *testing.T) {
	for _, origin := range []string{"", "http://lan", "file://host", "https://user:pass@host", "https://host/path", "https://host?", "https://host#", "https://host:65536", "https://host:"} {
		if _, err := New(origin, "", time.Second); err == nil {
			t.Errorf("accepted %q", origin)
		}
	}
	for _, origin := range []string{"http://localhost:61208", "http://[::1]", "https://lan/"} {
		if err := ValidateURL(origin); err != nil {
			t.Error(origin, err)
		}
	}
	if _, err := New("http://127.0.0.1", "secret", time.Second); err == nil {
		t.Error("allowed plaintext token")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer upstream.Close()
	c, err := New(upstream.URL, "", 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Sensors(t.Context()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline ignored: %v", err)
	}
}

func TestIndistinguishableSensorsCannotBePinnedByLabel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"label":"Core 0","type":"temperature_core","unit":"C","value":40},{"label":"Package id 0","type":"temperature_core","unit":"C","value":55},{"label":"Core 0","type":"temperature_core","unit":"C","value":90}]`)
	}))
	defer upstream.Close()
	c, err := New(upstream.URL, "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	readings, err := c.Sensors(t.Context())
	if err != nil || len(readings) != 3 {
		t.Fatal(readings, err)
	}
	if readings[0].ID != "" || readings[2].ID != "" || readings[1].ID != "temperature_core:Package id 0" || readings[0].Value != "40" || readings[2].Value != "90" {
		t.Fatal(readings)
	}
}

func TestGlancesUpstreamErrors(t *testing.T) {
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { followed.Store(true) }))
	defer target.Close()
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"outage", 503, "agent unavailable"},
		{"unauthorized", 401, "unauthorized"},
		{"redirect", 302, ""},
		{"truncated", 200, "[{"},
		{"trailing", 200, "[] []"},
		{"null", 200, "null"},
		{"oversize", 200, "[]" + strings.Repeat(" ", 256*1024)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer upstream.Close()
			c, err := New(upstream.URL, "", time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := c.Sensors(t.Context()); err == nil || followed.Load() {
				t.Fatal("accepted invalid response or followed redirect", err)
			}
		})
	}
}

func TestTemperatureThresholdsWithoutFan(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `[{"label":"Core 0","type":"temperature_core","unit":"C","value":87,"warning":87,"critical":105},{"label":"Core 1","type":"temperature_core","unit":"C","value":105,"warning":87,"critical":105},{"label":"Core 2","type":"temperature_core","unit":"C","value":null}]`)
	}))
	defer upstream.Close()
	c, err := New(upstream.URL, "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Sensors(t.Context())
	if err != nil || len(got) != 3 || got[0].State != "warning" || got[1].State != "critical" || got[2].State != "unavailable" {
		t.Fatalf("readings %v, err %v", got, err)
	}
}
