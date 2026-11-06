package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/akira69/iBORK/internal/management"
)

type diagnosticProvider struct {
	fakeProvider
	err   error
	wait  bool
	reads int
}

func (p *diagnosticProvider) Power(ctx context.Context) (management.PowerState, error) {
	p.reads++
	if p.wait {
		<-ctx.Done()
		return management.PowerState{}, ctx.Err()
	}
	return management.PowerState{State: "on"}, p.err
}
func (*diagnosticProvider) Inventory(context.Context) (management.Inventory, error) {
	return management.Inventory{Fields: map[string]string{"large": strings.Repeat("界", diagnosticLimit)}}, nil
}
func (*diagnosticProvider) Cooling(context.Context) (management.CoolingState, error) {
	return management.CoolingState{ModeCode: "0x03", ModeLabel: "Unknown", QuerySupported: true}, nil
}
func diagnosticRequest(s *Server, ctx context.Context, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/diagnostics", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.serveDiagnostics(w, r, ctx)
	return w
}
func TestDiagnosticsRejectsCommandsAndMalformedBodies(t *testing.T) {
	s, _ := testServer(t)
	p := &diagnosticProvider{}
	s.provider = p
	for _, command := range []string{"", "raw 0x30 0x45 0", "power off", "sel clear", "power status; whoami", "power status\n", "power status | cat", "$(id)", "power status -H other", "-U admin -P secret", "ipmitool power status", "sensor\tlist"} {
		body, _ := json.Marshal(map[string]string{"command": command})
		if w := diagnosticRequest(s, context.Background(), string(body)); w.Code != 400 {
			t.Fatal(command, w.Code)
		}
	}
	for _, body := range []string{`{`, `{"command":"help","host":"other"}`, `{"command":"help"} {}`, strings.Repeat("a", 5000)} {
		if w := diagnosticRequest(s, context.Background(), body); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	if p.reads != 0 || p.calls != 0 {
		t.Fatal("rejected command reached provider")
	}
}
func TestDiagnosticsAllowlistAndOutputLimit(t *testing.T) {
	s, _ := testServer(t)
	s.provider = &diagnosticProvider{}
	for _, command := range []string{"help", "power status", "sensor list", "fru", "inventory", "sel", "events", "dcmi power", "cooling status"} {
		body, _ := json.Marshal(map[string]string{"command": command})
		w := diagnosticRequest(s, context.Background(), string(body))
		var result struct {
			Output    string
			Truncated bool
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal(command, w.Code, w.Body.String())
		}
		if !utf8.ValidString(result.Output) || len(result.Output) > diagnosticLimit {
			t.Fatal("unbounded or invalid output")
		}
		if (command == "fru" || command == "inventory") && !result.Truncated {
			t.Fatal("missing truncation flag")
		}
	}
}
func TestDiagnosticsUnavailableTimeoutAndSanitizedError(t *testing.T) {
	s, _ := testServer(t)
	w := diagnosticRequest(s, context.Background(), `{"command":"cooling status"}`)
	if w.Code != 501 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	s.serveCooling(w, nil, context.Background())
	if w.Code != 501 {
		t.Fatal(w.Code)
	}
	p := &diagnosticProvider{err: errors.New("password secret internal host")}
	s.provider = p
	w = diagnosticRequest(s, context.Background(), `{"command":"power status"}`)
	if w.Code != 502 || strings.Contains(w.Body.String(), "secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	p.wait = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	w = diagnosticRequest(s, ctx, `{"command":"power status"}`)
	if w.Code != 504 {
		t.Fatal(w.Code)
	}
	s.readGate <- struct{}{}
	w = diagnosticRequest(s, ctx, `{"command":"power status"}`)
	<-s.readGate
	if w.Code != 504 {
		t.Fatal(w.Code)
	}
}
