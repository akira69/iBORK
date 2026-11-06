package management

import (
	"context"
	"errors"
	"fmt"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/app"
	"github.com/bougou/go-ipmi/pkg/types"
)

type CoolingState struct {
	ModeCode         string `json:"modeCode,omitempty"`
	ModeLabel        string `json:"modeLabel"`
	QuerySupported   bool   `json:"querySupported"`
	ControlSupported bool   `json:"controlSupported"`
	Reason           string `json:"reason"`
}

type CoolingProvider interface {
	Cooling(context.Context) (CoolingState, error)
}

type coolingClient interface {
	GetDeviceID(context.Context) (*app.GetDeviceIDResponse, error)
	RawCommand(context.Context, types.NetFn, uint8, []byte, string) (*client.CommandRawResponse, error)
}

func readCooling(ctx context.Context, c coolingClient) (CoolingState, error) {
	out := CoolingState{ModeLabel: "Unknown", Reason: "Changing built-in fan modes requires board-specific verification."}
	id, err := c.GetDeviceID(ctx)
	if err != nil {
		return out, err
	}
	// IANA PEN 10876 identifies Super Micro; OEM commands are not portable.
	if id == nil || id.ManufacturerID != 10876 {
		out.Reason = "Fan-mode query is only available for a verified Supermicro BMC. Fan control is not qualified."
		return out, nil
	}
	response, err := c.RawCommand(ctx, types.NetFn(0x30), 0x45, []byte{0x00}, "Read fan mode")
	if err != nil {
		var rejected *types.ResponseError
		if errors.As(err, &rejected) {
			out.Reason = "The BMC rejected the fan-mode query. Fan control is not qualified."
			return out, nil
		}
		return out, err
	}
	if response == nil || len(response.Response) != 1 {
		return out, errors.New("invalid fan-mode response")
	}
	out.QuerySupported = true
	out.ModeCode = fmt.Sprintf("0x%02x", response.Response[0])
	// Supermicro documents these modes for X9; other OEM values vary by board.
	switch response.Response[0] {
	case 0:
		out.ModeLabel = "Standard"
	case 1:
		out.ModeLabel = "Full speed"
	case 2:
		out.ModeLabel = "Optimal"
	default:
		out.ModeLabel = "Unrecognized mode"
		out.Reason = "The BMC returned a board-specific mode code. Check its native Fan Mode page. Fan control is not qualified."
	}
	return out, nil
}

func (p *ipmiProvider) Cooling(ctx context.Context) (out CoolingState, err error) {
	err = p.run(ctx, func(ctx context.Context, c *client.Client) error {
		var e error
		out, e = readCooling(ctx, c)
		return e
	})
	return
}
