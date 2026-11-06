package meter

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gonzalop/mq"
)

const topic = "test/meter/status"

func TestMQTTValidation(t *testing.T) {
	for _, test := range []struct{ broker, topic, user, password, field string }{
		{"mqtt://lan", topic, "user", "secret", ""}, {"mqtt://127.0.0.1", topic, "", "secret", ""},
		{"mqtt://user:pass@host", topic, "", "", ""}, {"mqtts://host/path", topic, "", "", ""},
		{"mqtts://host", "home/+", "", "", ""}, {"mqtts://host", "$share/g/status", "", "", ""},
		{"mqtts://host", "home/#", "", "", ""}, {"mqtts://host", topic, "", "", "unit"},
	} {
		if err := ValidateMQTT(test.broker, test.topic, test.user, test.password, test.field); err == nil {
			t.Errorf("accepted invalid configuration for %s", test.broker)
		}
	}
	for _, b := range []string{"mqtt://192.0.2.1", "mqtts://lan", "mqtt://[::1]"} {
		m, err := NewMQTT(b, topic, "", "", "apower")
		if err != nil || (!strings.Contains(m.broker, ":1883") && !strings.Contains(m.broker, ":8883")) {
			t.Errorf("broker %s: %v", b, err)
		}
	}
}

func TestMQTTPayload(t *testing.T) {
	now := time.Unix(1800000000, 0).UTC()
	m, err := NewMQTT("mqtts://broker", topic, "user", "secret", "apower")
	if err != nil {
		t.Fatal(err)
	}
	m.now = func() time.Time { return now }
	for _, payload := range []string{`{"watts":40}`, `{"apower":"42"}`, `{"apower":null}`, `{"apower":-1}`, `{"apower":65536}`, `{"apower":0,"unit":"kWh"}`, `{"apower":0,"unit":null}`, `[]`, `{`, `{"apower":0,"timestamp":null}`, `{"apower":1,"timestamp":"2050-01-01T00:00:00Z"}`} {
		m.receive(nil, mq.Message{Topic: topic, Payload: []byte(payload)})
		if _, err := m.Read(t.Context()); err == nil {
			t.Errorf("accepted %s", payload)
		}
	}
	payload := `{"apower":42,"unit":"W","timestamp":"` + now.Format(time.RFC3339) + `"}`
	m.receive(nil, mq.Message{Topic: topic, Payload: []byte(payload), Retained: true})
	if sample, err := m.Read(t.Context()); err != nil || sample.Watts != 42 || sample.At != now.Unix() {
		t.Fatalf("retained timestamp: %+v %v", sample, err)
	}
	now = now.Add(150 * time.Second)
	for _, msg := range []mq.Message{{Topic: topic, Payload: []byte(payload), Retained: true}, {Topic: topic, Payload: []byte(`{"apower":1}`), Duplicate: true}, {Topic: topic, Payload: []byte(`{"apower":2}`), Retained: true}, {Topic: "other", Payload: []byte(`{"apower":3}`)}} {
		m.receive(nil, msg)
	}
	if p, err := m.Read(t.Context()); err != nil || p.Watts != 42 || p.At != now.Unix()-150 {
		t.Fatalf("replay changed the sample: %+v %v", p, err)
	}
	now = now.Add(time.Second)
	if _, err := m.Read(t.Context()); err == nil {
		t.Fatal("replay refreshed observation")
	}
}

// The fixture accepts only short MQTT 3.1.1 packets on a disposable loopback socket.
func readFrame(t *testing.T, c net.Conn, kind byte) []byte {
	t.Helper()
	header := make([]byte, 2)
	if _, err := io.ReadFull(c, header); err != nil {
		t.Fatal(err)
	}
	if header[0] != kind || header[1] >= 128 {
		t.Fatalf("unexpected frame header %x", header)
	}
	body := make([]byte, int(header[1]))
	if _, err := io.ReadFull(c, body); err != nil {
		t.Fatal(err)
	}
	return body
}

func writeFrame(t *testing.T, c net.Conn, kind byte, body []byte) {
	t.Helper()
	if _, err := c.Write(append([]byte{kind, byte(len(body))}, body...)); err != nil {
		t.Fatal(err)
	}
}

func TestMQTTBroker(t *testing.T) {
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	m, err := NewMQTT("mqtt://"+listener.Addr().String(), topic, "read-only", "fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	var clock atomic.Int64
	var calls atomic.Int64
	clock.Store(1800000000)
	m.now = func() time.Time {
		calls.Add(1)
		return time.Unix(clock.Load(), 0)
	}
	m.retry = 15 * time.Millisecond
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); m.Run(ctx) }()
	accept := func() net.Conn {
		t.Helper()
		_ = listener.SetDeadline(time.Now().Add(2 * time.Second))
		c, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		p := readFrame(t, c, 0x10)
		if !bytes.HasPrefix(p, []byte{0, 4, 'M', 'Q', 'T', 'T', 4, 0xc2}) || !bytes.HasSuffix(p, []byte("\x00\x09read-only\x00\x07fixture")) {
			t.Fatalf("unexpected CONNECT flags or credentials")
		}
		return c
	}
	waitRead := func(watts float64, wantErr string) {
		t.Helper()
		until := time.Now().Add(time.Second)
		for {
			p, err := m.Read(ctx)
			if wantErr != "" && err != nil && strings.Contains(err.Error(), wantErr) {
				return
			}
			if wantErr == "" && err == nil && p.Watts == watts && p.At == clock.Load() {
				return
			}
			if time.Now().After(until) {
				t.Fatalf("wanted %v %q; got %+v, %v", watts, wantErr, p, err)
			}
			time.Sleep(time.Millisecond)
		}
	}
	c := accept()
	writeFrame(t, c, 0x20, []byte{0, 5})
	waitRead(0, "connection failed")
	c.Close()
	subscribe := func(granted byte) net.Conn {
		t.Helper()
		c := accept()
		writeFrame(t, c, 0x20, []byte{0, 0})
		sub := readFrame(t, c, 0x82)
		if len(sub) < 4 || !bytes.Equal(sub[2:], append(append([]byte{0, byte(len(topic))}, topic...), 0)) {
			t.Fatalf("unexpected subscription %x", sub)
		}
		writeFrame(t, c, 0x90, []byte{sub[0], sub[1], granted})
		return c
	}
	publish := func(c net.Conn, kind byte, payload string) {
		t.Helper()
		writeFrame(t, c, kind, append(append([]byte{0, byte(len(topic))}, topic...), payload...))
	}
	c = subscribe(0x80)
	waitRead(0, "subscription failed")
	c.Close()
	c = subscribe(0)
	publish(c, 0x30, `{"watts":42}`)
	waitRead(42, "")
	// Observe every callback before checking the last untimestamped value.
	const burst = 512
	wantCalls := calls.Load() + burst
	var frames bytes.Buffer
	for i := 1; i <= burst; i++ {
		payload := fmt.Sprintf(`{"watts":%d}`, i)
		frames.Write([]byte{0x30, byte(2 + len(topic) + len(payload)), 0, byte(len(topic))})
		frames.WriteString(topic)
		frames.WriteString(payload)
	}
	if _, err := c.Write(frames.Bytes()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for calls.Load() < wantCalls && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if calls.Load() != wantCalls {
		t.Fatal("broker burst was not fully delivered")
	}
	if got, err := m.Read(ctx); err != nil || got.Watts != burst {
		t.Fatalf("broker burst ended at %d W, got %+v, %v", burst, got, err)
	}
	clock.Add(60)
	publish(c, 0x30, `{"watts":0}`)
	waitRead(0, "")
	clock.Add(151)
	waitRead(0, "stale")
	c.Close()
	waitRead(0, "disconnected")
	c = subscribe(0)
	publish(c, 0x31, `{"watts":100}`)
	publish(c, 0x30, `{"watts":1}`)
	waitRead(1, "")
	// A broker announcing a 1 MiB packet must be rejected from the header alone.
	if _, err := c.Write([]byte{0x30, 0x80, 0x80, 0x40}); err != nil {
		t.Fatal(err)
	}
	waitRead(0, "disconnected")
	c.Close()
	c = accept() // Stall this reconnect after CONNECT; cancellation must interrupt the handshake.
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown blocked on reconnect")
	}
}
