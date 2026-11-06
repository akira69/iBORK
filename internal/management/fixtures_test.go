package management

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bougou/go-ipmi/pkg/bmc"
	"github.com/bougou/go-ipmi/pkg/hal/mock"
	"github.com/bougou/go-ipmi/pkg/handlers"
	"github.com/bougou/go-ipmi/pkg/server"
	"github.com/bougou/go-ipmi/pkg/transport/udp"
	"github.com/bougou/go-ipmi/pkg/types"
)

func TestDiscreteNormalization(t *testing.T) {
	for _, test := range []struct {
		name    string
		reading types.EventReadingType
		sensor  types.SensorType
		bits    types.Mask_DiscreteEvent
		want    string
	}{
		{"device absent", types.EventReadingTypeDevicePresent, types.SensorTypeReserved, types.Mask_DiscreteEvent{State_0: true}, "unavailable"},
		{"entity absent", types.EventReadingTypeSensorSpecific, types.SensorTypeEntityPresence, types.Mask_DiscreteEvent{State_1: true}, "unavailable"},
		{"unknown", 0x70, types.SensorTypeReserved, types.Mask_DiscreteEvent{State_0: true}, "unavailable"},
		{"unknown bit", types.EventReadingTypeDevicePresent, types.SensorTypeReserved, types.Mask_DiscreteEvent{State_14: true}, "unavailable"},
		{"known present", types.EventReadingTypeDevicePresent, types.SensorTypeReserved, types.Mask_DiscreteEvent{State_1: true}, "ok"},
		{"absent plus fault", types.EventReadingTypeSensorSpecific, types.SensorTypeEntityPresence, types.Mask_DiscreteEvent{State_1: true, State_2: true}, "critical"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &types.Sensor{Name: test.name, ReadingAvailable: true, EventReadingType: test.reading, SensorType: test.sensor}
			s.Discrete.ActiveStates = test.bits
			if got := sensorView(s); got.State != test.want {
				t.Fatalf("got %+v, want %s", got, test.want)
			}
		})
	}
}
func TestUnknownStandardSEL(t *testing.T) {
	s := &types.SEL{RecordID: 1, Standard: &types.SELStandard{EventReadingType: 0x70, EventData: types.EventData{EventData1: 0}}}
	if got := eventView(s); got.State != "unavailable" {
		t.Fatal(got)
	}
}

func fixtureBMC(t *testing.T, privilege bmc.PrivilegeLevel) (Provider, *mock.HAL) {
	t.Helper()
	h := mock.New()
	b := bmc.New(bmc.DeviceInfo{IPMIVersion: 0x20}, [16]byte{}, h)
	admin, e := b.Users.Add(2, "admin")
	if e != nil {
		t.Fatal(e)
	}
	admin.SetPassword([]byte("secret"))
	admin.Enabled = true
	admin.ChannelAccess[1] = bmc.UserChannelAccess{MaxPrivilege: privilege, Enabled: true}
	reg := handlers.NewRegistry()
	handlers.RegisterAllHandlers(reg)
	reg.RegisterFunc(types.CommandGetSELInfo, func(context.Context, *handlers.HandlerContext, []byte) ([]byte, types.CompletionCode, error) {
		return make([]byte, 14), types.CodeOK, nil
	})
	reg.RegisterFunc(types.CommandGetSELEntry, func(context.Context, *handlers.HandlerContext, []byte) ([]byte, types.CompletionCode, error) {
		return nil, types.CodeRequestedDataNotPresent, nil
	})
	reg.RegisterFunc(types.CommandReserveSEL, func(context.Context, *handlers.HandlerContext, []byte) ([]byte, types.CompletionCode, error) {
		return []byte{1, 0}, types.CodeOK, nil
	})
	var initiated atomic.Bool
	reg.RegisterFunc(types.CommandClearSEL, func(_ context.Context, _ *handlers.HandlerContext, data []byte) ([]byte, types.CompletionCode, error) {
		if len(data) != 6 || data[0] != 1 || string(data[2:5]) != "CLR" {
			return nil, types.CompletionCode(0xcc), nil
		}
		if data[5] == 0xaa && initiated.CompareAndSwap(false, true) {
			return []byte{0}, types.CodeOK, nil
		}
		if data[5] == 0 && initiated.Load() {
			return []byte{1}, types.CodeOK, nil
		}
		return nil, types.CompletionCode(0xcc), nil
	})
	conn, e := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	srv := server.NewServer(b, udp.Wrap(conn, udp.WithReadTimeout(time.Second)), server.WithHandlerRegistry(reg))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		_ = srv.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("fixture server did not stop")
		}
	})
	p, e := NewIPMI(Config{Host: "127.0.0.1", Port: conn.LocalAddr().(*net.UDPAddr).Port, Username: "admin", Password: "secret", Timeout: 3 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	return p, h
}
func TestEmptySELCommand(t *testing.T) {
	p, _ := fixtureBMC(t, bmc.PrivilegeLevelUser)
	if _, err := p.Power(context.Background()); err != nil {
		t.Fatalf("read-only account cannot read power: %v", err)
	}
	if err := p.SetPower(context.Background(), "on"); err == nil {
		t.Fatal("read-only account admitted a power action")
	}
	events, e := p.Events(context.Background())
	if e != nil || events == nil || len(events) != 0 {
		t.Fatalf("empty log: %v %v", events, e)
	}
}
func TestClearSELCommands(t *testing.T) {
	p, _ := fixtureBMC(t, bmc.PrivilegeLevelAdministrator)
	if err := p.ClearEvents(context.Background()); err != nil {
		t.Fatal(err)
	}
	events, err := p.Events(context.Background())
	if err != nil || len(events) != 0 {
		t.Fatalf("after clear: %v %v", events, err)
	}
}
func TestPowerAndBootCommands(t *testing.T) {
	p, h := fixtureBMC(t, bmc.PrivilegeLevelAdministrator)
	for _, action := range []string{"on", "off", "soft", "reset", "cycle"} {
		if e := p.SetPower(context.Background(), action); e != nil {
			t.Fatalf("%s: %v", action, e)
		}
	}
	if e := p.SetPower(context.Background(), "on"); e != nil {
		t.Fatal(e)
	}
	power, e := p.Power(context.Background())
	if e != nil || power.State != "on" {
		t.Fatalf("power: %+v %v", power, e)
	}
	if e := h.Chassis().SetBootFlags(context.Background(), &types.BootOptionParam_BootFlags{BIOSBootType: types.BIOSBootTypeEFI}); e != nil {
		t.Fatal(e)
	}
	if e := p.SetBoot(context.Background(), "pxe"); e != nil {
		t.Fatal(e)
	}
	flags, e := h.Chassis().GetBootFlags(context.Background())
	if e != nil || flags.Persist || flags.BIOSBootType != types.BIOSBootTypeEFI || flags.BootDeviceSelector != types.BootDeviceSelectorForcePXE {
		t.Fatalf("boot: %+v %v", flags, e)
	}
}
func TestFRUFieldsFixture(t *testing.T) {
	raw, e := types.PackFRU(types.FRUPackConfig{Board: &types.FRUPackBoard{Mfg: "Supermicro", Product: "X9 fixture", Serial: "board-serial"}, Product: &types.FRUPackProduct{Manufacturer: "Fixture", Name: "Server", Serial: "product-serial"}, Chassis: &types.FRUPackChassis{Type: 0x17, Serial: "chassis-serial"}})
	if e != nil {
		t.Fatal(e)
	}
	f, e := types.ParseFRU(raw)
	if e != nil {
		t.Fatal(e)
	}
	fields := fruFields(f)
	for k, want := range map[string]string{"Board Mfg": "Supermicro", "Board Product": "X9 fixture", "Board Serial": "board-serial", "Product Serial": "product-serial", "Chassis Serial Number": "chassis-serial"} {
		if fields[k] != want {
			t.Fatalf("%s: got %q, want %q", k, fields[k], want)
		}
	}
}
