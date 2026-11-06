package server

import (
	"crypto/tls"
	"errors"
	"github.com/coder/websocket"
	"net/http"
)

var errConsoleCertificate = errors.New("console certificate rejected")
var errConsoleAuthentication = errors.New("console authentication rejected")

// WebSocket APIs cannot expose HTTP failure bodies to browsers. Private close codes
// let the owner stop retrying terminal failures without returning upstream details.
func closeConsole(w http.ResponseWriter, r *http.Request, code websocket.StatusCode, reason string) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	_ = conn.Close(code, reason)
}
func consoleUpstreamError(w http.ResponseWriter, r *http.Request, err error, status int) {
	var certificate *tls.CertificateVerificationError
	switch {
	case errors.Is(err, errConsoleCertificate) || errors.As(err, &certificate):
		closeConsole(w, r, 4403, "Console certificate rejected")
	case errors.Is(err, errConsoleAuthentication) || status == 401 || status == 403:
		closeConsole(w, r, 4401, "Console authentication failed")
	case status == 409:
		closeConsole(w, r, 4409, "Console is busy")
	default:
		closeConsole(w, r, 1013, "Console connection failed")
	}
}
