import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("SSH setup generates a scoped command and applies the local origin without submitting", async ({
  page,
  context,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await page.getByLabel("Device type").selectOption("telemetry");
  await page.getByText("Connect Glances over SSH", { exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy setup command" });
  await expect(copy).toBeDisabled();
  await page.getByLabel("Glances server IPv4 address").fill("192.0.2.10;id");
  await expect(copy).toBeDisabled();
  await page.getByLabel("Glances server IPv4 address").fill("192.0.2.10");
  const port = page.getByLabel("Local tunnel port on iBORK");
  await port.fill("65536");
  await expect(copy).toBeDisabled();
  await port.fill("62001");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^bash -s -- 192\.0\.2\.10 62001 <<'IBORK_GLANCES_SETUP'/,
  );
  await page.getByText("View setup command", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Tunnel setup command" }),
  ).toHaveValue(/StrictHostKeyChecking=yes/);
  await page
    .getByRole("button", { name: "Use tunnel origin http://127.0.0.1:62001" })
    .click();
  await expect(page.getByLabel("Glances API origin")).toHaveValue(
    "http://127.0.0.1:62001",
  );
  await expect(
    page.getByRole("button", { name: "Save server & reconnect" }),
  ).toBeEnabled();
});

test("add a Glances server with a dedicated Matter outlet", async ({
  page,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await page.getByLabel("Device type").selectOption("telemetry");
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveCount(0);
  await page.getByLabel("Server name", { exact: true }).fill("Demo sensor");
  await page.getByLabel("Glances API origin").fill("https://probe.example.net");
  await page
    .getByRole("combobox", { name: "Power source", exact: true })
    .selectOption("mqtt");
  await page.getByLabel("MQTT status topic").fill("test/meter/status");
  await page
    .getByRole("combobox", { name: "Power source", exact: true })
    .selectOption("home-assistant");
  await page.getByLabel("Physical outlet ID").fill("probe");
  await page.getByLabel("Home Assistant origin").fill("https://ha.example.net");
  await page.getByLabel("Power sensor entity").fill("sensor.probe_power");
  await page.getByLabel("Home Assistant bearer token").fill("fixture-only");
  await page.route("**/api/device-settings", (route) =>
    route.fulfill({ json: { saved: true } }),
  );
  const request = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/device-settings"),
  );
  await page.getByRole("button", { name: "Save server & reconnect" }).click();
  expect((await request).postDataJSON()).toMatchObject({
    host: "",
    port: 0,
    jetUrl: "",
    telemetry: {
      glancesUrl: "https://probe.example.net",
      meterKind: "home-assistant",
      meterChannel: "sensor.probe_power",
      outletId: "probe",
    },
    meterSecret: "fixture-only",
  });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-only",
  );
});
