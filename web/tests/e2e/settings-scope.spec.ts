import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("app preferences stay shared while server settings follow the selected endpoint", async ({
  page,
}) => {
  await setup(page, true, false);
  const profiles = [
    {
      id: "default",
      name: "Demo compute",
      host: "192.0.2.1",
      port: 623,
      username: "ADMIN",
      jetUrl: "http://192.0.2.3",
    },
    {
      id: "dell",
      name: "Demo storage",
      host: "192.0.2.2",
      port: 623,
      username: "root",
      jetUrl: "",
    },
  ];
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        bmcHost: p.host,
        bmcPort: p.port,
        hasJetKVM: !!p.jetUrl,
      })),
    }),
  );
  await page.route("**/api/device-settings", (route) =>
    route.fulfill({ json: profiles }),
  );
  await page.reload();
  const rail = page.locator(".rail");
  await expect(rail.getByRole("button")).toHaveCount(5);
  await expect(rail.locator(".connection-status")).toHaveCount(0);
  await expect(
    page
      .locator(".workspace-title")
      .getByLabel("IPMI: Online", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".workspace-title")
      .getByLabel("KVM: Offline", { exact: true }),
  ).toBeVisible();
  await rail.getByRole("button", { name: "iBORK settings" }).click();
  await expect(rail.locator(".server-quicklinks [aria-current]")).toHaveCount(
    0,
  );
  await expect(
    rail.getByRole("button", { name: "iBORK settings" }),
  ).toHaveAttribute("aria-current", "page");
  await rail.getByRole("button", { name: "KVM Wall", exact: true }).click();
  await expect(rail.locator("[aria-current]")).toHaveCount(1);
  await expect(
    rail.getByRole("button", { name: "KVM Wall", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await rail.getByRole("button", { name: "iBORK settings" }).click();
  await expect(
    page.getByRole("navigation", { name: "Management views" }),
  ).toBeHidden();
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  await page.getByLabel("Electricity rate · $/kWh").fill("0.29");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByText("Electricity rate saved.")).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/app-settings-fixture.png",
    fullPage: true,
  });
  await rail.getByRole("button", { name: "Select Demo storage" }).click();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect(page.getByLabel("BMC address", { exact: true })).toHaveValue(
    "192.0.2.2",
  );
  await expect(page.getByLabel("BMC username", { exact: true })).toHaveValue(
    "root",
  );
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Show saved servers in sidebar" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/screenshots/server-settings-fixture.png",
    fullPage: true,
  });
  await rail.getByRole("button", { name: "iBORK settings" }).click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.29");
  await page
    .getByRole("checkbox", { name: "Demo compute", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Demo storage", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Back to server" }).click();
  await expect(
    page.getByRole("navigation", { name: "Management views" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.29");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.route("**/api/electricity-rate", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          json: { error: "Could not persist the electricity rate" },
        })
      : route.fallback(),
  );
  await page.getByLabel("Electricity rate · $/kWh").fill("0.4");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not persist");
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.4");
  await page.reload();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.29");
  await page
    .getByRole("button", { name: "Open Demo compute", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Demo compute", exact: true }),
  ).toBeVisible();
});
