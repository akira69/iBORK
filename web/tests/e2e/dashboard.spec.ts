import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

const storageKey = "jet-supermicro:dashboard:v1:192.0.2.50:623";
const saved = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    storageKey,
  );
async function add(page: Page, title: string) {
  if (
    !(await page.getByRole("button", { name: "Done", exact: true }).isVisible())
  )
    await page
      .getByRole("button", { name: "Edit layout", exact: true })
      .click();
  await page.getByRole("searchbox", { name: "Find widget" }).fill(title);
  await page
    .getByRole("region", { name: "Widget catalog" })
    .getByRole("button", { name: title, exact: true })
    .click();
}

const telemetry = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          telemetry: {
            peers: number;
            closed: number;
            hid: number[][];
            rpc: string[];
          };
        }
      ).telemetry,
  );

test("confirmed no-signal preserves deliberate keyboard wake control", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await expect(page.getByText("No HDMI signal", { exact: true })).toBeVisible();
  await expect(page.getByLabel("KVM: Connected · No video")).toBeVisible();
  const video = page.getByLabel("Remote server video and keyboard control");
  await video.click();
  await page.keyboard.press("a");
  await expect
    .poll(async () =>
      (await telemetry(page)).hid.some(
        (report) => report[0] === 2 && report[2] === 4,
      ),
    )
    .toBe(true);
  await page.clock.install();
  await page.clock.fastForward(60000);
  await expect(page.getByText("No HDMI signal", { exact: true })).toBeVisible();
  expect((await telemetry(page)).peers).toBe(1);
  expect((await telemetry(page)).closed).toBe(0);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("button", { name: "KVM Wall", exact: true }).click();
  const tile = page.getByRole("region", { name: "Demo compute console tile" });
  const status = tile.getByRole("status");
  await expect(status).toHaveText("No video");
  await tile.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(status).toHaveText("disconnected");
  expect(await status.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
    await status.evaluate((el) => el.clientWidth),
  );
});

test("settings disconnect the console while preserving its surface and layout", async ({
  page,
}) => {
  await setup(page, true, true);
  const video = page.getByLabel("Remote server video and keyboard control");
  const originalVideo = await video.elementHandle();
  await expect.poll(() => telemetry(page).then((value) => value.peers)).toBe(1);
  const size = await page.locator('[gs-id="jetkvm"]').getAttribute("gs-w");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(video).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Edit layout", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".overview-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Console", exact: true }).click();
  expect((await telemetry(page)).closed).toBe(1);
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(video).toBeVisible();
  await expect(page.locator('[gs-id="jetkvm"]')).toHaveAttribute("gs-w", size!);
  expect(
    await video.evaluate(
      (element, original) => element === original,
      originalVideo,
    ),
  ).toBe(true);
  expect((await telemetry(page)).peers).toBe(2);
  expect((await telemetry(page)).closed).toBe(1);
});

test("layout editing releases held keys without reconnecting the console", async ({
  page,
}) => {
  await setup(page, true, true);
  const video = page.getByLabel("Remote server video and keyboard control");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBe(1280);
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await video.click();
  await page.keyboard.down("a");
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  expect((await telemetry(page)).hid.filter((x) => x[0] === 2).at(-1)).toEqual([
    2, 0,
  ]);
  const count = (await telemetry(page)).hid.length;
  await video.dispatchEvent("keydown", { code: "KeyB" });
  expect((await telemetry(page)).hid).toHaveLength(count);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect((await telemetry(page)).peers).toBe(1);
});

test("fullscreen rejection reports failure and keeps the console connected", async ({
  page,
}) => {
  await setup(page, true, true);
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = () =>
      Promise.reject(new Error("Denied"));
  });
  await page.getByRole("button", { name: "Fullscreen console" }).click();
  await expect(
    page.getByText("Fullscreen is unavailable in this browser."),
  ).toBeVisible();
  expect((await telemetry(page)).peers).toBe(1);
});

test("resize, drag and fullscreen preserve the connected video and mouse mapping", async ({
  page,
}) => {
  await setup(page, true, true);
  await expect(
    page.getByText("WebRTC connected", { exact: true }),
  ).toBeVisible();
  const video = page.getByLabel("Remote server video and keyboard control");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBe(1280);
  const original = await video.elementHandle();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByLabel("JetKVM width", { exact: true }).fill("6");
  await page.getByLabel("JetKVM height", { exact: true }).fill("8");
  await page.locator("#widget-jetkvm .widget-grip").press("ArrowRight");
  const grip = page.locator("#widget-jetkvm .widget-grip");
  const box = await grip.boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + 15);
  await page.mouse.down();
  await page.mouse.move(box!.x + 150, box!.y + 95, { steps: 12 });
  await page.mouse.up();
  const item = page.locator('[gs-id="jetkvm"]');
  const handle = item.locator(".ui-resizable-se");
  await item.hover();
  await expect(handle).toBeVisible();
  const corner = await handle.boundingBox();
  await page.mouse.move(corner!.x + 5, corner!.y + 5);
  await page.mouse.down();
  await page.mouse.move(corner!.x + 100, corner!.y + 85, { steps: 12 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(await video.evaluate((v, old) => v === old, original)).toBe(true);
  expect((await telemetry(page)).peers).toBe(1);
  expect((await telemetry(page)).closed).toBe(0);
  const before = await saved(page);
  await page.getByRole("button", { name: "Fullscreen console" }).click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await page.screenshot({
    path: "test-results/screenshots/dashboard-fullscreen-fixture.png",
  });
  await page.evaluate(() => document.exitFullscreen());
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  expect(await saved(page)).toEqual(before);
  expect(await video.evaluate((v, old) => v === old, original)).toBe(true);
  for (const size of [
    { width: 1000, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await video.click();
    const packet = (await telemetry(page)).hid
      .filter((p) => p[0] === 3)
      .at(-1)!;
    const view = new DataView(Uint8Array.from(packet).buffer);
    expect(Math.abs(view.getInt32(1) - 16384)).toBeLessThan(150);
    expect(Math.abs(view.getInt32(5) - 16384)).toBeLessThan(150);
  }
  await page.reload();
  await expect(page.locator("#widget-jetkvm")).toBeVisible();
  expect(await saved(page)).toEqual(before);
});

test("removing and readding JetKVM disconnects without duplicate wheel listeners", async ({
  page,
}) => {
  await setup(page, true, true);
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove JetKVM", exact: true })
    .click();
  await expect(page.locator("#widget-jetkvm")).toHaveCount(0);
  expect((await telemetry(page)).closed).toBe(1);
  await add(page, "JetKVM");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect((await telemetry(page)).peers).toBe(1);
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Remote server video and keyboard control").click();
  await page
    .getByLabel("Remote server video and keyboard control")
    .dispatchEvent("wheel", { deltaY: 200 });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { wheelReports: unknown[] }).wheelReports,
      ),
    )
    .toEqual([{ wheelY: -2, wheelX: 0 }]);
  expect((await telemetry(page)).peers).toBe(2);
});

test("mobile add/remove and viewport round trips preserve desktop geometry", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByLabel("JetKVM width", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const before = await saved(page);
  for (const width of [767, 768, 900, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator("#widget-jetkvm")).toBeVisible();
    expect(await saved(page)).toEqual(before);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await add(page, "Selectable sensor");
  await page.getByLabel("Sensor to display").selectOption("2");
  await expect(
    page.getByRole("region", { name: "Sensor reading widget" }),
  ).toContainText("3,200 RPM");
  await page.reload();
  expect(
    (await saved(page)).widgets.find((w: { id: string }) => w.id === "jetkvm"),
  ).toEqual(before.widgets[0]);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByRole("button", { name: "Remove Sensor reading" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await saved(page)).widgets).toEqual(before.widgets);
});

test("empty dashboard persists and reset keeps an existing console session", async ({
  page,
}) => {
  await setup(page, true, true);
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  expect((await telemetry(page)).peers).toBe(1);
  expect((await telemetry(page)).closed).toBe(0);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  for (const title of ["JetKVM", "Power control", "At a glance"])
    await page
      .getByRole("button", { name: `Remove ${title}`, exact: true })
      .click();
  await expect(
    page.getByText("Your dashboard is empty.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".widget-shell")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await expect(page.locator(".widget-shell")).toHaveCount(3);
  expect((await telemetry(page)).peers).toBe(0);
});

test("mobile reset clears cached desktop sizes without reconnecting", async ({
  page,
}) => {
  await setup(page, true, true);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByLabel("JetKVM width", { exact: true }).fill("7");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".grid-stack")).toHaveClass(/gs-1(?: |$)/);
  const video = await page.locator("video").elementHandle();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".grid-stack")).toHaveClass(/gs-12(?: |$)/);
  await expect(page.locator('[gs-id="jetkvm"]')).toHaveAttribute("gs-w", "8");
  expect(
    await page.locator("video").evaluate((v, old) => v === old, video),
  ).toBe(true);
  expect((await telemetry(page)).peers).toBe(1);
});

test("bad storage falls back safely and save denial is visible", async ({
  page,
}) => {
  await page.addInitScript(
    (key) =>
      localStorage.setItem(key, '{"version":1,"widgets":[{"kind":"html"}]}'),
    storageKey,
  );
  await setup(page, true, false);
  await expect(
    page.getByText("Saved dashboard is invalid.", { exact: false }),
  ).toBeVisible();
  expect((await saved(page)).widgets[0].kind).toBe("html");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Quota");
    };
  });
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByLabel("JetKVM width", { exact: true }).fill("7");
  await expect(
    page.getByText("Layout not saved.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("JetKVM width", { exact: true })).toHaveValue(
    "7",
  );
});

test("sensor widgets share one poll and power widget shares the detail view", async ({
  page,
}) => {
  let sensorReads = 0,
    energyReads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/sensors")) sensorReads++;
    if (r.url().endsWith("/energy")) energyReads++;
  });
  await setup(page, true, false);
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: {
        now,
        samples: [
          { at: now - 60, watts: 100 },
          { at: now, watts: 100 },
        ],
        source: "Fixture",
      },
    }),
  );
  await add(page, "Selectable sensor");
  await add(page, "Selectable sensor");
  await page.getByLabel("Sensor to display").nth(0).selectOption("1");
  await page.getByLabel("Sensor to display").nth(1).selectOption("3");
  await expect(
    page.getByRole("region", { name: "Sensor reading widget" }).nth(0),
  ).toContainText("42 °C");
  await expect(
    page.getByRole("region", { name: "Sensor reading widget" }).nth(1),
  ).toContainText("Not present");
  expect(sensorReads).toBe(1);
  await add(page, "Power consumption");
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.2");
  await page.getByLabel("Electricity rate · $/kWh").fill("0.36");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByText("Electricity rate saved.")).toBeVisible();
  await page.locator(".server-quicklinks button").first().click();
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveCount(0);
  await expect(page.getByTestId("daily-projection")).toHaveText("$0.86");
  expect(energyReads).toBe(1);
  await page.screenshot({
    path: "test-results/screenshots/dashboard-widgets-fixture.png",
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Power usage", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page.locator("#widget-power-usage")).toContainText("$0.36/kWh");
  await expect(page.getByLabel("Sensor to display").nth(0)).toHaveValue("1");
});

test("server settings can explicitly reconnect JetKVM for EDID and media", async ({
  page,
}) => {
  await setup(page, true, true);
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Read current EDID", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Connect JetKVM for settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Read current EDID", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Read current EDID", exact: true })
    .click();
  await expect(page.locator(".edid-output").first()).toHaveText("fixture-edid");
  await expect(
    page.getByRole("button", { name: "Read status", exact: true }),
  ).toBeEnabled();
});
