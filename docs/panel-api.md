# Display API

The panel uses the same HTTPS origin as iBORK. A dedicated bearer grants telemetry access. Power commands, schedule edits and PIN changes also require the current panel PIN.

## Provisioning

1. Generate a dedicated token with `openssl rand -hex 32`. Redirect its output to a protected file under `umask 077`. Transfer that token to the panel through its private provisioning flow. Keep the token out of shell arguments, source control and request logs.
2. To enable controls, run `jet-supermicro hash-panel-pin` on a terminal. It reads 6–12 digits without echo. Redirect stdout to a protected file, or pipe it to `systemd-creds encrypt --name=panel-pin-hash - /etc/jet-supermicro/panel-pin-hash.cred`. Choose a random PIN distinct from the operator password. The service reads the bcrypt hash and the operator enters the PIN on the panel for each command.
3. Configure `PANEL_TOKEN_FILE` and, for controls, `PANEL_PIN_HASH_FILE` with service-readable paths. For the supplied systemd unit, encrypt the token using credential name `panel-token`, load each encrypted file in a service drop-in, and set the paths in the existing configuration. For example:

   ```ini
   [Service]
   LoadCredentialEncrypted=panel-token:/etc/jet-supermicro/panel-token.cred
   LoadCredentialEncrypted=panel-pin-hash:/etc/jet-supermicro/panel-pin-hash.cred
   ```

   ```sh
   PANEL_TOKEN_FILE=/run/credentials/jet-supermicro.service/panel-token
   PANEL_PIN_HASH_FILE=/run/credentials/jet-supermicro.service/panel-pin-hash
   ```

4. Set `APP_ORIGIN` to the exact HTTPS origin. The supplied loopback Caddy reverse proxy terminates TLS and supplies `X-Forwarded-Proto: https`. The service trusts that header only on loopback connections. Configure the panel to verify the certificate chain and hostname. Reload systemd after changing a unit drop-in and restart iBORK to activate or rotate credentials.

Leaving both paths unset disables the API. Configuring only the token enables read-only use. The authenticated web operator session and the panel bearer have separate scopes.

The configured PIN hash supplies the initial PIN. Operators can change it on the panel. The service stores the replacement bcrypt hash in `STATE_DIRECTORY/settings/panel-pin-override`, bound to the bootstrap hash. To reset a forgotten PIN, generate a fresh bootstrap hash, replace the configured credential and restart the service. Removing `PANEL_PIN_HASH_FILE` from the configuration disables controls on restart even if a saved override exists.

## Requests

Send `Authorization: Bearer <token>` with every request. The native client may omit `Origin`. All responses include `Cache-Control: no-store`.

**GET /api/v1/panel** returns these fields:

| Field | Meaning |
| --- | --- |
| `capturedAt` | Service observation time in UNIX seconds. Subsequent GETs may reuse a snapshot for up to ten seconds. |
| `devices` | Included servers in panel order, with `id`, `name`, `model`, `watts`, `controls`, and ordered `widgets`. Watts are null on read error or when the last observation is older than 150 seconds. Zero is a measured value. Controls require an enabled controls section, a PIN hash and an IPMI management provider. |
| `metered`, `total` | Number of included servers with power collectors and total included servers. |
| `home` | Ordered visible Home sections. Valid values are `power`, `day`, `month` and `servers`. |
| `detail` | Optional readings for the included server requested with `?detail=<id>`. Temperature is in °C and fan speed in RPM. A null reading is unavailable. |
| `day`, `month` | Rolling 24-hour and 30-day windows ending at the observation time. Each contains oldest-first hourly or daily time-weighted mean watts. A bucket with zero observed duration is null. |
| `dayKwh`, `monthKwh` | Energy from intervals observed in common by every included collector. Null when no interval is covered. |
| `dayHours`, `monthHours` | Hours of common observed time in each window. Multiply measured kWh by the configured price per kWh for the cost over these hours. |
| `usdPerKwh` | Shared fleet electricity rate, from 0 to 1000 USD per kWh. Operators read or update it through **GET /api/electricity-rate** and **PUT /api/electricity-rate** using an authenticated web session. PUT requires a CSRF token and a JSON body such as `{"usdPerKwh":0.20}`. |
| `displaySchedule`, `canEditDisplay` | Shared schedule and whether a panel PIN is configured for edits. Each period has a unique start minute in local time (0–1439) and brightness (0–100%). |

Each device may also include a `sidebar` object with its `id`, short `label` and a base64-encoded 40 × 40 JPEG `image`. The authenticated web settings can publish a set from the operator's browser.

Opening a server dashboard requests the hottest mapped temperature and lowest reported fan speed for that server. A cold read returns null while the service fetches the sensors. After 20 seconds the next detail request refreshes the readings in the background. The panel can receive the last successful readings until they reach 90 seconds of age. Failed reads back off for 20 seconds.

**GET /api/panel-layout** returns the effective layout for the authenticated web operator. **PUT /api/panel-layout** requires the operator's CSRF token, the current `revision`, at least one ordered `home` section and a `servers` row for every current inventory ID. Each row supplies `id`, `included` and its ordered `widgets` from `power`, `temperature`, `fan` and `controls`. The response lists each server's `available` widgets. Reload the layout after an HTTP 409 conflict.

**PUT /api/v1/panel/display** accepts the current `revision`, four `periods` and the current panel `pin`. It uses the same PIN attempt limit as power controls. HTTP 200 confirms a durable save. HTTP 409 indicates a newer revision. Refresh before editing again. The authenticated operator uses **GET /api/panel-display** to read the schedule and **PUT /api/panel-display** with CSRF protection to update it without a panel PIN.

Each collector needs two consecutive observations at most 150 seconds apart. The service linearly interpolates between them, clips to the common interval, and integrates across bucket boundaries. Unmetered devices are excluded. An assigned collector with missing readings reduces coverage. Persistent history accumulates for 30 days after upgrade, with existing retained readings available immediately. The web energy endpoint continues to return its seven-day window.

**POST /api/v1/panel/power** requires JSON with exactly the fields `id`, `action`, `confirm` and `pin`. The PIN is a string so leading zeroes survive. Supported actions are `on` (power on) and `soft` (request graceful shutdown). The confirmation string must match the selected action. Success returns HTTP 200 and `{"ok":true}` when the provider accepts the command.

**POST /api/v1/panel/pin** requires a JSON object containing exactly `currentPin` and `newPin`. Both are strings of 6–12 ASCII digits. The new PIN must differ from the current one. HTTP 200 with `{"ok":true}` confirms the new PIN applies immediately to every paired panel and survives restart. Invalid replacement values return 400. A failed save returns 503 and the current PIN still works. After a lost response, verify the outcome before another attempt.

Five failed current-PIN attempts across power commands, display edits and PIN changes lock all three operations for the rest of the five-minute window across all devices. Power commands share the web operator's per-device action cooldown, request gate and device timeout. A rejected PIN returns 403, an invalid bearer returns 401, and throttling returns 429. A timed-out command can already have reached the hardware. Never automatically retry a power POST.
