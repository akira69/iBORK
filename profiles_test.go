package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadProfilesValidatesAndKeepsSecretsOutOfErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devices.json")
	for _, text := range []string{`[]`, `[{"id":"bad/id","host":"192.0.2.1"}]`, `[{"id":"one","host":"192.0.2.1"},{"id":"two","host":"192.0.2.1"}]`, `[{"id":"one","host":"192.0.2.1","password":"DO-NOT-EXPOSE"}]`} {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := readProfiles(path)
		if err == nil || strings.Contains(err.Error(), "DO-NOT-EXPOSE") {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(path, []byte(`[{"id":"rack-a","name":"Rack A","host":"192.0.2.1"},{"id":"rack-b","host":"192.0.2.2","jetUrl":"http://192.0.2.3"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	profiles, err := readProfiles(path)
	if err != nil || len(profiles) != 2 || profiles[0].Port != 623 || profiles[0].Username != "ADMIN" || profiles[0].JetURL != "" {
		t.Fatal(profiles, err)
	}
}

func TestReadVNCProfiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "devices.json")
	for _, fields := range []string{`"vncPort":-1`, `"vncPort":65536`, `"vncPort":5901`, `"vncPasswordFile":"secret"`, `"vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"bad"`} {
		_ = os.WriteFile(path, []byte(`[{"id":"dell","host":"192.0.2.1",`+fields+`}]`), 0600)
		if _, err := readProfiles(path); err == nil {
			t.Fatal("invalid VNC profile accepted")
		}
	}
	pin := strings.Repeat("a", 64)
	_ = os.WriteFile(path, []byte(`[{"id":"dell","host":"192.0.2.1","vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"`+pin+`"}]`), 0600)
	profiles, err := readProfiles(path)
	if err != nil || profiles[0].VNCPort != 5901 || profiles[0].VNCCertificateSHA256 != pin {
		t.Fatal("valid VNC profile rejected", err)
	}
}
