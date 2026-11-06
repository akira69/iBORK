package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/akira69/iBORK/internal/server"
)

func TestDeviceSettingsPersistence(t *testing.T) {
	dir := t.TempDir()
	store := &profileStore{dir: dir}
	password := "private-test-password"
	input := server.DeviceSettings{Name: "Rack two", Host: "192.0.2.2", Port: 623, Username: "ADMIN", Password: &password}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	profiles, err := readProfiles(filepath.Join(dir, "devices.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].Host != input.Host || profiles[0].JetURL != "" {
		t.Fatal(profiles)
	}
	secret, err := fileSecret(profiles[0].PasswordFile)
	if err != nil || secret != password {
		t.Fatal("secret not persisted")
	}
	data, _ := json.Marshal(store.List())
	if strings.Contains(string(data), password) || strings.Contains(string(data), "passwordFile") {
		t.Fatal("secret exposed")
	}
	if info, _ := os.Stat(profiles[0].PasswordFile); info == nil {
		t.Fatal("secret file missing")
	}
	store.pending = false
	input.ID = profiles[0].ID
	input.Password = nil
	input.Name = "Renamed"
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	store.pending = false
	input.Host = "192.0.2.3"
	if err := store.Save(input); err == nil {
		t.Fatal("credentials reused across endpoints")
	}
	input.Host = "192.0.2.2"
	input.ID = ""
	if err := store.Save(input); err == nil {
		t.Fatal("duplicate endpoint accepted")
	}
	input.ID = profiles[0].ID
	rotated := "new-private-test-password"
	input.Password = &rotated
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(profiles[0].PasswordFile); !os.IsNotExist(err) {
		t.Fatal("superseded credential retained")
	}
	store.pending = false
	before := store.profiles[0].PasswordFile
	if err := os.Remove(filepath.Join(dir, "devices.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "devices.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(input); err == nil {
		t.Fatal("manifest replacement failure accepted")
	}
	if _, err := os.Stat(before); err != nil {
		t.Fatal("failed save removed active credential")
	}
}

func TestDeviceSettingsRejectsInvalidAndFailedWrites(t *testing.T) {
	for _, password := range []string{"\r\n", "secret\n"} {
		store := &profileStore{dir: t.TempDir()}
		if err := store.Save(server.DeviceSettings{Name: "Test", Host: "192.0.2.2", Port: 623, Username: "ADMIN", Password: &password}); err == nil {
			t.Fatal("unrepresentable password accepted")
		}
	}
	for _, host := range []string{"", "http://192.0.2.2", "localhost/path", "bad host"} {
		store := &profileStore{dir: t.TempDir()}
		password := "test"
		if err := store.Save(server.DeviceSettings{Name: "Bad", Host: host, Port: 623, Username: "ADMIN", Password: &password}); err == nil {
			t.Fatal(host)
		}
		if len(store.List()) != 0 {
			t.Fatal("failed save changed state")
		}
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "file")
	_ = os.WriteFile(file, []byte("blocked"), 0600)
	store := &profileStore{dir: file}
	password := "test"
	if err := store.Save(server.DeviceSettings{Name: "Test", Host: "192.0.2.2", Port: 623, Username: "ADMIN", Password: &password}); err == nil {
		t.Fatal("failed write accepted")
	}
	if len(store.List()) != 0 {
		t.Fatal("failed write changed state")
	}
}

func TestSettingsPreserveVNCOnlyForSameHost(t *testing.T) {
	dir := t.TempDir()
	secret, err := writeProtected(dir, []byte("VncTest1"))
	if err != nil {
		t.Fatal(err)
	}
	store := &profileStore{dir: dir, profiles: []deviceProfile{{ID: "dell", Name: "Dell", Host: "192.0.2.1", Port: 623, Username: "root", PasswordFile: "imported", VNCPort: 5901, VNCPasswordFile: secret, VNCCertificateSHA256: strings.Repeat("a", 64)}}}
	input := server.DeviceSettings{ID: "dell", Name: "Renamed", Host: "192.0.2.1", Port: 623, Username: "root"}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	if store.profiles[0].VNCPort != 5901 || store.profiles[0].VNCPasswordFile != secret {
		t.Fatal("VNC lost on ordinary save")
	}
	if _, err := os.Stat(secret); err != nil {
		t.Fatal("referenced VNC secret removed")
	}
	store.pending = false
	password := "new-host-password"
	input.Host, input.Password = "192.0.2.2", &password
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	p := store.profiles[0]
	if p.VNCPort != 0 || p.VNCPasswordFile != "" || p.VNCCertificateSHA256 != "" {
		t.Fatal("VNC credentials reused for changed host")
	}
	if _, err := os.Stat(secret); !os.IsNotExist(err) {
		t.Fatal("obsolete owned VNC credential retained")
	}
}

func TestKGKeyProtectedLifecycle(t *testing.T) {
	dir := t.TempDir()
	store := &profileStore{dir: dir}
	password, key := "fixture-password", strings.Repeat("a1", 20)
	input := server.DeviceSettings{Name: "Dell", Host: "192.0.2.1", Port: 623, Username: "root", Password: &password, KGKey: &key}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	p := store.profiles[0]
	actual, err := fileSecret(p.KGKeyFile)
	if err != nil || actual != key {
		t.Fatal("KG key was not saved separately")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(p.KGKeyFile)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("KG file permissions are not 0600")
		}
	}
	data, _ := json.Marshal(store.List())
	if strings.Contains(string(data), key) || strings.Contains(string(data), `"kgKey":`) {
		t.Fatal("KG key exposed")
	}
	if store.List()[0].KGKeyLocation != p.KGKeyFile {
		t.Fatal("protected location not shown")
	}
	manifest, _ := os.ReadFile(filepath.Join(dir, "devices.json"))
	if strings.Contains(string(manifest), key) {
		t.Fatal("key in manifest")
	}
	store.pending = false
	input.ID, input.Password, input.KGKey = p.ID, nil, nil
	if err = store.Save(input); err != nil || store.profiles[0].KGKeyFile != p.KGKeyFile {
		t.Fatal("ordinary save lost key")
	}
	store.pending = false
	input.Host, input.Password = "192.0.2.2", &password
	if err = store.Save(input); err == nil {
		t.Fatal("key silently reused for another BMC")
	}
	input.Host = "192.0.2.1"
	empty := ""
	input.KGKey = &empty
	if err = store.Save(input); err != nil || store.profiles[0].KGKeyFile != "" {
		t.Fatal("key removal failed")
	}
	if _, err = os.Stat(p.KGKeyFile); !os.IsNotExist(err) {
		t.Fatal("superseded managed key retained")
	}
	store.pending = false
	invalid := "sensitive-invalid-key"
	input.KGKey = &invalid
	if err = store.Save(input); err == nil || strings.Contains(err.Error(), invalid) {
		t.Fatal("invalid key accepted or echoed")
	}
	input.KGKey = nil
	input.KGKeyLocation = "/etc/shadow"
	if err = store.Save(input); err == nil {
		t.Fatal("browser-controlled key path accepted")
	}
}
