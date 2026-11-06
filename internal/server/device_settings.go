package server

import "net/http"

// Credentials are write-only; settings responses must leave these pointers nil.
type TelemetrySettings struct {
	GlancesURL   string `json:"glancesUrl,omitempty"`
	MeterKind    string `json:"meterKind,omitempty"`
	MeterURL     string `json:"meterUrl,omitempty"`
	MeterChannel string `json:"meterChannel,omitempty"`
	MeterUser    string `json:"meterUser,omitempty"`
	WattsField   string `json:"wattsField,omitempty"`
	OutletID     string `json:"outletId,omitempty"`
}

type DeviceSettings struct {
	HasGlancesToken      bool               `json:"hasGlancesToken,omitempty"`
	Telemetry            *TelemetrySettings `json:"telemetry,omitempty"`
	GlancesToken         *string            `json:"glancesToken,omitempty"`
	MeterSecret          *string            `json:"meterSecret,omitempty"`
	VNCHost              string             `json:"vncHost,omitempty"`
	VNCKind              string             `json:"vncKind,omitempty"`
	VNCTransport         string             `json:"vncTransport,omitempty"`
	VNCPort              *int               `json:"vncPort,omitempty"`
	VNCCertificateSHA256 string             `json:"vncCertificateSHA256,omitempty"`
	VNCPassword          *string            `json:"vncPassword,omitempty"`
	GLURL                *string            `json:"glUrl,omitempty"`
	GLUsername           string             `json:"glUsername,omitempty"`
	GLCertificateSHA256  string             `json:"glCertificateSHA256,omitempty"`
	GLPassword           *string            `json:"glPassword,omitempty"`
	ID                   string             `json:"id"`
	Name                 string             `json:"name"`
	Host                 string             `json:"host"`
	Port                 int                `json:"port"`
	Username             string             `json:"username"`
	JetURL               string             `json:"jetUrl"`
	Password             *string            `json:"password,omitempty"`
	JetPassword          *string            `json:"jetPassword,omitempty"`
	KGKey                *string            `json:"kgKey,omitempty"`
	KGKeyLocation        string             `json:"kgKeyLocation,omitempty"`
}

type DeviceSettingsStore interface {
	List() []DeviceSettings
	Save(DeviceSettings) error
	Remove(string) error
}

// SetDeviceSettings is called before serving requests. Reload runs after a save.
func (s *Server) SetDeviceSettings(store DeviceSettingsStore, reload func()) {
	s.settings, s.reload = store, reload
}

func (s *Server) deviceSettings(w http.ResponseWriter, r *http.Request) {
	if s.settings == nil {
		fail(w, 503, "Server settings are unavailable")
		return
	}
	if r.Method == "GET" {
		reply(w, 200, s.settings.List())
		return
	}
	if r.Method != "POST" && r.Method != "DELETE" {
		fail(w, 405, "Method not allowed")
		return
	}
	if !s.beginSettingsChange(w) {
		return
	}
	defer s.settingsMu.Unlock()
	var err error
	if r.Method == "DELETE" {
		var input struct {
			ID      string `json:"id"`
			Confirm string `json:"confirm"`
		}
		if !decode(w, r, &input) {
			return
		}
		if input.ID == "" || input.Confirm != input.ID {
			fail(w, 400, "Confirm the selected device ID")
			return
		}
		err = s.settings.Remove(input.ID)
	} else {
		var input DeviceSettings
		if !decode(w, r, &input) {
			return
		}
		err = s.settings.Save(input)
	}
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	s.reloading = true
	s.mu.Unlock()
	s.CloseSessions()
	reply(w, 200, map[string]bool{"saved": true, "signInRequired": false})
	s.reload()
}

// CloseSessions stops admission and cancels upgraded streams; WaitForSOL drains cleanup.
func (s *Server) CloseSessions() {
	s.closeDeviceSessions()
	for _, device := range s.devices {
		if device != s {
			device.closeDeviceSessions()
		}
	}
}
func (s *Server) closeDeviceSessions() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closing = true
	if s.panel != nil {
		s.panel.cancel()
	}
	for key, session := range s.sessions {
		session.cancel()
		if !s.reloading {
			delete(s.sessions, key)
		}
	}
}
