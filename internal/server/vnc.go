package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const vncMessageLimit = 64 * 1024

func vncHost(cfg Config) string {
	if cfg.VNCHost != "" {
		return cfg.VNCHost
	}
	return cfg.BMCHost
}

func validateVNCConfig(cfg Config) error {
	host := vncHost(cfg)
	if cfg.VNCPort == 0 {
		return nil
	}
	if cfg.VNCPort < 1 || cfg.VNCPort > 65535 || host == "" || strings.ContainsAny(host, "/\\ \t\r\n@[]") || (strings.Contains(host, ":") && net.ParseIP(host) == nil) {
		return errors.New("VNC requires a host and port between 1 and 65535")
	}
	if cfg.VNCKind != "" && cfg.VNCKind != "dell" && cfg.VNCKind != "generic" {
		return errors.New("unsupported VNC kind")
	}
	if cfg.VNCTransport != "" && cfg.VNCTransport != "tls" && cfg.VNCTransport != "tcp" {
		return errors.New("unsupported VNC transport")
	}
	generic := cfg.VNCKind == "generic"
	if len(cfg.VNCPassword) < 1 || len(cfg.VNCPassword) > 8 || (!generic && len(cfg.VNCPassword) != 8) {
		if generic {
			return errors.New("generic VNC requires 1-8 printable ASCII password bytes")
		}
		return errors.New("Dell VNC requires an 8-byte printable ASCII password")
	}
	for _, b := range []byte(cfg.VNCPassword) {
		if b < 32 || b > 126 {
			return errors.New("VNC password must use printable ASCII")
		}
	}
	if cfg.VNCTransport == "tcp" {
		if !generic || cfg.VNCCertificateSHA256 != "" {
			return errors.New("plaintext TCP requires generic VNC without a certificate pin")
		}
		return nil
	}
	pin, err := hex.DecodeString(cfg.VNCCertificateSHA256)
	if err != nil || len(pin) != sha256.Size {
		return errors.New("VNC requires a SHA256 certificate fingerprint (64 hex characters)")
	}
	return nil
}

func dialVNC(ctx context.Context, cfg Config) (net.Conn, error) {
	if err := validateVNCConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.VNCTransport == "tcp" {
		dialer := net.Dialer{Timeout: cfg.Timeout}
		return dialer.DialContext(ctx, "tcp", net.JoinHostPort(vncHost(cfg), strconv.Itoa(cfg.VNCPort)))
	}
	dialer := tls.Dialer{NetDialer: &net.Dialer{Timeout: cfg.Timeout}, Config: consoleTLSConfig(cfg.VNCCertificateSHA256)}
	dialCtx, dialCancel := context.WithTimeout(ctx, cfg.Timeout)
	defer dialCancel()
	return dialer.DialContext(dialCtx, "tcp", net.JoinHostPort(vncHost(cfg), strconv.Itoa(cfg.VNCPort)))
}

func consoleTLSConfig(pin string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			// Pinned iDRAC7 needs static RSA: authenticated AEAD, but no forward secrecy.
			tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
		},
		// BMC certificates are self-signed; the configured certificate pin replaces CA trust.
		InsecureSkipVerify: true, // #nosec G402 -- VerifyConnection pins the complete leaf certificate.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) > 0 {
				sum := sha256.Sum256(state.PeerCertificates[0].Raw)
				if strings.EqualFold(hex.EncodeToString(sum[:]), pin) {
					return nil
				}
			}
			return errConsoleCertificate
		},
	}
}

// The authenticated router checks exact Origin. View-only is a noVNC client policy;
// After generic authentication selection, the relay does not restrict RFB commands.
func (s *Server) serveVNC(w http.ResponseWriter, r *http.Request, sessionContext context.Context) {
	if s.cfg.VNCPort == 0 {
		fail(w, http.StatusConflict, "VNC is unavailable for this device")
		return
	}
	s.mu.Lock()
	if s.closing || sessionContext.Err() != nil {
		s.mu.Unlock()
		fail(w, http.StatusServiceUnavailable, "VNC session is closing")
		return
	}
	select {
	case s.vncGate <- struct{}{}:
		defer func() { <-s.vncGate }()
	default:
		s.mu.Unlock()
		closeConsole(w, r, 4409, "Console is busy")
		return
	}
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(sessionContext)
	defer cancel()
	stopRequest := context.AfterFunc(r.Context(), cancel)
	defer stopRequest()
	upstream, err := dialVNC(ctx, s.cfg)
	if err != nil {
		consoleUpstreamError(w, r, err, 0)
		return
	}
	// Close the transport directly so a stalled peer cannot delay TLS close-notify.
	socket := upstream
	if secured, ok := upstream.(*tls.Conn); ok {
		socket = secured.NetConn()
	}
	defer socket.Close()
	stopDial := context.AfterFunc(ctx, func() { _ = socket.Close() })
	defer stopDial()
	var hello, clientHello []byte
	if s.cfg.VNCKind == "generic" {
		if err = upstream.SetDeadline(time.Now().Add(s.cfg.Timeout)); err != nil {
			return
		}
		hello, clientHello, err = negotiateVNCPassword(upstream)
		if err != nil {
			if errors.Is(err, errVNCAuthenticationMethod) {
				closeConsole(w, r, 4406, "Unsupported VNC authentication")
			} else {
				consoleUpstreamError(w, r, err, 0)
			}
			return
		}
		if err = upstream.SetDeadline(time.Time{}); err != nil {
			return
		}
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(vncMessageLimit)
	stopIO := context.AfterFunc(ctx, func() {
		_ = socket.Close()
		_ = ws.CloseNow()
	})
	defer stopIO()
	if len(hello) > 0 {
		sendCtx, sendCancel := context.WithTimeout(ctx, s.cfg.Timeout)
		err = ws.Write(sendCtx, websocket.MessageBinary, hello)
		sendCancel()
		if err != nil {
			return
		}
	}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer cancel()
		for {
			kind, data, err := ws.Read(ctx)
			if err != nil || kind != websocket.MessageBinary {
				return
			}
			if len(clientHello) > 0 {
				n := min(len(clientHello), len(data))
				if !bytes.Equal(data[:n], clientHello[:n]) {
					return
				}
				clientHello = clientHello[n:]
				data = data[n:]
				if len(data) == 0 {
					continue
				}
			}
			if err := upstream.SetWriteDeadline(time.Now().Add(s.cfg.Timeout)); err != nil {
				return
			}
			if n, err := upstream.Write(data); err != nil || n != len(data) {
				return
			}
		}
	}()
	// Reads can be idle on a static screen; session expiry/cancellation closes both sockets.
	data := make([]byte, vncMessageLimit)
	for {
		n, readErr := upstream.Read(data)
		if n > 0 {
			writeCtx, writeCancel := context.WithTimeout(ctx, s.cfg.Timeout)
			err = ws.Write(writeCtx, websocket.MessageBinary, data[:n])
			writeCancel()
			if err != nil {
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	cancel()
	_ = socket.Close()
	_ = ws.CloseNow()
	<-readDone
}
