package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akira69/iBORK/internal/assistant"
)

func TestAssistedJetReviewAndRetry(t *testing.T) {
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/device" {
			t.Error("unexpected device operation")
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(200)
	}))
	defer fixture.Close()
	s, _ := testServer(t)
	store := &fakeSettings{}
	s.SetDeviceSettings(store, func() {})
	c, csrf := login(t, s)
	a := &s.sessions[c.Value].assistant
	s.initGrant(a)
	a.grant.Candidates = append(a.grant.Candidates, assistant.Candidate{ID: "test-kvm", Kind: "kvm", Address: strings.TrimPrefix(fixture.URL, "http://")})
	_, err := a.grant.Call(context.Background(), "propose_server", []byte(`{"name":"Vault","kvm":"test-kvm"}`))
	if err != nil {
		t.Fatal(err)
	}
	id := a.grant.Draft.ID
	password := ""
	input := DeviceSettings{Name: "Vault", JetURL: fixture.URL, JetPassword: &password}
	save := func(id string) int {
		data, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", s.cfg.Origin+"/api/assistant/apply", strings.NewReader(string(data)))
		r.AddCookie(c)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", s.cfg.Origin)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("X-Assistant-Draft", id)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if save("stale") != 409 || store.calls != 0 {
		t.Fatal("stale draft applied")
	}
	if save(id) != 200 || store.calls != 1 {
		t.Fatal("reviewed proposal wasn't saved")
	}
	if save(id) == 200 || store.calls != 1 {
		t.Fatal("replayed save")
	}
}
