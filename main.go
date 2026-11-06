package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/akira69/iBORK/internal/energy"
	"github.com/akira69/iBORK/internal/management"
	"github.com/akira69/iBORK/internal/meter"
	"github.com/akira69/iBORK/internal/server"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
)

//go:embed web/dist
var assets embed.FS
var errSettingsReload = errors.New("server settings changed")

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func secret(key string) (string, error) {
	path := os.Getenv(key)
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s", key)
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}
func run(logins *server.LoginState) error {
	if len(os.Args) == 2 && (os.Args[1] == "hash-password" || os.Args[1] == "hash-panel-pin") {
		panelPIN := os.Args[1] == "hash-panel-pin"
		if panelPIN {
			fmt.Fprint(os.Stderr, "New panel PIN (6 to 12 digits): ")
		} else {
			fmt.Fprint(os.Stderr, "New management password: ")
		}
		password, err := term.ReadPassword(int(os.Stdin.Fd()))
		defer clear(password)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		if panelPIN && !server.ValidPanelPIN(password) {
			return errors.New("use 6 to 12 digits for the panel PIN")
		}
		if !panelPIN && len(password) < 12 {
			return errors.New("use at least 12 characters")
		}
		hash, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		fmt.Println(string(hash))
		return nil
	}
	timeout, err := time.ParseDuration(env("DEVICE_TIMEOUT", "10s"))
	if err != nil || timeout < time.Second || timeout > time.Minute {
		return errors.New("DEVICE_TIMEOUT must be between 1s and 60s")
	}
	var profiles []deviceProfile
	settingsDir, err := filepath.Abs(filepath.Join(env("STATE_DIRECTORY", "data"), "settings"))
	if err != nil {
		return err
	}
	settingsPath := filepath.Join(settingsDir, "devices.json")
	hash, err := appPasswordHash(settingsDir)
	if err != nil {
		return err
	}
	_, settingsErr := os.Stat(settingsPath)
	if settingsErr != nil && !errors.Is(settingsErr, os.ErrNotExist) {
		return errors.New("cannot inspect saved server settings")
	}
	if path := os.Getenv("DEVICES_FILE"); settingsErr == nil || path != "" {
		if settingsErr == nil {
			path = settingsPath
		}
		profiles, err = readProfilesFile(path, settingsErr == nil)
		if err != nil {
			return err
		}
	} else {
		profiles, err = legacyProfiles()
		if err != nil {
			return err
		}
	}
	files, err := fs.Sub(assets, "web/dist")
	if err != nil {
		return err
	}
	static := http.FileServer(http.FS(files))
	var app *server.Server
	type collector struct {
		history   *energy.History
		read      energy.Reader
		subscribe func(context.Context)
	}
	collectors := make([]collector, 0, len(profiles))
	for i, profile := range profiles {
		profile, err = normalizeProfile(profile)
		if err != nil {
			return err
		}
		profiles[i] = profile
		ipmiPassword, err := fileSecret(profile.PasswordFile)
		if err != nil {
			return err
		}
		jetPassword, err := fileSecret(profile.JetPasswordFile)
		if err != nil {
			return err
		}
		kgKey, err := fileSecret(profile.KGKeyFile)
		if err != nil {
			return err
		}
		vncPassword, err := fileSecret(profile.VNCPasswordFile)
		if err != nil {
			return err
		}
		cfg := server.Config{Origin: env("APP_ORIGIN", "http://localhost:8080"), PasswordHash: hash, DeviceID: profile.ID, ServerName: profile.Name, Manufacturer: profile.Manufacturer, Model: profile.Model, JetURL: profile.JetURL, JetPassword: jetPassword, BMCHost: profile.Host, BMCUsername: profile.Username, BMCPort: profile.Port, Timeout: timeout}
		cfg.VNCPort, cfg.VNCPassword, cfg.VNCCertificateSHA256 = profile.VNCPort, vncPassword, profile.VNCCertificateSHA256
		cfg.VNCHost, cfg.VNCKind, cfg.VNCTransport = profile.VNCHost, profile.VNCKind, profile.VNCTransport
		cfg.GLURL, cfg.GLUsername, cfg.GLCertificateSHA256 = profile.GLURL, profile.GLUsername, profile.GLCertificateSHA256
		cfg.GLPassword, err = fileSecret(profile.GLPasswordFile)
		if err != nil {
			return err
		}
		cfg.GlancesURL = profile.Telemetry.GlancesURL
		cfg.GlancesToken, err = fileSecret(profile.GlancesTokenFile)
		if err != nil {
			return err
		}
		var provider management.Provider
		var c collector
		var endpoint, source string
		if cfg.BMCHost != "" {
			provider, err = management.NewIPMI(management.Config{Host: cfg.BMCHost, Port: cfg.BMCPort, Username: cfg.BMCUsername, Password: ipmiPassword, KGKey: kgKey, Timeout: timeout})
			if err != nil {
				return err
			}
			endpoint = fmt.Sprintf("%s:%d", cfg.BMCHost, cfg.BMCPort)
			c.read = func(ctx context.Context) (energy.Sample, error) {
				watts, err := provider.Watts(ctx)
				return energy.Sample{At: time.Now().Unix(), Watts: watts}, err
			}
		}
		t := profile.Telemetry
		if t.MeterKind != "" {
			secret, err := fileSecret(profile.MeterSecretFile)
			if err != nil {
				return err
			}
			endpoint = strings.Join([]string{profile.ID, t.OutletID, t.MeterKind, t.MeterURL, t.MeterChannel, t.WattsField}, "|")
			switch t.MeterKind {
			case "mqtt":
				client, err := meter.NewMQTT(t.MeterURL, t.MeterChannel, t.MeterUser, secret, t.WattsField)
				if err != nil {
					return err
				}
				c.read, c.subscribe, source = client.Read, client.Run, energy.MQTTSource
			case "home-assistant":
				client, err := meter.NewHomeAssistant(t.MeterURL, t.MeterChannel, secret)
				if err != nil {
					return err
				}
				c.read, source = client.Read, energy.MatterSource
			}
		}
		if c.read != nil {
			identity := sha256.Sum256([]byte(endpoint))
			cfg.History, err = energy.Open(filepath.Join(env("STATE_DIRECTORY", "data"), fmt.Sprintf("power-%x", identity[:8])), time.Now())
			if err != nil {
				log.Print("Power history storage unavailable; using memory-only collection")
				cfg.History = energy.MemoryOnly()
			}
			cfg.History.SetSource(source)
			c.history = cfg.History
			collectors = append(collectors, c)
		}
		if app == nil {
			app, err = server.New(cfg, provider, static)
		} else {
			err = app.AddDevice(cfg, provider)
		}
		if err != nil {
			return err
		}
	}
	if app == nil {
		app, err = server.NewEmpty(server.Config{Origin: env("APP_ORIGIN", "http://localhost:8080"), PasswordHash: hash, Timeout: timeout}, static)
		if err != nil {
			return err
		}
	}
	if os.Getenv("PANEL_TOKEN_FILE") != "" || os.Getenv("PANEL_PIN_HASH_FILE") != "" {
		token, err := secret("PANEL_TOKEN_FILE")
		if err != nil {
			return err
		}
		bootstrap, err := secret("PANEL_PIN_HASH_FILE")
		if err != nil {
			return err
		}
		if os.Getenv("PANEL_PIN_HASH_FILE") != "" && bootstrap == "" {
			return errors.New("PANEL_PIN_HASH_FILE is empty")
		}
		pinHash, err := panelPINHash(settingsDir, bootstrap)
		if err != nil {
			return err
		}
		if err := app.EnablePanel(token, pinHash, func(hash string) error {
			return savePanelPINHash(settingsDir, bootstrap, hash)
		}); err != nil {
			return err
		}
		if err := configureStoredSetting(settingsDir, "panel-display.json", 4096, app.SetPanelDisplay); err != nil {
			return err
		}
		if err := configureStoredSetting(settingsDir, "panel-icons.json", server.PanelIconConfigLimit, app.SetPanelIcons); err != nil {
			return err
		}
		if err := configureStoredSetting(settingsDir, "panel-layout.json", 4096, app.SetPanelLayout); err != nil {
			return err
		}
	}
	if err := configureStoredSetting(settingsDir, "electricity-rate.json", 4096, app.SetElectricityRate); err != nil {
		return fmt.Errorf("load electricity rate: %w", err)
	}
	srv := &http.Server{Addr: env("LISTEN_ADDR", "127.0.0.1:8080"), Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 70 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	app.RestoreLogins(logins)
	reload := make(chan struct{}, 1)
	reloadSettings := func() {
		select {
		case reload <- struct{}{}:
		default:
		}
	}
	app.SetDeviceSettings(&profileStore{dir: settingsDir, profiles: profiles}, reloadSettings)
	app.SetPasswordSettings(func(hash string) error { return saveAppPasswordHash(settingsDir, hash) }, reloadSettings)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var workers sync.WaitGroup
	for _, c := range collectors {
		if c.subscribe != nil {
			workers.Add(1)
			go func() { defer workers.Done(); c.subscribe(ctx) }()
		}
		workers.Add(1)
		go func() { defer workers.Done(); c.history.Run(ctx, c.read) }()
	}
	shutdownDone := make(chan struct{})
	var shutdownErr error
	reloading := false
	go func() {
		select {
		case <-ctx.Done():
		case <-reload:
			reloading = true
		}
		app.CloseSessions()
		stop()
		deadline, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownErr = srv.Shutdown(deadline)
		if err := app.WaitForSOL(deadline); shutdownErr == nil {
			shutdownErr = err
		}
		close(shutdownDone)
	}()
	log.Printf("iBORK listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		stop()
		<-shutdownDone
		workers.Wait()
		return err
	}
	<-shutdownDone
	workers.Wait()
	if shutdownErr != nil {
		return errors.New("request or console cleanup timed out during shutdown")
	}
	if reloading {
		app.SaveLogins(logins)
		return errSettingsReload
	}
	return nil
}
func main() {
	var logins server.LoginState
	for {
		err := run(&logins)
		if errors.Is(err, errSettingsReload) {
			continue
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
}
