package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/akira69/iBORK/internal/management"
	"github.com/akira69/iBORK/internal/server"
)

type profileStore struct {
	mu       sync.Mutex
	dir      string
	profiles []deviceProfile
	pending  bool
}

func (s *profileStore) List() []server.DeviceSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]server.DeviceSettings, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, server.DeviceSettings{HasGlancesToken: p.GlancesTokenFile != "", Telemetry: &p.Telemetry, ID: p.ID, Name: p.Name, Host: p.Host, Port: p.Port, Username: p.Username, JetURL: p.JetURL, KGKeyLocation: p.KGKeyFile, VNCHost: p.VNCHost, VNCKind: p.VNCKind, VNCTransport: p.VNCTransport, VNCPort: &p.VNCPort, VNCCertificateSHA256: p.VNCCertificateSHA256, GLURL: &p.GLURL, GLUsername: p.GLUsername, GLCertificateSHA256: p.GLCertificateSHA256})
	}
	return out
}

var hostnamePattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)

func (s *profileStore) Save(input server.DeviceSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending {
		return errors.New("settings reload in progress; retry shortly")
	}
	if input.KGKeyLocation != "" {
		return errors.New("KG key storage location is managed by the app")
	}
	if input.KGKey != nil {
		if _, err := management.ParseKGKey(*input.KGKey); err != nil {
			return err
		}
	}
	if input.Name == "" || len(input.Name) > 100 {
		return errors.New("enter a device name")
	}
	host, hostErr := normalizedHost(input.Host)
	if input.Host != "" {
		if hostErr != nil || input.Port < 1 || input.Port > 65535 || input.Username == "" || len(input.Username) > 16 {
			return errors.New("enter a valid BMC host, port and username")
		}
	} else if input.Port != 0 || input.Username != "" || input.Password != nil || input.KGKey != nil {
		return errors.New("management fields require a BMC host")
	}
	for _, secret := range []struct {
		value *string
		max   int
	}{{input.Password, 64}, {input.JetPassword, 1024}, {input.GLPassword, 1024}, {input.GlancesToken, 4096}, {input.MeterSecret, 4096}} {
		if secret.value != nil && (len(*secret.value) > secret.max || strings.ContainsAny(*secret.value, "\r\n")) {
			return errors.New("invalid credential length or line break")
		}
	}
	if input.Password != nil && *input.Password == "" {
		return errors.New("BMC password cannot be empty")
	}
	if input.JetURL != "" {
		normalized, err := normalizedConsoleURL(input.JetURL)
		if err != nil {
			return err
		}
		input.JetURL = normalized
	}
	index := -1
	for i, p := range s.profiles {
		if p.ID == input.ID {
			index = i
		} else if input.Host != "" && strings.EqualFold(p.Host, input.Host) && p.Port == input.Port {
			return errors.New("a server already uses this BMC address and port")
		}
	}
	if input.ID != "" && index < 0 {
		return errors.New("server not found")
	}
	if index < 0 && len(s.profiles) >= 16 {
		return errors.New("maximum of 16 servers reached")
	}
	p := deviceProfile{}
	if index >= 0 {
		p = s.profiles[index]
		// DCMI history uses the saved host spelling as part of its directory key.
		if savedHost, err := normalizedHost(p.Host); err == nil && savedHost == host {
			input.Host = p.Host
		}
	}
	if err := applyTelemetry(&p, input); err != nil {
		return err
	}
	if input.Host != "" && input.Password == nil && (p.PasswordFile == "" || p.Host != input.Host || p.Port != input.Port || p.Username != input.Username) {
		return errors.New("enter the BMC password for a new or changed connection")
	}
	if p.KGKeyFile != "" && input.KGKey == nil && (p.Host != input.Host || p.Port != input.Port) {
		return errors.New("re-enter or remove the IPMI KG key for a changed BMC address or port")
	}
	oldJet, _ := normalizedConsoleURL(p.JetURL)
	if input.JetURL != "" && input.JetURL != oldJet && input.JetPassword == nil {
		return errors.New("enter the JetKVM password, or explicitly choose passwordless")
	}
	if input.VNCPort != nil {
		old := p
		p.VNCHost, p.VNCKind, p.VNCTransport, p.VNCPort, p.VNCCertificateSHA256 = input.VNCHost, input.VNCKind, input.VNCTransport, *input.VNCPort, input.VNCCertificateSHA256
		if p.VNCPort == 0 {
			p.VNCHost, p.VNCKind, p.VNCTransport, p.VNCPasswordFile, p.VNCCertificateSHA256 = "", "", "", "", ""
		} else {
			if p.VNCKind == "" {
				p.VNCKind = "dell"
			}
			if p.VNCTransport == "" {
				p.VNCTransport = "tls"
			}
			if p.VNCHost == "" && p.VNCKind == "dell" {
				p.VNCHost = input.Host
			}
			oldHost := old.VNCHost
			if oldHost == "" {
				oldHost = old.Host
			}
			oldKind := old.VNCKind
			if oldKind == "" {
				oldKind = "dell"
			}
			oldTransport := old.VNCTransport
			if oldTransport == "" {
				oldTransport = "tls"
			}
			if input.VNCPassword == nil && (p.VNCPasswordFile == "" || p.VNCHost != oldHost || p.VNCPort != old.VNCPort || p.VNCKind != oldKind || p.VNCTransport != oldTransport || !strings.EqualFold(p.VNCCertificateSHA256, old.VNCCertificateSHA256)) {
				return errors.New("re-enter VNC credentials and verify trust for a changed connection")
			}
		}
	} else if input.VNCPassword != nil {
		return errors.New("VNC settings required with a password")
	}
	if input.VNCPassword != nil {
		value := *input.VNCPassword
		if p.VNCPort == 0 || len(value) < 1 || len(value) > 8 || (p.VNCKind != "generic" && len(value) != 8) {
			return errors.New("VNC password must be 1-8 printable ASCII bytes (exactly 8 for Dell)")
		}
		for _, b := range []byte(value) {
			if b < 32 || b > 126 {
				return errors.New("VNC password must use printable ASCII")
			}
		}
	}
	if input.GLURL != nil {
		u := *input.GLURL
		if u != "" {
			var err error
			u, err = normalizedConsoleURL(u)
			if err != nil {
				return err
			}
		}
		oldURL, _ := normalizedConsoleURL(p.GLURL)
		username := input.GLUsername
		if u != "" && username == "" {
			username = "admin"
		}
		if u != "" && input.GLPassword == nil && (p.GLPasswordFile == "" || u != oldURL || username != p.GLUsername || !strings.EqualFold(input.GLCertificateSHA256, p.GLCertificateSHA256)) {
			return errors.New("re-enter Comet credentials and verify trust for a changed connection")
		}
		p.GLURL, p.GLUsername, p.GLCertificateSHA256 = u, username, input.GLCertificateSHA256
		if u == "" {
			p.GLUsername, p.GLCertificateSHA256, p.GLPasswordFile = "", "", ""
		}
	} else if input.GLPassword != nil {
		return errors.New("Comet settings required with a password")
	}
	if p.ID == "" {
		var id [12]byte
		if _, err := rand.Read(id[:]); err != nil {
			return errors.New("could not create server ID")
		}
		p.ID = hex.EncodeToString(id[:])
	}
	if p.Host != input.Host && input.VNCPort == nil {
		p.VNCPort, p.VNCPasswordFile, p.VNCCertificateSHA256 = 0, "", ""
		p.VNCHost, p.VNCKind, p.VNCTransport = "", "", ""
	}
	p.Name, p.Host, p.Port, p.Username, p.JetURL = input.Name, input.Host, input.Port, input.Username, input.JetURL
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return errors.New("cannot create protected settings directory")
	}
	var staged []string
	committed := false
	defer func() {
		if !committed {
			for _, path := range staged {
				_ = os.Remove(path)
			}
		}
	}()
	for _, credential := range []struct {
		value *string
		path  *string
	}{{input.Password, &p.PasswordFile}, {input.JetPassword, &p.JetPasswordFile}, {input.KGKey, &p.KGKeyFile}, {input.VNCPassword, &p.VNCPasswordFile}, {input.GLPassword, &p.GLPasswordFile}, {input.MeterSecret, &p.MeterSecretFile}, {input.GlancesToken, &p.GlancesTokenFile}} {
		if credential.value == nil {
			continue
		}
		if *credential.value == "" && (credential.path == &p.GlancesTokenFile || credential.path == &p.MeterSecretFile) {
			*credential.path = ""
			continue
		}
		path, err := writeProtected(s.dir, []byte(*credential.value))
		if err != nil {
			return errors.New("cannot save protected credential")
		}
		staged = append(staged, path)
		*credential.path = path
	}
	if input.KGKey != nil && *input.KGKey == "" {
		p.KGKeyFile = ""
	}
	if p.JetURL == "" {
		p.JetPasswordFile = ""
	}
	next := append([]deviceProfile(nil), s.profiles...)
	if index < 0 {
		next = append(next, p)
	} else {
		next[index] = p
	}
	endpoints := map[string]bool{}
	for i, profile := range next {
		normalized, err := normalizeProfile(profile)
		if err != nil {
			return err
		}
		for _, endpoint := range profileEndpoints(normalized) {
			if endpoints[endpoint] {
				return errors.New("duplicate device endpoint")
			}
			endpoints[endpoint] = true
		}
		next[i] = normalized
	}
	if err := s.persist(next, staged); err != nil {
		return err
	}
	committed = true
	return nil
}

func (s *profileStore) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending {
		return errors.New("settings reload in progress; retry shortly")
	}
	next := make([]deviceProfile, 0, len(s.profiles))
	found := false
	for _, p := range s.profiles {
		if p.ID != id {
			next = append(next, p)
			continue
		}
		if p.Host != "" {
			return errors.New("only standalone KVM devices can be removed")
		}
		found = true
	}
	if !found {
		return errors.New("device not found")
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return errors.New("cannot create settings directory")
	}
	return s.persist(next, nil)
}

func (s *profileStore) persist(next []deviceProfile, staged []string) error {
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return errors.New("cannot encode server settings")
	}
	if len(data) > maxProfilesBytes {
		return errors.New("combined device settings exceed the storage limit")
	}
	path, err := writeProtected(s.dir, data)
	if err != nil {
		return errors.New("cannot save server settings")
	}
	defer os.Remove(path)
	if err = os.Rename(path, filepath.Join(s.dir, "devices.json")); err != nil {
		return errors.New("cannot replace server settings")
	}
	used := map[string]bool{}
	for _, profile := range next {
		used[profile.PasswordFile], used[profile.JetPasswordFile] = true, true
		used[profile.VNCPasswordFile], used[profile.GlancesTokenFile], used[profile.MeterSecretFile] = true, true, true
		used[profile.KGKeyFile], used[profile.GLPasswordFile] = true, true
	}
	for _, profile := range s.profiles {
		staged = append(staged, profile.PasswordFile, profile.JetPasswordFile, profile.VNCPasswordFile, profile.KGKeyFile, profile.GLPasswordFile, profile.GlancesTokenFile, profile.MeterSecretFile)
	}
	for _, path := range staged {
		if !used[path] && filepath.Dir(path) == s.dir && strings.HasPrefix(filepath.Base(path), ".settings-") {
			_ = os.Remove(path)
		}
	}
	s.profiles = next
	s.pending = true
	return nil
}

func writeProtected(dir string, data []byte) (string, error) {
	f, err := os.CreateTemp(dir, ".settings-*")
	if err != nil {
		return "", err
	}
	path := f.Name()
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return path, nil
}
