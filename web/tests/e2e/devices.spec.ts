import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("server switching isolates controls, layouts and optional consoles", async ({
  page,
}) => {
  await setup(page, true, true);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "Demo compute",
          manufacturer: "Supermicro",
          model: "DEMO-BOARD",
          bmcHost: "192.0.2.50",
          bmcPort: 623,
          hasJetKVM: true,
        },
        {
          id: "dell",
          name: "Rack Dell",
          manufacturer: "Dell",
          model: "R730",
          bmcHost: "192.0.2.2",
          bmcPort: 623,
          hasJetKVM: false,
        },
      ],
    }),
  );
  await page.route("**/api/devices/dell/**", (route) => {
    const path = new URL(route.request().url()).pathname.split("/").at(-1);
    if (path === "energy")
      return route.fulfill({ status: 503, json: { error: "No history yet" } });
    return route.fulfill({
      json:
        path === "config"
          ? {
              serverName: "Rack Dell",
              manufacturer: "Dell",
              model: "R730",
              bmcHost: "192.0.2.2",
              bmcPort: 623,
              jetUrl: "",
              bmcUsername: "ADMIN",
              timeoutSeconds: 10,
            }
          : path === "power"
            ? { state: "off" }
            : path === "inventory"
              ? { fields: {} }
              : [],
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Connect to console", exact: true })
    .click();
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove At a glance", exact: true })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const reads: string[] = [],
    writes: string[] = [];
  page.on("request", (request) =>
    (request.method() === "POST" ? writes : reads).push(
      new URL(request.url()).pathname,
    ),
  );
  await page
    .getByRole("button", { name: "Select Rack Dell", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Rack Dell", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { telemetry: { closed: number } }).telemetry
            .closed,
      ),
    )
    .toBe(1);
  await expect(
    page.getByRole("region", { name: "JetKVM widget", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Dell", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "At a glance widget", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Widget catalog" })
      .getByRole("button", { name: "JetKVM", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Power on/ }).click();
  await page
    .getByRole("button", { name: "Confirm action", exact: true })
    .click();
  await expect.poll(() => writes).toEqual(["/api/devices/dell/power"]);
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect
    .poll(() => reads.includes("/api/devices/dell/energy"))
    .toBe(true);
  await page
    .getByRole("button", { name: "Select Demo compute", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "At a glance widget", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect to console", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { telemetry: { peers: number } }).telemetry
            .peers,
      ),
    )
    .toBe(1);
});

test("identity overrides, quicklinks and project link persist independently of inventory", async ({
  page,
}) => {
  await setup(page, true, false);
  await expect(
    page.locator(".topbar").getByRole("img", { name: "JetKVM" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".rail-bottom").getByRole("link", { name: "iBORK on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/akira69/iBORK");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await page.getByLabel("Display name", { exact: true }).fill("Lab rack");
  await page.getByLabel("Manufacturer override", { exact: true }).fill("Dell");
  await page.getByLabel("Model override", { exact: true }).fill("R730");
  await page.getByRole("button", { name: "Save display preferences" }).click();
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await page.getByRole("checkbox", { name: "Lab rack" }).uncheck();
  await expect(
    page.getByRole("button", { name: "Select Lab rack" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "iBORK Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to server" }).click();
  await expect(
    page.getByRole("heading", { name: "Lab rack", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Dell", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select Lab rack" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .last()
    .click();
  await page.getByRole("checkbox", { name: "Lab rack" }).check();
  await expect(
    page.getByRole("button", { name: "Select Lab rack" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/device-settings-fixture.png",
    fullPage: true,
  });
});
