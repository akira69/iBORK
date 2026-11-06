package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/assistant"
	"golang.org/x/crypto/bcrypt"
)

func TestAssistantSessionAndProvider(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	origin := s.cfg.Origin
	if err := s.SetAssistantProvider(nil, func([]byte) error { return nil }); err != nil {
		t.Fatal(err)
	}
	route := func(action, body string) *httptest.ResponseRecorder {
		return request(s, "POST", "/api/assistant/"+action, body, c, csrf, origin)
	}
	if route("scope", `{"scope":"8.8.8.8"}`).Code != 400 || route("pair", "{}").Code != 400 {
		t.Fatal("network boundary")
	}
	if route("scope", `{"scope":"10.23.45.67"}`).Code != 200 {
		t.Fatal("scope")
	}
	c2, csrf2 := login(t, s)
	if strings.Contains(request(s, "GET", "/api/assistant/status", "", c2, csrf2, origin).Body.String(), "10.23.45.67") {
		t.Fatal("cross-session scope")
	}
	modelsUsed := make(chan string, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			if r.Method != "GET" {
				t.Error("model catalog requires GET")
			}
			reply(w, 200, map[string]any{"data": []map[string]string{{"id": "fake"}, {"id": "acme/chat:7b"}, {"id": "fake"}, {"id": ""}}})
			return
		}
		var input struct {
			Messages []assistant.Message
			Tools    []any
			Model    string
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		modelsUsed <- input.Model
		msg := assistant.Message{Role: "assistant", Calls: []assistant.Call{{ID: "fixture", Type: "function", Function: assistant.FunctionCall{Name: "setup_status", Arguments: "{}"}}}}
		last := input.Messages[len(input.Messages)-1]
		if last.Role == "tool" {
			if last.CallID != "fixture" || (!strings.Contains(last.Content, "10.23.45.67") && last.Content != `{"status":"ready"}`) {
				t.Error("wrong tool result")
			}
			msg.Calls = nil
			msg.Content = "Found fixture scope"
		}
		reply(w, 200, map[string]any{"choices": []any{map[string]any{"message": msg}}})
	}))
	defer provider.Close()
	body, _ := json.Marshal(assistant.Provider{BaseURL: provider.URL + "/v1", Model: "fake"})
	if w := route("provider", string(body)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_, revision := s.modelProvider()
	catalog := request(s, "GET", "/api/assistant/models", "", c, csrf, origin)
	if catalog.Code != 200 || strings.TrimSpace(catalog.Body.String()) != `{"models":["acme/chat:7b","fake"]}` {
		t.Fatal(catalog.Code, catalog.Body.String())
	}
	if w := route("chat", `{"message":"private","model":"acme/chat:7b","revision":"old"}`); w.Code != 409 || len(modelsUsed) != 2 {
		t.Fatal("stale provider used")
	}
	for _, model := range []string{`null`, `""`, `" "`, `"has\ncontrol"`, `" padded"`, `{}`, `123`, `"` + strings.Repeat("a", 257) + `"`} {
		if w := route("chat", `{"message":"hi","revision":"`+revision+`","model":`+model+`}`); w.Code != 400 {
			t.Fatalf("invalid model %s: %d", model, w.Code)
		}
	}
	if w := route("chat", `{"message":"hi","model":"acme/chat:7b","revision":"`+revision+`"}`); w.Code != 200 || len(modelsUsed) != 4 {
		t.Fatal(len(modelsUsed), w.Body.String())
	}
	if p, current := s.modelProvider(); p.Model != "fake" || current != revision {
		t.Fatal("chat changed saved provider")
	}
	if w := route("chat", `{"message":"status","language":"en","revision":"`+revision+`"}`); w.Code != 200 || !strings.Contains(w.Body.String(), "Found fixture scope") || len(modelsUsed) != 6 {
		t.Fatal(len(modelsUsed), w.Body.String())
	}
	for _, want := range []string{"fake", "fake", "acme/chat:7b", "acme/chat:7b", "fake", "fake"} {
		if got := <-modelsUsed; got != want {
			t.Fatalf("completion model %q, want %q", got, want)
		}
	}
	if w := route("provider", `{"baseUrl":"http://169.254.169.254/v1","model":"bad"}`); w.Code != 400 {
		t.Fatal("failed change overwrote working provider")
	}
	if w := request(s, "POST", "/api/assistant/chat", "{}", c, "", origin); w.Code != 403 {
		t.Fatal("missing CSRF")
	}
	if w := route("apply", `{"name":"unapproved"}`); w.Code != 409 {
		t.Fatal("stale proposal applied")
	}
}

func TestAssistantModelCatalogFailure(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	get := func(cookie *http.Cookie) *httptest.ResponseRecorder {
		return request(s, "GET", "/api/assistant/models", "", cookie, csrf, s.cfg.Origin)
	}
	if w := get(nil); w.Code != 401 {
		t.Fatal("anonymous catalog request", w.Code)
	}
	if w := get(c); w.Code != 400 {
		t.Fatal("missing provider", w.Code)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "private provider detail", 503)
	}))
	defer provider.Close()
	body, _ := json.Marshal(assistant.Provider{BaseURL: provider.URL + "/v1", Model: "fake"})
	if err := s.SetAssistantProvider(body, nil); err != nil {
		t.Fatal(err)
	}
	// Reading the catalog is independent of a chat already in progress.
	a := &s.sessions[c.Value].assistant
	a.mu.Lock()
	defer a.mu.Unlock()
	if w := get(c); w.Code != 502 || !strings.Contains(w.Body.String(), "HTTP 503") || strings.Contains(w.Body.String(), "private") {
		t.Fatal(w.Code, w.Body.String())
	}
}

// Opt-in installed browser and model test. The two synthetic servers have no network-backed providers or approved scan scope.
func TestAssistantLiveBrowser(t *testing.T) {
	profile := os.Getenv("IBORK_ASSISTANT_TEST_PROFILE")
	if profile == "" {
		t.Skip("set IBORK_ASSISTANT_TEST_PROFILE to an ignored local provider profile")
	}
	web, err := filepath.Abs("../../web")
	if err != nil {
		t.Fatal(err)
	}
	password := token()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	host := httptest.NewUnstartedServer(nil)
	origin := "http://" + host.Listener.Addr().String()
	s, err := NewEmpty(Config{Origin: origin, PasswordHash: string(hash), Timeout: time.Second}, http.FileServer(http.Dir(filepath.Join(web, "dist"))))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetAssistantProvider(nil, func([]byte) error { return nil }); err != nil {
		t.Fatal(err)
	}
	s.SetDeviceSettings(&fakeSettings{}, func() {})
	for index, id := range []string{"atlas", "vault"} {
		addr := []string{"192.0.2.1", "192.0.2.2"}[index]
		if err := s.AddDevice(Config{DeviceID: id, ServerName: id, BMCHost: addr, BMCPort: 623, Timeout: time.Second}, &fakeProvider{}); err != nil {
			t.Fatal(err)
		}
	}
	host.Config.Handler = s
	host.Start()
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "tests/live/assistant.mjs")
	cmd.Dir = web
	cmd.Env = append(os.Environ(), "IBORK_TEST_ORIGIN="+origin, "IBORK_TEST_PASSWORD="+password)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, output)
	} else {
		t.Log(string(output))
	}
}
