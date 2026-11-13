import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("SSH setup generates a scoped command and applies the local origin without submitting", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1920, height: 1050 });
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await page.getByLabel("Device type").selectOption("telemetry");
  const card = page.locator(".connection-settings");
  const cardWidth = (await card.boundingBox())!.width;
  await page.getByText("Connect Glances over SSH", { exact: true }).click();
  await expect(page.getByLabel("Glances server IPv4 address")).toBeVisible();
  expect((await card.boundingBox())!.width).toBe(cardWidth);
  const copy = page.getByRole("button", { name: "Copy: Start setup" });
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
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  expect(await clipboard()).toBe(
    "/opt/jet-supermicro/jet-supermicro glances-tunnel 192.0.2.10 62001",
  );
  const authorize = page.getByRole("button", {
    name: "Copy: Authorize the tunnel key",
  });
  const pairing = page.getByLabel("Public pairing line");
  await pairing.fill("192.0.2.1 ssh-ed25519 key;id");
  await expect(authorize).toBeDisabled();
  const key = "ssh-ed25519 " + "A".repeat(68);
  await pairing.fill("192.0.2.1 " + key);
  const panel = page.locator(".glances-setup");
  const columns = panel.locator(".glances-hosts section");
  expect((await columns.last().boundingBox())!.y).toBeGreaterThan(
    (await columns.first().boundingBox())!.y,
  );
  await panel.screenshot({
    path: "test-results/screenshots/glances-setup.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await panel.screenshot({
    path: "test-results/screenshots/glances-mobile.png",
  });
  await authorize.click();
  const auth = await clipboard();
  expect(auth).toContain('from="192.0.2.1",restrict,port-forwarding');
  expect(auth).toContain(key);
  expect(auth).not.toMatch(/\n|SSH_PUBLIC_KEY|SOURCE_IPV4/);
  for (const [title, prefix] of [
    ["Create the tunnel account", "id ibork-glances"],
    ["Read the server host key", "cat /etc/ssh/ssh_host_ed25519_key.pub"],
  ]) {
    await page.getByRole("button", { name: "Copy: " + title }).click();
    expect((await clipboard()).startsWith(prefix)).toBe(true);
  }
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw Error("Clipboard blocked");
      },
    }),
  );
  await copy.click();
  await expect(
    panel.getByText("Select the text and copy manually."),
  ).toBeVisible();
  await page.getByLabel("Glances server IPv4 address").fill("192.0.2.11");
  await expect(authorize).toBeDisabled();
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
