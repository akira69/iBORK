import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("Fit content measures all readings after styling instead of collapsing the card", async ({
  page,
}) => {
  await setup(page, true, false);
  const readings = Array.from({ length: 6 }, (_, i) => ({
    id: `cpu-${i}`,
    name: `CPU ${i + 1}`,
    value: "48",
    unit: "degrees C",
    state: "ok",
  }));
  await page.route("**/sensors", (route) => route.fulfill({ json: readings }));
  await page.evaluate(
    (ids) =>
      localStorage.setItem(
        "jet-supermicro:dashboard:v1:192.0.2.50:623",
        JSON.stringify({
          version: 1,
          widgets: [
            {
              id: "many-cpus",
              kind: "sensor",
              title: "CPU readings",
              sensorIds: ids,
              x: 0,
              y: 0,
              w: 4,
              h: 12,
              appearance: { density: "comfortable", valueSize: "large" },
            },
          ],
        }),
      ),
    readings.map((s) => s.id),
  );
  await page.reload();
  const card = page.locator("#widget-many-cpus");
  await expect(card.getByText("CPU 6", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await card.getByRole("button", { name: "Fit CPU readings content" }).click();
  const rows = Number(
    await card
      .getByRole("spinbutton", { name: "CPU readings height" })
      .inputValue(),
  );
  expect(rows).toBeGreaterThanOrEqual(4);
  expect(rows).toBeLessThan(12);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() =>
      card
        .locator(".widget-body")
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeLessThanOrEqual(1);
});

test("fleet plots preserve partial segments and compact cards at desktop and phone sizes", async ({
  page,
}) => {
  await setup(page, true, false);
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "Compute A",
          bmcHost: "192.0.2.50",
          bmcPort: 623,
          hasSensors: true,
          hasEnergy: true,
        },
        {
          id: "second",
          name: "Compute B",
          bmcHost: "192.0.2.60",
          bmcPort: 623,
          hasSensors: true,
          hasEnergy: true,
        },
      ],
    }),
  );
  await page.route("**/api/devices/*/energy", (route) => {
    const second = route.request().url().includes("/second/");
    return route.fulfill({
      json: {
        now,
        source: "Synthetic",
        samples: Array.from({ length: 61 }, (_, i) => ({
          at: now - 3600 + i * 60,
          watts: second
            ? 90 + 10 * Math.sin(i / 4)
            : 220 + 25 * Math.sin(i / 5),
        })).filter((_, i) => !second || i > 30),
      },
    });
  });
  await page.route("**/api/devices/*/sensors", (route) =>
    route.fulfill({
      json: [
        {
          id: "cpu",
          name: "CPU temperature",
          value: "48",
          unit: "degrees C",
          state: "ok",
        },
        { id: "fan", name: "Fan 1", value: "2400", unit: "RPM", state: "ok" },
      ],
    }),
  );
  await page.evaluate(() => {
    localStorage.setItem(
      "ibork:navigation:v1",
      JSON.stringify({ deviceId: "default", view: "wall", tab: "Console" }),
    );
    localStorage.setItem("ibork:wall-view:v1", "Central Dashboard");
    const widgets = [
      {
        id: "fleet-current",
        kind: "power-now",
        deviceIds: ["default", "second"],
        title: "Current measured power",
        x: 0,
        y: 0,
        w: 4,
        h: 3,
      },
      {
        id: "fleet-hour",
        kind: "power-hour",
        deviceIds: ["default", "second"],
        title: "Last hour",
        x: 4,
        y: 0,
        w: 8,
        h: 4,
      },
      ...["default", "second"].flatMap((id, i) => [
        {
          id: `${id}-cpu`,
          kind: "sensor",
          deviceIds: [id],
          sensorId: "cpu",
          title: "CPU temperature",
          x: 0,
          y: 4 + i * 2,
          w: 4,
          h: 2,
        },
        {
          id: `${id}-power`,
          kind: "power-now",
          deviceIds: [id],
          title: "Current power",
          x: 4,
          y: 4 + i * 2,
          w: 4,
          h: 2,
        },
        {
          id: `${id}-fan`,
          kind: "sensor",
          deviceIds: [id],
          sensorId: "fan",
          title: "Highest fan RPM",
          x: 8,
          y: 4 + i * 2,
          w: 4,
          h: 2,
        },
      ]),
    ];
    localStorage.setItem(
      "ibork:fleet-dashboard:v1",
      JSON.stringify({ version: 1, widgets }),
    );
  });
  await page.reload();
  const chart = page.locator("#widget-fleet-hour");
  await expect(chart.locator(".power-plot")).toBeVisible();
  await expect(
    chart.locator('.recharts-line-curve[stroke-dasharray="4 3"]'),
  ).toHaveCount(1);
  await expect(chart.locator(".recharts-line-curve")).toHaveCount(2);
  await expect(chart).toContainText("Recorded energy · Partial");
  await page.screenshot({
    path: "test-results/screenshots/appearance-fleet-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await chart.boundingBox())!.width)
    .toBeGreaterThan(300);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await expect(chart.locator(".power-plot")).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/appearance-fleet-mobile.png",
    fullPage: true,
  });
});

test("appearance persists and plots fill resized cards with optional internal height", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find widget" }).fill("Last hour");
  await page
    .getByRole("region", { name: "Widget catalog" })
    .getByRole("button", { name: "Last hour", exact: true })
    .click();
  const card = page.locator("#widget-power-hour");
  await card.getByRole("button", { name: "Appearance" }).click();
  const options = page.getByRole("dialog", { name: "Widget appearance" });
  await options.getByLabel("Accent").selectOption("violet");
  await options.getByLabel("Value size").selectOption("large");
  await options.getByLabel("Show title").uncheck();
  await options.getByLabel("Show legend").uncheck();
  await options.getByRole("button", { name: "Close appearance" }).click();
  const plot = card.locator(".power-plot");
  const before = (await plot.boundingBox())!.height;
  await card.getByRole("spinbutton", { name: "Last hour height" }).fill("8");
  await expect
    .poll(async () => (await plot.boundingBox())!.height)
    .toBeGreaterThan(before + 100);
  await card.getByRole("button", { name: "Appearance" }).click();
  await options.getByLabel("Plot sizing").selectOption("fixed");
  await options.getByLabel("Plot height (px)").fill("240");
  await options.getByRole("button", { name: "Close appearance" }).click();
  await expect
    .poll(async () => Math.round((await plot.boundingBox())!.height))
    .toBe(240);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(card.locator(".widget-bar")).toBeHidden();
  await expect(card.locator(".recharts-legend-wrapper")).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveAttribute("data-accent", "violet");
  await expect(card).toHaveAttribute("data-value-size", "large");
  await expect
    .poll(async () => Math.round((await plot.boundingBox())!.height))
    .toBe(240);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(card.getByRole("button", { name: "Appearance" })).toBeVisible();
});
