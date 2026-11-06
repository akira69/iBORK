package glances

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/akira69/iBORK/internal/management"
	"github.com/akira69/iBORK/internal/telemetryhttp"
)

func ValidateURL(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || strings.ContainsAny(origin, "?#") || strings.HasSuffix(u.Host, ":") {
		return errors.New("Glances requires an HTTP(S) origin")
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return errors.New("invalid Glances port")
		}
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && (strings.EqualFold(u.Hostname(), "localhost") || net.ParseIP(u.Hostname()).IsLoopback()) {
		return nil
	}
	return errors.New("Glances requires verified HTTPS or a loopback HTTP tunnel")
}

type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

func New(origin, token string, timeout time.Duration) (*Client, error) {
	if err := ValidateURL(origin); err != nil {
		return nil, err
	}
	if token != "" && (!strings.HasPrefix(origin, "https://") || !telemetryhttp.ValidBearer(token)) {
		return nil, errors.New("Glances requires a valid bearer token over HTTPS")
	}
	if timeout <= 0 || timeout > time.Minute {
		return nil, errors.New("invalid Glances timeout")
	}
	return &Client{strings.TrimSuffix(origin, "/") + "/api/4/sensors", token, telemetryhttp.NewClient(timeout)}, nil
}

// Unresolved Apple temperature keys can contain sentinel readings (e.g. TH0A = -127).
var smcTemperatureKey = regexp.MustCompile(`^T[[:alnum:]]{3}$`)

func (c *Client) Sensors(ctx context.Context) ([]management.Sensor, error) {
	var rows []struct {
		Label, Type, Unit        string
		Value, Warning, Critical *float64
	}
	if err := telemetryhttp.GetJSON(ctx, c.http, c.endpoint, c.token, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("expected Glances sensor array")
	}
	out := make([]management.Sensor, 0, len(rows))
	counts := make(map[string]int)
	for _, r := range rows {
		s := management.Sensor{ID: r.Type + ":" + r.Label, Name: r.Label, State: "unavailable", Value: "Unavailable", Warning: r.Warning, Critical: r.Critical}
		switch {
		case (r.Type == "temperature_core" || r.Type == "temperature_hdd") && r.Unit == "C":
			s.Unit = "degrees C"
			s.DetailOnly = smcTemperatureKey.MatchString(s.Name) && !strings.EqualFold(s.Name, "temp")
		case r.Type == "fan_speed" && (r.Unit == "R" || r.Unit == "RPM"):
			s.Unit = "RPM"
		default:
			continue
		}
		if strings.TrimSpace(s.Name) == "" {
			return nil, errors.New("missing Glances sensor label")
		}
		if r.Value != nil {
			s.Value = strconv.FormatFloat(*r.Value, 'f', -1, 64)
			s.State = "ok"
			if s.DetailOnly {
				s.State = "unmapped"
			} else if s.Unit == "degrees C" {
				switch {
				case s.Critical != nil && *r.Value >= *s.Critical:
					s.State = "critical"
				case s.Warning != nil && *r.Value >= *s.Warning:
					s.State = "warning"
				}
			}
		}
		counts[s.ID]++
		out = append(out, s)
	}
	for i := range out {
		// Identical labels can belong to different chips. Keep all readings but withhold ambiguous widget IDs.
		if counts[out[i].ID] > 1 {
			out[i].ID = ""
		}
	}
	return out, nil
}
