package server

import (
	"bytes"
	"context"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestGenericVNCPasswordNegotiation(t *testing.T) {
	for _, tc := range []struct {
		name, version string
		security      []byte
		accept        bool
	}{
		{"classic", "RFB 003.008\n", []byte{1, 2}, true},
		{"None before classic", "RFB 003.008\n", []byte{2, 1, 2}, true},
		{"None only", "RFB 003.008\n", []byte{1, 1}, false},
		{"VeNCrypt", "RFB 003.008\n", []byte{1, 19}, false},
		{"3.7", "RFB 003.007\n", []byte{1, 2}, true},
		{"3.3 classic", "RFB 003.003\n", []byte{0, 0, 0, 2}, true},
		{"3.3 None", "RFB 003.003\n", []byte{0, 0, 0, 1}, false},
		{"invalid version", "RFB 999.999\n", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(time.Second))
			done := make(chan bool, 1)
			go func() {
				defer server.Close()
				_ = server.SetDeadline(time.Now().Add(time.Second))
				for _, b := range []byte(tc.version) {
					if _, err := server.Write([]byte{b}); err != nil {
						done <- false
						return
					}
				}
				response := make([]byte, 12)
				if _, err := io.ReadFull(server, response); err != nil {
					done <- false
					return
				}
				if !bytes.Equal(response, []byte(tc.version)) {
					done <- false
					return
				}
				if _, err := server.Write(tc.security); err != nil {
					done <- false
					return
				}
				if tc.accept && tc.version != "RFB 003.003\n" {
					choice := make([]byte, 1)
					_, err := io.ReadFull(server, choice)
					done <- err == nil && choice[0] == 2
					return
				}
				done <- tc.accept
			}()
			hello, expected, err := negotiateVNCPassword(client)
			if tc.accept {
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.HasPrefix(hello, []byte(tc.version)) || !bytes.HasPrefix(expected, []byte(tc.version)) {
					t.Fatal("invalid replay")
				}
			} else if err == nil {
				t.Fatal("unsupported authentication accepted")
			}
			_ = client.Close()
			if accepted := <-done; tc.accept && !accepted {
				t.Fatal("classic authentication not selected")
			}
		})
	}
}
func TestGenericVNCStalledHandshake(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	_ = client.SetDeadline(time.Now().Add(20 * time.Millisecond))
	if _, _, err := negotiateVNCPassword(client); err == nil {
		t.Fatal("stalled handshake accepted")
	}
}

func TestGenericVNCRelayEnforcesSelection(t *testing.T) {
	for _, choice := range []byte{1, 2} {
		t.Run(strconv.Itoa(int(choice)), func(t *testing.T) {
			received := make(chan []byte, 1)
			s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) {
				_, _ = conn.Write([]byte("RFB 003.008\n"))
				version := make([]byte, 12)
				if _, err := io.ReadFull(conn, version); err != nil {
					return
				}
				_, _ = conn.Write([]byte{2, 1, 2})
				selection := make([]byte, 1)
				if _, err := io.ReadFull(conn, selection); err != nil || selection[0] != 2 {
					return
				}
				_, _ = conn.Write(bytes.Repeat([]byte{7}, 16))
				response := make([]byte, 16)
				n, _ := io.ReadFull(conn, response)
				received <- response[:n]
			})
			s.cfg.VNCKind = "generic"
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			_, hello, err := ws.Read(ctx)
			if err != nil || !bytes.Equal(hello, append([]byte("RFB 003.008\n"), 1, 2)) {
				t.Fatal("unfiltered handshake", err)
			}
			_, challenge, err := ws.Read(ctx)
			if err != nil || len(challenge) != 16 {
				t.Fatal("challenge", err)
			}
			_ = ws.Write(ctx, websocket.MessageBinary, []byte("RFB "))
			payload := append([]byte("003.008\n"), choice)
			payload = append(payload, bytes.Repeat([]byte{9}, 16)...)
			_ = ws.Write(ctx, websocket.MessageBinary, payload)
			select {
			case response := <-received:
				if choice == 2 && !bytes.Equal(response, bytes.Repeat([]byte{9}, 16)) {
					t.Fatal("classic response lost")
				}
				if choice == 1 && len(response) > 0 {
					t.Fatal("anonymous response reached upstream")
				}
			case <-ctx.Done():
				t.Fatal("relay did not finish")
			}
		})
	}
}
func TestGenericVNCRelayRejectsAnonymousServer(t *testing.T) {
	s, endpoint, cookie, _ := vncFixture(t, func(conn net.Conn) {
		_, _ = conn.Write([]byte("RFB 003.008\n"))
		version := make([]byte, 12)
		if _, err := io.ReadFull(conn, version); err != nil {
			return
		}
		_, _ = conn.Write([]byte{1, 1})
	})
	s.cfg.VNCKind = "generic"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ws, _, err := dialVNCWebSocket(ctx, endpoint, cookie)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	_, _, err = ws.Read(ctx)
	if websocket.CloseStatus(err) != 4406 {
		t.Fatalf("anonymous upstream not rejected: %v", err)
	}
}
