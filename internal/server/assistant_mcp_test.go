package server

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/assistant"
)

func TestMCPExternalPair(t *testing.T) {
	s, _ := testServer(t)
	c, csrf := login(t, s)
	host := httptest.NewTLSServer(s)
	defer host.Close()
	s.cfg.Origin = host.URL
	browser := func(action, body string) *http.Response {
		req, _ := http.NewRequest("POST", host.URL+"/api/assistant/"+action, strings.NewReader(body))
		req.AddCookie(c)
		req.Header.Set("X-CSRF-Token", csrf)
		req.Header.Set("Origin", host.URL)
		req.Header.Set("Content-Type", "application/json")
		res, err := host.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		if res.StatusCode != 200 {
			t.Fatal(res.Status)
		}
		return res
	}
	browser("scope", `{"scope":"10.1.2.3"}`)
	var pair struct{ Token string }
	if json.NewDecoder(browser("pair", "{}").Body).Decode(&pair) != nil || len(pair.Token) != 64 {
		t.Fatal("pair")
	}
	rpc := func(method string, params any, origin string) (int, string) {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		req, _ := http.NewRequest("POST", host.URL+"/api/assistant/mcp", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+pair.Token)
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := host.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(out)
	}
	if code, _ := rpc("ping", nil, "https://outside.invalid"); code != 403 {
		t.Fatal(code)
	}
	_, list := rpc("tools/list", nil, "")
	for _, tool := range assistant.Tools {
		if !strings.Contains(list, tool.Name) {
			t.Fatal(list)
		}
	}
	_, status := rpc("tools/call", map[string]any{"name": "setup_status"}, "")
	if !strings.Contains(status, "10.1.2.3") {
		t.Fatal(status)
	}
	_, blocked := rpc("tools/call", map[string]any{"name": "power_cycle"}, "")
	if !strings.Contains(blocked, `"isError":true`) {
		t.Fatal(blocked)
	}
	_, layout := rpc("tools/call", map[string]any{"name": "propose_layout", "arguments": map[string]string{"source": "default", "target": "default"}}, "")
	if !strings.Contains(layout, `"isError":false`) {
		t.Fatal(layout)
	}
	if path := os.Getenv("IBORK_TEST_MCP_CLIENT"); path != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path)
		cmd.Env = append(os.Environ(), "IBORK_MCP_URL="+host.URL+"/api/assistant/mcp", "IBORK_MCP_TOKEN="+pair.Token, "IBORK_TEST_CERT="+string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: host.Certificate().Raw})))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		} else {
			t.Log(string(out))
		}
	}
	browser("revoke", "{}")
	if code, _ := rpc("tools/list", nil, ""); code != 401 {
		t.Fatal(code)
	}
}
