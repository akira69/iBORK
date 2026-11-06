package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

type jetRelay struct {
	url      *url.URL
	password string
	client   *http.Client
	gate     chan struct{}
	timeout  time.Duration
}

func newJetRelay(raw, password string, timeout time.Duration) (*jetRelay, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("JETKVM_URL must be an http(s) origin without credentials")
	}
	jar, _ := cookiejar.New(nil)
	return &jetRelay{url: u, password: password, gate: make(chan struct{}, 1), timeout: timeout, client: &http.Client{Timeout: timeout, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (j *jetRelay) call(ctx context.Context, method, path string, body []byte) (int, error) {
	u := *j.url
	u.Path = path
	r, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	r.Header.Set("Content-Type", "application/json")
	response, err := j.client.Do(r)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode, nil
}
func (j *jetRelay) check(ctx context.Context) error {
	// A single login refresh avoids invalidating stock JetKVM's global auth cookie repeatedly.
	ctx, cancel := context.WithTimeout(ctx, j.timeout)
	defer cancel()
	select {
	case j.gate <- struct{}{}:
		defer func() { <-j.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	code, err := j.call(ctx, "GET", "/device", nil)
	if err != nil {
		return err
	}
	if code == 200 {
		return nil
	}
	if (code == 401 && j.password == "") || code == 403 {
		return errConsoleAuthentication
	}
	if code != 401 {
		return errors.New("JetKVM unavailable")
	}
	body, _ := json.Marshal(map[string]string{"password": j.password})
	code, err = j.call(ctx, "POST", "/auth/login-local", body)
	if err != nil {
		return err
	}
	if code != 200 {
		return errConsoleAuthentication
	}
	return nil
}
func (s *Server) serveJet(w http.ResponseWriter, r *http.Request, sessionContext context.Context) {
	s.mu.Lock()
	if s.closing || sessionContext.Err() != nil {
		s.mu.Unlock()
		fail(w, 503, "Console session is closing")
		return
	}
	select {
	case s.jetGate <- struct{}{}:
	default:
		s.mu.Unlock()
		closeConsole(w, r, 4409, "Console is busy")
		return
	}
	s.mu.Unlock()
	defer func() { <-s.jetGate }()
	s.jet.signal(w, r, sessionContext)
}

func (j *jetRelay) signal(w http.ResponseWriter, r *http.Request, sessionContext context.Context) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()
	connectCtx, connectCancel := context.WithCancel(sessionContext)
	defer connectCancel()
	stopConnect := context.AfterFunc(ctx, connectCancel)
	defer stopConnect()
	if err := j.check(connectCtx); err != nil {
		consoleUpstreamError(w, r, err, 0)
		return
	}
	target := *j.url
	target.Path = "/webrtc/signaling/client"
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	upstream, response, err := websocket.Dial(connectCtx, target.String(), &websocket.DialOptions{HTTPClient: j.client})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		consoleUpstreamError(w, r, err, status)
		return
	}
	defer upstream.CloseNow()
	browser, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer browser.CloseNow()
	upstream.SetReadLimit(256 * 1024)
	browser.SetReadLimit(256 * 1024)
	done := make(chan struct{}, 2)
	relay := func(dst, src *websocket.Conn) {
		defer func() { done <- struct{}{} }()
		for {
			kind, data, readErr := src.Read(ctx)
			if readErr != nil {
				code := websocket.CloseStatus(readErr)
				if code == 4001 {
					_ = dst.Close(4001, "Other session connected")
				}
				return
			}
			if dst.Write(ctx, kind, data) != nil {
				return
			}
		}
	}
	go relay(browser, upstream)
	go relay(upstream, browser)
	consumed := false
	select {
	case <-sessionContext.Done():
		_ = browser.Close(websocket.StatusPolicyViolation, "Management session expired")
	case <-done:
		consumed = true
	}
	cancel()
	_ = browser.CloseNow()
	_ = upstream.CloseNow()
	<-done
	if !consumed {
		<-done
	}
}
