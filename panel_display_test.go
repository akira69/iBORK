package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/server"
	"golang.org/x/crypto/bcrypt"
)

func TestPanelDisplayFileRoundTrip(t *testing.T) {
	dir, token := t.TempDir(), strings.Repeat("ab", 32)
	hash, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	start := func() *server.Server {
		t.Helper()
		app, err := server.NewEmpty(server.Config{Origin: "https://localhost", PasswordHash: string(hash), Timeout: time.Second}, http.NotFoundHandler())
		if err != nil {
			t.Fatal(err)
		}
		if err := app.EnablePanel(token, string(hash), nil); err != nil {
			t.Fatal(err)
		}
		if err := configureStoredSetting(dir, "panel-display.json", 4096, app.SetPanelDisplay); err != nil {
			t.Fatal(err)
		}
		return app
	}
	request := func(app *server.Server, method, path, body string) string {
		t.Helper()
		r := httptest.NewRequest(method, "https://localhost/api/v1/panel"+path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		return w.Body.String()
	}
	const periods = `"periods":[{"start":1,"brightness":3},{"start":2,"brightness":55},{"start":3,"brightness":99},{"start":4,"brightness":0}]`
	request(start(), "PUT", "/display", `{"pin":"123456","revision":1,`+periods+`}`)
	restarted := start()
	if body := request(restarted, "GET", "", ""); !strings.Contains(body, `"displaySchedule":{"revision":2,`+periods+`}`) {
		t.Fatal("fresh server did not restore saved schedule", body)
	}
	path := filepath.Join(dir, "panel-display.json")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := configureStoredSetting(dir, "panel-display.json", 4096, restarted.SetPanelDisplay); err == nil {
		t.Fatal("corrupt file accepted")
	}
	if err := os.WriteFile(path, []byte(strings.Repeat(" ", 4096)+`{"revision":2,`+periods+`}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := configureStoredSetting(dir, "panel-display.json", 4096, restarted.SetPanelDisplay); err == nil {
		t.Fatal("oversized file accepted")
	}
}
