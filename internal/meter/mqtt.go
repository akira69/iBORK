package meter

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/gonzalop/mq"
)

var fieldName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)

type MQTT struct {
	broker, topic, username, password, field string
	now                                      func() time.Time
	retry                                    time.Duration
	mu                                       sync.Mutex
	at                                       time.Time
	watts                                    float64
	err                                      error
}

func ValidateMQTT(broker, topic, username, password, field string) error {
	u, err := origin(broker)
	if err != nil || (u.Scheme != "mqtt" && u.Scheme != "mqtts") {
		return errors.New("enter an mqtt:// or mqtts:// broker URL")
	}
	if username != "" && u.Scheme != "mqtts" && !net.ParseIP(u.Hostname()).IsLoopback() && !strings.EqualFold(u.Hostname(), "localhost") {
		return errors.New("use mqtts:// for broker credentials outside loopback")
	}
	if (password != "" && username == "") || len(username) > 65535 || len(password) > 65535 {
		return errors.New("invalid MQTT credentials")
	}
	if strings.TrimSpace(topic) == "" || len(topic) > 1024 || !utf8.ValidString(topic) || strings.ContainsAny(topic, "+#\x00") || strings.HasPrefix(topic, "$share/") {
		return errors.New("enter one exact MQTT status topic")
	}
	if field != "" && (!fieldName.MatchString(field) || field == "unit" || field == "timestamp") {
		return errors.New("enter the name of a numeric watts field")
	}
	return nil
}

func NewMQTT(broker, topic, username, password, field string) (*MQTT, error) {
	if err := ValidateMQTT(broker, topic, username, password, field); err != nil {
		return nil, err
	}
	if field == "" {
		field = "watts"
	}
	u, _ := origin(broker)
	if u.Port() == "" {
		port := "1883"
		if u.Scheme == "mqtts" {
			port = "8883"
		}
		u.Host = net.JoinHostPort(u.Hostname(), port)
	}
	return &MQTT{broker: u.String(), topic: topic, username: username, password: password, field: field, now: time.Now, retry: 5 * time.Second}, nil
}

func (m *MQTT) Read(ctx context.Context) (energy.Sample, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return energy.Sample{}, err
	}
	if m.err != nil {
		return energy.Sample{}, m.err
	}
	return observation(m.watts, m.at, m.now())
}

func (m *MQTT) receive(client *mq.Client, message mq.Message) {
	if message.Topic != m.topic || message.Duplicate {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if client != nil && !client.IsConnected() {
		return
	}
	now := m.now()
	var fields map[string]json.RawMessage
	var watts *float64
	if json.Unmarshal(message.Payload, &fields) != nil || json.Unmarshal(fields[m.field], &watts) != nil || watts == nil {
		m.err = errors.New("MQTT message has no numeric watts field")
		return
	}
	if raw, ok := fields["unit"]; ok {
		var unit string
		if json.Unmarshal(raw, &unit) != nil || unit != "W" {
			m.err = errors.New("MQTT watts field has an invalid unit")
			return
		}
	}
	at := now
	if raw, ok := fields["timestamp"]; ok {
		at = time.Time{}
		if json.Unmarshal(raw, &at) != nil || at.IsZero() {
			m.err = errors.New("invalid MQTT observation timestamp")
			return
		}
	} else if message.Retained {
		// A broker may replay the same retained value after every reconnect.
		return
	}
	if at.Before(m.at) || (at.Equal(m.at) && message.Retained && m.watts != *watts) {
		return
	}
	if _, err := observation(*watts, at, now); err != nil {
		m.err = err
		return
	}
	m.watts, m.at, m.err = *watts, at, nil
}

func (m *MQTT) Run(ctx context.Context) {
	for ctx.Err() == nil {
		err := m.session(ctx)
		m.mu.Lock()
		m.err = err
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(m.retry):
		}
	}
}

func (m *MQTT) session(ctx context.Context) error {
	connect, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	disconnected, markLost := context.WithCancel(ctx)
	defer markLost()
	client, err := mq.DialContext(connect, m.broker, mq.WithProtocolVersion(mq.ProtocolV311),
		mq.WithClientID("ibork"+rand.Text()[:16]), mq.WithCredentials(m.username, m.password),
		mq.WithAutoReconnect(false), mq.WithMaxIncomingPacket(64<<10), mq.WithIncomingQueueSize(4), mq.WithOrderedHandlers(),
		mq.WithOnConnectionLost(func(*mq.Client, error) { markLost() }))
	if err != nil {
		return errors.New("MQTT connection failed; check the broker, TLS and credentials")
	}
	defer func() {
		shutdown, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_ = client.Disconnect(shutdown)
	}()
	if err := client.Subscribe(connect, m.topic, mq.AtMostOnce, m.receive).Wait(connect); err != nil {
		return errors.New("MQTT subscription failed; check the topic and read permission")
	}
	<-disconnected.Done()
	return errors.New("MQTT broker disconnected")
}
