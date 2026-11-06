import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function fleet(page: Page) {
  await setup(page, true, false, false, false, true);
  const devices = [
    {
      id: "default",
      name: "Rack A",
      bmcHost: "192.0.2.1",
      bmcPort: 623,
      hasVNC: true,
      hasJetKVM: false,
    },
    {
      id: "rack-b",
      name: "Rack B",
      bmcHost: "192.0.2.2",
      bmcPort: 623,
      hasVNC: true,
      hasJetKVM: false,
    },
    {
      id: "probe",
      name: "Demo sensor",
      bmcHost: "",
      bmcPort: 0,
      hasManagement: false,
      hasSensors: true,
      hasEnergy: false,
      hasJetKVM: false,
    },
  ];
  const state = { devices, failed: false, consoleRequests: 0 };
  await page.route("**/api/devices", (route) =>
    route.fulfill({ json: state.devices }),
  );
  await page.route("**/api/devices/*/vnc/session", (route) => {
    state.consoleRequests++;
    return route.fulfill({ status: 503, json: { error: "fixture" } });
  });
  await page.route("**/api/devices/*/energy", (route) => {
    const second = route.request().url().includes("rack-b");
    if (second && state.failed)
      return route.fulfill({ status: 504, json: { error: "Read timed out" } });
    const watts = second ? 120 : 80;
    return route.fulfill({
      json: {
        now: 1000,
        source: second ? "MQTT meter" : "DCMI",
        samples: [
          { at: 940, watts },
          { at: 1000, watts },
        ],
        storageError: second ? "" : "Disk full",
      },
    });
  });
  await page.evaluate(() => {
    localStorage.setItem(
      "ibork:navigation:v1",
      JSON.stringify({ deviceId: "default", view: "wall", tab: "Console" }),
    );
    localStorage.setItem("ibork:wall-view:v1", "Power Overview");
    localStorage.setItem(
      "jet-supermicro:kvm-wall:v1",
      JSON.stringify({
        version: 1,
        automatic: true,
        entries: [
          {
            deviceId: "default",
            source: "vnc",
            connect: "auto",
            included: true,
            x: 0,
            y: 0,
            w: 6,
            h: 4,
          },
        ],
      }),
    );
  });
  await page.reload();
  return state;
}
test("Power Overview restores without connecting consoles and reports partial failures independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fleet(page);
  const overview = page.getByRole("region", {
    name: "Power Overview",
    exact: true,
  });
  await expect(overview.getByText("200 W", { exact: true })).toBeVisible();
  await expect(overview.getByText("2 of 3 reporting")).toBeVisible();
  await expect(
    overview.getByRole("row", { name: /Demo sensor/ }),
  ).toContainText("No power source");
  await expect(overview.getByRole("row", { name: /Rack A/ })).toContainText(
    "Storage: Disk full",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  state.failed = true;
  await page.reload();
  await expect(overview.getByRole("row", { name: /Rack B/ })).toContainText(
    "Collection: Read timed out",
  );
  await expect(overview.getByText("1 of 3 reporting")).toBeVisible();
  expect(state.consoleRequests).toBe(0);
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await expect.poll(() => state.consoleRequests).toBe(1);
});

test("Central Dashboard persists overlapping groups, sensor, keyboard geometry and missing hosts", async ({
  page,
}) => {
  const state = await fleet(page);
  await page
    .getByRole("button", { name: "Central Dashboard", exact: true })
    .click();
  const dashboard = page.getByRole("region", { name: "KVM wall", exact: true });
  await dashboard
    .getByRole("button", { name: "Edit layout", exact: true })
    .click();
  const editor = dashboard.getByRole("region", { name: "Widget catalog" });
  const add = editor.getByRole("button", { name: "Add widget", exact: true });
  await editor.getByLabel("Rack A", { exact: true }).check();
  await editor.getByLabel("Rack B", { exact: true }).check();
  await add.click();
  const group = dashboard.getByRole("region", {
    name: "Rack A + Rack B · Current power widget",
  });
  await expect(group.getByText("200 W")).toBeVisible();
  await editor.getByLabel("Metric").selectOption("power-hour");
  await add.click();
  const chart = dashboard.getByRole("region", {
    name: "Rack A + Rack B · Last hour widget",
  });
  await expect(
    chart.getByRole("img", { name: /Combined watts/ }),
  ).toBeVisible();
  await expect(chart.getByText(/0.0033 kWh/)).toBeVisible();
  await page.route("**/api/electricity-rate", (route) =>
    route.fulfill({ json: { usdPerKwh: 30 } }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(chart.getByText("0.0033 kWh · $0.10")).toBeVisible();
  await page.route("**/devices/probe/sensors", (route) =>
    route.fulfill({
      json: [
        { id: "fan", name: "FAN1", unit: "RPM", value: "3200", state: "ok" },
        {
          id: "x".repeat(129),
          name: "Unsaveable sensor",
          unit: "RPM",
          value: "42",
          state: "ok",
        },
      ],
    }),
  );
  let sensorPolls = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/devices/probe/sensors")) sensorPolls++;
  });
  await editor.getByLabel("Source").selectOption("probe");
  await editor.getByLabel("Metric").selectOption({ label: "FAN1" });
  await expect(
    editor.getByRole("option", { name: "Unsaveable sensor" }),
  ).toHaveCount(0);
  await add.click();
  const sensor = dashboard.getByRole("region", {
    name: "Demo sensor · Sensor reading widget",
  });
  await expect(sensor.getByText("3,200 RPM")).toBeVisible();
  expect(sensorPolls).toBe(1);
  await group.locator(".widget-grip").focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.locator("xpath=../..")).toHaveAttribute("gs-x", "1");
  await page.reload();
  await expect(group.getByText("2 of 2 reporting")).toBeVisible();
  await expect(group.locator("xpath=../..")).toHaveAttribute("gs-x", "1");
  expect(state.consoleRequests).toBe(0);
  state.devices[0].name = "Renamed rack";
  state.devices.splice(1, 1);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  const remaining = dashboard.getByRole("region", {
    name: "Renamed rack + Removed server (rack-b) · Current power widget",
  });
  await expect(remaining.getByText("80 W")).toBeVisible();
  await expect(remaining.getByText("1 of 2 reporting")).toBeVisible();
  await expect(
    dashboard.getByText("Last hour · 0.0% common coverage"),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await remaining.boundingBox())?.width)
    .toBeGreaterThan(300);
  await dashboard
    .getByRole("button", { name: "Edit layout", exact: true })
    .click();
  await expect(
    dashboard.getByText("Move and resize on a wider screen.", { exact: false }),
  ).toBeVisible();
  await sensor.getByRole("button", { name: /Remove/ }).click();
  await expect(sensor).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("an empty Central Dashboard does not download fleet power histories", async ({
  page,
}) => {
  await fleet(page);
  await page.evaluate(() =>
    localStorage.setItem("ibork:wall-view:v1", "Central Dashboard"),
  );
  let polls = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/energy")) polls++;
  });
  await page.reload();
  await expect(
    page
      .getByText("Your dashboard is empty.", { exact: false })
      .filter({ visible: true }),
  ).toBeVisible();
  expect(polls).toBe(0);
});

test("server watts and projections expire while the next poll is pending", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.clock.install();
  let polls = 0;
  await page.route("**/devices/default/energy", (route) => {
    if (++polls > 1) return;
    return route.fulfill({
      json: { now: 1000, samples: [{ at: 920, watts: 80 }], source: "Fixture" },
    });
  });
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  const current = page
    .getByText("Current draw", { exact: true })
    .locator("..")
    .locator("strong");
  await expect(current).toHaveText("80.0 W");
  await page.clock.fastForward(60000);
  await expect.poll(() => polls).toBeGreaterThan(1);
  await page.clock.fastForward(12000);
  await expect(current).toHaveText("—");
  await expect(page.getByTestId("daily-projection")).toHaveText("—");
});
