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
	err = p.run(ctx, types.PrivilegeLevelUser, func(ctx context.Context, c *client.Client) error {
		reading, e := c.GetDCMIPowerReading(ctx)
		if e != nil {
			return e
		}
		watts, e = measurementWatts(reading)
		return e
	})
	return
}
