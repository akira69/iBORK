package management

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/bougou/go-ipmi/pkg/client"
	"github.com/bougou/go-ipmi/pkg/command/transport"
	"github.com/bougou/go-ipmi/pkg/types"
)

type SOLProvider interface {
	SOL(context.Context, io.Reader, io.Writer) error
}

// SOL owns a separate session so an idle console never blocks telemetry.
func (p *ipmiProvider) SOL(ctx context.Context, input io.Reader, output io.Writer) error {
	c, err := p.newClient()
	if err != nil {
		return errors.New("invalid IPMI configuration")
	}
	activated := false
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		// Only release our own activation, including when the stream context expired.
		if activated {
			_, _ = c.DeactivatePayload(cleanup, &transport.DeactivatePayloadRequest{PayloadType: types.PayloadTypeSOL, PayloadInstance: 1})
		}
		_ = c.Close(cleanup)
	}()
	connectCtx, cancel := context.WithTimeout(ctx, p.config.Timeout)
	err = p.connect(connectCtx, c)
	connectErr := connectCtx.Err()
	cancel()
	if err == nil {
		err = c.SOLActivate(ctx, input, output, &client.SOLActivateOptions{
			OnActivated:   func(uint8, io.Reader, io.Writer, *transport.ActivatePayloadResponse) { activated = true },
			OnDeactivated: func(uint8, io.Reader, io.Writer, *transport.ActivatePayloadResponse) { activated = ctx.Err() != nil },
		})
	}
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if connectErr != nil {
		return connectErr
	}
	return errors.New("SOL unavailable; check connectivity, credentials, privileges and existing sessions")
}
