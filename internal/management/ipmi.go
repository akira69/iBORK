package management

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/chassis"
	"github.com/bougou/go-ipmi/pkg/command/storage"
	"github.com/bougou/go-ipmi/pkg/types"
)

type PowerState struct {
	State string `json:"state"`
}
type Sensor struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Value      string   `json:"value"`
	Unit       string   `json:"unit"`
	State      string   `json:"state"`
	Warning    *float64 `json:"warning,omitempty"`
	Critical   *float64 `json:"critical,omitempty"`
	DetailOnly bool     `json:"detailOnly,omitempty"`
}
type Inventory struct {
	Fields map[string]string `json:"fields"`
}
type Event struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Sensor    string `json:"sensor"`
	Message   string `json:"message"`
	State     string `json:"state"`
}
type Provider interface {
	Watts(context.Context) (float64, error)
	Power(context.Context) (PowerState, error)
	Sensors(context.Context) ([]Sensor, error)
	Inventory(context.Context) (Inventory, error)
	Events(context.Context) ([]Event, error)
	SetPower(context.Context, string) error
	SetBoot(context.Context, string) error
	ClearEvents(context.Context) error
}
type Config struct {
	Host, Username, Password string
	KGKey                    string
	Port                     int
	Timeout                  time.Duration
}
type ipmiProvider struct {
	config  Config
	gate    chan struct{}
	connect func(context.Context, *client.Client) error
}

func NewIPMI(c Config) (Provider, error) {
	if _, err := ParseKGKey(c.KGKey); err != nil {
		return nil, err
	}
	if c.Port == 0 {
		c.Port = 623
	}
	if c.Timeout == 0 {
		c.Timeout = 15 * time.Second
	}
	if strings.TrimSpace(c.Host) == "" || strings.ContainsAny(c.Host, "/\\\r\n\t ") || c.Port < 1 || c.Port > 65535 || c.Timeout < time.Second || c.Timeout > 2*time.Minute || len(c.Username) > 16 || c.Username == "" || c.Password == "" {
		return nil, errors.New("invalid IPMI configuration")
	}
	return &ipmiProvider{config: c, gate: make(chan struct{}, 1), connect: func(ctx context.Context, c *client.Client) error { return c.Connect(ctx) }}, nil
}

// ParseKGKey accepts the 20-byte hexadecimal representation shown by iDRAC.
func ParseKGKey(value string) ([]byte, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) != 40 {
		return nil, errors.New("IPMI KG key must contain exactly 40 hexadecimal characters")
	}
	key, err := hex.DecodeString(value)
	if err != nil || len(key) != 20 {
		return nil, errors.New("IPMI KG key must contain exactly 40 hexadecimal characters")
	}
	return key, nil
}

func (p *ipmiProvider) newClient() (*client.Client, error) {
	c, err := client.NewClient(p.config.Host, p.config.Port, p.config.Username, p.config.Password)
	if err != nil {
		return nil, errors.New("invalid IPMI configuration")
	}
	key, err := ParseKGKey(p.config.KGKey)
	if err != nil {
		return nil, err
	}
	c.WithInterface(client.InterfaceLanplus).WithTimeout(p.config.Timeout).WithRetry(0).WithDebug(false).WithCipherSuiteID(types.CipherSuiteID(17), types.CipherSuiteID(3)).WithKG(key)
	clear(key)
	return c, nil
}

// Each operation owns a session; a failed authentication cannot poison later requests.
func (p *ipmiProvider) run(ctx context.Context, privilege types.PrivilegeLevel, op func(context.Context, *client.Client) error) error {
	ctx, cancel := context.WithTimeout(ctx, p.config.Timeout)
	defer cancel()
	select {
	case p.gate <- struct{}{}:
		defer func() { <-p.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	c, err := p.newClient()
	if err != nil {
		return errors.New("invalid IPMI configuration")
	}
	defer func() {
		closeCtx, done := context.WithTimeout(context.Background(), time.Second)
		defer done()
		_ = c.Close(closeCtx)
	}()
	err = p.connect(ctx, c.WithMaxPrivilegeLevel(privilege))
	if err == nil {
		err = op(ctx, c)
	}
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return context.DeadlineExceeded
	}
	// Upstream errors can contain credential material. Do not forward or log them.
	return errors.New("BMC operation failed; check connectivity, credentials and privileges")
}
func (p *ipmiProvider) Power(ctx context.Context) (out PowerState, err error) {
	err = p.run(ctx, types.PrivilegeLevelUser, func(ctx context.Context, c *client.Client) error {
		r, e := c.GetChassisStatus(ctx)
		if e != nil {
			return e
		}
		out.State = "off"
		if r.PowerIsOn {
			out.State = "on"
		}
		return nil
	})
	return
}
func normalizeState(s string) string {
	switch strings.ToLower(s) {
	case "ok", "info":
		return "ok"
	case "nc", "lnc", "unc", "warning", "degraded", "non-fatal":
		return "warning"
	case "cr", "nr", "lcr", "ucr", "lnr", "unr", "critical":
		return "critical"
	default:
		return "unavailable"
	}
}
func eventState(reading types.EventReadingType, sensor types.SensorType, data types.EventData, direction types.EventDir) string {
	offset := data.EventReadingOffset()
	if reading.EventForOffset(sensor, offset) == nil ||
		(reading == types.EventReadingTypeDevicePresent && offset == 0) ||
		(reading == types.EventReadingTypeSensorSpecific && sensor == types.SensorTypeEntityPresence && offset == 1) {
		return "unavailable"
	}
	return normalizeState(string(reading.EventSeverity(sensor, data, direction)))
}
func sensorView(s *types.Sensor) Sensor {
	out := Sensor{ID: fmt.Sprintf("%04x:%02x", uint16(s.GeneratorID), s.Number), Name: s.Name, State: "unavailable", Value: "Unavailable", Unit: s.SensorUnit.String()}
	if s.NotPresent || s.ScanningDisabled || !s.IsReadingValid() {
		return out
	}
	out.Value = s.HumanStr()
	if s.IsThreshold() {
		out.Value = strconv.FormatFloat(s.Value, 'f', -1, 64)
	} else {
		out.Unit = ""
	}
	out.State = normalizeState(s.Status())
	if !s.IsThreshold() {
		out.State = "unavailable"
		unavailable := false
		for _, offset := range s.DiscreteActiveEvents() {
			state := eventState(s.EventReadingType, s.SensorType, types.EventData{EventData1: offset}, false)
			if state == "unavailable" {
				unavailable = true
			}
			if state == "critical" {
				out.State = state
				break
			}
			if state == "warning" {
				out.State = state
			}
			if state == "ok" && out.State == "unavailable" {
				out.State = state
			}
		}
		if unavailable && out.State == "ok" {
			out.State = "unavailable"
		}
		if out.Value == "" {
			out.Value = "Unavailable"
		}
	}
	return out
}
func (p *ipmiProvider) Sensors(ctx context.Context) (out []Sensor, err error) {
	out = []Sensor{}
	err = p.run(ctx, types.PrivilegeLevelUser, func(ctx context.Context, c *client.Client) error {
		var e error
		out, e = readSensors(ctx, c)
		return e
	})
	return
}
func fruFields(f *types.FRU) map[string]string {
	fields := map[string]string{}
	if f == nil || !f.Present() {
		return fields
	}
	// Upstream's formatter decodes all FRU encodings and includes custom fields.
	for _, line := range strings.Split(f.String(), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok && strings.TrimSpace(v) != "" {
			fields[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return fields
}
func (p *ipmiProvider) Inventory(ctx context.Context) (out Inventory, err error) {
	out.Fields = map[string]string{}
	err = p.run(ctx, types.PrivilegeLevelUser, func(ctx context.Context, c *client.Client) error {
		d, e := c.GetDeviceID(ctx)
		if e != nil {
			return e
		}
		out.Fields["BMC firmware"] = d.FirmwareVersionStr()
		out.Fields["BIOS version"] = "Unavailable via standard IPMI"
		fs, e := c.GetFRUs(ctx)
		if e != nil {
			return e
		}
		for _, f := range fs {
			for k, v := range fruFields(f) {
				out.Fields[fmt.Sprintf("FRU %d / %s", f.DeviceID, k)] = v
			}
		}
		return nil
	})
	return
}
func eventView(s *types.SEL) Event {
	out := Event{ID: strconv.Itoa(int(s.RecordID)), State: "unavailable", Message: "OEM event (not decoded)"}
	if s.Standard != nil {
		r := s.Standard
		out.Timestamp = r.Timestamp.UTC().Format(time.RFC3339)
		out.Sensor = fmt.Sprintf("%s (%02x)", r.SensorType, r.SensorNumber)
		out.Message = r.EventString()
		out.State = eventState(r.EventReadingType, r.SensorType, r.EventData, r.EventDir)
		if out.Message == "" {
			out.Message = "Unknown event (not decoded)"
		}
	} else if s.OEMTimestamped != nil {
		out.Timestamp = s.OEMTimestamped.Timestamp.UTC().Format(time.RFC3339)
	}
	return out
}
func (p *ipmiProvider) Events(ctx context.Context) (out []Event, err error) {
	out = []Event{}
	err = p.run(ctx, types.PrivilegeLevelUser, func(ctx context.Context, c *client.Client) error {
		info, e := c.GetSELInfo(ctx)
		if e != nil {
			return e
		}
		if info.Entries == 0 {
			return nil
		}
		ss, e := c.GetSELEntries(ctx, 0)
		if e != nil {
			return e
		}
		for _, s := range ss {
			if s != nil {
				out = append(out, eventView(s))
			}
		}
		return nil
	})
	return
}
func (p *ipmiProvider) SetPower(ctx context.Context, action string) error {
	a, ok := map[string]chassis.ChassisControl{"on": chassis.ChassisControlPowerUp, "soft": chassis.ChassisControlSoftShutdown, "off": chassis.ChassisControlPowerDown, "reset": chassis.ChassisControlHardReset, "cycle": chassis.ChassisControlPowerCycle}[action]
	if !ok {
		return errors.New("unsupported power action")
	}
	return p.run(ctx, types.PrivilegeLevelAdministrator, func(ctx context.Context, c *client.Client) error { _, e := c.ChassisControl(ctx, a); return e })
}
func (p *ipmiProvider) SetBoot(ctx context.Context, device string) error {
	d, ok := map[string]types.BootDeviceSelector{"default": types.BootDeviceSelectorNoOverride, "bios": types.BootDeviceSelectorForceBIOSSetup, "pxe": types.BootDeviceSelectorForcePXE, "disk": types.BootDeviceSelectorForceHardDrive, "cdrom": types.BootDeviceSelectorForceCDROM}[device]
	if !ok {
		return errors.New("unsupported boot device")
	}
	return p.run(ctx, types.PrivilegeLevelAdministrator, func(ctx context.Context, c *client.Client) error {
		flags := &types.BootOptionParam_BootFlags{}
		if e := c.GetSystemBootOptionsParamFor(ctx, flags); e != nil {
			return e
		}
		return c.SetBootDevice(ctx, d, flags.BIOSBootType, false)
	})
}
func (p *ipmiProvider) ClearEvents(ctx context.Context) error {
	return p.run(ctx, types.PrivilegeLevelAdministrator, func(ctx context.Context, c *client.Client) error {
		r, e := c.ReserveSEL(ctx)
		if e != nil {
			return e
		}
		status, e := c.ClearSEL(ctx, r.ReservationID)
		if e != nil {
			return e
		}
		for status.ErasureProgressStatus != 1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			status = &storage.ClearSELResponse{}
			if e = c.Exchange(ctx, &storage.ClearSELRequest{ReservationID: r.ReservationID, GetErasureStatusFlag: true}, status); e != nil {
				return e
			}
		}
		return nil
	})
}
