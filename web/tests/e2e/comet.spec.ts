import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function comet(page: Page, noSignal = false, managed = false) {
  await setup(page, true, false);
  await page.addInitScript(
    ({ noSignal }) => {
      localStorage.setItem(
        "jet-supermicro:display:v1:device:default",
        JSON.stringify({ autoConnect: false }),
      );
      const telemetry = {
        keys: [] as { key: string; state: boolean }[],
        sockets: 0,
        closed: 0,
        errors: [] as string[],
        codec: "",
        restore: () => {},
        fail: (code: number) => {
          void code;
        },
      };
      Object.assign(window, { comet: telemetry });
      class Socket {
        static OPEN = 1;
        readyState = 1;
        onopen?: () => void;
        onmessage?: (e: { data: string }) => void;
        onclose?: (e: { code: number }) => void;
        peer = new RTCPeerConnection();
        timer?: ReturnType<typeof setInterval>;
        candidates: RTCIceCandidateInit[] = [];
        stream?: MediaStream;
        constructor() {
          telemetry.sockets++;
          telemetry.restore = () => {
            this.metadata(false);
            void this.offer();
          };
          telemetry.fail = (code) => {
            this.close();
            this.onclose?.({ code });
          };
          setTimeout(() => {
            this.onopen?.();
            this.metadata(noSignal);
          }, 10);
        }
        message(channel: string, data: unknown) {
          this.onmessage?.({ data: JSON.stringify({ channel, data }) });
        }
        metadata(missing: boolean) {
          this.message("events", {
            event_type: "streamer",
            event: {
              streamer: {
                source: {
                  online: true,
                  real_resolution: missing ? "no_signal" : "640x360",
                },
              },
            },
          });
        }
        async offer() {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          const context = canvas.getContext("2d")!;
          let frame = 0;
          const draw = () => {
            context.fillStyle = "#10242a";
            context.fillRect(0, 0, 640, 360);
            context.fillStyle = "#9edac7";
            context.font = "24px monospace";
            context.fillText(`Comet H.264 fixture ${++frame}`, 30, 80);
          };
          draw();
          this.timer = setInterval(draw, 100);
          this.stream = canvas.captureStream(10);
          const transceiver = this.peer.addTransceiver(
            this.stream.getVideoTracks()[0],
            { direction: "sendonly" },
          );
          const codecs = RTCRtpSender.getCapabilities("video")!.codecs.filter(
            (c) => c.mimeType === "video/H264",
          );
          if (!codecs.length) throw Error("H.264 unavailable");
          transceiver.setCodecPreferences(codecs);
          await this.peer.setLocalDescription(await this.peer.createOffer());
          await new Promise<void>((resolve) => {
            if (this.peer.iceGatheringState === "complete") resolve();
            else
              this.peer.onicegatheringstatechange = () => {
                if (this.peer.iceGatheringState === "complete") resolve();
              };
          });
          this.message("janus", {
            janus: "event",
            jsep: this.peer.localDescription,
          });
        }
        send(raw: string) {
          void this.handle(raw).catch((error) =>
            telemetry.errors.push(String(error)),
          );
        }
        async handle(raw: string) {
          const { channel, data } = JSON.parse(raw);
          if (channel === "events") {
            if (data.event_type === "key") telemetry.keys.push(data.event);
            return;
          }
          if (data.janus === "create" || data.janus === "attach")
            this.message("janus", {
              janus: "success",
              transaction: data.transaction,
              data: { id: data.janus === "create" ? 1 : 2 },
            });
          if (data.body?.request === "watch" && !noSignal) await this.offer();
          if (data.body?.request === "start") {
            await this.peer.setRemoteDescription(data.jsep);
            for (const candidate of this.candidates)
              await this.peer.addIceCandidate(candidate);
            this.candidates = [];
            telemetry.codec = data.jsep.sdp.includes("H264") ? "H264" : "other";
          }
          if (data.janus === "trickle" && !data.candidate.completed) {
            if (this.peer.remoteDescription)
              await this.peer.addIceCandidate(data.candidate);
            else this.candidates.push(data.candidate);
          }
        }
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          telemetry.closed++;
          clearInterval(this.timer);
          this.stream?.getTracks().forEach((track) => track.stop());
          this.peer.close();
        }
      }
      Object.defineProperty(window, "WebSocket", {
        value: new Proxy(WebSocket, {
          construct(target, args) {
            return String(args[0]).includes("/glkvm/session")
              ? new Socket()
              : Reflect.construct(target, args);
          },
        }),
      });
    },
    { noSignal },
  );
  const config = {
    deviceId: "default",
    serverName: "Comet fixture",
    bmcHost: managed ? "192.0.2.1" : "",
    bmcPort: managed ? 623 : 0,
    jetUrl: "",
    glUrl: "https://192.0.2.8",
    glUsername: "admin",
    timeoutSeconds: 1,
  };
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          ...config,
          id: "default",
          name: "Comet fixture",
          hasManagement: managed,
          hasJetKVM: false,
          consoleSources: ["glinet"],
        },
      ],
    }),
  );
  await page.route("**/api/devices/default/config", (route) =>
    route.fulfill({ json: config }),
  );
  await page.route("**/api/device-settings", (route) =>
    route.fulfill({
      json: [
        {
          ...config,
          id: "default",
          name: "Comet fixture",
          host: config.bmcHost,
          port: config.bmcPort,
          username: managed ? "admin" : "",
        },
      ],
    }),
  );
  await page.reload();
}
const telemetry = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          comet: {
            keys: { key: string; state: boolean }[];
            sockets: number;
            closed: number;
            codec: string;
            errors: string[];
          };
        }
      ).comet,
  );

test("decodes real H.264 video, gates keyboard focus, releases keys and closes on settings", async ({
  page,
}) => {
  await comet(page);
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(page.getByLabel("KVM: Online", { exact: true })).toBeVisible();
  const video = page.getByLabel("Remote server video and keyboard control");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.videoWidth),
    )
    .toBe(640);
  expect((await telemetry(page)).codec).toBe("H264");
  await page.keyboard.press("a");
  expect((await telemetry(page)).keys).toEqual([]);
  await video.click();
  await page.keyboard.down("a");
  await page.keyboard.press("Shift+Escape");
  await expect
    .poll(async () =>
      (await telemetry(page)).keys.some((k) => k.key === "KeyA" && !k.state),
    )
    .toBe(true);
  const released = (await telemetry(page)).keys.length;
  await page.keyboard.press("b");
  expect((await telemetry(page)).keys).toHaveLength(released);
  await video.click();
  await page.keyboard.down("c");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect.poll(async () => (await telemetry(page)).closed).toBe(1);
  expect((await telemetry(page)).keys).toContainEqual({
    key: "KeyC",
    state: false,
    finish: false,
  });
  expect((await telemetry(page)).errors).toEqual([]);
  await expect(page.locator('img[src*="jetkvm"]:visible')).toHaveCount(0);
});

test("online device with no_signal shows keyboard-ready console and recovers to decoded video", async ({
  page,
}) => {
  await comet(page, true);
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(page.getByText("No HDMI signal", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Console connected", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("WebRTC connected", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel("KVM: No signal", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/comet-no-signal.png",
  });
  await page.evaluate(() =>
    (window as unknown as { comet: { restore(): void } }).comet.restore(),
  );
  await expect(page.getByLabel("KVM: Online", { exact: true })).toBeVisible();
  await expect(page.getByText("No HDMI signal", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: "test-results/screenshots/comet-video.png" });
});

test("terminal certificate failure stops reconnects and managed Comet settings have no Jet branding", async ({
  page,
}) => {
  await comet(page, true, true);
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(page.getByText("No HDMI signal", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { comet: { fail(code: number): void } }).comet.fail(
      4403,
    ),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Comet certificate does not match",
  );
  await page.clock.install();
  await page.clock.runFor(10000);
  expect((await telemetry(page)).sockets).toBe(1);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect(page.locator('img[src*="jetkvm"]:visible')).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Console compatibility", exact: true }),
  ).toHaveCount(0);
});

test("wall connects Comet and preserves its video session when enlarged", async ({
  page,
}) => {
  await comet(page);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  const tile = page.getByRole("region", { name: "Comet fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.getByRole("button", { name: "Enlarge Comet fixture" }).click();
  await expect(
    page.getByRole("region", { name: "Enlarged console" }).locator("video"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wall", exact: true }).click();
  expect((await telemetry(page)).sockets).toBe(1);
  expect((await telemetry(page)).closed).toBe(0);
});

test.describe("Comet mobile keyboard", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("types through the shared keyboard and releases control when hidden", async ({
    page,
  }) => {
    await comet(page, true);
    await page
      .getByRole("button", { name: "Connect to console", exact: true })
      .tap();
    await expect(
      page.getByText("No HDMI signal", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Show keyboard", exact: true })
      .tap();
    await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
    await page.keyboard.insertText("a");
    await expect
      .poll(async () =>
        (await telemetry(page)).keys.filter((k) => k.key === "KeyA"),
      )
      .toEqual([
        { key: "KeyA", state: true, finish: false },
        { key: "KeyA", state: false, finish: false },
      ]);
    await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
    await expect(page.getByLabel("Remote keyboard input")).not.toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });
});

test("an old saved JetKVM widget follows the standalone Comet provider", async ({
  page,
}) => {
  await comet(page, true);
  await page.evaluate(() =>
    localStorage.setItem(
      "jet-supermicro:dashboard:v1:device:default",
      JSON.stringify({
        version: 1,
        widgets: [{ id: "jetkvm", kind: "jetkvm", x: 0, y: 0, w: 12, h: 6 }],
      }),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "GL.iNet Comet widget", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Your dashboard is empty. Add a widget to get started."),
  ).toHaveCount(0);
});
