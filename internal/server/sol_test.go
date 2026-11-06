package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type solProvider struct {
	fakeProvider
	run func(context.Context, io.Reader, io.Writer) error
}

func (p *solProvider) SOL(ctx context.Context, in io.Reader, out io.Writer) error {
	return p.run(ctx, in, out)
}

func solTestServer(t *testing.T, session context.Context, run func(context.Context, io.Reader, io.Writer) error) (*Server, string) {
	t.Helper()
	s, _ := testServer(t)
	s.provider = &solProvider{run: run}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.serveSOL(w, r, session) }))
	t.Cleanup(ts.Close)
	return s, ts.URL
}

func TestSOLUnsupported(t *testing.T) {
	s, _ := testServer(t)
	w := httptest.NewRecorder()
	s.serveSOL(w, httptest.NewRequest("GET", "/", nil), context.Background())
	if w.Code != http.StatusNotImplemented {
		t.Fatal(w.Code)
	}
}

func TestSOLStreamsAndRejectsConcurrentSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s, endpoint := solTestServer(t, ctx, func(_ context.Context, in io.Reader, out io.Writer) error { _, err := io.Copy(out, in); return err })
	ws, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := ws.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	kind, data, err := ws.Read(ctx)
	if err != nil || kind != websocket.MessageBinary || string(data) != "hello" {
		t.Fatalf("%v %q %v", kind, data, err)
	}
	second, response, err := websocket.Dial(ctx, endpoint, nil)
	if err == nil {
		second.CloseNow()
		t.Fatal("second connection accepted")
	}
	if response == nil || response.StatusCode != http.StatusConflict {
		t.Fatalf("%v %v", response, err)
	}
	cancel()
	_, _, _ = ws.Read(context.Background())
	waitSOLRelease(t, s)
}

func waitSOLRelease(t *testing.T, s *Server) {
	t.Helper()
	select {
	case s.solGate <- struct{}{}:
		<-s.solGate
	case <-time.After(2 * time.Second):
		t.Fatal("SOL lease was not released")
	}
}

func TestSOLFailureIsSanitizedAndReleasesLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s, endpoint := solTestServer(t, ctx, func(context.Context, io.Reader, io.Writer) error { return errors.New("password=secret") })
	ws, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusInternalError || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
	waitSOLRelease(t, s)
}

func TestSOLCancelsStalledConsumer(t *testing.T) {
	for _, name := range []string{"disconnect", "input buffer limit"} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, endpoint := solTestServer(t, ctx, func(ctx context.Context, _ io.Reader, _ io.Writer) error {
				<-ctx.Done()
				return ctx.Err()
			})
			ws, _, err := websocket.Dial(ctx, endpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			if err := ws.Write(ctx, websocket.MessageText, []byte("pending input")); err != nil {
				t.Fatal(err)
			}
			if name == "disconnect" {
				_ = ws.CloseNow()
			} else {
				for range 16 {
					_ = ws.Write(ctx, websocket.MessageText, []byte("pending input"))
				}
				_, _, err = ws.Read(ctx)
				if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
					t.Fatal(err)
				}
			}
			waitSOLRelease(t, s)
		})
	}
}

func TestSOLRejectsInvalidAndOversizedInput(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind websocket.MessageType
		data []byte
	}{
		{"binary", websocket.MessageBinary, []byte("x")},
		{"oversized", websocket.MessageText, []byte(strings.Repeat("x", 4097))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, endpoint := solTestServer(t, ctx, func(_ context.Context, in io.Reader, _ io.Writer) error {
				_, err := io.Copy(io.Discard, in)
				return err
			})
			ws, _, err := websocket.Dial(ctx, endpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			_ = ws.Write(ctx, tc.kind, tc.data)
			if _, _, err := ws.Read(ctx); err == nil {
				t.Fatal("invalid input accepted")
			}
			waitSOLRelease(t, s)
		})
	}
}

func TestSOLShutdownDrainsAllDevicesAndRejectsNewSessions(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup := make(chan struct{})
	defer func() {
		select {
		case <-cleanup:
		default:
			close(cleanup)
		}
	}()
	started := make(chan struct{})
	device, endpoint := solTestServer(t, ctx, func(ctx context.Context, _ io.Reader, _ io.Writer) error {
		close(started)
		<-ctx.Done()
		<-cleanup
		return ctx.Err()
	})
	root, _ := testServer(t)
	root.devices["child"] = device
	root.sessions["test"] = &session{ctx: ctx, cancel: cancel}
	ws, _, err := websocket.Dial(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	<-started
	root.CloseSessions()
	if ctx.Err() == nil {
		t.Fatal("shutdown did not cancel SOL session")
	}
	deadline, done := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer done()
	if err := root.WaitForSOL(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown did not wait for provider cleanup: %v", err)
	}
	w := httptest.NewRecorder()
	device.serveSOL(w, httptest.NewRequest("GET", "/", nil), context.Background())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("new SOL admission during shutdown: %d", w.Code)
	}
	if w := request(root, "POST", "/api/login", `{"password":"test password"}`, nil, "", root.cfg.Origin); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("new login during shutdown: %d", w.Code)
	}
	close(cleanup)
	deadline, done = context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err := root.WaitForSOL(deadline); err != nil {
		t.Fatal(err)
	}
	root.CloseSessions()
}
