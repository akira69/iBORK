package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/akira69/iBORK/internal/server"
)

type deviceProfile struct {
	Telemetry            server.TelemetrySettings `json:"telemetry,omitzero"`
	GlancesTokenFile     string                   `json:"glancesTokenFile,omitempty"`
	MeterSecretFile      string                   `json:"meterSecretFile,omitempty"`
	ID                   string                   `json:"id"`
	Name                 string                   `json:"name"`
	Host                 string                   `json:"host"`
	Port                 int                      `json:"port"`
	Username             string                   `json:"username"`
	PasswordFile         string                   `json:"passwordFile"`
	KGKeyFile            string                   `json:"kgKeyFile,omitempty"`
	JetURL               string                   `json:"jetUrl"`
	JetPasswordFile      string                   `json:"jetPasswordFile"`
	Manufacturer         string                   `json:"manufacturer"`
	Model                string                   `json:"model"`
	VNCHost              string                   `json:"vncHost,omitempty"`
	VNCKind              string                   `json:"vncKind,omitempty"`
	VNCTransport         string                   `json:"vncTransport,omitempty"`
	GLURL                string                   `json:"glUrl,omitempty"`
	GLUsername           string                   `json:"glUsername,omitempty"`
	GLPasswordFile       string                   `json:"glPasswordFile,omitempty"`
	GLCertificateSHA256  string                   `json:"glCertificateSHA256,omitempty"`
	VNCPort              int                      `json:"vncPort,omitempty"`
	VNCPasswordFile      string                   `json:"vncPasswordFile,omitempty"`
	VNCCertificateSHA256 string                   `json:"vncCertificateSHA256,omitempty"`
}

// legacyProfiles imports only the endpoints explicitly configured in the environment.
func legacyProfiles() ([]deviceProfile, error) {
	p := deviceProfile{
		Host: os.Getenv("IPMI_HOST"), Username: os.Getenv("IPMI_USERNAME"),
		PasswordFile: os.Getenv("IPMI_PASSWORD_FILE"), KGKeyFile: os.Getenv("IPMI_KG_KEY_FILE"),
		JetURL: os.Getenv("JETKVM_URL"), JetPasswordFile: os.Getenv("JETKVM_PASSWORD_FILE"),
	}
	if value := os.Getenv("IPMI_PORT"); value != "" {
		port, err := strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid IPMI_PORT")
		}
		p.Port = port
	}
	if p == (deviceProfile{}) {
		return nil, nil
	}
	p.ID, p.Name = "default", os.Getenv("SERVER_NAME")
	return []deviceProfile{p}, nil
}

func readProfiles(path string) ([]deviceProfile, error) {
	return readProfilesFile(path, false)
}

const maxProfilesBytes = 64 * 1024

func readProfilesFile(path string, allowEmpty bool) ([]deviceProfile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot read DEVICES_FILE")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxProfilesBytes+1))
	if err != nil || len(data) > maxProfilesBytes {
		return nil, errors.New("DEVICES_FILE is unreadable or too large")
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	var profiles []deviceProfile
	if d.Decode(&profiles) != nil || d.Decode(&struct{}{}) != io.EOF || profiles == nil || (!allowEmpty && len(profiles) == 0) || len(profiles) > 16 {
		return nil, errors.New("DEVICES_FILE must contain 1 to 16 valid device profiles")
	}
	ids, endpoints := map[string]bool{}, map[string]bool{}
	for i, profile := range profiles {
		p, err := normalizeProfile(profile)
		if err != nil {
			return nil, err
		}
		if ids[p.ID] {
			return nil, errors.New("duplicate device ID")
		}
		ids[p.ID] = true
		for _, endpoint := range profileEndpoints(p) {
			if endpoints[endpoint] {
				return nil, errors.New("duplicate device endpoint")
			}
			endpoints[endpoint] = true
		}
		profiles[i] = p
	}

	return profiles, nil
}

func fileSecret(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read a device credential file")
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}

var profileIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
var certificatePinPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func normalizedHost(host string) (string, error) {
	if ip := net.ParseIP(host); ip != nil {
		return ip.String(), nil
	}
	if host == "" || len(host) > 253 || !hostnamePattern.MatchString(host) {
		return "", errors.New("invalid device hostname")
	}
	return strings.TrimSuffix(strings.ToLower(host), "."), nil
}

func normalizedConsoleURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("console address must be an HTTP(S) origin")
	}
	host, err := normalizedHost(u.Hostname())
	if err != nil {
		return "", err
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", errors.New("invalid console port")
	}
	return u.Scheme + "://" + net.JoinHostPort(host, strconv.Itoa(n)), nil
}

func normalizeProfile(p deviceProfile) (deviceProfile, error) {
	invalid := func(message string) (deviceProfile, error) { return deviceProfile{}, errors.New(message) }
	if !profileIDPattern.MatchString(p.ID) || len(p.Name) > 100 || len(p.Manufacturer) > 100 || len(p.Model) > 100 {
		return invalid("invalid device profile")
	}
	if p.Host != "" {
		_, err := normalizedHost(p.Host)
		if err != nil {
			return invalid("invalid management host")
		}
		if p.Port == 0 {
			p.Port = 623
		}
		if p.Username == "" {
			p.Username = "ADMIN"
		}
		if p.Port < 1 || p.Port > 65535 || len(p.Username) > 16 {
			return invalid("invalid management port or username")
		}
	} else if p.Port != 0 || p.Username != "" || p.PasswordFile != "" || p.KGKeyFile != "" {
		return invalid("management fields require a BMC host")
	}
	if p.Name == "" {
		p.Name = p.Host
		if p.Name == "" {
			p.Name = p.ID
		}
	}
	sources := 0
	if p.JetURL != "" {
		u, e := normalizedConsoleURL(p.JetURL)
		if e != nil {
			return invalid("invalid JetKVM origin")
		}
		p.JetURL = u
		sources++
	} else if p.JetPasswordFile != "" {
		return invalid("JetKVM password requires an endpoint")
	}
	if p.VNCPort != 0 {
		sources++
		if p.VNCKind == "" {
			p.VNCKind = "dell"
		}
		if p.VNCTransport == "" {
			p.VNCTransport = "tls"
		}
		if p.VNCHost == "" && p.VNCKind == "dell" {
			p.VNCHost = p.Host
		}
		h, e := normalizedHost(p.VNCHost)
		if e != nil {
			return invalid("VNC requires a host")
		}
		p.VNCHost = h
		if p.VNCPort < 1 || p.VNCPort > 65535 || p.VNCPasswordFile == "" || (p.VNCKind != "dell" && p.VNCKind != "generic") || (p.VNCTransport != "tls" && p.VNCTransport != "tcp") || (p.VNCKind == "dell" && p.VNCTransport != "tls") {
			return invalid("invalid VNC transport or credentials")
		}
		if (p.VNCTransport == "tls" && !certificatePinPattern.MatchString(p.VNCCertificateSHA256)) || (p.VNCTransport == "tcp" && p.VNCCertificateSHA256 != "") {
			return invalid("TLS VNC requires a certificate pin; TCP must not specify one")
		}
	} else if p.VNCHost != "" || p.VNCKind != "" || p.VNCTransport != "" || p.VNCPasswordFile != "" || p.VNCCertificateSHA256 != "" {
		return invalid("VNC settings require a port")
	}
	if p.GLURL != "" {
		sources++
		u, e := normalizedConsoleURL(p.GLURL)
		if e != nil {
			return invalid("invalid Comet origin")
		}
		p.GLURL = u
		if p.GLUsername == "" {
			p.GLUsername = "admin"
		}
		if len(p.GLUsername) > 64 || p.GLPasswordFile == "" {
			return invalid("Comet requires credentials")
		}
		if (strings.HasPrefix(u, "https:") && !certificatePinPattern.MatchString(p.GLCertificateSHA256)) || (strings.HasPrefix(u, "http:") && p.GLCertificateSHA256 != "") {
			return invalid("HTTPS Comet requires a certificate pin; HTTP must not specify one")
		}
	} else if p.GLUsername != "" || p.GLPasswordFile != "" || p.GLCertificateSHA256 != "" {
		return invalid("Comet settings require an endpoint")
	}
	if err := normalizeTelemetry(&p); err != nil {
		return deviceProfile{}, err
	}
	if p.Host == "" && (sources > 1 || (sources == 0 && p.Telemetry.GlancesURL == "" && p.Telemetry.MeterKind == "")) {
		return invalid("standalone devices require exactly one console source")
	}
	return p, nil
}

func profileEndpoints(p deviceProfile) []string {
	var out []string
	t := p.Telemetry
	if t.GlancesURL != "" {
		out = append(out, "glances:"+t.GlancesURL)
	}
	if t.MeterKind != "" {
		out = append(out, "outlet:"+t.OutletID, t.MeterKind+":"+t.MeterURL+"/"+t.MeterChannel)
	}
	if p.Host != "" {
		host, _ := normalizedHost(p.Host)
		out = append(out, "ipmi:"+net.JoinHostPort(host, strconv.Itoa(p.Port)))
	}
	if p.JetURL != "" {
		out = append(out, p.JetURL)
	}
	if p.GLURL != "" {
		out = append(out, p.GLURL)
	}
	if p.VNCPort != 0 {
		out = append(out, "vnc:"+net.JoinHostPort(p.VNCHost, strconv.Itoa(p.VNCPort)))
	}
	return out
}
