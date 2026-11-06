package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"strings"

	"github.com/akira69/iBORK/internal/assistant"
)

func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request) {
	if !s.secureAssistantRequest(r) {
		fail(w, 403, "HTTPS required")
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.cfg.Origin {
		fail(w, 403, "Origin rejected")
		return
	}
	key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || len(key) != 64 {
		fail(w, 401, "Pair in iBORK Assistant")
		return
	}
	hash := sha256.Sum256([]byte(key))
	var a *assistantSession
	var paired context.Context
	s.mu.Lock()
	for _, sess := range s.sessions {
		candidate := &sess.assistant
		if candidate.pairCtx != nil && candidate.pairCtx.Err() == nil && subtle.ConstantTimeCompare(hash[:], candidate.hash[:]) == 1 {
			a = candidate
			paired = candidate.pairCtx
			break
		}
	}
	s.mu.Unlock()
	if a == nil {
		fail(w, 401, "Pairing expired or revoked")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(paired, cancel)
	defer stop()
	if r.Method != "POST" {
		w.Header().Set("Allow", "POST")
		fail(w, 405, "POST required")
		return
	}
	if version := r.Header.Get("MCP-Protocol-Version"); version != "" && !supportedMCP(version) {
		fail(w, 400, "Unsupported MCP protocol version")
		return
	}
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		fail(w, 415, "JSON required")
		return
	}
	var req struct {
		JSONRPC string
		ID      json.RawMessage
		Method  string
		Params  json.RawMessage
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	rpcError := func(status, code int, msg string) {
		reply(w, status, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": code, "message": msg}})
	}
	if decoder.Decode(&req) != nil || decoder.Decode(new(any)) != io.EOF {
		req.ID = nil
		rpcError(400, -32700, "Invalid JSON")
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		req.ID = nil
		rpcError(400, -32600, "Invalid request")
		return
	}
	if len(req.ID) == 0 {
		w.WriteHeader(202)
		return
	}
	if req.ID[0] != '"' && (bytes.ContainsAny(req.ID, ".eE") || (req.ID[0] != '-' && (req.ID[0] < '0' || req.ID[0] > '9'))) {
		req.ID = nil
		rpcError(400, -32600, "Invalid request ID")
		return
	}
	var result any
	switch req.Method {
	case "initialize":
		var params struct{ ProtocolVersion string }
		if json.Unmarshal(req.Params, &params) != nil || params.ProtocolVersion == "" {
			rpcError(200, -32602, "Protocol version required")
			return
		}
		version := params.ProtocolVersion
		if !supportedMCP(version) {
			version = "2025-11-25"
		}
		result = map[string]any{"protocolVersion": version, "serverInfo": map[string]string{"name": "ibork-assistant", "version": "1"}, "capabilities": map[string]any{"tools": struct{}{}}}
	case "ping":
		result = struct{}{}
	case "tools/list":
		tools := make([]any, 0, len(assistant.Tools))
		for _, t := range assistant.Tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": t.Parameters})
		}
		result = map[string]any{"tools": tools}
	case "tools/call":
		var params struct {
			Name      string
			Arguments json.RawMessage
		}
		if json.Unmarshal(req.Params, &params) != nil || params.Name == "" {
			rpcError(200, -32602, "Tool name required")
			return
		}
		if !a.mu.TryLock() {
			rpcError(200, -32000, "Assistant is busy")
			return
		}
		defer a.mu.Unlock()
		if paired.Err() != nil {
			fail(w, 401, "Pairing expired")
			return
		}
		value, err := a.grant.Call(ctx, params.Name, params.Arguments)
		var content string
		if err != nil {
			content = err.Error()
		} else {
			data, _ := json.Marshal(value)
			content = string(data)
		}
		result = map[string]any{"content": []any{map[string]string{"type": "text", "text": content}}, "isError": err != nil}
	default:
		rpcError(200, -32601, "Unknown method")
		return
	}
	reply(w, 200, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
}
func supportedMCP(version string) bool {
	return version == "2025-11-25" || version == "2025-06-18" || version == "2025-03-26"
}

// The supported reverse proxy runs on the same host and terminates TLS.
func (s *Server) secureAssistantRequest(r *http.Request) bool {
	if !strings.HasPrefix(s.cfg.Origin, "https://") {
		return false
	}
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	return r.TLS != nil || (err == nil && peer.Addr().Unmap().IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https")
}
