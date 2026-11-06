# Deployment

Keep the service on a trusted management network. The browser must be able to reach the JetKVM media endpoint. The service needs network access to the configured management, console and telemetry providers.

## Run from source

Follow the [build instructions](../README.md). The service listens on loopback by default. Set `APP_ORIGIN` to the exact HTTPS origin seen by browser clients when using a reverse proxy. The [example environment](../deploy/config.env.example) and [Caddy configuration](../deploy/Caddyfile) show the available settings. Supply your own DNS name and trusted certificate chain.

Store credentials outside the checkout. Set `APP_PASSWORD_HASH_FILE` to a protected bcrypt hash file and `STATE_DIRECTORY` to private persistent storage writable by the service. Add devices through the dashboard after login. Configure read-only management credentials when you only need telemetry. The optional panel bearer token and PIN hash are separate credentials. See [display provisioning](panel-api.md).

## Linux service

The [systemd unit](../deploy/jet-supermicro.service) uses a dynamic user and a private state directory. It reads its environment from `/etc/jet-supermicro/config.env`. To prepare the dashboard password credential on a host that supports encrypted systemd credentials, run the following from the source checkout in a root shell after building:

```sh
set -euo pipefail
umask 077
install -d -m 0700 /etc/jet-supermicro
./dist/jet-supermicro hash-password | systemd-creds encrypt --with-key=host --name=app-password-hash - /etc/jet-supermicro/app-password-hash.cred
install -m 0600 deploy/config.env.example /etc/jet-supermicro/config.env
```

Edit the environment file for your installation before starting the service. For a source install, install the executable as `/opt/jet-supermicro/jet-supermicro` and the unit in `/etc/systemd/system/`. Run `systemctl daemon-reload` and `systemctl enable --now jet-supermicro`. Verify the service status, HTTPS origin and browser sign-in before adding devices. Back up service state and credentials before upgrades.

## Releases

Source builds are available at launch. The release installer and updater expect a published Linux amd64 binary, service unit, scripts and SHA-256 manifest. Use them only for a tag that supplies the complete asset set. Leave running installations on their configured version until you have verified the new release source, preserved their settings and tested rollback.

## Container

Build from the repository root with `docker build -t ibork .`. Supply a readable password-hash file, a writable state volume and the correct external origin. Bind the container port to loopback when a reverse proxy provides external HTTPS access.
