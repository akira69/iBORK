package main

import (
	"encoding/json"
	"github.com/akira69/iBORK/internal/server"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConsoleSettingsRoundTrip(t *testing.T) {
	for _, kind := range []string{"jet", "dell", "generic", "glinet"} {
		t.Run(kind, func(t *testing.T) {
			store := &profileStore{dir: t.TempDir()}
			password, pin, port, gl := "testpass", strings.Repeat("a", 64), 5900, "https://192.0.2.3"
			input := server.DeviceSettings{Name: "Console"}
			switch kind {
			case "jet":
				input.JetURL, input.JetPassword = "http://192.0.2.1", &password
			case "dell", "generic":
				input.VNCHost, input.VNCKind, input.VNCPort, input.VNCCertificateSHA256, input.VNCPassword = "192.0.2.2", kind, &port, pin, &password
			case "glinet":
				input.GLURL, input.GLUsername, input.GLCertificateSHA256, input.GLPassword = &gl, "admin", pin, &password
			}
			if err := store.Save(input); err != nil {
				t.Fatal(err)
			}
			first := store.profiles[0]
			store.pending = false
			listed := store.List()[0]
			data, _ := json.Marshal(listed)
			if strings.Contains(string(data), password) || strings.Contains(string(data), "PasswordFile") {
				t.Fatal("credential exposed")
			}
			listed.Name = "Renamed"
			if err := store.Save(listed); err != nil {
				t.Fatal(err)
			}
			if p := store.profiles[0]; p.JetPasswordFile != first.JetPasswordFile || p.VNCPasswordFile != first.VNCPasswordFile || p.GLPasswordFile != first.GLPasswordFile {
				t.Fatal("ordinary edit replaced secrets")
			}
			store.pending = false
			switch kind {
			case "jet":
				listed.JetURL = "http://192.0.2.9"
			case "dell", "generic":
				listed.VNCHost = "192.0.2.9"
			case "glinet":
				changed := "https://192.0.2.9"
				listed.GLURL = &changed
			}
			if err := store.Save(listed); err == nil {
				t.Fatal("credentials reused for changed endpoint")
			}
		})
	}
}

func TestConsoleSettingsFailedSaveRetainsSecrets(t *testing.T) {
	store := &profileStore{dir: t.TempDir()}
	password := "test-secret"
	if err := store.Save(server.DeviceSettings{Name: "Jet", JetURL: "http://192.0.2.1", JetPassword: &password}); err != nil {
		t.Fatal(err)
	}
	old := store.profiles[0].JetPasswordFile
	store.pending = false
	path := filepath.Join(store.dir, "devices.json")
	os.Remove(path)
	os.Mkdir(path, 0700)
	before, _ := filepath.Glob(filepath.Join(store.dir, ".settings-*"))
	input := store.List()[0]
	input.JetPassword = &password
	if err := store.Save(input); err == nil {
		t.Fatal("failed replacement accepted")
	}
	after, _ := filepath.Glob(filepath.Join(store.dir, ".settings-*"))
	if len(before) != len(after) {
		t.Fatal("staged secret leaked")
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("existing secret removed")
	}
}

func TestRemoveStandaloneConsole(t *testing.T) {
	dir := t.TempDir()
	imported := filepath.Join(dir, "imported")
	os.WriteFile(imported, []byte("test-secret"), 0600)
	store := &profileStore{dir: filepath.Join(dir, "settings"), profiles: []deviceProfile{{ID: "jet", Name: "Jet", JetURL: "http://192.0.2.1", JetPasswordFile: imported}}}
	if err := store.Remove("missing"); err == nil {
		t.Fatal("missing accepted")
	}
	if err := store.Remove("jet"); err != nil {
		t.Fatal(err)
	}
	if len(store.List()) != 0 {
		t.Fatal("device retained")
	}
	data, err := os.ReadFile(filepath.Join(store.dir, "devices.json"))
	if err != nil || strings.TrimSpace(string(data)) != "[]" {
		t.Fatalf("empty inventory not persisted: %q %v", data, err)
	}
	if _, err := os.Stat(imported); err != nil {
		t.Fatal("imported secret deleted")
	}
	store = &profileStore{dir: t.TempDir(), profiles: []deviceProfile{{ID: "ipmi", Host: "192.0.2.2"}}}
	if err := store.Remove("ipmi"); err == nil {
		t.Fatal("management server removed")
	}
}

func TestConsoleSettingsTrustChangesRequireCredentials(t *testing.T) {
	password, pin, port := "testpass", strings.Repeat("a", 64), 5900
	store := &profileStore{dir: t.TempDir()}
	if err := store.Save(server.DeviceSettings{Name: "VNC", VNCHost: "192.0.2.2", VNCKind: "generic", VNCPort: &port, VNCCertificateSHA256: pin, VNCPassword: &password}); err != nil {
		t.Fatal(err)
	}
	store.pending = false
	for _, change := range []func(*server.DeviceSettings){
		func(p *server.DeviceSettings) { p.VNCCertificateSHA256 = strings.Repeat("b", 64) },
		func(p *server.DeviceSettings) { p.VNCTransport = "tcp"; p.VNCCertificateSHA256 = "" },
		func(p *server.DeviceSettings) { p.VNCKind = "dell" },
	} {
		input := store.List()[0]
		change(&input)
		if err := store.Save(input); err == nil {
			t.Fatal("trust/provider change reused credentials")
		}
	}
	input := store.List()[0]
	input.VNCTransport = "tcp"
	input.VNCCertificateSHA256 = ""
	input.VNCPassword = &password
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
}
