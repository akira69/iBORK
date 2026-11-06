package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readProfileFixture(t *testing.T, input string) ([]deviceProfile, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "profiles.json")
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	return readProfiles(path)
}

func TestProfilesOptionalManagement(t *testing.T) {
	pin := strings.Repeat("a", 64)
	cases := []struct {
		name, fields string
		valid        bool
	}{
		{"jet", `"jetUrl":"http://kvm.example.test"`, true},
		{"dell", `"vncHost":"idrac.example.test","vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"` + pin + `"`, true},
		{"generic", `"vncHost":"desktop.example.test","vncKind":"generic","vncTransport":"tcp","vncPort":5900,"vncPasswordFile":"secret"`, true},
		{"comet", `"glUrl":"https://comet.example.test","glUsername":"admin","glPasswordFile":"secret","glCertificateSHA256":"` + pin + `"`, true},
		{"empty", `"name":"Empty"`, false},
		{"no-bmc-secret", `"jetUrl":"http://kvm.example.test","passwordFile":"secret"`, false},
		{"no-bmc-key", `"jetUrl":"http://kvm.example.test","kgKeyFile":"secret"`, false},
		{"no-bmc-port", `"jetUrl":"http://kvm.example.test","port":623`, false},
		{"no-bmc-user", `"jetUrl":"http://kvm.example.test","username":"root"`, false},
		{"multiple", `"jetUrl":"http://kvm.example.test","glUrl":"http://comet.example.test","glUsername":"admin","glPasswordFile":"secret"`, false},
		{"url-user", `"jetUrl":"http://user:DO-NOT-EXPOSE@kvm.example.test"`, false},
		{"url-path", `"jetUrl":"http://kvm.example.test/secret"`, false},
		{"comet-pin", `"glUrl":"https://comet.example.test","glPasswordFile":"secret"`, false},
		{"tcp-pin", `"vncHost":"desktop.example.test","vncKind":"generic","vncTransport":"tcp","vncPort":5900,"vncPasswordFile":"secret","vncCertificateSHA256":"` + pin + `"`, false},
		{"dell-tcp", `"vncHost":"idrac.example.test","vncTransport":"tcp","vncPort":5901,"vncPasswordFile":"secret"`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			profiles, err := readProfileFixture(t, `[{"id":"device",`+c.fields+`}]`)
			if (err == nil) != c.valid {
				t.Fatalf("valid=%v error=%v", c.valid, err)
			}
			if err != nil && strings.Contains(err.Error(), "DO-NOT-EXPOSE") {
				t.Fatal("credential in error")
			}
			if c.valid && (profiles[0].Host != "" || profiles[0].Port != 0 || profiles[0].Username != "") {
				t.Fatal("fabricated management configuration")
			}
		})
	}
	var entries []string
	for i := 0; i < 17; i++ {
		entries = append(entries, fmt.Sprintf(`{"id":"kvm-%d","jetUrl":"http://kvm-%d.example.test"}`, i, i))
	}
	if p, e := readProfileFixture(t, "["+strings.Join(entries[:16], ",")+"]"); e != nil || len(p) != 16 {
		t.Fatal("16 standalone consoles rejected", e)
	}
	if _, e := readProfileFixture(t, "["+strings.Join(entries, ",")+"]"); e == nil {
		t.Fatal("17 consoles accepted")
	}
}

func TestProfilesLegacyConsoleDefaults(t *testing.T) {
	p, err := readProfileFixture(t, `[{"id":"dell","host":"192.0.2.5","vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"`+strings.Repeat("a", 64)+`"}]`)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(p[0])
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	for k, want := range map[string]string{"vncHost": "192.0.2.5", "vncKind": "dell", "vncTransport": "tls"} {
		if fields[k] != want {
			t.Fatalf("%s=%v want %s", k, fields[k], want)
		}
	}
	if p[0].Port != 623 || p[0].Username != "ADMIN" {
		t.Fatal("legacy BMC defaults lost")
	}
}

func TestProfilesDuplicateConsoleEndpoint(t *testing.T) {
	pin := strings.Repeat("a", 64)
	for _, text := range []string{
		`[{"id":"a","host":"192.0.2.1","jetUrl":"http://KVM.example.test"},{"id":"b","host":"192.0.2.2","jetUrl":"http://kvm.example.test:80/"}]`,
		`[{"id":"a","host":"192.0.2.1","jetUrl":"https://KVM.example.test."},{"id":"b","host":"192.0.2.2","jetUrl":"https://kvm.example.test:443"}]`,
		`[{"id":"a","host":"192.0.2.1","jetUrl":"http://kvm.example.test"},{"id":"b","host":"192.0.2.2","glUrl":"http://kvm.example.test","glUsername":"admin","glPasswordFile":"secret"}]`,
		`[{"id":"a","host":"192.0.2.1","vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"` + pin + `"},{"id":"b","host":"192.0.2.2","vncHost":"192.0.2.1","vncKind":"generic","vncTransport":"tls","vncPort":5901,"vncPasswordFile":"secret","vncCertificateSHA256":"` + pin + `"}]`,
	} {
		if _, err := readProfileFixture(t, text); err == nil {
			t.Fatal("duplicate physical endpoint accepted")
		}
	}
}

func TestProfilesPreserveManagementIdentity(t *testing.T) {
	for _, host := range []string{"BMC.Example.test", "2001:0db8:0:0:0:0:0:1"} {
		p, err := readProfileFixture(t, `[{"id":"legacy","host":"`+host+`"}]`)
		if err != nil || p[0].Host != host {
			t.Fatal("legacy history/layout identity changed", err)
		}
	}
}

func TestLegacyProfilesRequireExplicitEndpoints(t *testing.T) {
	for _, key := range []string{"SERVER_NAME", "IPMI_HOST", "IPMI_PORT", "IPMI_USERNAME", "IPMI_PASSWORD_FILE", "IPMI_KG_KEY_FILE", "JETKVM_URL", "JETKVM_PASSWORD_FILE"} {
		t.Setenv(key, "")
	}
	profiles, err := legacyProfiles()
	if err != nil || len(profiles) != 0 {
		t.Fatal("unexpected device on first start", profiles, err)
	}
	t.Setenv("JETKVM_URL", "http://jet.example")
	profiles, err = legacyProfiles()
	if err != nil || len(profiles) != 1 {
		t.Fatal(profiles, err)
	}
	p, err := normalizeProfile(profiles[0])
	if err != nil || p.Host != "" || p.JetURL != "http://jet.example:80" {
		t.Fatal(p, err)
	}
	t.Setenv("IPMI_HOST", "bmc.example")
	t.Setenv("JETKVM_URL", "")
	profiles, err = legacyProfiles()
	if err != nil || len(profiles) != 1 {
		t.Fatal(profiles, err)
	}
	p, err = normalizeProfile(profiles[0])
	if err != nil || p.Host != "bmc.example" || p.Port != 623 || p.Username != "ADMIN" || p.JetURL != "" {
		t.Fatal(p, err)
	}
	t.Setenv("IPMI_PORT", "invalid")
	if _, err := legacyProfiles(); err == nil {
		t.Fatal("invalid legacy port accepted")
	}
}
