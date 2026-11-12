import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { setup } from "./fixtures";

const home = ["power", "day", "month", "servers"];
const names = ["DEMO-A", "DEMO-B", "DEMO-C", "DEMO-D"];
const available = ["power", "temperature", "fan", "controls"];
const initial = () => ({
  revision: 1,
  home: [...home],
  servers: names.map((name, i) => {
    const keys = i === 2 ? ["power"] : available;
    return {
      id: name.toLowerCase(),
      included: i !== 3,
      available: [...keys],
      widgets: [...keys],
    };
  }),
});
async function editor(page: Page) {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: names.map((name, i) => ({
        id: name.toLowerCase(),
        name,
        bmcHost: "",
        bmcPort: 0,
        hasJetKVM: false,
        manufacturer: i === 0 ? "Supermicro" : "",
        model: i === 1 ? "T440" : "",
      })),
    }),
  );
  await page.route("**/api/remote-display", (route) =>
    route.fulfill({
      json: {
        connected: true,
        lastSeen: Math.floor(Date.now() / 1000),
        snapshot: {
          devices: names.slice(0, 3).map((name, i) => ({
            id: name.toLowerCase(),
            name,
            model: "",
            metered: true,
            watts: [50, 75, null][i],
            controls: true,
          })),
          details: {
            "demo-a": {
              temperature: 37,
              fan: 900,
              fanMax: 1300,
              powerState: "on",
            },
          },
          day: Array(96).fill(225),
          month: Array(120).fill(225),
          dayHours: 24,
          monthHours: 720,
          dayKwh: 5.4,
          monthKwh: 162,
          usdPerKwh: 0.2,
        },
      },
    }),
  );
  let stored = initial(),
    failure = 0;
  const writes: unknown[] = [];
  await page.route("**/api/panel-layout", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: stored });
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    const sent = route.request().postDataJSON();
    writes.push(sent);
    if (failure)
      return route.fulfill({
        status: failure,
        json: { error: "Fixture write failed" },
      });
    expect(sent.revision).toBe(stored.revision);
    stored = {
      ...sent,
      revision: stored.revision + 4,
      servers: sent.servers.map(
        (s: { id: string; included: boolean; widgets: string[] }) => {
          expect(s).not.toHaveProperty("available");
          return {
            ...s,
            available: stored.servers.find((v) => v.id === s.id)!.available,
          };
        },
      ),
    };
    return route.fulfill({ json: stored });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Remote display" }).click();
  return {
    writes,
    setFailure(value: number) {
      failure = value;
    },
    updatedElsewhere() {
      stored.revision++;
    },
  };
}
const shot = (name: string) =>
  join(process.env.PANEL_LAYOUT_QA_DIR || test.info().outputDir, name);

test("layout preview follows visible order and server capabilities, and persists confirmed choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1488, height: 1058 });
  const api = await editor(page);
  const controls = page.getByRole("region", { name: "Layout controls" });
  const preview = page.getByRole("region", {
    name: "Display preview",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save layout" });
  await expect(preview).toContainText("Elecrow CrowPanel V3");
  await expect(preview.locator(".cl-screen")).toHaveCSS("width", "800px");
  await expect(preview.locator(".cl-screen")).toHaveCSS("height", "480px");
  await preview.getByLabel("Preview palette").selectOption("Amber");
  await expect(preview.locator(".cl-screen")).toHaveCSS(
    "background-color",
    "rgb(29, 23, 17)",
  );
  await preview.getByLabel("Preview palette").selectOption("Teal");
  await expect(save).toBeDisabled();
  await expect(preview.locator(".cl-chart-row > section")).toHaveCount(2);
  await expect(
    preview.getByRole("button", { name: "Preview DEMO-A" }),
  ).toBeVisible();
  await expect(preview.locator(".cl-power")).toContainText(
    "Current fleet power",
  );
  await expect(preview.locator(".cl-power")).toContainText("125 W");
  await expect(preview.locator(".cl-power")).toContainText("2/3 reporting");
  for (const [name, count] of [
    ["24-hour chart preview", 96],
    ["30-day chart preview", 120],
  ] as const) {
    const lines = preview.getByRole("region", { name }).locator("svg line");
    await expect(lines).toHaveCount(count - 1);
    await expect(lines.last()).toHaveAttribute("x2", "344");
  }
  await controls.getByRole("checkbox", { name: "30-day chart" }).uncheck();
  await page.screenshot({ path: shot("desktop-home.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page
    .getByRole("region", { name: "Display layout editor" })
    .screenshot({ path: shot("mobile-home.png") });
  await preview.getByRole("button", { name: "Actual-size preview" }).click();
  expect(
    await preview
      .locator(".cl-pan")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  await preview.getByRole("button", { name: "Fit preview" }).click();
  await page.setViewportSize({ width: 1488, height: 1058 });
  await controls.getByRole("button", { name: "Move Server tiles up" }).click();
  await controls
    .getByRole("checkbox", { name: "DEMO-B", exact: true })
    .uncheck();
  await controls.getByRole("button", { name: "Move DEMO-C up" }).click();
  await controls.getByRole("button", { name: "Move DEMO-C up" }).click();
  await expect(preview.locator(".cl-power")).toContainText("50 W");
  await expect(preview.locator(".cl-power")).toContainText("1/2 reporting");
  await expect(
    preview.locator(".cl-tiles button").first(),
  ).toHaveAccessibleName("Preview DEMO-C");
  await controls.getByRole("checkbox", { name: "Server tiles" }).uncheck();
  await expect(preview.locator(".cl-tiles")).toHaveCount(0);
  await preview
    .getByRole("button", { name: "Preview server selector" })
    .click();
  await preview.getByRole("button", { name: "Preview DEMO-C" }).click();
  await expect(
    controls
      .getByRole("list", { name: "Server widgets" })
      .getByRole("checkbox"),
  ).toHaveCount(1);
  await controls
    .getByRole("checkbox", { name: "Power draw", exact: true })
    .uncheck();
  await expect(
    preview.getByText("No widgets enabled for this server"),
  ).toBeVisible();
  await controls.getByLabel("Server to edit").selectOption("demo-a");
  await controls.getByRole("button", { name: "Move Temperature up" }).click();
  await expect(preview.locator(".cl-stat").first()).toContainText(
    "Hottest temperature",
  );
  await expect(preview.locator(".cl-switch img")).toHaveCSS("width", "282px");
  await expect(preview.locator(".cl-switch img")).toHaveCSS("height", "254px");
  await expect(preview.locator(".cl-stat")).toContainText([
    "37.0",
    "50 W",
    "Highest: 1300 RPM",
  ]);
  await page.screenshot({ path: shot("desktop-server.png") });
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Layout saved.");
  expect(api.writes[0]).toMatchObject({
    revision: 1,
    home: ["power", "day"],
    servers: [
      { id: "demo-c", included: true, widgets: [] },
      { id: "demo-a", widgets: ["temperature", "power", "fan", "controls"] },
      { id: "demo-b", included: false },
      { id: "demo-d", included: false },
    ],
  });
  await page.reload();
  await page.getByRole("button", { name: "Remote display" }).click();
  await expect(
    controls.getByRole("checkbox", { name: "Server tiles", exact: true }),
  ).not.toBeChecked();
  await controls
    .getByRole("checkbox", { name: "Fleet power", exact: true })
    .uncheck();
  await controls
    .getByRole("checkbox", { name: "24-hour chart", exact: true })
    .uncheck();
  await expect(save).toBeDisabled();
  await controls
    .getByRole("checkbox", { name: "Server tiles", exact: true })
    .check();
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Layout saved.");
  expect(api.writes[1]).toMatchObject({ revision: 5, home: ["servers"] });
});

test("failed writes preserve the draft and conflicts require an explicit reload", async ({
  page,
}) => {
  const api = await editor(page);
  const controls = page.getByRole("region", { name: "Layout controls" });
  const save = page.getByRole("button", { name: "Save layout" });
  api.setFailure(503);
  await controls
    .getByRole("checkbox", { name: "Fleet power", exact: true })
    .uncheck();
  await save.click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm");
  await expect(
    controls.getByRole("checkbox", { name: "Fleet power", exact: true }),
  ).not.toBeChecked();
  api.updatedElsewhere();
  api.setFailure(409);
  await save.click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  await expect(save).toBeDisabled();
  await expect(
    controls.getByRole("checkbox", { name: "Fleet power", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Discard edits and reload layout" })
    .click();
  await expect(
    controls.getByRole("checkbox", { name: "Fleet power", exact: true }),
  ).toBeChecked();
  await controls
    .getByRole("checkbox", { name: "24-hour chart", exact: true })
    .uncheck();
  api.setFailure(0);
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Layout saved.");
  expect(api.writes.at(-1)).toMatchObject({ revision: 2 });
});

test("dragging a chart separates its row and a fleet with all servers hidden can be saved", async ({
  page,
}) => {
  const api = await editor(page);
  const controls = page.getByRole("region", { name: "Layout controls" });
  const homeList = controls.getByRole("list", { name: "Home sections" });
  await homeList
    .locator(".cl-grip")
    .nth(1)
    .dragTo(homeList.getByRole("listitem").last());
  const preview = page.getByRole("region", {
    name: "Display preview",
    exact: true,
  });
  await expect(preview.locator(".cl-chart-row")).toHaveCount(2);
  const servers = controls.getByRole("list", { name: "Servers on panel" });
  for (const box of await servers.getByRole("checkbox").all())
    await box.uncheck();
  await expect(preview.getByText("No servers on this panel")).toBeVisible();
  await expect(preview.locator(".cl-power")).toContainText("No meters");
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByRole("status")).toHaveText("Layout saved.");
  expect(api.writes.at(-1)).toMatchObject({
    home: ["power", "month", "servers", "day"],
    servers: names.map(() => ({ included: false })),
  });
});

test("empty inventory supports the editor, with recoverable reads and hidden disabled panels", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.reload();
  await expect(
    page.getByText("No devices saved.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remote display" }),
  ).toHaveCount(0);
  let ready = false;
  await page.route("**/api/panel-layout", (route) =>
    ready
      ? route.fulfill({ json: { revision: 1, home, servers: [] } })
      : route.abort("timedout"),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load the panel layout",
  );
  ready = true;
  await page.getByRole("button", { name: "Retry loading layout" }).click();
  await page.getByRole("button", { name: "Remote display" }).click();
  await expect(
    page
      .getByLabel("Server tiles preview")
      .getByText("Waiting for iBORK", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Servers", exact: true }).click();
  await expect(page.getByText("No servers configured.")).toBeVisible();
  await page.getByRole("button", { name: "Back to iBORK settings" }).click();
  await expect(
    page.getByRole("button", { name: "Retry loading layout" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No devices saved.", { exact: false }),
  ).toBeVisible();
});
