import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("wide dashboard and fixed sensor groups stay compact outside edit mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await setup(page, true, false);
  await expect(page.locator("#widget-health")).toBeVisible();
  await expect(page.locator(".main")).toBeVisible();
  expect((await page.locator(".main").boundingBox())!.width).toBeGreaterThan(
    2300,
  );
  const health = page.locator("#widget-health");
  await expect(health).toContainText("42 °C");
  await expect(health).toContainText("3,200 RPM");
  await expect(health).toContainText("PS1 Status");
  await expect(health).toContainText("PS2 Status");
  await expect(health).not.toContainText("RPM RPM");
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("button", { name: "Sensor reading", exact: true })
    .click();
  const widget = page.getByRole("region", { name: "Sensor reading widget" });
  await widget.getByRole("button", { name: "Configure sensor" }).click();
  await widget
    .getByRole("checkbox", { name: "CPU1 Temp", exact: true })
    .check();
  await widget.getByRole("checkbox", { name: "FAN1", exact: true }).check();
  await widget.getByRole("button", { name: "Close sensor settings" }).click();
  await widget.getByLabel("Sensor reading width", { exact: true }).fill("5");
  await widget.getByLabel("Sensor reading height", { exact: true }).fill("3");
  await expect(widget.locator(".widget-adjust input")).toHaveCount(2);
  await expect(
    widget.getByRole("button", { name: /left|right|up|down/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(widget.getByRole("combobox")).toHaveCount(0);
  await expect(widget.locator(".measurement-reading")).toHaveCount(2);
  await expect(widget).toContainText("42 °C");
  await expect(widget).toContainText("3,200 RPM");
  await page.reload();
  await expect(widget.locator(".measurement-reading")).toHaveCount(2);
  await expect(widget.getByRole("combobox")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/screenshots/sensor-widgets-fixture.png",
    fullPage: true,
  });
});

test("connection settings add independent endpoints and retain failed drafts without storing passwords", async ({
  page,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveValue(
    "192.0.2.50",
  );
  await expect(page.getByLabel("JetKVM address", { exact: true })).toHaveValue(
    "http://192.0.2.51",
  );
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("JetKVM address", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Server name", { exact: true }).fill("Rack Dell");
  await page.getByLabel("BMC address", { exact: true }).fill("192.0.2.20");
  await page
    .getByLabel("BMC password", { exact: true })
    .fill("fixture-private-password");
  await page.getByLabel("Pair a JetKVM with this server").check();
  await page
    .getByLabel("JetKVM address", { exact: true })
    .fill("http://192.0.2.21");
  await page
    .getByLabel("JetKVM password", { exact: true })
    .fill("fixture-jet-password");
  let body: Record<string, unknown> = {};
  await page.route("**/api/device-settings", async (route) => {
    body = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    await route.fulfill({
      status: 400,
      json: { error: "Cannot save protected settings" },
    });
  });
  await page.getByRole("button", { name: "Save server & reconnect" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Cannot save protected settings",
  );
  expect(body).toMatchObject({
    id: "",
    host: "192.0.2.20",
    jetUrl: "http://192.0.2.21",
    password: "fixture-private-password",
    jetPassword: "fixture-jet-password",
  });
  expect(
    JSON.stringify(await page.evaluate(() => ({ ...localStorage }))),
  ).not.toContain("fixture-private-password");
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveValue(
    "192.0.2.20",
  );
  await page.getByLabel("BMC password", { exact: true }).fill("");
  await page.getByLabel("JetKVM password", { exact: true }).fill("");
  await page.screenshot({
    path: "test-results/screenshots/server-connections-fixture.png",
    fullPage: true,
  });
});
