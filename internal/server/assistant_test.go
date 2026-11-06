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
	var calls int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			reply(w, 200, map[string]any{"data": []any{map[string]string{"id": "fake"}}})
			return
		}
		var input struct {
			Messages []assistant.Message
			Tools    []any
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		calls++
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
	if w := route("chat", `{"message":"private","revision":"old"}`); w.Code != 409 || calls != 2 {
		t.Fatal("stale provider used")
	}
	if w := route("chat", `{"message":"status","language":"en","revision":"`+revision+`"}`); w.Code != 200 || !strings.Contains(w.Body.String(), "Found fixture scope") || calls != 4 {
		t.Fatal(calls, w.Body.String())
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
