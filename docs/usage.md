## Welcome to iBORK

iBORK brings server management and remote consoles into one workspace. Use it to view a server's display, operate its keyboard and mouse, check health and power usage, and manage supported hardware. Standalone KVM connections work without IPMI management.

A fresh visit opens this information page. After that, iBORK remembers your last page and selected server in this browser, including KVM Wall and settings. Sign in when prompted to return to that page. Clearing browser data or using a different browser or app address starts fresh. If a saved server is removed, iBORK returns here.

## Find your way around

Choose a server icon in the left column to open its Console. The tabs across the workspace show the tools available for that server. Choose KVM Wall for multiple consoles, the book icon for this guide, or the gear for iBORK settings. On a small screen, these app buttons move to the top bar.

iBORK settings contains shared preferences, Add server, sidebar shortcuts, the electricity rate and sign-in security. Server settings contains connections, credentials, appearance and console options for the selected server. Saving a connection reloads the app, reconnects devices and preserves your sign-in.

## Use a remote console

Open a server's Console and connect if needed. Auto-connect can be changed in Server settings. Click the display to control it; Shift+Escape releases keyboard control. Fullscreen gives the console more room. Connection status distinguishes the KVM connection from IPMI management, so one can be available while the other is offline.

KVM Wall brings saved consoles together. Use its settings to choose entries and connection options. Connect a tile, hover over its display to direct keyboard input, or click to enlarge it. Use Back to wall to return. Disconnect when you are finished; switching pages does not replace an explicit disconnect for sessions that remain open.

## View power across servers

In KVM Wall, Power Overview lists every configured server with its power source and sample age. The measured total adds one fresh whole-machine reading per reporting server. A measured 0 W counts. A missing reading, collection error or sample older than 150 seconds reduces coverage. For example, two readings of 80 W and 120 W plus an unmetered server show 200 W and 2 of 3 reporting.

Open Central Dashboard and choose Edit layout to add a widget. Choose one server for a sensor or power reading, or choose Combined power and check the servers to include. Last hour charts cover only intervals where every selected server has measurements at most 150 seconds apart. Energy and cost use those same intervals and the electricity rate in iBORK settings. Groups can overlap across widgets.

The Wall remembers its last view. Opening a telemetry view starts no console sessions. The Central Dashboard layout is saved separately in this browser. Use the title bar and size controls on a wider screen to arrange its widgets.

## Use the iBORK touchscreen display

The current firmware supports the Elecrow CrowPanel DIS08070H V3.0 in 800 × 480 landscape. Another display of this size can reuse the layout once it has a driver for its screen, touch input, and backlight.

On the display, the Wi-Fi icon turns green when the panel joins the network. The server connection icon turns green after iBORK supplies fresh readings. Red identifies which connection needs attention.

The overview shows fleet watts, estimated cost for measured energy, and reporting coverage for 24 hours and 30 days. Set the shared USD/kWh rate in **iBORK settings → Electricity cost** and save it. All dashboards and paired panels use that rate. The initial rate is $0.20/kWh. A panel picks up edits on its next successful telemetry poll. Older servers omit the rate, so an updated panel shows watts and kWh with cost unavailable. Up to 12 server tiles fit below the charts. Each shows an icon, short label, watts and a chevron. Tap a tile for details or swipe up for additional servers. In **iBORK settings → Display settings**, choose **Copy sidebar icons to panel** to send the short labels and cropped artwork from this browser. Repeat after changing the sidebar icons.

Edit the shared daily schedule in **iBORK settings → Display settings** or on the touchscreen under **Settings → Display schedule**. Set four start times in the panel's local time. Each period runs until the next start, including across midnight. Normal uses full brightness, Dim accepts 1–99%, and Screen off turns off the backlight while telemetry continues. The defaults are Screen off at 1 AM, Dim at 5 AM, Normal at 7 AM and Dim at 7 PM, with both dim periods at 25%. The first touch wakes the panel and consumes the tap. Five minutes after the last touch it resumes the schedule. A paired panel requires its PIN to save and reads web edits on the next successful poll.

In **iBORK settings → Edit display layout**, use **Home** to show, hide or reorder fleet power, the 24-hour and 30-day charts, and server tiles. Choose which servers appear and their order. Home totals, history and cost cover the included servers. The browser sidebar has its own visibility settings.

Use **Servers** to choose the sections for each server dashboard. The editor offers watts for a configured meter, temperature and fan readings for IPMI or Glances, and PIN-protected controls for a supported management connection. A metered outlet can provide watts alongside either sensor source. The preview uses example readings. Choose **Save layout** to apply your edits to paired panels on their next successful refresh.

On the touchscreen, tap a tile or use the server selector in the fixed top bar. The selector works even when Home has no server tiles. Opening a dashboard requests sensor readings for that server. A missing reading stays unavailable, and the panel continues to show connection status when offline. Before the first customization, the panel includes every server. Afterward, choose any newly added servers in the web editor.

Tap the gear beside Finch13 for Wi-Fi setup or Change power PIN. To change the PIN, enter the current PIN and then a new 6–12 digit PIN. The change applies to all panels paired with this iBORK server. Power on and graceful shutdown require the panel PIN and confirmation of the target. If the connection drops after submitting a command, check the server before issuing it again.

## Arrange your workspace

Use Edit layout to add, remove, move or resize widgets, then choose Done. While editing, drag a widget's title bar or use arrow keys on a focused title bar to move it. Resize with its corner or size controls. Layouts, display names, sidebar shortcuts and other browser preferences stay in this browser.

## Monitor and manage servers

For a machine without IPMI, choose iBORK settings → Add server → Telemetry server. Enter the Glances origin that the iBORK service can reach. Use HTTPS with a certificate trusted by the iBORK host, or a tunnel that listens on the iBORK host's loopback interface. iBORK reads the Glances v4 sensors endpoint. The Sensors tab shows the temperatures and fan RPM supplied by the host.

Choose Connect Glances over SSH beside the origin field to generate a tunnel setup command. Run it on the iBORK host, then follow its prompt in the Glances server's root terminal. After it verifies the sensors, choose Use tunnel origin and save. For an existing tunnel, enter its local port and use the origin directly.

To add whole-machine watts, connect only that machine to a metered outlet and select its power source in Server connection. Use one physical outlet ID across protocols. For MQTT outlet, enter the broker, exact status topic and the top-level numeric JSON field measured in watts (default watts). Grant the account permission to subscribe to that topic. For Matter via Home Assistant, pair the plug in Home Assistant and enter its HTTPS origin, bearer token and instantaneous power sensor entity in iBORK. The sensor must report W or kW. A switch or a cumulative kWh reading cannot supply live watts. iBORK stores the samples with its local 30-day power history.

On an IPMI server, Sensors shows readings from the BMC unless a Glances source is configured. Events shows the BMC event log, and Inventory shows reported hardware information. Cooling displays available temperatures, fan speeds and supported controls. Check device and connection status if a reading is unavailable.

Power usage shows current consumption, sampled history, measured energy and estimated cost using the electricity rate in iBORK settings. Gaps and partial coverage affect totals, and forecasts are estimates rather than a billing record.

Power controls can start, shut down, reset or cycle a server. Boot selects a one-time boot target. Read the confirmation before applying a change. If a hardware action times out, refresh and check the server before trying again: it may already have happened.

## Terminals and virtual media

Terminals provides Serial-over-LAN and read-only IPMI diagnostics where management is available. Connect SOL explicitly and disconnect when finished. Diagnostics accepts supported commands such as help, power status, sensor list, inventory and events; it is not a shell on the server.

On supported JetKVM connections, virtual media can mount an HTTP or HTTPS ISO URL reachable by the device. The source must support byte-range requests. Check media status and eject when finished. Local ISO upload is not available.

## Connection help

If a console is blank, check whether the KVM is connected and whether the server is sending a video signal. Check the selected server's connection settings, credentials and device reachability. A KVM-only entry has console tools without IPMI sensors, power or SOL.

Use iBORK on your trusted management network or VPN. Sign out when finished, especially on a shared browser. Saved page preferences contain only navigation choices; they do not bypass sign-in or store your passwords.

## iBORK Assistant

Open iBORK settings and expand the brain icon under Add server for optional help. To chat here, open Model connection, enter an OpenAI-compatible /v1 endpoint and a tool-capable model ID, then choose Test & save model. Your messages, server names and device findings go to that provider. Suggested questions fill the message box so you can edit them before sending.

To find devices, approve private IPv4 addresses or a subnet of up to 256 addresses under Discovery scope. Review a proposed server, enter its credentials in the connection form, and choose Verify, save & reconnect. Checks read BMC power status and check JetKVM access. A quiet device can still be added manually.

To use your own agent, open Connect my agent (MCP) on the HTTPS site. Copy the configuration, create a temporary token, and enter it in your client's secret settings. An approved network enables discovery. Without one the agent can still read server names and propose layouts. Use Refresh proposals to review your agent's work. Changing scope, revoking the token or signing out ends its access.

Ask the assistant to tidy one server's Console dashboard or copy the panel arrangement from one server to another. Preview shows the destination and proposed positions. Apply to this browser saves the arrangement for that server. Existing widgets and sensor selections belong to the destination. Repeat for additional servers.
