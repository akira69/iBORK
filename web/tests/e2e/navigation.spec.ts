import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("fresh visits show the shared guide with credits, above Settings and on mobile", async ({
  page,
}) => {
  await setup(page, true, false, true, false, true);
  await expect(
    page.getByRole("heading", { name: "Information", exact: true }),
  ).toBeVisible();
  const guide = page.getByRole("article", { name: "iBORK usage guide" });
  await expect(
    guide.getByRole("heading", { name: "Welcome to iBORK" }),
  ).toBeVisible();
  await expect(
    guide.getByText("Use Edit layout", { exact: false }),
  ).toBeVisible();
  await expect(guide.getByAltText("Finch13")).toBeVisible();
  await expect(
    guide.getByRole("link", { name: "iBORK on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/akira69/iBORK");
  await expect(
    page.locator(".rail-bottom > button").first(),
  ).toHaveAccessibleName("Information");
  await expect(
    page.locator(".rail-bottom > button").nth(1),
  ).toHaveAccessibleName("iBORK settings");
  await expect(
    page.getByRole("navigation", { name: "Management views" }),
  ).toBeHidden();
  await expect(page.locator(".server-quicklinks [aria-current]")).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "test-results/screenshots/information-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Information", exact: true }).click();
  await expect(guide).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/screenshots/information-mobile.png",
    fullPage: true,
  });
});

test("restores a selected server and tab after reload, including terminals, settings and wall", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "First",
          bmcHost: "192.0.2.1",
          bmcPort: 623,
          hasJetKVM: false,
        },
        {
          id: "second",
          name: "Second",
          bmcHost: "192.0.2.2",
          bmcPort: 623,
          hasJetKVM: false,
        },
      ],
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Select Second", exact: true })
    .click();
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  await page.reload();
  await expect(
    page.locator(".rail").getByRole("button", { name: "Select Second" }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    page.getByRole("button", { name: "Sensors", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page.reload();
  await expect(page.locator(".terminal-area")).toBeVisible();
  await page
    .locator(".rail")
    .getByRole("button", { name: "iBORK settings" })
    .click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "iBORK Settings", exact: true }),
  ).toBeVisible();
  await page.locator(".rail").getByRole("button", { name: "KVM Wall" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "KVM Wall", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rail-bottom [aria-current=page]")).toHaveCount(0);
  await page
    .locator(".rail")
    .getByRole("button", { name: "Information", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Information", exact: true }),
  ).toBeVisible();
});

test("reopening the browser with saved browser data restores the last page", async ({
  page,
  browser,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  try {
    const reopened = await context.newPage();
    await setup(reopened, true, false, true, false, true);
    await expect(
      reopened.getByRole("button", { name: "Sensors", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});

test("removed servers and corrupt or denied storage leave navigation usable", async ({
  page,
}) => {
  await setup(page, true, false, true, false, true);
  for (const value of [
    "{broken",
    JSON.stringify({ deviceId: "removed", tab: "Boot", view: "server" }),
  ]) {
    await page.evaluate(
      (value) => localStorage.setItem("ibork:navigation:v1", value),
      value,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Information", exact: true }),
    ).toBeVisible();
  }
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw Error("Storage denied");
      },
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Information", exact: true }),
  ).toBeVisible();
  await page
    .locator(".rail")
    .getByRole("button", { name: "iBORK settings" })
    .click();
  await expect(
    page.getByRole("heading", { name: "iBORK Settings", exact: true }),
  ).toBeVisible();
});

test("saved navigation waits for sign-in and survives a failed device-list request", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.route("**/api/login", (route) =>
    route.fulfill({ json: { csrf: "fixture" } }),
  );
  await page.route("**/api/devices", (route) => route.abort("timedout"));
  await page.reload();
  await expect(
    page.getByLabel("Management password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sensors", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Management password", { exact: true })
    .fill("fixture-password");
  await page
    .getByRole("button", { name: "Sign in to console", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("ibork:navigation:v1")!).tab,
    ),
  ).toBe("Sensors");
  await page.unroute("**/api/devices");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sensors", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
