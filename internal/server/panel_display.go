package server

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"
)

type displayPeriod struct {
	Start      int `json:"start"`
	Brightness int `json:"brightness"`
}

func (p *displayPeriod) UnmarshalJSON(data []byte) error {
	return panelFields{"start": &p.Start, "brightness": &p.Brightness}.UnmarshalJSON(data)
}

type displaySchedule struct {
	Revision uint32          `json:"revision"`
	Periods  []displayPeriod `json:"periods"`
}

func (s *displaySchedule) fields() panelFields {
	return panelFields{"revision": &s.Revision, "periods": &s.Periods}
}

func (s displaySchedule) valid() bool {
	if s.Revision == 0 || len(s.Periods) != 4 {
		return false
	}
	var seen [1440]bool
	for _, p := range s.Periods {
		if p.Start < 0 || p.Start >= len(seen) || seen[p.Start] || p.Brightness < 0 || p.Brightness > 100 {
			return false
		}
		seen[p.Start] = true
	}
	return true
}

// SetPanelDisplay restores the settings before the server starts accepting requests.
func (s *Server) SetPanelDisplay(data []byte, save func([]byte) error) error {
	if data != nil {
		var saved displaySchedule
		fields := saved.fields()
		if json.Unmarshal(data, &fields) != nil || !saved.valid() {
			return errors.New("invalid saved panel display schedule")
		}
		s.panel.display = saved
	}
	s.panel.saveDisplay = save
	return nil
}

func (p *panelAccess) displaySettings(w http.ResponseWriter, r *http.Request, native bool) {
	if p == nil {
		fail(w, 404, "Panel access is disabled")
		return
	}
	if r.Method == "GET" {
		p.snapshotMu.Lock()
		current := p.display
		p.snapshotMu.Unlock()
		reply(w, 200, current)
		return
	}
	if r.Method != "PUT" {
		fail(w, 405, "Method not allowed")
		return
	}
	var next displaySchedule
	var pin string
	fields := next.fields()
	if native {
		if p.pinCost == 0 {
			fail(w, 403, "Panel controls are disabled")
			return
		}
		fields["pin"] = &pin
	}
	if !decode(w, r, &fields) {
		return
	}
	if !next.valid() {
		fail(w, 400, "Provide four unique start times and brightness values from 0 to 100")
		return
	}
	if native && !p.verifyPIN(w, pin) {
		return
	}
	p.snapshotMu.Lock()
	defer p.snapshotMu.Unlock()
	if next.Revision != p.display.Revision {
		fail(w, 409, "Display schedule changed; reload before saving")
		return
	}
	if p.ctx.Err() != nil || r.Context().Err() != nil || next.Revision == math.MaxUint32 {
		fail(w, 503, "Display schedule could not be updated")
		return
	}
	next.Revision++
	data, err := json.Marshal(next)
	if err != nil || p.saveDisplay == nil || p.saveDisplay(data) != nil {
		fail(w, 503, "Could not save the display schedule")
		return
	}
	p.display, p.capturedAt = next, time.Time{}
	reply(w, 200, map[string]bool{"ok": true})
}
