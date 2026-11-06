import { type Page } from "@playwright/test";

export async function setup(
  page: Page,
  bmc: boolean,
  kvm: boolean,
  signal = true,
  autoConnect = false,
  freshVisit = false,
) {
  // Existing hardware scenarios begin on Console; first-visit tests opt out.
  if (!freshVisit)
    await page.addInitScript(() => {
      if (!localStorage.getItem("ibork:navigation:v1"))
        localStorage.setItem(
          "ibork:navigation:v1",
          JSON.stringify({
            deviceId: "default",
            tab: "Console",
            view: "server",
          }),
        );
    });
  if (!autoConnect)
    await page.addInitScript(() => {
      for (const address of [
        "192.0.2.50",
        "192.0.2.1",
        "192.0.2.2",
        "192.0.2.10",
        "192.0.2.11",
        "192.0.2.20",
        "192.0.2.40",
      ]) {
        const key = `jet-supermicro:display:v1:${address}:623`;
        if (!localStorage.getItem(key))
          localStorage.setItem(key, JSON.stringify({ autoConnect: false }));
      }
    });
  await page.addInitScript(
    ({ connected, signal }) => {
      if (!connected) return;
      // Windows WebKit has no WebRTC; no-signal fixtures still exercise connections and input.
      if (!signal && typeof MediaStream === "undefined")
        Object.defineProperty(window, "MediaStream", {
          value: class {
            addTrack() {}
          },
        });
      const wheelReports: unknown[] = [];
      const telemetry = {
        peers: 0,
        closed: 0,
        hid: [] as number[][],
        rpc: [] as string[],
      };
      Object.defineProperty(window, "telemetry", { value: telemetry });
      Object.defineProperty(window, "wheelReports", { value: wheelReports });
      class Channel {
        readyState = "open";
        onopen?: () => void;
        onmessage?: (e: { data: ArrayBuffer | string }) => void;
        send(data: string | Uint8Array) {
          if (typeof data === "string") {
            const report = JSON.parse(data);
            telemetry.rpc.push(report.method);
            if (report.id)
              setTimeout(
                () =>
                  this.onmessage?.({
                    data: JSON.stringify({
                      id: report.id,
                      result: report.method === "getEDID" ? "fixture-edid" : {},
                    }),
                  }),
                0,
              );
            if (report.method === "wheelReport")
              wheelReports.push(report.params);
          } else telemetry.hid.push(Array.from(data));
        }
        constructor(name: string) {
          setTimeout(() => {
            this.onopen?.();
            this.onmessage?.({ data: new Uint8Array([1, 1]).buffer });
            if (name === "rpc" && !signal)
              this.onmessage?.({
                data: JSON.stringify({
                  method: "videoInputState",
                  params: { ready: false, error: "no_signal" },
                }),
              });
          }, 20);
        }
      }
      class Peer {
        connectionState = "new";
        framesDecoded = 0;
        async getStats() {
          return new Map([
            [
              "video",
              {
                type: "inbound-rtp",
                kind: "video",
                framesDecoded: this.framesDecoded ? ++this.framesDecoded : 0,
              },
            ],
          ]);
        }
        constructor() {
          telemetry.peers++;
        }
        ontrack?: (e: { track: MediaStreamTrack }) => void;
        onconnectionstatechange?: () => void;
        localDescription = { type: "offer", sdp: "fixture" };
        addTransceiver() {}
        createDataChannel(name: string) {
          return new Channel(name);
        }
        async createOffer() {
          return this.localDescription;
        }
        async setLocalDescription() {
          setTimeout(() => {
            this.connectionState = "connected";
            this.onconnectionstatechange?.();
            if (!signal) return;
            const canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 720;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#10242a";
            ctx.fillRect(0, 0, 1280, 720);
            ctx.fillStyle = "#9edac7";
            ctx.font = "28px monospace";
            ctx.fillText("JetKVM fixture · 1280 × 720", 80, 100);
            ctx.fillText("server:~$ _", 24, 696);
            const stream = canvas.captureStream(1);
            this.framesDecoded = 1;
            this.ontrack?.({ track: stream.getVideoTracks()[0] });
          }, 30);
        }
        close() {
          telemetry.closed++;
        }
      }
      class Socket {
        static OPEN = 1;
        readyState = 1;
        onopen?: () => void;
        onmessage?: (e: { data: string }) => void;
        constructor() {
          setTimeout(() => {
            this.onopen?.();
            this.onmessage?.({
              data: JSON.stringify({ type: "device-metadata", data: {} }),
            });
          }, 10);
        }
        send() {}
        close() {}
      }
      Object.defineProperty(window, "WebSocket", { value: Socket });
      Object.defineProperty(window, "RTCPeerConnection", { value: Peer });
    },
    { connected: kvm, signal },
  );
  let usdPerKwh = 0.2;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      /^\/api\/devices\/[^/]+\//,
      "/api/",
    );
    if (path === "/api/electricity-rate") {
      if (route.request().method() === "PUT")
        usdPerKwh = route.request().postDataJSON().usdPerKwh;
      return route.fulfill({ json: { usdPerKwh } });
    }
    const data: Record<string, unknown> = {
      "/api/panel-display": { error: "Panel access is disabled" },
      "/api/panel-layout": { error: "Panel access is disabled" },
      "/api/session": { csrf: "fixture" },
      "/api/energy": {
        now: Math.floor(Date.now() / 1000),
        samples: [],
        source: "Fixture",
      },
      "/api/device-settings": [
        {
          id: "default",
          name: "Demo compute",
          host: "192.0.2.50",
          port: 623,
          username: "ADMIN",
          jetUrl: "http://192.0.2.51",
        },
      ],
      "/api/devices": [
        {
          id: "default",
          name: "Demo compute",
          manufacturer: "Supermicro",
          model: "DEMO-BOARD",
          bmcHost: "192.0.2.50",
          bmcPort: 623,
          hasJetKVM: true,
        },
      ],
      "/api/config": {
        serverName: "Demo compute",
        bmcHost: "192.0.2.50",
        bmcPort: 623,
        bmcUsername: "ADMIN",
        jetUrl: "http://192.0.2.51",
        timeoutSeconds: 10,
      },
      "/api/power": { state: "on" },
      "/api/sensors": [
        {
          id: "1",
          name: "CPU1 Temp",
          value: "42.000 degrees C",
          unit: "degrees C",
          state: "ok",
        },
        {
          id: "2",
          name: "FAN1",
          value: "3200.000 RPM",
          unit: "RPM",
          state: "ok",
        },
        {
          id: "4",
          name: "PS1 Status",
          value: "Presence detected",
          unit: "discrete",
          state: "ok",
        },
        {
          id: "5",
          name: "PS2 Status",
          value: "Presence detected",
          unit: "discrete",
          state: "ok",
        },
        {
          id: "3",
          name: "PSU2",
          value: "Not present",
          unit: "",
          state: "unavailable",
        },
      ],
      "/api/events": [],
      "/api/cooling": {
        modeCode: "0x03",
        modeLabel: "Unknown",
        querySupported: true,
        controlSupported: false,
        reason: "Fan control needs board-specific qualification.",
      },
      "/api/inventory": {
        fields: {
          Manufacturer: "Supermicro",
          Board: "DEMO-BOARD",
          "BIOS version": "Unavailable via standard IPMI",
        },
      },
    };
    const unavailable =
      !bmc &&
      ["/api/power", "/api/sensors", "/api/inventory", "/api/events"].includes(
        path,
      );
    await route.fulfill({
      status: ["/api/panel-display", "/api/panel-layout"].includes(path)
        ? 404
        : unavailable
          ? 504
          : 200,
      contentType: "application/json",
      body: JSON.stringify(
        unavailable
          ? { error: "Device timed out; check connection and credentials" }
          : (data[path] ?? { ok: true }),
      ),
    });
  });
  await page.goto("/");
  if (kvm && !autoConnect)
    await page
      .getByRole("button", { name: "Connect to console", exact: true })
      .click();
}
