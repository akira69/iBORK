package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/akira69/iBORK/internal/management"
)

const diagnosticLimit = 32 * 1024
const diagnosticHelp = "Read-only commands:\nhelp\npower status\nsensor list\nfru (or inventory)\nsel (or events)\ndcmi power\ncooling status\n\nShell syntax, raw commands, host overrides and credentials are not accepted."

func (s *Server) serveCooling(w http.ResponseWriter, _ *http.Request, ctx context.Context) {
	p, ok := s.provider.(management.CoolingProvider)
	if !ok {
		fail(w, 501, "Cooling query is unavailable for this provider")
		return
	}
	s.read(w, ctx, "cooling", 30*time.Second, func(ctx context.Context) (any, error) { return p.Cooling(ctx) })
}

func (s *Server) serveDiagnostics(w http.ResponseWriter, r *http.Request, ctx context.Context) {
	var body struct {
		Command string `json:"command"`
	}
	if !decode(w, r, &body) {
		return
	}
	var load func(context.Context) (any, error)
	// Exact commands deliberately exclude option parsing and shell interpretation.
	switch strings.ToLower(strings.Trim(body.Command, " ")) {
	case "help":
		reply(w, 200, map[string]any{"output": diagnosticHelp, "truncated": false})
		return
	case "power status":
		load = func(ctx context.Context) (any, error) { return s.provider.Power(ctx) }
	case "sensor list":
		load = func(ctx context.Context) (any, error) { return s.provider.Sensors(ctx) }
	case "fru", "inventory":
		load = func(ctx context.Context) (any, error) { return s.provider.Inventory(ctx) }
	case "sel", "events":
		load = func(ctx context.Context) (any, error) { return s.provider.Events(ctx) }
	case "dcmi power":
		load = func(ctx context.Context) (any, error) {
			watts, err := s.provider.Watts(ctx)
			return map[string]float64{"watts": watts}, err
		}
	case "cooling status":
		p, ok := s.provider.(management.CoolingProvider)
		if !ok {
			fail(w, 501, "Cooling query is unavailable for this provider")
			return
		}
		load = func(ctx context.Context) (any, error) { return p.Cooling(ctx) }
	default:
		fail(w, 400, "Unsupported diagnostic command; enter help for read-only commands")
		return
	}
	select {
	case s.readGate <- struct{}{}:
		defer func() { <-s.readGate }()
	case <-ctx.Done():
		upstreamError(w, ctx.Err())
		return
	}
	value, err := load(ctx)
	if err != nil {
		upstreamError(w, err)
		return
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fail(w, 502, "Device returned an invalid diagnostic response")
		return
	}
	truncated := len(data) > diagnosticLimit
	if truncated {
		data = data[:diagnosticLimit]
		for !utf8.Valid(data) {
			data = data[:len(data)-1]
		}
	}
	reply(w, 200, map[string]any{"output": string(data), "truncated": truncated})
}
