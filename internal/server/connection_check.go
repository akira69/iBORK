package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Server) checkConsole(w http.ResponseWriter, r *http.Request, ctx context.Context) {
	isVNC := r.URL.Path == "/api/vnc/status"
	if (isVNC && s.cfg.VNCPort == 0) || (!isVNC && s.cfg.GLURL == "") {
		fail(w, 409, "Console is not configured for this device")
		return
	}
	gate := s.glCheckGate
	if isVNC {
		gate = s.vncGate
	}
	select {
	case gate <- struct{}{}:
		defer func() { <-gate }()
	default:
		fail(w, 409, "Console is busy; disconnect it before testing")
		return
	}
	var err error
	message := "GL.iNet Comet login verified. Video and keyboard control are not tested."
	if isVNC {
		err = checkVNC(ctx, s.cfg)
		message = "VNC server reached. Password, video and keyboard control are not tested."
	} else {
		err = checkComet(ctx, s.cfg)
	}
	if err != nil {
		message := "Console connection failed; check the address and device availability"
		if errors.Is(err, errConsoleCertificate) {
			message = "Console certificate rejected; verify the saved SHA256 fingerprint"
		}
		if errors.Is(err, errConsoleAuthentication) {
			message = "Comet authentication failed; check its username and password"
		}
		if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
			message = "Connection test timed out or was canceled"
		}
		fail(w, 502, message)
		return
	}
	reply(w, 200, map[string]string{"message": message})
}

func checkVNC(ctx context.Context, cfg Config) error {
	conn, err := dialVNC(ctx, cfg)
	if err != nil {
		return err
	}
	socket := conn
	if secured, ok := conn.(*tls.Conn); ok {
		socket = secured.NetConn()
	}
	defer socket.Close()
	stop := context.AfterFunc(ctx, func() { _ = socket.Close() })
	defer stop()
	if err = conn.SetDeadline(time.Now().Add(cfg.Timeout)); err != nil {
		return err
	}
	var banner [12]byte
	if _, err = io.ReadFull(conn, banner[:]); err != nil {
		return err
	}
	if string(banner[:]) != "RFB 003.003\n" && string(banner[:]) != "RFB 003.007\n" && string(banner[:]) != "RFB 003.008\n" {
		return errors.New("unsupported RFB version")
	}
	return nil
}

func checkComet(ctx context.Context, cfg Config) (err error) {
	return withComet(ctx, cfg, nil)
}

// One short-lived token owns both channels and is always logged out on exit.
func withComet(ctx context.Context, cfg Config, use func(*http.Client, string) error) (err error) {
	transport := &http.Transport{TLSClientConfig: consoleTLSConfig(cfg.GLCertificateSHA256)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: cfg.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	call := func(ctx context.Context, method, path, body, token string) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(cfg.GLURL, "/")+path, strings.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if token != "" {
			req.Header.Set("Token", token)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode == 401 || res.StatusCode == 403 {
			return nil, errConsoleAuthentication
		}
		if res.StatusCode != 200 {
			return nil, errors.New("Comet request failed")
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, 8193))
		if len(data) > 8192 {
			return nil, errors.New("Comet response too large")
		}
		return data, err
	}
	data, err := call(ctx, "POST", "/api/auth/login", url.Values{"user": {cfg.GLUsername}, "passwd": {cfg.GLPassword}}.Encode(), "")
	if err != nil {
		return err
	}
	var auth struct {
		Result struct {
			Token string `json:"token"`
		} `json:"result"`
	}
	if json.Unmarshal(data, &auth) != nil || auth.Result.Token == "" {
		return errConsoleAuthentication
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), min(cfg.Timeout, time.Second))
		defer cancel()
		_, logoutErr := call(cleanup, "POST", "/api/auth/logout", "", auth.Result.Token)
		if err == nil {
			err = logoutErr
		}
	}()
	_, err = call(ctx, "GET", "/api/auth/check", "", auth.Result.Token)
	if err == nil && use != nil {
		err = use(client, auth.Result.Token)
	}
	return err
}
