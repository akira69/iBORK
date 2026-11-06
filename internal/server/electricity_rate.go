package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type electricityRate struct {
	USDPerKwh float64 `json:"usdPerKwh"`
}

func (rate *electricityRate) UnmarshalJSON(data []byte) error {
	if err := (panelFields{"usdPerKwh": &rate.USDPerKwh}).UnmarshalJSON(data); err != nil {
		return err
	}
	if rate.USDPerKwh < 0 || rate.USDPerKwh > 1000 {
		return errors.New("electricity rate must be between 0 and 1000 USD/kWh")
	}
	return nil
}

// SetElectricityRate restores the saved rate before serving the dashboard or any panels.
func (s *Server) SetElectricityRate(data []byte, save func([]byte) error) error {
	if data != nil {
		var saved electricityRate
		if err := json.Unmarshal(data, &saved); err != nil {
			return err
		}
		s.rate = saved
	}
	s.saveRate = save
	return nil
}

func (s *Server) currentRate() electricityRate {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rate
}

func (s *Server) electricityRateSettings(w http.ResponseWriter, r *http.Request, session context.Context) {
	if r.Method == http.MethodGet {
		reply(w, 200, s.currentRate())
		return
	}
	if r.Method != http.MethodPut {
		fail(w, 405, "Method not allowed")
		return
	}
	var next electricityRate
	if !decode(w, r, &next) || !s.beginSettingsChange(w) {
		return
	}
	defer s.settingsMu.Unlock()
	if r.Context().Err() != nil || session.Err() != nil {
		fail(w, 408, "Electricity rate request expired")
		return
	}
	data, err := json.Marshal(next)
	if err != nil || s.saveRate == nil || s.saveRate(data) != nil {
		fail(w, 503, "Could not save electricity rate")
		return
	}
	s.mu.Lock()
	s.rate = next
	s.mu.Unlock()
	if p := s.panel; p != nil {
		p.snapshotMu.Lock()
		p.capturedAt = time.Time{}
		p.snapshotMu.Unlock()
	}
	reply(w, 200, next)
}
