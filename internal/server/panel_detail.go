package server

import (
	"context"
	"math"
	"slices"
	"strconv"
	"time"

	"github.com/akira69/iBORK/internal/management"
)

const (
	powerTTL          = 5 * time.Second
	sensorTTL         = 20 * time.Second
	panelSensorMaxAge = 90 * time.Second
)

func (s *Server) readSensors(ctx context.Context) (any, error) {
	return s.cachedRead(ctx, "sensors", sensorTTL, func(ctx context.Context) (any, error) { return s.sensors(ctx) })
}

func (s *Server) readPower(ctx context.Context) (any, error) {
	return s.cachedRead(ctx, "power", powerTTL, func(ctx context.Context) (any, error) { return s.provider.Power(ctx) })
}

type panelRefresh struct {
	running    bool
	retryAfter time.Time
}

// A cold BMC scan can outlast the panel's HTTPS deadline. Let the next poll use its result.
func (s *Server) panelCached(panelCtx context.Context, key string, ttl, maxAge time.Duration, scan *panelRefresh, read func(context.Context) (any, error)) (any, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	now := time.Now()
	hit := s.cache[key]
	if now.Before(hit.expires) {
		return hit.value, true
	}
	if !scan.running && !now.Before(scan.retryAfter) && panelCtx.Err() == nil {
		scan.running = true
		go func() {
			ctx, cancel := context.WithTimeout(panelCtx, s.cfg.Timeout)
			defer cancel()
			_, err := read(ctx)
			s.cacheMu.Lock()
			defer s.cacheMu.Unlock()
			scan.running = false
			if err != nil {
				scan.retryAfter = time.Now().Add(ttl)
			}
		}()
	}
	// Keep the last reading visible during bounded refreshes.
	if now.Before(hit.expires.Add(maxAge - ttl)) {
		return hit.value, false
	}
	return nil, false
}

type panelReadings struct {
	Pending     bool     `json:"pending,omitempty"`
	ID          string   `json:"id"`
	Image       []byte   `json:"image,omitempty"`
	PowerState  string   `json:"powerState,omitempty"`
	PowerFresh  *bool    `json:"powerFresh,omitempty"`
	Temperature *float64 `json:"temperature"`
	Fan         *float64 `json:"fan"`
	FanMax      *float64 `json:"fanMax"`
}

func (s *Server) panelDetail(ctx context.Context, device panelDevice) panelReadings {
	detail := panelReadings{ID: device.ID}
	if device.Controls && s.provider != nil {
		cached, fresh := s.panelCached(ctx, "power", powerTTL, 40*time.Second, &s.panelPowerScan, s.readPower)
		power, _ := cached.(management.PowerState)
		if power.State == "on" || power.State == "off" {
			detail.PowerState = power.State
			detail.PowerFresh = &fresh
		}
	}
	wantTemp := slices.Contains(device.Widgets, "temperature")
	wantFan := slices.Contains(device.Widgets, "fan")
	if !wantTemp && !wantFan {
		return detail
	}
	cached, _ := s.panelCached(ctx, "sensors", sensorTTL, panelSensorMaxAge, &s.panelSensorScan, s.readSensors)
	sensors, _ := cached.([]management.Sensor)
	for _, sensor := range sensors {
		if sensor.DetailOnly || sensor.State == "unavailable" || sensor.State == "unmapped" {
			continue
		}
		n, err := strconv.ParseFloat(sensor.Value, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			continue
		}
		switch sensor.Unit {
		case "RPM":
			if !wantFan || n < 0 {
				continue
			}
			if detail.Fan == nil || n < *detail.Fan {
				detail.Fan = &n
			}
			if detail.FanMax == nil || n > *detail.FanMax {
				detail.FanMax = &n
			}
			continue
		case "degrees F":
			n = (n - 32) * (5.0 / 9)
		case "degrees K":
			n -= 273.15
		case "degrees C":
		default:
			continue
		}
		if wantTemp && (detail.Temperature == nil || n > *detail.Temperature) {
			detail.Temperature = &n
		}
	}
	return detail
}
