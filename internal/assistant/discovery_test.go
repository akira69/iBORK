package assistant

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/akira69/iBORK/internal/telemetryhttp"
)

func TestDiscoveryEvidenceAndDeadlines(t *testing.T) {
	client := telemetryhttp.NewClient(100 * time.Millisecond)
	ctx := context.Background()
	for _, test := range []struct {
		body string
		ok   bool
	}{{`{"sku":"jetkvm-v2","isSetup":false}`, true}, {`{"sku":"other","isSetup":true}`, false}, {`{"sku":"jetkvm-v2"}`, false}, {"login", false}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "GET" || r.URL.Path != "/device/status" || r.Header.Get("Authorization") != "" {
				t.Error("unexpected discovery request")
			}
			fmt.Fprint(w, test.body)
		}))
		if jetStatus(ctx, client, srv.URL) != test.ok {
			t.Error(test.body)
		}
		srv.Close()
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/unexpected", 302)
		if r.URL.Path == "/unexpected" {
			t.Error("followed redirect")
		}
	}))
	defer redirect.Close()
	if jetStatus(ctx, client, redirect.URL) {
		t.Fatal("redirect identified as device")
	}
	for _, good := range []bool{true, false} {
		sock, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			defer sock.Close()
			_ = sock.SetDeadline(time.Now().Add(time.Second))
			var b [28]byte
			n, addr, err := sock.ReadFrom(b[:])
			if err != nil || n != 12 {
				return
			}
			b[8] = 0x40
			b[11] = 16
			if good {
				b[20] = 0x80
			}
			_, _ = sock.WriteTo(b[:], addr)
		}()
		if ipmiPong(ctx, sock.LocalAddr().String()) != good {
			t.Fatal("RMCP evidence")
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	found, done := discover(canceled, []netip.Addr{netip.MustParseAddr("10.1.2.3")})
	if done || len(found) != 0 {
		t.Fatal("cancelled scan")
	}
}
func TestProviderDestinationsAndTimeout(t *testing.T) {
	for _, addr := range []string{"169.254.169.254", "fd00:ec2::254", "fe80::1", "0.0.0.0", "224.0.0.1", "100.100.100.200"} {
		if allowedAddress(netip.MustParseAddr(addr), false) {
			t.Error(addr)
		}
	}
	if allowedAddress(netip.MustParseAddr("8.8.8.8"), true) {
		t.Error("public plaintext accepted")
	}
	slow := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer slow.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	p := Provider{BaseURL: slow.URL + "/v1", Model: "fixture"}
	if p.Test(ctx) == nil || ctx.Err() == nil {
		t.Fatal("provider timeout")
	}
}
