package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"testing"
)

func TestPanelIconPublication(t *testing.T) {
	s, _ := testServer(t)
	cookie, csrf := login(t, s)
	s.cfg.Origin = "https://localhost:8080"
	key := token()
	if err := s.EnablePanel(key, "", nil); err != nil {
		t.Fatal(err)
	}
	var imageData bytes.Buffer
	if err := jpeg.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 40, 40)), nil); err != nil {
		t.Fatal(err)
	}
	icon := panelIcon{ID: s.deviceOrder[0], Label: "DB", Image: imageData.Bytes()}
	put := func(list []panelIcon, token string) int {
		b, err := json.Marshal(panelIconList{Icons: list})
		if err != nil {
			t.Fatal(err)
		}
		return request(s, "PUT", "/api/panel-icons", string(b), cookie, token, s.cfg.Origin).Code
	}
	snapshot := func() []byte { return panelRequest(s, "GET", "/api/v1/panel", "", "Bearer "+key).Body.Bytes() }
	if bytes.Contains(snapshot(), []byte(`"sidebar"`)) {
		t.Fatal("unexpected icon")
	}
	if put([]panelIcon{icon}, "") != 403 || put([]panelIcon{icon, icon}, csrf) != 400 {
		t.Fatal("invalid publish accepted")
	}
	if put([]panelIcon{}, csrf) != 409 {
		t.Fatal("stale inventory accepted")
	}
	s.panel.saveIcons = func([]byte) error { return errors.New("disk full") }
	if put([]panelIcon{icon}, csrf) != 503 || bytes.Contains(snapshot(), []byte(`"sidebar"`)) {
		t.Fatal("failed publication leaked")
	}
	var saved []byte
	s.panel.saveIcons = func(data []byte) error { saved = data; return nil }
	if put([]panelIcon{icon}, csrf) != 200 || !bytes.Contains(snapshot(), []byte(`"label":"DB"`)) {
		t.Fatal("missing new sidebar icon")
	}
	if err := s.SetPanelIcons(saved, s.panel.saveIcons); err != nil || s.panel.icons[icon.ID].Label != "DB" {
		t.Fatal("could not restore icons", err)
	}
	icon.DetailImage = icon.Image
	if put([]panelIcon{icon}, csrf) != 400 {
		t.Fatal("accepted thumbnail as detail image")
	}
	var fullImage bytes.Buffer
	if err := jpeg.Encode(&fullImage, image.NewRGBA(image.Rect(0, 0, 80, 80)), nil); err != nil {
		t.Fatal(err)
	}
	icon.DetailImage = fullImage.Bytes()
	if put([]panelIcon{icon}, csrf) != 200 || bytes.Contains(snapshot(), []byte("detailImage")) {
		t.Fatal("detail artwork leaked into fleet snapshot")
	}
	var snap struct{ Detail panelReadings }
	body := panelRequest(s, "GET", "/api/v1/panel?detail="+icon.ID, "", "Bearer "+key).Body.Bytes()
	if json.Unmarshal(body, &snap) != nil || len(snap.Detail.Image) == 0 {
		t.Fatal("selected artwork absent")
	}

	for _, bad := range [][]byte{nil, make([]byte, 2049), imageData.Bytes()[:20]} {
		icon.Image = bad
		if put([]panelIcon{icon}, csrf) != 400 {
			t.Fatal("invalid thumbnail accepted")
		}
	}
}
