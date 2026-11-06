package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"image/jpeg"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type panelIcon struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Image []byte `json:"image"`
}

type panelIconList struct {
	Icons []panelIcon `json:"icons"`
}

func (list panelIconList) validated() (map[string]panelIcon, error) {
	invalid := errors.New("expected up to 16 distinct server icons with a short label and a 40 by 40 JPEG")
	if list.Icons == nil || len(list.Icons) > 16 {
		return nil, invalid
	}
	icons := make(map[string]panelIcon, len(list.Icons))
	for _, icon := range list.Icons {
		if _, exists := icons[icon.ID]; exists || icon.ID == "" || len(icon.ID) > 32 ||
			strings.TrimSpace(icon.Label) == "" || utf8.RuneCountInString(icon.Label) > 6 ||
			strings.IndexFunc(icon.Label, unicode.IsControl) >= 0 || len(icon.Image) > 2048 {
			return nil, invalid
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(icon.Image))
		if err != nil || cfg.Width != 40 || cfg.Height != 40 {
			return nil, invalid
		}
		im, err := jpeg.Decode(bytes.NewReader(icon.Image))
		if err != nil {
			return nil, invalid
		}
		// Publish a baseline JPEG without delivering browser-supplied metadata to firmware.
		var clean bytes.Buffer
		if jpeg.Encode(&clean, im, &jpeg.Options{Quality: 78}) != nil || clean.Len() > 2048 {
			return nil, invalid
		}
		icon.Image = clean.Bytes()
		icons[icon.ID] = icon
	}
	return icons, nil
}

func (s *Server) SetPanelIcons(data []byte, save func([]byte) error) error {
	if data != nil {
		var list panelIconList
		if err := json.Unmarshal(data, &list); err != nil {
			return err
		}
		icons, err := list.validated()
		if err != nil {
			return err
		}
		s.panel.icons = icons
	}
	s.panel.saveIcons = save
	return nil
}

func (s *Server) panelIcons(w http.ResponseWriter, r *http.Request) {
	p := s.panel
	if p == nil {
		fail(w, 404, "Panel access is disabled")
		return
	}
	if r.Method != http.MethodPut {
		fail(w, 405, "Use PUT to copy sidebar icons")
		return
	}
	var list panelIconList
	if !decode(w, r, &list) {
		return
	}
	icons, err := list.validated()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if len(icons) != len(s.devices) {
		fail(w, 409, "Fleet changed. Reload before copying icons.")
		return
	}
	for id := range icons {
		if s.devices[id] == nil {
			fail(w, 409, "Fleet changed. Reload before copying icons.")
			return
		}
	}
	// Publish the icon set and discard any snapshot built with the previous icons.
	p.snapshotMu.Lock()
	defer p.snapshotMu.Unlock()
	data, err := json.Marshal(list)
	if err != nil || p.ctx.Err() != nil || r.Context().Err() != nil || p.saveIcons == nil || p.saveIcons(data) != nil {
		fail(w, 503, "Could not save panel icons")
		return
	}
	p.icons = icons
	p.capturedAt = time.Time{}
	reply(w, 200, map[string]bool{"ok": true})
}
