package server

import (
	"context"
	"io"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/akira69/iBORK/internal/management"
	"github.com/coder/websocket"
)

const solMessageLimit = 4096

// The authenticated router checks the exact Origin before calling serveSOL.
// Client text frames carry UTF-8 input; server binary frames carry raw console bytes.
func (s *Server) serveSOL(w http.ResponseWriter, r *http.Request, sessionContext context.Context) {
	p, ok := s.provider.(management.SOLProvider)
	if !ok {
		fail(w, http.StatusNotImplemented, "SOL is unavailable for this device")
		return
	}
	s.mu.Lock()
	if s.closing || sessionContext.Err() != nil {
		s.mu.Unlock()
		fail(w, http.StatusServiceUnavailable, "SOL session is closing")
		return
	}
	select {
	case s.solGate <- struct{}{}:
		defer func() { <-s.solGate }()
	default:
		s.mu.Unlock()
		fail(w, http.StatusConflict, "SOL is already connected for this device")
		return
	}
	s.mu.Unlock()
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(solMessageLimit)
	ctx, cancel := context.WithCancel(sessionContext)
	defer cancel()
	input := &solInput{ctx: ctx, queue: make(chan []byte, 16)}
	stopIO := context.AfterFunc(ctx, func() {
		_ = ws.CloseNow()
	})
	defer stopIO()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer cancel()
		for {
			kind, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageText || !utf8.Valid(data) {
				_ = ws.Close(websocket.StatusUnsupportedData, "SOL requires UTF-8 text input")
				return
			}
			select {
			case input.queue <- data:
			default:
				_ = ws.Close(websocket.StatusPolicyViolation, "SOL input buffer exceeded")
				return
			}
		}
	}()
	err = p.SOL(ctx, input, solOutput{ctx: ctx, ws: ws})
	if ctx.Err() == nil {
		if err != nil {
			_ = ws.Close(websocket.StatusInternalError, "SOL unavailable; check BMC settings and existing sessions")
		} else {
			_ = ws.Close(websocket.StatusNormalClosure, "SOL disconnected")
		}
	}
	cancel()
	_ = ws.CloseNow()
	<-readDone
}

// WaitForSOL drains console handlers after CloseSessions has stopped admission.
func (s *Server) WaitForSOL(ctx context.Context) error {
	for _, device := range s.devices {
		for _, gate := range []chan struct{}{device.solGate, device.vncGate, device.jetGate, device.glCheckGate} {
			select {
			case gate <- struct{}{}:
				<-gate
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}

type solInput struct {
	ctx   context.Context
	queue chan []byte
	data  []byte
}

func (i *solInput) Read(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	for len(i.data) == 0 {
		select {
		case <-i.ctx.Done():
			return 0, io.EOF
		case i.data = <-i.queue:
		}
	}
	n := copy(data, i.data)
	i.data = i.data[n:]
	return n, nil
}

type solOutput struct {
	ctx context.Context
	ws  *websocket.Conn
}

func (o solOutput) Write(data []byte) (int, error) {
	written := 0
	for len(data) > 0 {
		n := min(len(data), solMessageLimit)
		ctx, cancel := context.WithTimeout(o.ctx, 5*time.Second)
		err := o.ws.Write(ctx, websocket.MessageBinary, data[:n])
		cancel()
		if err != nil {
			return written, err
		}
		written += n
		data = data[n:]
	}
	return written, nil
}
