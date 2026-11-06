package management

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/chassis"
	"github.com/bougou/go-ipmi/pkg/types"
)

func testProvider(t *testing.T) *ipmiProvider {
	t.Helper()
	p, e := NewIPMI(Config{Host: "fixture.invalid", Username: "admin", Password: "secret"})
	if e != nil {
		t.Fatal(e)
	}
	return p.(*ipmiProvider)
}
func TestFailureIsSanitized(t *testing.T) {
	p := testProvider(t)
	p.connect = func(context.Context, *client.Client) error { return errors.New("authentication: admin secret") }
	_, err := p.Power(context.Background())
	if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "admin") {
		t.Fatalf("unsafe error: %v", err)
	}
}
func TestTimeoutAndQueueCancellation(t *testing.T) {
	p := testProvider(t)
	p.connect = func(ctx context.Context, _ *client.Client) error { <-ctx.Done(); return ctx.Err() }
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := p.Power(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("timeout: %v", err)
	}
	p.gate <- struct{}{}
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = p.Power(ctx)
	<-p.gate
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
func TestInvalidActionsNeverConnect(t *testing.T) {
	p := testProvider(t)
	p.connect = func(context.Context, *client.Client) error { t.Fatal("connected for invalid action"); return nil }
	if p.SetPower(context.Background(), "raw") == nil || p.SetBoot(context.Background(), "persistent") == nil {
		t.Fatal("invalid action accepted")
	}
}
func TestConfigValidation(t *testing.T) {
	for _, c := range []Config{{}, {Host: "https://bmc", Username: "admin", Password: "secret"}, {Host: "bmc", Username: "admin", Password: "secret", Port: -1}, {Host: "bmc", Username: "admin", Password: "secret", Timeout: -time.Second}} {
		if _, e := NewIPMI(c); e == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestKGKeyValidation(t *testing.T) {
	for _, value := range []string{"abc", strings.Repeat("g", 40), strings.Repeat("a", 42), " " + strings.Repeat("a", 40)} {
		if _, err := ParseKGKey(value); err == nil || strings.Contains(err.Error(), value) {
			t.Fatal("invalid key accepted or echoed")
		}
	}
	for _, value := range []string{"", strings.Repeat("A1", 20)} {
		key, err := ParseKGKey(value)
		if err != nil || (value != "" && len(key) != 20) {
			t.Fatal("valid key rejected")
		}
	}
	if _, err := NewIPMI(Config{Host: "fixture.invalid", Username: "root", Password: "fixture", KGKey: "not-hex"}); err == nil {
		t.Fatal("invalid config accepted")
	}
}
func TestPowerFixture(t *testing.T) {
	for _, value := range []byte{0, 1} {
		r := &chassis.GetChassisStatusResponse{}
		if err := r.Unpack([]byte{value, 0, 0, 0}); err != nil {
			t.Fatal(err)
		}
		if r.PowerIsOn != (value == 1) {
			t.Fatal("power fixture misread")
		}
	}
}
func TestSensorFixtures(t *testing.T) {
	s := &types.Sensor{Name: "CPU temperature", Number: 1, ReadingAvailable: true, EventReadingType: types.EventReadingTypeThreshold, Value: 42}
	if got := sensorView(s); got.Value != "42" {
		t.Fatalf("numeric reading must exclude units and padded decimals: %+v", got)
	}
	for status, want := range map[string]string{"ok": "ok", "lnc": "warning", "ucr": "critical", "unr": "critical", "unknown": "unavailable"} {
		s.Threshold.ThresholdStatus = types.SensorThresholdStatus(status)
		if got := sensorView(s); got.State != want {
			t.Fatalf("%s: %+v", status, got)
		}
	}
	s.NotPresent = true
	got := sensorView(s)
	if got.State != "unavailable" || got.Value != "Unavailable" {
		t.Fatal(got)
	}
	s.NotPresent = false
	s.ReadingAvailable = false
	if sensorView(s).State != "unavailable" {
		t.Fatal("unreadable sensor healthy")
	}
}
func TestSELFixture(t *testing.T) {
	raw := []byte{1, 0, 2, 0, 0, 0, 100, 0x20, 0, 4, 1, 1, 1, 7, 0, 0}
	s, err := types.ParseSEL(raw)
	if err != nil {
		t.Fatal(err)
	}
	event := eventView(s)
	if event.ID != "1" || event.Timestamp == "" || event.Message == "" || event.Sensor == "" {
		t.Fatal(event)
	}
	if _, e := types.ParseSEL(raw[:5]); e == nil {
		t.Fatal("truncated SEL accepted")
	}
	if eventView(&types.SEL{RecordID: 2}).State != "unavailable" {
		t.Fatal("OEM severity guessed")
	}
}
func TestFRUFixture(t *testing.T) {
	f := &types.FRU{DeviceID: 0, DeviceName: "Board"}
	if fruFields(f)["FRU Device Description"] != "Board (ID 0)" {
		t.Fatal(fruFields(f))
	}
	f.DeviceNotPresent = true
	if len(fruFields(f)) != 0 {
		t.Fatal("missing FRU populated")
	}
	if _, e := types.ParseFRU([]byte{1, 2}); e == nil {
		t.Fatal("truncated FRU accepted")
	}
}
