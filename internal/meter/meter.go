package meter

import (
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/akira69/iBORK/internal/energy"
)

const timeout = 5 * time.Second

func origin(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || strings.ContainsAny(raw, "?#") || (u.EscapedPath() != "" && u.EscapedPath() != "/") || strings.HasSuffix(u.Host, ":") {
		return nil, errors.New("enter a server URL with no credentials, path, query or fragment")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, errors.New("invalid server port")
		}
	}
	return u, nil
}

func observation(watts float64, at, now time.Time) (energy.Sample, error) {
	if math.IsNaN(watts) || math.IsInf(watts, 0) || watts < 0 || watts > 65535 {
		return energy.Sample{}, errors.New("power reading is outside the supported watts range")
	}
	if at.IsZero() || at.After(now) || now.Sub(at) > energy.MaxSampleAge {
		return energy.Sample{}, errors.New("power observation timestamp is missing, stale or in the future")
	}
	return energy.Sample{Watts: watts, At: at.Unix()}, nil
}
