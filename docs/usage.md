# iBORK

## Operator handbook

Connect to a server, follow its power draw, or ask the iBORK Assistant to help set up your fleet.

## Getting around

### Choose a server

Select a server in the left rail to see its tools. A standalone KVM provides a console. A management connection adds hardware controls. **KVM Wall** brings multiple servers into one view. On small screens, the wall, guide and settings buttons move to the top bar.

### Find the right settings

Open **iBORK settings** for Add server, sidebar shortcuts, the shared electricity rate and sign-in security. Open **Server settings** for the selected machine’s connections, credentials, appearance and console options. Saving a connection reloads the app and reconnects your devices.

### Pick up where you left off

After your first visit, this browser remembers your last server and page. Sign in to return there. Clearing browser data, using a different app address or removing the selected server brings you back to this guide.

## iBORK Assistant

Open the brain icon at the right edge of any signed-in page to chat. Ask the Assistant to find devices, pair a KVM or rearrange a Console dashboard. The gear in the chat header opens **Assistant settings**.

### Chat with a model

In **Assistant settings → Model**, enter your provider’s OpenAI-compatible `/v1` endpoint and the ID of a tool-capable model. Choose **Test & save model** to set the shared default. The picker below your message lists models from that endpoint, including models installed in Ollama. Choose a chat model that supports tool calls. Your selection applies to this conversation.

Type a question or choose a suggestion and edit it. Press `Enter` to send or `Shift+Enter` for a new line. The selected provider receives your messages and device findings. Use the connection form for device passwords.

### Discover and verify devices

In **Assistant settings → Discovery**, approve private IPv4 addresses or a subnet of up to 256 addresses. Try **Find my devices** or **Pair a KVM**. Review the proposed server and its physical pairing, enter credentials in the form, then choose **Verify, save & reconnect**. Verification checks BMC power status or JetKVM access as applicable. You can add a quiet device manually.

### Connect your own agent

On the HTTPS site, open **Assistant settings → MCP**. Copy the client configuration and put the temporary token in your client’s secret settings. Tokens expire within 15 minutes. Discovery requires an approved network. Your agent can read server names and propose layouts without one. Reopen the chat to see its latest proposals. Changing scope, revoking the token or signing out ends access.

### Preview a layout

Try **Tidy my dashboard** to close gaps, or **Copy a layout** to copy panel positions and sizes between servers. Review the destination in the preview. **Apply to this browser** saves the arrangement. The destination keeps its widgets and sensor selections.

## Remote consoles

### Control one machine

Open **Console** and connect. To change auto-connect, open **Server settings**. Click the display to send keyboard and mouse input. Press `Shift+Escape` to release the keyboard or use **Fullscreen** for more room. The KVM and IPMI indicators report each connection separately.

### Work from the wall

Use **KVM Wall** settings to choose consoles and connection options. Connect a tile and hover over its display to direct keyboard input. Click to enlarge it and choose **Back to wall** to return. Disconnect explicitly when you finish a session.

## Power and energy

### Read fleet coverage

Open **KVM Wall → Power Overview** to see each server’s power source and sample age. The total counts one whole-machine reading per server, including 0 W. If two servers report 80 W and 120 W while a third has no meter, you’ll see **200 W · 2 of 3 reporting**. A collection error or a sample older than 150 seconds reduces coverage.

### Compare a group

In **Central Dashboard → Edit layout**, add a power or sensor widget for one server, or choose **Combined power** and select a group. Last-hour charts count intervals where every selected server has readings at most 150 seconds apart. Energy and estimated cost cover those same intervals. Different widgets can use overlapping groups.

### Estimate cost

Set the shared USD/kWh rate in **iBORK settings → Electricity cost**. The initial rate is $0.20/kWh. **Power usage** shows measured history, energy and estimated cost for one server. Check coverage before using a forecast. Opening a telemetry view starts no console sessions.

## Dashboard layouts

Use **Edit layout** to add or remove widgets. Drag a title bar, or focus it and use the arrow keys to move the widget. Resize with the corner or size controls, then choose **Done**.

The Central Dashboard has its own layout. Arrange its widgets on a wider screen. Layouts, display names and sidebar shortcuts are saved in this browser. KVM Wall also remembers its last view.

## Sensors and management

### Connect Glances

For a host without IPMI, choose **iBORK settings → Add server → Telemetry server**. Enter a Glances origin the service can reach over trusted HTTPS or a tunnel on the iBORK host’s loopback interface. **Sensors** reads temperatures and fan speeds from the Glances v4 sensors endpoint.

Expand **Connect Glances over SSH** and enter the server address and a free local port. Copy **Start setup** into a root terminal on the iBORK host. Paste its public pairing line into the guide, then copy each command in the Glances server section into that server’s root terminal. Paste its public host key into the waiting iBORK terminal. Once the sensor check succeeds, choose **Use tunnel origin** and save. For an existing tunnel, enter its local port directly.

### Add a power meter

Connect just the measured machine to the outlet. In **Server connection**, select its power source. Use the same physical outlet ID across protocols. iBORK keeps 30 days of local power history.

For **MQTT outlet**, enter the broker, exact status topic and top-level numeric watts field (default `watts`). The account needs subscribe access to that topic. For **Matter via Home Assistant**, pair the plug there and supply its HTTPS origin, bearer token and instantaneous power sensor entity. Select a sensor that reports W or kW.

### Inspect hardware and issue commands

Open **Sensors** for temperatures and fan speeds. On managed servers the readings come from the BMC unless Glances is configured. **Cooling** shows the current firmware fan mode on supported boards. Use **Events** for the BMC log and **Inventory** for reported hardware details.

Power controls can start, shut down, reset or cycle the server. **Boot** sets a one-time boot target. Confirm the target before applying. If a command times out, **check the server before retrying**. The first request may already have taken effect.

## Touchscreen display

### Read the panel

The Elecrow CrowPanel DIS08070H V3.0 uses an 800 × 480 landscape layout. A green Wi-Fi icon means the panel joined the network. A green server icon means fresh iBORK readings arrived. A red icon identifies the connection to check.

Home shows fleet watts, estimated cost and reporting coverage over 24 hours and 30 days. Up to 12 server tiles show a short label and watts. Tap a tile for details, swipe up for more servers, or use the top-bar selector even when Home has no tiles. Opening a server requests fresh readings.

### Choose what appears

In **iBORK settings → Remote display → Home**, show, hide or reorder fleet power, charts and tiles. Totals and cost cover the servers you include. Initially all servers are included. After customizing, add new servers in the editor.

Under **Servers**, choose watts for a configured meter, temperatures and fans for IPMI or Glances, and PIN-protected controls for supported management connections. The preview uses the latest panel readings and leaves gaps where measurements are missing. Remote display shows when the panel last checked in and marks the connection stale after one minute. Select the preview palette that matches your touchscreen. Choose **Save layout** for paired panels to pick up changes on refresh.

In **Remote display → Display settings**, use **Copy sidebar icons to panel** after editing browser labels or artwork. Paired panels also pick up the shared electricity rate on their next successful poll. With an older server, the panel can show watts and kWh while cost is unavailable.

### Schedule the backlight

Use **iBORK settings → Remote display → Display settings** or **Settings → Display → Edit schedule** on the panel. Set four local start times. Each period runs until the next, including across midnight. Normal uses full brightness, Dim accepts 1–99%, and Screen off keeps telemetry running with the backlight off.

The default schedule turns the screen off at 1 AM, dims to 25% at 5 AM, returns to full brightness at 7 AM and dims to 25% at 7 PM. In scheduled mode, the first touch wakes the screen and consumes the tap. The schedule resumes after five idle minutes. A paired panel requires its PIN to save schedule changes.

The panel's **Display** page also has a 1–100% brightness slider. Manual brightness works offline and survives restarts until you tap **Use schedule**. It applies only to that panel and does not change the shared schedule.

### Protect power actions

Tap the gear beside Finch13 for Wi-Fi setup or **Change power PIN**. Enter the current PIN and a new 6–12 digit PIN. The new PIN applies to every panel paired with this iBORK server. Power on and graceful shutdown require the PIN and target confirmation. If the connection drops after submission, check the server before sending another command.

## Terminals and media

### Open a terminal

**Terminals** offers Serial-over-LAN and read-only IPMI diagnostics on supported management connections. Connect SOL explicitly and disconnect when finished. Diagnostics accepts commands such as `help`, `power status`, `sensor list`, `inventory` and `events`.

### Mount an ISO

On a supported JetKVM connection, supply an HTTP or HTTPS ISO URL the device can reach. The source must support byte-range requests. Check media status after mounting and eject when finished. Host the ISO on a reachable server to use a local image.

## Connection help

### Blank console

Check the KVM connection, then check for a video signal from the server. Confirm the credentials and address in **Server settings**. On a KVM-only entry, console tools are available independently of IPMI sensors, power controls and SOL.

### Shared browser

Use your trusted management network or VPN. Sign out when finished. Browser preferences remember your last page and selected server. Returning to the workspace still requires a valid sign-in.
