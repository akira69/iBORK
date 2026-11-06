package management

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/bougou/go-ipmi/pkg/client"
)

func TestSOLConnectionIsIsolatedAndSanitized(t *testing.T) {
	p := &ipmiProvider{config: Config{Host: "127.0.0.1", Port: 623, Username: "test", Password: "secret", Timeout: time.Second}, gate: make(chan struct{}, 1)}
	p.gate <- struct{}{}
	called := false
	p.connect = func(ctx context.Context, _ *client.Client) error {
		called = true
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("connection must have a deadline")
		}
		return errors.New("secret credential material")
	}
	err := p.SOL(context.Background(), strings.NewReader(""), io.Discard)
	if !called || err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("called=%v error=%v", called, err)
	}
}

func TestSOLConnectionTimeout(t *testing.T) {
	p := &ipmiProvider{config: Config{Host: "127.0.0.1", Port: 623, Username: "test", Password: "secret", Timeout: 10 * time.Millisecond}}
	p.connect = func(ctx context.Context, _ *client.Client) error { <-ctx.Done(); return ctx.Err() }
	if err := p.SOL(context.Background(), strings.NewReader(""), io.Discard); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
