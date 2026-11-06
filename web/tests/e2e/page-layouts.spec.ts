import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("sensor groups hide unavailable readings, retain warnings and save their arrangement", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices/default/sensors", (route) =>
    route.fulfill({
      json: [
        {
          id: "cpu",
          name: "CPU1 Temp",
          value: "30.000",
          unit: "degrees C",
          state: "ok",
        },
        {
          id: "ram",
          name: "DIMM A1",
          value: "38",
          unit: "degrees C",
          state: "warning",
        },
        {
          id: "empty",
          name: "DIMM B1",
          value: "Unavailable",
          unit: "degrees C",
          state: "unavailable",
        },
      ],
    }),
  );
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "CPU", exact: true }),
  ).toContainText("30 °C");
  const ram = page.getByRole("table", { name: "Memory / RAM", exact: true });
  await expect(ram).toContainText("DIMM B1");
  await page.getByLabel("Hide unavailable").check();
  await expect(ram).not.toContainText("DIMM B1");
  await expect(ram).toContainText("warning");
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "CPU width", exact: true })
    .fill("5");
  await page.locator("#widget-sensor-cpu .widget-grip").press("ArrowDown");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  await expect(page.getByLabel("Hide unavailable")).toBeChecked();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "CPU width", exact: true }),
  ).toHaveValue("5");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.screenshot({
    path: "test-results/screenshots/grouped-sensors-fixture.png",
    fullPage: true,
  });
  await page.route("**/api/devices/default/sensors", (route) =>
    route.fulfill({ status: 502, json: { error: "Read failed" } }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "System sensors" }),
  ).toContainText("Readings are stale or unavailable");
  await expect(
    page.getByRole("region", { name: "System sensors" }),
  ).not.toContainText("38 °C");
});

test("power panels resize independently and settings and branding use compact placement", async ({
  page,
}) => {
  await setup(page, true, false);
  const brand = await page.locator(".rail-brand").boundingBox();
  const quicklinks = await page.locator(".server-quicklinks").boundingBox();
  const gear = await page
    .locator(".rail-bottom")
    .getByRole("button", { name: "iBORK settings", exact: true })
    .boundingBox();
  const owner = await page
    .locator(".rail-bottom .owner-links img")
    .boundingBox();
  expect(brand!.y + brand!.height).toBeLessThanOrEqual(quicklinks!.y);
  expect(gear!.y + gear!.height).toBeLessThanOrEqual(owner!.y);
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Last hour width", exact: true })
    .fill("6");
  await expect(
    page.getByRole("region", { name: "Widget catalog" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Last hour width", exact: true }),
  ).toHaveValue("6");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const connection = await page
    .locator(".server-settings-main .connection-settings")
    .boundingBox();
  const appearance = await page
    .locator(".server-settings-main .display-settings")
    .boundingBox();
  expect(appearance!.x).toBeGreaterThan(connection!.x + connection!.width);
  expect(appearance!.y).toBeGreaterThan(connection!.y);
  await page.screenshot({
    path: "test-results/screenshots/server-settings-fixture.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("both terminal tools remain visible and editing pauses input", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect SOL", exact: true }),
  ).toBeVisible();
  const command = page.getByRole("textbox", { name: "Command", exact: true });
  await expect(command).toBeVisible();
  await expect(command).toBeEnabled();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(command).toBeDisabled();
  await page
    .getByRole("spinbutton", { name: "IPMI diagnostics width", exact: true })
    .fill("5");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(command).toBeEnabled();
});
