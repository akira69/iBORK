package assistant

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/akira69/iBORK/internal/telemetryhttp"
)

func Targets(input string) ([]netip.Addr, error) {
	invalid := errors.New("approve private IPv4 hosts or a subnet of at most 256 addresses")
	if len(input) > 2048 {
		return nil, invalid
	}
	seen := map[netip.Addr]bool{}
	var hosts []netip.Addr
	for _, word := range strings.FieldsFunc(input, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
		prefix, err := netip.ParsePrefix(word)
		if err != nil {
			addr, e := netip.ParseAddr(word)
			if e != nil {
				return nil, invalid
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		first := prefix.Masked().Addr()
		if !first.Is4() || !first.IsPrivate() || prefix.Bits() < 24 {
			return nil, invalid
		}
		for addr := first; prefix.Contains(addr); addr = addr.Next() {
			if prefix.Bits() <= 30 && (addr == first || !prefix.Contains(addr.Next())) {
				continue
			}
			if !seen[addr] {
				seen[addr] = true
				hosts = append(hosts, addr)
				if len(hosts) > 256 {
					return nil, invalid
				}
			}
		}
	}
	if len(hosts) == 0 {
		return nil, invalid
	}
	return hosts, nil
}
func discover(parent context.Context, hosts []netip.Addr) ([]Candidate, bool) {
	ctx, cancel := context.WithTimeout(parent, 40*time.Second)
	defer cancel()
	jobs := make(chan netip.Addr, len(hosts))
	for _, host := range hosts {
		jobs <- host
	}
	close(jobs)
	var mu sync.Mutex
	var found []Candidate
	var wg sync.WaitGroup
	client := telemetryhttp.NewClient(500 * time.Millisecond)
	client.Transport = &http.Transport{DisableKeepAlives: true}
	defer client.CloseIdleConnections()
	for range min(len(hosts), 8) {
		wg.Go(func() {
			for host := range jobs {
				if ctx.Err() != nil {
					return
				}
				address := host.String()
				kinds := []string{}
				if ipmiPong(ctx, net.JoinHostPort(address, "623")) {
					kinds = append(kinds, "bmc")
				}
				if jetStatus(ctx, client, "http://"+address) {
					kinds = append(kinds, "kvm")
				}
				mu.Lock()
				for _, kind := range kinds {
					evidence := "IPMI supported in ASF presence reply"
					if kind == "kvm" {
						evidence = "Stock JetKVM device status and SKU"
					}
					found = append(found, Candidate{kind + "@" + address, kind, address, evidence})
				}
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	sort.Slice(found, func(i, j int) bool { return found[i].ID < found[j].ID })
	return found, ctx.Err() == nil
}
func jetStatus(ctx context.Context, client *http.Client, origin string) bool {
	var status struct {
		SKU     string `json:"sku"`
		IsSetup *bool  `json:"isSetup"`
	}
	return telemetryhttp.GetJSON(ctx, client, origin+"/device/status", "", &status) == nil && status.IsSetup != nil && strings.HasPrefix(status.SKU, "jetkvm-")
}
func ipmiPong(ctx context.Context, endpoint string) bool {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "udp4", endpoint)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(500 * time.Millisecond))
	ping := []byte{6, 0, 255, 6, 0, 0, 0x11, 0xbe, 0x80, 1, 0, 0}
	if _, err = conn.Write(ping); err != nil {
		return false
	}
	var reply [64]byte
	n, err := conn.Read(reply[:])
	return err == nil && n == 28 && bytes.Equal(reply[:8], ping[:8]) && reply[8] == 0x40 && reply[9] == ping[9] && reply[11] == 16 && reply[20]&0x80 != 0
}
