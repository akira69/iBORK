package assistant

import (
	"context"
	"encoding/json"
	"testing"
)

func TestScopeAndDraft(t *testing.T) {
	for _, bad := range []string{"8.8.8.8", "127.0.0.1", "10.1.0.0/16", "169.254.1.2"} {
		if _, err := Targets(bad); err == nil {
			t.Fatal(bad)
		}
	}
	hosts, err := Targets("10.1.2.0/30")
	if err != nil || len(hosts) != 2 {
		t.Fatal(hosts, err)
	}
	g := Grant{Scope: "10.1.2.1", Candidates: []Candidate{{ID: "bmc@10.1.2.1", Kind: "bmc", Address: "10.1.2.1"}}}
	call := func(args string) error {
		_, err := g.Call(context.Background(), "propose_server", json.RawMessage(args))
		return err
	}
	if call(`{"name":"Vault","bmc":"bmc@10.1.2.1"}`) != nil || g.Draft.Host != "10.1.2.1" {
		t.Fatal(g.Draft)
	}
	if call(`{"name":"Other","bmc":"outside"}`) == nil || call(`{"name":"Vault","password":"bad"}`) == nil {
		t.Fatal("accepted invalid input")
	}
}
