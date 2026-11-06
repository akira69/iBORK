package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Retain the socket so a stalled close handshake cannot delay key/token cleanup.
type cometUpgrade struct {
	http.ResponseWriter
	socket net.Conn
}

func (w *cometUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	w.socket = conn
	return conn, buffer, err
}

func (s *Server) serveComet(w http.ResponseWriter, r *http.Request, login context.Context) {
	if s.cfg.GLURL == "" {
		closeConsole(w, r, 4404, "No GL.iNet console paired")
		return
	}
	s.mu.Lock()
	if s.closing || login.Err() != nil {
		s.mu.Unlock()
		fail(w, 503, "Console session is closing")
		return
	}
	select {
	case s.glCheckGate <- struct{}{}:
	default:
		s.mu.Unlock()
		closeConsole(w, r, 4409, "Console is busy")
		return
	}
	s.mu.Unlock()
	defer func() { <-s.glCheckGate }()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(login, cancel)
	defer stop()
	accepted := false
	err := withComet(ctx, s.cfg, func(client *http.Client, token string) error {
		// HTTP timeouts bound the handshakes; streaming lifetime follows the app login.
		streamClient := *client
		streamClient.Timeout = 0
		dial := func(path string, protocols []string) (*websocket.Conn, error) {
			target := "ws" + strings.TrimPrefix(strings.TrimRight(s.cfg.GLURL, "/"), "http") + path
			deadline, done := context.WithTimeout(ctx, s.cfg.Timeout)
			defer done()
			conn, response, err := websocket.Dial(deadline, target, &websocket.DialOptions{
				HTTPClient: &streamClient, HTTPHeader: http.Header{"Token": {token}}, Subprotocols: protocols,
			})
			if err != nil && response != nil && (response.StatusCode == 401 || response.StatusCode == 403) {
				return nil, errConsoleAuthentication
			}
			return conn, err
		}
		janus, err := dial("/janus/ws", []string{"janus-protocol"})
		if err != nil {
			return err
		}
		defer janus.CloseNow()
		if janus.Subprotocol() != "janus-protocol" {
			return errCometProtocol
		}
		events, err := dial("/api/ws", nil)
		if err != nil {
			return err
		}
		defer events.CloseNow()
		upgrade := &cometUpgrade{ResponseWriter: w}
		browser, err := websocket.Accept(upgrade, r, nil)
		if err != nil {
			accepted = true
			return err
		}
		accepted = true
		defer browser.CloseNow()
		return relayComet(ctx, browser, janus, events, upgrade.socket, s.cfg, token)
	})
	if err != nil && !accepted {
		consoleUpstreamError(w, r, err, 0)
	}
}

func cometWrite(ctx context.Context, conn *websocket.Conn, data []byte) error {
	deadline, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return conn.Write(deadline, websocket.MessageText, data)
}

func relayComet(lifetime context.Context, browser, janus, events *websocket.Conn, socket net.Conn, cfg Config, token string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, conn := range []*websocket.Conn{browser, janus, events} {
		conn.SetReadLimit(cometMessageLimit)
	}
	var mu sync.Mutex
	p := cometProtocol{held: make(map[string]bool)}
	closing := false
	done := make(chan error, 3)
	var workers sync.WaitGroup
	workers.Add(3)
	for channel, upstream := range map[string]*websocket.Conn{"janus": janus, "events": events} {
		go func() {
			defer workers.Done()
			for {
				kind, data, err := upstream.Read(ctx)
				if err != nil {
					done <- err
					return
				}
				var value any
				decoder := json.NewDecoder(bytes.NewReader(data))
				decoder.UseNumber()
				if kind != websocket.MessageText || decoder.Decode(&value) != nil || !json.Valid(data) {
					done <- errCometProtocol
					return
				}
				data = cometJSON(value)
				// Normalize escaped JSON before checking; no upstream auth material reaches the browser.
				if cometContainsSecret(data, token) || cometContainsSecret(data, cfg.GLPassword) {
					done <- errCometProtocol
					return
				}
				if channel == "janus" {
					mu.Lock()
					err = p.janusOutput(data)
					mu.Unlock()
					if err != nil {
						done <- err
						return
					}
				} else {
					var event struct {
						Type string `json:"event_type"`
					}
					_ = json.Unmarshal(data, &event)
					if event.Type != "streamer" && event.Type != "hid" && event.Type != "pong" {
						continue
					}
				}
				if err = cometWrite(ctx, browser, cometJSON(cometEnvelope{channel, data})); err != nil {
					done <- err
					return
				}
			}
		}()
	}
	go func() {
		defer workers.Done()
		for {
			kind, data, err := browser.Read(ctx)
			if err != nil {
				done <- err
				return
			}
			var msg cometEnvelope
			if kind != websocket.MessageText || cometDecode(data, &msg) != nil {
				done <- errCometProtocol
				return
			}
			mu.Lock()
			if closing {
				mu.Unlock()
				return
			}
			switch msg.Channel {
			case "janus":
				data, err = p.janusInput(msg.Data)
				if err == nil {
					err = cometWrite(ctx, janus, data)
				}
			case "events":
				var key cometKeyEvent
				err = cometDecode(msg.Data, &key)
				if err == nil && key.Type == "ping" && key.Event.Key == "" && key.Event.State == nil && !key.Event.Finish {
					err = cometWrite(ctx, events, []byte(`{"event_type":"ping","event":{}}`))
				} else if err == nil && key.Type == "key" && cometKey.MatchString(key.Event.Key) && key.Event.State != nil {
					// Track before writing: a failed write may still have delivered a key-down.
					if *key.Event.State && !key.Event.Finish {
						p.held[key.Event.Key] = true
					}
					err = cometWrite(ctx, events, cometJSON(key))
					if err == nil && (!*key.Event.State || key.Event.Finish) {
						delete(p.held, key.Event.Key)
					}
				} else {
					err = errCometProtocol
				}
			default:
				err = errCometProtocol
			}
			mu.Unlock()
			if err != nil {
				done <- err
				return
			}
		}
	}()
	var err error
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
watch:
	for {
		select {
		case err = <-done:
			break watch
		case <-lifetime.Done():
			err = lifetime.Err()
			break watch
		case <-heartbeat.C:
			deadline, stop := context.WithTimeout(ctx, min(cfg.Timeout, 2*time.Second))
			err = browser.Ping(deadline)
			stop()
			if err != nil {
				break watch
			}
		}
	}
	// Preserve the event socket long enough to release keys before canceling readers.
	mu.Lock()
	closing = true
	cleanup, finish := context.WithTimeout(context.Background(), 2*time.Second)
	for key := range p.held {
		up := false
		event := cometKeyEvent{Type: "key"}
		event.Event.Key, event.Event.State = key, &up
		_ = cometWrite(cleanup, events, cometJSON(event))
	}
	if p.session != 0 {
		_ = cometWrite(cleanup, janus, cometJSON(cometJanus{Janus: "destroy", Transaction: "ibork-cleanup", SessionID: p.session}))
	}
	finish()
	mu.Unlock()
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		if errors.Is(err, errCometProtocol) {
			_ = browser.Close(websocket.StatusPolicyViolation, "Unsupported console message")
		} else if lifetime.Err() != nil {
			_ = browser.Close(websocket.StatusPolicyViolation, "Management session ended")
		} else {
			_ = browser.Close(websocket.StatusGoingAway, "Console disconnected")
		}
	}()
	select {
	case <-closed:
	case <-time.After(250 * time.Millisecond):
		_ = socket.Close()
	}
	_ = browser.CloseNow()
	<-closed
	cancel()
	_ = janus.CloseNow()
	_ = events.CloseNow()
	workers.Wait()
	return err
}

func cometContainsSecret(data []byte, secret string) bool {
	if secret == "" {
		return false
	}
	escaped := cometJSON(secret)
	return bytes.Contains(data, escaped[1:len(escaped)-1])
}
