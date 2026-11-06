package client

import (
	"bytes"
	"github.com/bougou/go-ipmi/pkg/crypto"
	"github.com/bougou/go-ipmi/pkg/types"
	"testing"
)

func TestKGKeyDerivationAndOwnership(t *testing.T) {
	c, err := NewClient("fixture.invalid", 623, "root", "fixture-password")
	if err != nil {
		t.Fatal(err)
	}
	c.session.v20.authAlg = types.AuthAlg_HMAC_SHA1
	key := bytes.Repeat([]byte{0x42}, 20)
	c.WithKG(key)
	key[0] = 0
	want, err := crypto.DeriveSIK(c.session.v20.authAlg, c.session.v20.consoleRand[:], c.session.v20.bmcRand[:], c.session.v20.role, c.Username, bytes.Repeat([]byte{0x42}, 20))
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.generate_sik()
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("KG key not used or caller mutation changed it")
	}
	c.WithKG(nil)
	want, err = crypto.DeriveSIK(c.session.v20.authAlg, c.session.v20.consoleRand[:], c.session.v20.bmcRand[:], c.session.v20.role, c.Username, crypto.PadPassword20([]byte(c.Password)))
	if err != nil {
		t.Fatal(err)
	}
	got, err = c.generate_sik()
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("one-key authentication changed")
	}
}
