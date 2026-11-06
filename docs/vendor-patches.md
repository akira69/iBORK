# Vendored Go dependencies

`vendor/` is generated from the pinned `go.mod` / `go.sum` with `go mod vendor`.
Normal Go builds use it automatically. Preserve upstream licenses. Do not build
with `-mod=mod`: the upstream client does not expose the KG setter yet.

## IPMI KG key

- `vendor/github.com/bougou/go-ipmi/pkg/client/kg_key.go`: a copying `WithKG`
  setter for the library's existing `session.v20.bmcKey` and RAKP derivation.
  Call only before connecting. App validation requires exactly 20 decoded bytes.
- `kg_key_test.go` beside it: verifies KG-derived session keys, caller ownership
  and unchanged password-only authentication. Run explicitly with
  `go test github.com/bougou/go-ipmi/pkg/client`; `go test ./...` skips vendor.

When updating dependencies, preserve these two additions before regenerating
vendor, restore them afterward, and run the explicit test plus the app suite.
Replace the local setter when upstream provides an equivalent supported API.
No cryptographic algorithm or wire-protocol code is changed here.

## MQTT receive order

iBORK's QoS 0 meter subscriber enables a small local `WithOrderedHandlers`
option in `vendor/github.com/gonzalop/mq`. Preserve the option in `options.go`
and `options_limits.go`, and its dispatch branch in `logic.go`, when regenerating
vendor. Upstream v0.11.0 launches a goroutine per incoming message even when
handler concurrency is limited to one. A burst can reorder untimestamped watts
and accumulate waiting goroutines. The option runs the short measurement handler
on the packet loop, allowing the four-packet queue to backpressure the socket.
Handlers in this mode must return promptly without waiting for MQTT operations.

Run `go test -count=20 -run TestMQTTBroker ./internal/meter` after an upgrade.
It sends a 512-message burst and checks the last delivered watts. Retire the
patch when upstream provides ordered, bounded dispatch.
