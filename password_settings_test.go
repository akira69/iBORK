package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestAppPasswordPersistence(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "settings")
	original, _ := bcrypt.GenerateFromPassword([]byte("original test password"), bcrypt.MinCost)
	initial := filepath.Join(t.TempDir(), "initial-hash")
	if err := os.WriteFile(initial, original, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_PASSWORD_HASH_FILE", initial)
	if got, err := appPasswordHash(dir); err != nil || got != string(original) {
		t.Fatal("initial hash unavailable")
	}
	replacement, _ := bcrypt.GenerateFromPassword([]byte("replacement test password"), bcrypt.MinCost)
	if err := saveAppPasswordHash(dir, string(replacement)); err != nil {
		t.Fatal(err)
	}
	if got, err := appPasswordHash(dir); err != nil || got != string(replacement) {
		t.Fatal("saved hash not loaded")
	}
	if err := saveAppPasswordHash(dir, string(original)); err != nil {
		t.Fatal("could not replace existing hash", err)
	}
	if err := saveAppPasswordHash(dir, string(replacement)); err != nil {
		t.Fatal("could not replace existing hash again", err)
	}
	info, err := os.Stat(filepath.Join(dir, "app-password-hash"))
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("hash permissions")
	}
	if err := saveAppPasswordHash(dir, "plaintext password"); err == nil {
		t.Fatal("plaintext accepted")
	}
	if got, _ := appPasswordHash(dir); got != string(replacement) {
		t.Fatal("failed save overwrote hash")
	}
	if got, _ := os.ReadFile(initial); string(got) != string(original) {
		t.Fatal("bootstrap credential changed")
	}
	files, _ := os.ReadDir(dir)
	for _, file := range files {
		if strings.HasPrefix(file.Name(), ".settings-") {
			t.Fatal("temporary hash left behind")
		}
	}
	if err := os.Remove(filepath.Join(dir, "app-password-hash")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "app-password-hash"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveAppPasswordHash(dir, string(original)); err == nil {
		t.Fatal("rename failure ignored")
	}
	if _, err := appPasswordHash(dir); err == nil {
		t.Fatal("unreadable saved hash fell back to bootstrap")
	}
}

func TestPanelPINPersistenceAndBootstrapReset(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "settings")
	original, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := bcrypt.GenerateFromPassword([]byte("000001"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	load := func(bootstrap, want string) {
		t.Helper()
		if got, err := panelPINHash(dir, bootstrap); err != nil || got != want {
			t.Fatal("unexpected saved PIN", err)
		}
	}
	load(string(original), string(original))
	if err := savePanelPINHash(dir, string(original), string(rotated)); err != nil {
		t.Fatal(err)
	}
	load(string(original), string(rotated))
	if err := savePanelPINHash(dir, string(original), "654321"); err == nil {
		t.Fatal("saved a plaintext PIN")
	}
	load(string(original), string(rotated))
	load("", "")
	reset, err := bcrypt.GenerateFromPassword([]byte("555555"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	load(string(reset), string(reset))
	path := filepath.Join(dir, panelPINFile)
	info, err := os.Stat(path)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("PIN hash permissions")
	}
	if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := panelPINHash(dir, string(original)); err == nil {
		t.Fatal("corrupt record silently restored bootstrap PIN")
	}
}
