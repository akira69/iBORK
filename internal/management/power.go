package management

import (
	"context"
	"errors"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/dcmi"
	"github.com/bougou/go-ipmi/pkg/types"
)

func measurementWatts(reading *dcmi.GetDCMIPowerReadingResponse) (float64, error) {
	if reading == nil || !reading.PowerMeasurementActive {
		return 0, errors.New("DCMI power measurement unavailable")
	}
	return float64(reading.CurrentPower), nil
}

func (p *ipmiProvider) Watts(ctx context.Context) (watts float64, err error) {
	ctx, cancel := context.WithTimeout(ctx, p.config.Timeout)
	defer cancel()
	var denied bool
	read := func(ctx context.Context, c *client.Client) error {
		reading, e := c.GetDCMIPowerReading(ctx)
		if e != nil {
			response, ok := types.IsResponseError(e)
			denied = ok && response.CompletionCode() == types.CodeInsufficientPrivilege
			return e
		}
		watts, e = measurementWatts(reading)
		return e
	}
	err = p.run(ctx, types.PrivilegeLevelUser, read)
	// Some BMCs require an administrator session even for a read-only DCMI power query.
	if denied && ctx.Err() == nil {
		err = p.run(ctx, types.PrivilegeLevelAdministrator, read)
	}
	return
}
