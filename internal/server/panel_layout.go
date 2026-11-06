package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"slices"
	"time"
)

var homeWidgets = []string{"power", "day", "month", "servers"}
var deviceWidgets = []string{"power", "temperature", "fan", "controls"}

type panelRow struct {
	ID        string   `json:"id"`
	Included  bool     `json:"included"`
	Widgets   []string `json:"widgets"`
	Available []string `json:"available,omitzero"`
}

func (r *panelRow) UnmarshalJSON(data []byte) error {
	return panelFields{"id": &r.ID, "included": &r.Included, "widgets": &r.Widgets}.UnmarshalJSON(data)
}

type panelLayout struct {
	Revision uint32     `json:"revision"`
	Home     []string   `json:"home"`
	Servers  []panelRow `json:"servers"`
}

func (l *panelLayout) UnmarshalJSON(data []byte) error {
	if err := (panelFields{"revision": &l.Revision, "home": &l.Home, "servers": &l.Servers}).UnmarshalJSON(data); err != nil {
		return err
	}
	invalid := errors.New("invalid panel layout")
	if l.Revision == 0 || len(l.Home) == 0 || !validWidgets(l.Home, homeWidgets) || len(l.Servers) > 16 {
		return invalid
	}
	seen := make(map[string]bool, len(l.Servers))
	for _, row := range l.Servers {
		if seen[row.ID] || !deviceIDPattern.MatchString(row.ID) || !validWidgets(row.Widgets, deviceWidgets) {
			return invalid
		}
		seen[row.ID] = true
	}
	return nil
}

func validWidgets(widgets, allowed []string) bool {
	for i, widget := range widgets {
		if !slices.Contains(allowed, widget) || slices.Contains(widgets[:i], widget) {
			return false
		}
	}
	return true
}

func (s *Server) availableWidgets(id string) []string {
	d := s.devices[id]
	out := []string{}
	if d.cfg.History != nil {
		out = append(out, "power")
	}
	if d.sensors != nil {
		out = append(out, "temperature", "fan")
	}
	if d.provider != nil && s.panel.pinCost != 0 {
		out = append(out, "controls")
	}
	return out
}

// Caller holds snapshotMu. Saved rows keep their order across inventory reloads.
func (s *Server) effectiveLayout() panelLayout {
	saved := s.panel.layout
	layout := panelLayout{Revision: 1, Home: homeWidgets, Servers: []panelRow{}}
	seen := make(map[string]bool, len(s.devices))
	if saved != nil {
		layout.Revision, layout.Home = saved.Revision, saved.Home
		for _, row := range saved.Servers {
			if s.devices[row.ID] == nil {
				continue
			}
			row.Available = s.availableWidgets(row.ID)
			selected := []string{}
			for _, widget := range row.Widgets {
				if slices.Contains(row.Available, widget) {
					selected = append(selected, widget)
				}
			}
			row.Widgets = selected
			layout.Servers = append(layout.Servers, row)
			seen[row.ID] = true
		}
	}
	for _, id := range s.deviceOrder {
		if !seen[id] {
			available := s.availableWidgets(id)
			layout.Servers = append(layout.Servers, panelRow{id, saved == nil, available, available})
		}
	}
	return layout
}

func (s *Server) SetPanelLayout(data []byte, save func([]byte) error) error {
	if data != nil {
		var saved panelLayout
		if err := json.Unmarshal(data, &saved); err != nil {
			return err
		}
		s.panel.layout = &saved
	}
	s.panel.saveLayout = save
	return nil
}

func (s *Server) panelLayoutSettings(w http.ResponseWriter, r *http.Request, session context.Context) {
	p := s.panel
	if p == nil {
		fail(w, 404, "Panel access is disabled")
		return
	}
	if r.Method == http.MethodGet {
		p.snapshotMu.Lock()
		layout := s.effectiveLayout()
		p.snapshotMu.Unlock()
		reply(w, 200, layout)
		return
	}
	if r.Method != http.MethodPut {
		fail(w, 405, "Method not allowed")
		return
	}
	var next panelLayout
	if !decode(w, r, &next) {
		return
	}
	p.controlMu.Lock()
	defer p.controlMu.Unlock()
	p.snapshotMu.Lock()
	defer p.snapshotMu.Unlock()
	current := s.effectiveLayout()
	if next.Revision != current.Revision || len(next.Servers) != len(s.devices) {
		fail(w, 409, "Layout or fleet changed. Reload before saving.")
		return
	}
	for _, row := range next.Servers {
		if s.devices[row.ID] == nil || !validWidgets(row.Widgets, s.availableWidgets(row.ID)) {
			fail(w, 409, "Server capabilities changed. Reload before saving.")
			return
		}
	}
	if next.Revision == math.MaxUint32 || p.ctx.Err() != nil || session.Err() != nil || r.Context().Err() != nil {
		fail(w, 503, "Layout could not be updated")
		return
	}
	next.Revision++
	data, err := json.Marshal(next)
	if err != nil || p.saveLayout == nil || p.saveLayout(data) != nil {
		fail(w, 503, "Could not save panel layout")
		return
	}
	p.layout, p.capturedAt = &next, time.Time{}
	reply(w, 200, s.effectiveLayout())
}
