package main

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/akira69/iBORK/internal/glances"
	"github.com/akira69/iBORK/internal/meter"
	"github.com/akira69/iBORK/internal/server"
	"github.com/akira69/iBORK/internal/telemetryhttp"
)

// Canonical addresses bind saved credentials and meter identities to one endpoint.
func normalizeTelemetry(p *deviceProfile) error {
	t := &p.Telemetry
	if t.GlancesURL != "" {
		if err := glances.ValidateURL(t.GlancesURL); err != nil {
			return err
		}
		origin, err := normalizedConsoleURL(t.GlancesURL)
		if err != nil {
			return err
		}
		t.GlancesURL = origin
		if p.GlancesTokenFile != "" && !strings.HasPrefix(origin, "https://") {
			return errors.New("use HTTPS for a Glances token")
		}
	} else if p.GlancesTokenFile != "" {
		return errors.New("Glances token requires an endpoint")
	}

	switch t.MeterKind {
	case "":
		if t.OutletID != "" || t.MeterURL != "" || t.MeterChannel != "" || t.WattsField != "" || t.MeterUser != "" || p.MeterSecretFile != "" {
			return errors.New("select a power meter source")
		}
		return nil
	case "home-assistant":
		if err := meter.ValidateHomeAssistant(t.MeterURL, t.MeterChannel); err != nil {
			return err
		}
		if p.MeterSecretFile == "" || t.MeterUser != "" || t.WattsField != "" {
			return errors.New("Matter via Home Assistant requires a bearer token")
		}
		origin, err := normalizedConsoleURL(t.MeterURL)
		if err != nil {
			return err
		}
		t.MeterURL = origin
	case "mqtt":
		// The actual password is read only when constructing the client.
		var password string
		if p.MeterSecretFile != "" {
			password = "configured"
		}
		if err := meter.ValidateMQTT(t.MeterURL, t.MeterChannel, t.MeterUser, password, t.WattsField); err != nil {
			return err
		}
		u, err := url.Parse(t.MeterURL)
		if err != nil {
			return err
		}
		host, err := normalizedHost(u.Hostname())
		if err != nil {
			return err
		}
		port := 1883
		if u.Scheme == "mqtts" {
			port = 8883
		}
		if u.Port() != "" {
			port, _ = strconv.Atoi(u.Port()) // ValidateMQTT checked the range.
		}
		t.MeterURL = u.Scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port))
		if t.WattsField == "" {
			t.WattsField = "watts"
		}
	default:
		return errors.New("unknown power meter source")
	}
	t.OutletID = strings.ToLower(strings.TrimSpace(t.OutletID))
	if !profileIDPattern.MatchString(t.OutletID) {
		return errors.New("enter a physical outlet ID of 1–32 lowercase letters, digits or hyphens")
	}
	return nil
}

func applyTelemetry(p *deviceProfile, input server.DeviceSettings) error {
	if input.Telemetry == nil {
		if input.GlancesToken != nil || input.MeterSecret != nil {
			return errors.New("telemetry settings required with a credential")
		}
		return nil
	}
	old := p.Telemetry
	p.Telemetry = *input.Telemetry
	if input.GlancesToken != nil && *input.GlancesToken != "" && !telemetryhttp.ValidBearer(*input.GlancesToken) {
		return errors.New("enter a valid Glances bearer token")
	}
	if p.Telemetry.MeterKind == "home-assistant" && input.MeterSecret != nil && !telemetryhttp.ValidBearer(*input.MeterSecret) {
		return errors.New("enter a valid Home Assistant bearer token")
	}
	if p.Telemetry.GlancesURL == "" {
		p.GlancesTokenFile = ""
	}
	if p.Telemetry.MeterKind == "" {
		p.MeterSecretFile = ""
	}
	// Validate with the prospective credential state before staging any files.
	next := *p
	for _, cred := range []struct {
		value *string
		file  *string
	}{{input.GlancesToken, &next.GlancesTokenFile}, {input.MeterSecret, &next.MeterSecretFile}} {
		if cred.value != nil {
			*cred.file = ""
			if *cred.value != "" {
				*cred.file = "pending"
			}
		}
	}
	if err := normalizeTelemetry(&next); err != nil {
		return err
	}
	p.Telemetry = next.Telemetry
	if input.GlancesToken == nil && p.GlancesTokenFile != "" && old.GlancesURL != next.Telemetry.GlancesURL {
		return errors.New("re-enter the Glances token for a changed endpoint")
	}
	if input.MeterSecret == nil && p.MeterSecretFile != "" && (old.MeterKind != next.Telemetry.MeterKind || old.MeterURL != next.Telemetry.MeterURL || old.MeterUser != next.Telemetry.MeterUser) {
		return errors.New("re-enter the credential for a changed meter connection")
	}
	return nil
}
