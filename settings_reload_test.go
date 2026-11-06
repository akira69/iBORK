package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestSettingsProcess(t *testing.T) {
	if os.Getenv("JSM_SETTINGS_TEST_PROCESS") == "1" {
		main()
		os.Exit(0)
	}
}

func TestSettingsReload(t *testing.T) {
	for _, standalone := range []bool{false, true} {
		name := "integrated"
		if standalone {
			name = "standalone"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			hash, _ := bcrypt.GenerateFromPassword([]byte("fixture-login"), bcrypt.MinCost)
			for name, data := range map[string][]byte{"hash": hash, "password": []byte("fixture-device")} {
				if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			profiles := []deviceProfile{{ID: "first", Name: "First", Host: "192.0.2.1", Port: 623, Username: "ADMIN", PasswordFile: filepath.Join(dir, "password")}}
			if standalone {
				profiles[0].Host = ""
				profiles[0].Port = 0
				profiles[0].Username = ""
				profiles[0].PasswordFile = ""
				profiles[0].JetURL = "http://127.0.0.1:9"
				profiles[0].JetPasswordFile = filepath.Join(dir, "password")
			}
			data, _ := json.Marshal(profiles)
			if err := os.WriteFile(filepath.Join(dir, "profiles.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := listener.Addr().String()
			_ = listener.Close()
			origin := "http://" + address
			cmd := exec.Command(os.Args[0], "-test.run=^TestSettingsProcess$")
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			cmd.Env = append(os.Environ(), "JSM_SETTINGS_TEST_PROCESS=1", "APP_ORIGIN="+origin, "LISTEN_ADDR="+address, "APP_PASSWORD_HASH_FILE="+filepath.Join(dir, "hash"), "DEVICES_FILE="+filepath.Join(dir, "profiles.json"), "STATE_DIRECTORY="+filepath.Join(dir, "state"), "DEVICE_TIMEOUT=1s")
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			jar, _ := cookiejar.New(nil)
			client := &http.Client{Timeout: 2 * time.Second, Jar: jar}
			request := func(method, path string, body any, csrf string) (int, []byte) {
				encoded, _ := json.Marshal(body)
				req, _ := http.NewRequest(method, origin+path, bytes.NewReader(encoded))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", origin)
				req.Header.Set("X-CSRF-Token", csrf)
				res, err := client.Do(req)
				if err != nil {
					return 0, nil
				}
				defer res.Body.Close()
				result, _ := io.ReadAll(res.Body)
				return res.StatusCode, result
			}
			wait := func(check func() bool) {
				t.Helper()
				deadline := time.Now().Add(12 * time.Second)
				for time.Now().Before(deadline) {
					if check() {
						return
					}
					time.Sleep(50 * time.Millisecond)
				}
				t.Fatal("app did not reach expected state")
			}
			wait(func() bool { code, _ := request("GET", "/api/session", nil, ""); return code == 401 })
			login := func() string {
				t.Helper()
				code, data := request("POST", "/api/login", map[string]string{"password": "fixture-login"}, "")
				if code != 200 {
					t.Fatalf("login status %d", code)
				}
				var result struct {
					CSRF string `json:"csrf"`
				}
				_ = json.Unmarshal(data, &result)
				return result.CSRF
			}
			csrf := login()
			if standalone {
				code, data := request("GET", "/api/devices", nil, "")
				if code != 200 || !bytes.Contains(data, []byte(`"hasManagement":false`)) {
					t.Fatal("standalone metadata unavailable", code)
				}
				if code, _ := request("GET", "/api/devices/first/power", nil, ""); code != 409 {
					t.Fatal("management enabled for console-only device", code)
				}
				files, _ := filepath.Glob(filepath.Join(dir, "state", "power-*"))
				if len(files) != 0 {
					t.Fatal("power history created for console-only device")
				}
			}

			if standalone {
				if code, _ := request("DELETE", "/api/device-settings", map[string]string{"id": "first", "confirm": "first"}, csrf); code != 200 {
					t.Fatal("remove failed", code)
				}
				wait(func() bool {
					code, data := request("GET", "/api/devices", nil, "")
					return code == 200 && string(bytes.TrimSpace(data)) == "[]"
				})
				if code, _ := request("GET", "/api/device-settings", nil, ""); code != 200 {
					t.Fatal("empty inventory settings unavailable")
				}
			}

			code, _ := request("POST", "/api/device-settings", map[string]any{"id": "", "name": "Second", "host": "192.0.2.2", "port": 623, "username": "ADMIN", "password": "new-fixture-device", "jetUrl": ""}, csrf)
			if code != 200 {
				t.Fatalf("save status %d", code)
			}
			// The original cookie must reach the reloaded inventory without another login.
			wait(func() bool {
				code, data := request("GET", "/api/devices", nil, "")
				var devices []any
				_ = json.Unmarshal(data, &devices)
				expected := 2
				if standalone {
					expected = 1
				}
				return code == 200 && len(devices) == expected
			})
			if code, data := request("GET", "/api/session", nil, ""); code != 200 || !bytes.Contains(data, []byte(csrf)) {
				t.Fatal("reload lost the original login or CSRF token", code)
			}
			code, data = request("GET", "/api/device-settings", nil, "")
			if code != 200 || bytes.Contains(data, []byte("new-fixture-device")) || bytes.Contains(data, []byte("passwordFile")) {
				t.Fatal("settings response exposed credentials or failed")
			}
			if _, err = os.Stat(filepath.Join(dir, "password")); err != nil {
				t.Fatal("imported credential removed")
			}
			if standalone {
				agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != "/api/4/sensors" {
						http.NotFound(w, r)
						return
					}
					_, _ = io.WriteString(w, `[{"label":"Exhaust","type":"fan_speed","unit":"R","value":1799}]`)
				}))
				defer agent.Close()
				code, _ := request("POST", "/api/device-settings", map[string]any{"name": "Unmetered node", "telemetry": map[string]string{"glancesUrl": agent.URL}}, csrf)
				if code != 200 {
					t.Fatalf("add telemetry server: %d", code)
				}
				var nodeID string
				wait(func() bool {
					code, raw := request("GET", "/api/devices", nil, "")
					var devices []struct {
						ID, Name                             string
						HasSensors, HasManagement, HasEnergy bool
					}
					if code != 200 || json.Unmarshal(raw, &devices) != nil {
						return false
					}
					for _, d := range devices {
						if d.Name == "Unmetered node" && d.HasSensors && !d.HasManagement && !d.HasEnergy {
							nodeID = d.ID
							return true
						}
					}
					return false
				})
				code, raw := request("GET", "/api/devices/"+nodeID+"/sensors", nil, "")
				if code != 200 || !bytes.Contains(raw, []byte(`"value":"1799"`)) {
					t.Fatalf("Glances fixture unavailable after authenticated reload: %d", code)
				}
			}
		})
	}
}
