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
	sensorTTL         = 20 * time.Second
	panelSensorMaxAge = 90 * time.Second
)

func (s *Server) readSensors(ctx context.Context) (any, error) {
	return s.cachedRead(ctx, "sensors", sensorTTL, func(ctx context.Context) (any, error) { return s.sensors(ctx) })
}

// A cold BMC scan can outlast the panel's HTTPS deadline. Let the next poll use its result.
func (s *Server) panelSensors(panelCtx context.Context) []management.Sensor {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	now := time.Now()
	hit := s.cache["sensors"]
	if now.Before(hit.expires) {
		return hit.value.([]management.Sensor)
	}
	if !s.panelRefreshing && !now.Before(s.panelRetryAfter) && panelCtx.Err() == nil {
		s.panelRefreshing = true
		go func() {
			ctx, cancel := context.WithTimeout(panelCtx, s.cfg.Timeout)
			defer cancel()
			_, err := s.readSensors(ctx)
			s.cacheMu.Lock()
			defer s.cacheMu.Unlock()
			s.panelRefreshing = false
			if err != nil {
				s.panelRetryAfter = time.Now().Add(sensorTTL)
			}
		}()
	}
	// The panel polls every 30 seconds. Keep the last reading visible during bounded refreshes.
	if now.Before(hit.expires.Add(panelSensorMaxAge - sensorTTL)) {
		return hit.value.([]management.Sensor)
	}
	return nil
}

type panelReadings struct {
	ID          string   `json:"id"`
	Temperature *float64 `json:"temperature"`
	Fan         *float64 `json:"fan"`
}

func (s *Server) panelDetail(ctx context.Context, device panelDevice) panelReadings {
	detail := panelReadings{ID: device.ID}
	wantTemp := slices.Contains(device.Widgets, "temperature")
	wantFan := slices.Contains(device.Widgets, "fan")
	if !wantTemp && !wantFan {
		return detail
	}
	for _, sensor := range s.panelSensors(ctx) {
		if sensor.DetailOnly || sensor.State == "unavailable" || sensor.State == "unmapped" {
			continue
		}
		n, err := strconv.ParseFloat(sensor.Value, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			continue
		}
		switch sensor.Unit {
		case "RPM":
			if wantFan && n >= 0 && (detail.Fan == nil || n < *detail.Fan) {
				detail.Fan = &n
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
