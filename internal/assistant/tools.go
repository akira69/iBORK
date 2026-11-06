// Package assistant contains the shared tool contract for chat and MCP.
package assistant

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
)

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

func tool(name, description string, required []string, fields ...string) Tool {
	props := map[string]any{}
	for _, key := range fields {
		props[key] = map[string]string{"type": "string"}
	}
	schema := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return Tool{name, description, schema}
}

var Tools = []Tool{
	tool("setup_status", "Read the current approved discovery scope, candidates and proposals.", nil),
	tool("discover_devices", "Look for supported devices only on the network approved in iBORK.", nil),
	tool("propose_server", "Draft one server using discovered candidate IDs. Supply name and bmc and/or kvm.", []string{"name"}, "name", "bmc", "kvm"),
	tool("propose_layout", "Propose tidying one Console dashboard or copying its panel positions to another. Use server IDs from setup_status. The browser previews and applies.", []string{"source", "target"}, "source", "target"),
}

type Candidate struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Address  string `json:"address"`
	Evidence string `json:"evidence"`
}
type Draft struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Host   string `json:"host"`
	JetURL string `json:"jetUrl"`
}
type Layout struct {
	Source string `json:"source"`
	Target string `json:"target"`
}
type Grant struct {
	Scope      string            `json:"scope"`
	Servers    map[string]string `json:"servers"`
	Candidates []Candidate       `json:"candidates"`
	Draft      *Draft            `json:"draft,omitempty"`
	Layout     *Layout           `json:"layout,omitempty"`
	Scan       string            `json:"scan,omitempty"`
}

func arguments(raw json.RawMessage, dest any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if len(raw) > 2048 || !strings.HasPrefix(strings.TrimSpace(string(raw)), "{") {
		return errors.New("expected a small arguments object")
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if d.Decode(dest) != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("invalid tool arguments")
	}
	return nil
}
func (g *Grant) Call(ctx context.Context, name string, args json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch name {
	case "setup_status", "discover_devices":
		if err := arguments(args, &struct{}{}); err != nil {
			return nil, err
		}
		if name == "discover_devices" {
			hosts, err := Targets(g.Scope)
			if err != nil {
				return nil, err
			}
			found, complete := discover(ctx, hosts)
			g.Candidates = found
			g.Draft = nil
			g.Scan = "finished; silent devices may be offline or filtered"
			if !complete {
				g.Scan = "partial; scan deadline reached"
			}
		}
		return g, nil
	case "propose_server":
		var p struct{ Name, BMC, KVM string }
		if err := arguments(args, &p); err != nil {
			return nil, err
		}
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" || len(p.Name) > 100 || strings.IndexFunc(p.Name, unicode.IsControl) >= 0 {
			return nil, errors.New("enter a valid server name")
		}
		draft := Draft{Name: p.Name}
		for _, c := range g.Candidates {
			if c.ID == p.BMC && c.Kind == "bmc" {
				draft.Host = c.Address
			}
			if c.ID == p.KVM && c.Kind == "kvm" {
				// Discovery probes HTTP port 80. Use the same explicit port as saved profiles.
				draft.JetURL = "http://" + c.Address + ":80"
			}
		}
		if (p.BMC == "" && p.KVM == "") || (p.BMC != "" && draft.Host == "") || (p.KVM != "" && draft.JetURL == "") {
			return nil, errors.New("choose discovered candidates from this session")
		}
		if g.Draft != nil {
			draft.ID = g.Draft.ID
			if draft == *g.Draft {
				return draft, nil
			}
		}
		draft.ID = rand.Text()
		g.Draft = &draft
		return draft, nil
	case "propose_layout":
		var p Layout
		if err := arguments(args, &p); err != nil {
			return nil, err
		}
		if _, ok := g.Servers[p.Source]; !ok {
			return nil, errors.New("unknown source server")
		}
		if _, ok := g.Servers[p.Target]; !ok {
			return nil, errors.New("unknown target server")
		}
		g.Layout = &p
		return p, nil
	default:
		return nil, errors.New("unknown assistant tool")
	}
}
