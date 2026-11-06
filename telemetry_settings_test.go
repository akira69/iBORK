package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/akira69/iBORK/internal/server"
)

func TestTelemetrySettingsLifecycle(t *testing.T) {
	store := &profileStore{dir: t.TempDir()}
	token := "private-test-token"
	settings := server.TelemetrySettings{GlancesURL: "https://agent.example", MeterKind: "home-assistant", MeterURL: "https://ha.example", MeterChannel: "sensor.node_power", OutletID: "node"}
	input := server.DeviceSettings{Name: "Test node", Telemetry: &settings, MeterSecret: &token}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	store.pending = false
	list := store.List()
	data, _ := json.Marshal(list)
	if strings.Contains(string(data), token) || list[0].Telemetry.MeterChannel != "sensor.node_power" {
		t.Fatal("settings round trip or secret leak")
	}
	input.ID, input.MeterSecret = list[0].ID, nil
	settings.MeterURL = "https://other.example"
	if store.Save(input) == nil {
		t.Fatal("reused secret for another origin")
	}
	settings.MeterURL = "https://ha.example"
	input.ID, input.MeterSecret = "", &token
	if store.Save(input) == nil {
		t.Fatal("accepted duplicate meter")
	}
	if err := store.Save(server.DeviceSettings{ID: list[0].ID, Name: "Renamed"}); err != nil {
		t.Fatal("legacy update lost telemetry", err)
	}
	if store.List()[0].Telemetry.OutletID != "node" {
		t.Fatal("lost outlet assignment")
	}
}

func TestEquivalentBMCEditKeepsPowerHistoryIdentity(t *testing.T) {
	for _, hosts := range [][2]string{{"BMC.Example", "bmc.example"}, {"2001:0db8::1", "2001:db8::1"}} {
		store := &profileStore{dir: t.TempDir()}
		password := "fixture"
		input := server.DeviceSettings{Name: "node", Host: hosts[0], Port: 623, Username: "user", Password: &password}
		if err := store.Save(input); err != nil {
			t.Fatal(err)
		}
		store.pending = false
		input.ID, input.Host, input.Password = store.profiles[0].ID, hosts[1], nil
		if err := store.Save(input); err != nil {
			t.Fatal(err)
		}
		if got := store.profiles[0].Host; got != hosts[0] {
			t.Fatalf("history identity changed from %q to %q", hosts[0], got)
		}
	}
}

func TestOutletCannotBeAssignedAcrossProtocols(t *testing.T) {
	store := &profileStore{dir: t.TempDir()}
	input := server.DeviceSettings{Name: "First", Telemetry: &server.TelemetrySettings{
		MeterKind: "mqtt", MeterURL: "mqtt://localhost", MeterChannel: "plug/status", OutletID: "rack-a",
	}}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	store.pending = false
	token := "local-fixture"
	input = server.DeviceSettings{Name: "Second", MeterSecret: &token, Telemetry: &server.TelemetrySettings{
		MeterKind: "home-assistant", MeterURL: "https://ha.example", MeterChannel: "sensor.rack_a", OutletID: "RACK-A",
	}}
	if err := store.Save(input); err == nil {
		t.Fatal("same outlet counted twice across MQTT and Matter")
	}
	if len(store.List()) != 1 {
		t.Fatal("failed assignment changed saved devices")
	}
}

func TestEquivalentMQTTChannelsCannotBeAssignedTwice(t *testing.T) {
	store := &profileStore{dir: t.TempDir()}
	settings := server.TelemetrySettings{MeterKind: "mqtt", MeterURL: "mqtt://broker:01883", MeterChannel: "outlet/status", OutletID: "office"}
	input := server.DeviceSettings{Name: "Test node", Telemetry: &settings}
	if err := store.Save(input); err != nil {
		t.Fatal(err)
	}
	store.pending = false
	settings.MeterURL, settings.OutletID = "mqtt://broker", "rack"
	if store.Save(input) == nil {
		t.Fatal("a second profile assigned the same MQTT channel")
	}
}

func TestBadBearerCannotPreventSettingsReload(t *testing.T) {
	for _, value := range []string{" ", "bad\x00token", "bad\ttoken", strings.Repeat("x", 4097)} {
		for _, kind := range []string{"home-assistant", "glances"} {
			store := &profileStore{dir: t.TempDir()}
			input := server.DeviceSettings{Name: "Test node", Telemetry: &server.TelemetrySettings{}}
			if kind == "home-assistant" {
				input.Telemetry = &server.TelemetrySettings{MeterKind: kind, MeterURL: "https://ha.example", MeterChannel: "sensor.outlet_power", OutletID: "office"}
				input.MeterSecret = &value
			} else {
				input.Telemetry.GlancesURL = "https://agent.example"
				input.GlancesToken = &value
			}
			if store.Save(input) == nil || store.pending {
				t.Errorf("saved unusable %s bearer", kind)
			}
		}
	}
}
