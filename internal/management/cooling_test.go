package management

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/app"
	"github.com/bougou/go-ipmi/pkg/types"
)

type coolingFixture struct {
	manufacturer uint32
	data         []byte
	err          error
	calls        int
	t            *testing.T
}

func (f *coolingFixture) GetDeviceID(context.Context) (*app.GetDeviceIDResponse, error) {
	return &app.GetDeviceIDResponse{ManufacturerID: f.manufacturer}, nil
}
func (f *coolingFixture) RawCommand(_ context.Context, netfn types.NetFn, cmd uint8, data []byte, _ string) (*client.CommandRawResponse, error) {
	f.calls++
	if netfn != 0x30 || cmd != 0x45 || !reflect.DeepEqual(data, []byte{0x00}) {
		f.t.Fatal("unexpected hardware command")
	}
	return &client.CommandRawResponse{Response: f.data}, f.err
}

func TestCoolingVendorGuardAndUnknownMode(t *testing.T) {
	for _, manufacturer := range []uint32{0, 157, 674, 10876} {
		f := &coolingFixture{manufacturer: manufacturer, data: []byte{3}, t: t}
		state, err := readCooling(context.Background(), f)
		if err != nil || state.ControlSupported {
			t.Fatalf("unsafe cooling state: %+v, %v", state, err)
		}
		if manufacturer == 10876 {
			if f.calls != 1 || !state.QuerySupported || state.ModeCode != "0x03" || state.ModeLabel != "Unrecognized mode" {
				t.Fatal(state, f.calls)
			}
		} else if f.calls != 0 || state.QuerySupported || state.ModeCode != "" {
			t.Fatal("OEM query sent to another vendor")
		}
	}
}

func TestCoolingKnownModes(t *testing.T) {
	for code, label := range []string{"Standard", "Full speed", "Optimal"} {
		f := &coolingFixture{manufacturer: 10876, data: []byte{byte(code)}, t: t}
		state, err := readCooling(context.Background(), f)
		if err != nil || state.ModeLabel != label || !state.QuerySupported || state.ControlSupported {
			t.Fatal(state, err)
		}
	}
}

func TestCoolingMalformedRead(t *testing.T) {
	for _, data := range [][]byte{nil, {1, 2}} {
		f := &coolingFixture{manufacturer: 10876, data: data, t: t}
		if state, err := readCooling(context.Background(), f); err == nil || state.QuerySupported {
			t.Fatal(state, err)
		}
	}
}

func TestCoolingQueryRejectionAndTransportFailure(t *testing.T) {
	f := &coolingFixture{manufacturer: 10876, t: t, err: types.NewResponseError(0xcc, "invalid request")}
	state, err := readCooling(context.Background(), f)
	if err != nil || state.QuerySupported || !strings.Contains(state.Reason, "rejected") {
		t.Fatal(state, err)
	}
	f.err = context.DeadlineExceeded
	if _, err := readCooling(context.Background(), f); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestCoolingTimeoutAndSanitizedFailure(t *testing.T) {
	p := testProvider(t)
	p.connect = func(context.Context, *client.Client) error { return errors.New("admin secret") }
	if _, err := p.Cooling(context.Background()); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
	p.connect = func(ctx context.Context, _ *client.Client) error { <-ctx.Done(); return ctx.Err() }
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := p.Cooling(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
