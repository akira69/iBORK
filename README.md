# iBORK

**IPMI · Bare-metal Operations & Remote KVM**
*Less bork. More uptime.* — by Finch13

iBORK brings remote consoles, sensors and power readings into one web workspace. Connect an IPMI server, a standalone KVM, or a telemetry source. Use the KVM Wall to view several consoles together and select one for keyboard and mouse input. JetKVM uses its stock firmware.

## Quick start

Build with Node.js 24 and Go 1.27.3 or newer. The Go executable embeds the web UI.

```sh
(cd web && npm ci && npm run build)
mkdir -p dist
go build -trimpath -o dist/jet-supermicro .
```

For a local evaluation on Linux or macOS, create a private state directory and a dashboard password hash. The hash command prompts for the password.

```sh
umask 077
mkdir -p "$HOME/.local/state/ibork/settings"
export STATE_DIRECTORY="$HOME/.local/state/ibork"
export APP_PASSWORD_HASH_FILE="$STATE_DIRECTORY/bootstrap-password-hash"
./dist/jet-supermicro hash-password > "$APP_PASSWORD_HASH_FILE"
./dist/jet-supermicro
```

Open **http://localhost:8080**, sign in, and choose **iBORK settings → Add server**. For network access, configure HTTPS and an exact external origin. Restrict access to people and networks authorized to manage your hardware.

## Features

- Connect via IPMI, JetKVM, VNC or a supported Comet KVM. Each workspace shows the tools its providers support.
- Review IPMI or Glances sensors, server events, power history and metered outlets. Set your electricity rate in iBORK settings.
- Arrange server and fleet dashboards. Pair an optional touchscreen to view selected servers, apply a shared brightness schedule, and request PIN-protected power actions.

[Operator guide](docs/usage.md) · [Deployment](docs/deployment.md) · [Display provisioning and API](docs/panel-api.md) · [ESP32 display firmware](https://github.com/akira69/iBORK-ESP32)

## Development

```sh
(cd web && npm ci && npm run lint && npm test && npm run build)
go test ./...
go vet ./...
```

See the [vendored dependency notes](docs/vendor-patches.md) before regenerating Go dependencies. iBORK is licensed under [GPL-2.0](LICENSE). [Third-party notices](THIRD_PARTY_NOTICES.md) cover dependencies and bundled assets.
