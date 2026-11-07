package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/akira69/iBORK/internal/assistant"
	"github.com/akira69/iBORK/internal/management"
)

func (s *Server) dashboardDevices() map[string]assistant.DashboardDevice {
	devices := make(map[string]assistant.DashboardDevice, len(s.devices))
	for id, d := range s.devices {
		devices[id] = assistant.DashboardDevice{Name: dashboardLabel(d.cfg.ServerName, 100), Management: d.provider != nil, Sensors: d.sensors != nil, Energy: d.cfg.History != nil, JetKVM: d.cfg.JetURL != "", VNC: d.cfg.VNCPort != 0, GLInet: d.cfg.GLURL != ""}
	}
	return devices
}

func dashboardLabel(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	if len(value) > limit {
		value = value[:limit]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

func (s *Server) dashboardSensors(ctx context.Context, id string) ([]assistant.DashboardSensor, error) {
	d, ok := s.devices[id]
	if !ok || d.sensors == nil {
		return nil, errors.New("Sensor source unavailable")
	}
	value, err := d.readSensors(ctx)
	if err != nil {
		return nil, err
	}
	raw, ok := value.([]management.Sensor)
	if !ok {
		return nil, errors.New("Invalid sensor source")
	}
	result := make([]assistant.DashboardSensor, 0, min(len(raw), 256))
	seen := map[string]bool{}
	for _, sensor := range raw {
		if sensor.DetailOnly || sensor.ID == "" || len(sensor.ID) > 128 || strings.IndexFunc(sensor.ID, unicode.IsControl) >= 0 || seen[sensor.ID] {
			continue
		}
		seen[sensor.ID] = true
		unit := dashboardLabel(sensor.Unit, 32)
		kind := "other"
		switch strings.ToLower(unit) {
		case "rpm":
			kind = "fan"
		case "c", "°c", "degrees c", "celsius":
			kind = "temperature"
		case "w", "watts":
			kind = "power"
		}
		reading := assistant.DashboardSensor{ID: sensor.ID, Name: dashboardLabel(sensor.Name, 100), Unit: unit, Type: kind}
		number, err := strconv.ParseFloat(strings.TrimSpace(sensor.Value), 64)
		reading.Valid = err == nil && !math.IsNaN(number) && !math.IsInf(number, 0) && sensor.State != "na" && sensor.State != "unavailable"
		if reading.Valid {
			reading.Value = &number
		}
		result = append(result, reading)
		if len(result) == 256 {
			break
		}
	}
	return result, nil
}

func (s *Server) publishAssistantDashboard(w http.ResponseWriter, r *http.Request, a *assistantSession, ctx context.Context) {
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		fail(w, 415, "JSON required")
		return
	}
	var input struct {
		assistant.Dashboard
		ExpectedRevision string `json:"expectedRevision"`
		Release          bool   `json:"release"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, assistant.DashboardLimit))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF {
		fail(w, 400, "Invalid dashboard request")
		return
	}
	if input.Release {
		if a.grant.Dashboard != nil && input.Instance != a.grant.Dashboard.Instance {
			fail(w, 409, "Dashboard belongs to another browser tab")
			return
		}
		s.unpair(a)
		a.grant.Dashboard = nil
		reply(w, 200, true)
		return
	}
	if err := a.grant.PublishDashboard(ctx, input.Dashboard, input.ExpectedRevision); err != nil {
		fail(w, 409, err.Error())
		return
	}
	reply(w, 200, a.grant.Dashboard)
}
