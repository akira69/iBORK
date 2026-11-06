import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function checkBrandImages(
  page: Page,
  names = ["Finch13", "JetKVM", "Supermicro"],
) {
  for (const name of names) {
    const logo = page.getByRole("img", { name, exact: true });
    await expect(logo).toBeVisible();
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await logo.evaluate((img: HTMLImageElement) => img.decode());
  }
}

for (const [bmc, kvm] of [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
]) {
  test(`independent connections: BMC ${bmc}, KVM ${kvm}`, async ({ page }) => {
    await setup(page, bmc, kvm);
    const nativeInterface = page.getByRole("link", {
      name: "Open native JetKVM interface",
    });
    await expect(nativeInterface).toBeVisible();
    await expect(nativeInterface).toHaveAttribute("href", "http://192.0.2.51");
    await expect(nativeInterface).toHaveAttribute("target", "_blank");
    await expect(nativeInterface).toHaveAttribute("rel", "noopener noreferrer");
    await expect(
      page
        .getByLabel(`IPMI: ${bmc ? "Online" : "Offline"}`, {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByLabel(`KVM: ${kvm ? "Online" : "Offline"}`, {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    if (bmc)
      await expect(
        page.getByRole("button", { name: "Force power off" }),
      ).toBeEnabled();
    else
      await expect(
        page.getByRole("button", { name: "Force power off" }),
      ).toBeDisabled();
  });
}
test("power actions require confirmation and cancel sends nothing", async ({
  page,
}) => {
  await setup(page, true, false);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(request.postData() ?? "");
  });
  await page.getByRole("button", { name: "Force power off" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Force power off" }).click();
  await page.getByRole("button", { name: "Confirm action" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(JSON.parse(writes[0])).toEqual({ action: "off", confirm: "off" });
});
test("sensor absence, empty events and next-boot panels", async ({ page }) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "Sensors", exact: true })
    .last()
    .click();
  await expect(page.getByRole("row").filter({ hasText: "PSU2" })).toContainText(
    "unavailable",
  );
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await expect(page.getByText("No events to display.")).toBeVisible();
  await page.getByRole("button", { name: "Boot", exact: true }).click();
  await expect(
    page.getByText(
      "One-time override. Selecting a target does not restart the server.",
    ),
  ).toBeVisible();
});
test("desktop and mobile layout retain full-width video", async ({ page }) => {
  await setup(page, true, false);
  await checkBrandImages(page);
  await expect(
    page
      .locator(".topbar")
      .getByRole("button", { name: "Edit layout", exact: true }),
  ).toBeVisible();
  const topbar = await page.locator(".topbar").boundingBox();
  const grid = await page.locator(".grid-stack").boundingBox();
  const navigation = await page
    .getByRole("navigation", { name: "Management views" })
    .boundingBox();
  expect(navigation!.y - topbar!.height).toBeLessThan(24);
  expect(grid!.y - navigation!.y - navigation!.height).toBeLessThan(32);
  await expect(
    page
      .locator(".workspace-title")
      .getByLabel("IPMI: Online", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/desktop-fixture.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkBrandImages(page);
  expect((await page.locator(".topbar").boundingBox())!.height).toBeLessThan(
    230,
  );
  await expect(page.locator(".grid-stack")).toHaveClass(/gs-1(?: |$)/);
  const video = await page.locator(".console-card").boundingBox(),
    controls = await page.locator(".power-panel").boundingBox();
  expect(video!.width).toBeGreaterThan(330);
  await expect(page.locator(".health-panel")).toBeVisible();
  expect(controls!.y).toBeGreaterThan(video!.y + video!.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/screenshots/mobile-fixture.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(
    await page
      .locator(".workspace-title h1")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await checkBrandImages(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
test("expired API session returns to sign in", async ({ page }) => {
  await setup(page, true, true);
  await page.route("**/api/devices/default/events", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"error":"Session expired"}',
    }),
  );
  await page.getByRole("button", { name: "Events", exact: true }).click();
  await expect(page.getByLabel("Management password")).toBeVisible();
  await expect(page).toHaveTitle("iBORK · IPMI & Remote KVM");
  await expect(
    page.getByRole("heading", { name: "iBORK", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("IPMI · Bare-metal Operations & Remote KVM"),
  ).toBeVisible();
  await expect(page.getByText("Less bork. More uptime.")).toBeVisible();
  await expect(page.getByText("by Finch13")).toBeVisible();
  await expect(page.getByRole("img", { name: "Supermicro" })).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "JetKVM", exact: true }),
  ).toHaveCount(0);
  await checkBrandImages(page, ["iBORK", "Finch13"]);
  await page.screenshot({
    path: "test-results/screenshots/login-fixture.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await checkBrandImages(page, ["iBORK", "Finch13"]);
  await page.screenshot({
    path: "test-results/screenshots/ibork-login-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("video wheel forwards once without scrolling the local page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await setup(page, true, true);
  await expect(
    page.getByLabel("KVM: Online", { exact: true }).first(),
  ).toBeVisible();
  // Reveal the existing video without requiring a real media source or device.
  await page.addStyleTag({
    content:
      ".no-stream { visibility: visible !important; } .console-empty { display: none !important; }",
  });
  const video = page.getByLabel("Remote server video and keyboard control");
  await video.click();
  await video.hover();
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 300);
  const reports = () =>
    page.evaluate(
      () => (window as Window & { wheelReports: unknown[] }).wheelReports,
    );
  await expect.poll(reports).toEqual([{ wheelY: -3, wheelX: 0 }]);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 10;
        const tick = () => {
          if (--frames) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  const panel = page.locator(".widget-power-control");
  await panel.hover();
  const panelScroll = await panel.evaluate((e) => e.scrollTop);
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => panel.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(panelScroll);
  expect(await reports()).toHaveLength(1);
});

test("power charts calculate cost, persist tariff and preserve mobile width", async ({
  page,
}) => {
  await setup(page, true, false);
  const now = Math.floor(Date.now() / 1000);
  const samples = Array.from({ length: 10081 }, (_, i) => ({
    at: now - 604800 + i * 60,
    watts: 100,
  }));
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: { now, samples, source: "Fixture DCMI system power" },
    }),
  );
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByTestId("energy-cost-1")).toHaveText("$0.48");
  await expect(page.getByTestId("energy-cost-2")).toHaveText("$3.36");
  await expect(
    page.getByRole("img", { name: /power consumption in watts/ }),
  ).toHaveCount(3);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.2");
  await page.getByLabel("Electricity rate · $/kWh").fill("0.36");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByText("Electricity rate saved.")).toBeVisible();
  await page.locator(".server-quicklinks button").first().click();
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByTestId("energy-cost-1")).toHaveText("$0.86");
  await page.reload();
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveValue("0.36");
  await page.getByLabel("Electricity rate · $/kWh").fill("-1");
  await expect(page.getByLabel("Electricity rate · $/kWh")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByLabel("Electricity rate · $/kWh").fill("0.18");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByText("Electricity rate saved.")).toBeVisible();
  await page.locator(".server-quicklinks button").first().click();
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  const varied = samples.map((point, i) => ({
    ...point,
    watts:
      i > 4000 && i < 9700
        ? 5 + 2 * Math.sin(i / 20)
        : 80 + 8 * Math.sin(i / 150) + 7 * Math.sin(i / 5),
  }));
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: {
        now,
        samples: varied,
        source: "Fixture data · illustrative load profile",
      },
    }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText("Fixture data · illustrative load profile", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".widget-dashboard:visible")
    .screenshot({ path: "test-results/screenshots/power-usage-fixture.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator(".widget-dashboard:visible").screenshot({
    path: "test-results/screenshots/power-usage-mobile-fixture.png",
  });
});

test("unavailable power retains historical cost without a current-load projection", async ({
  page,
}) => {
  await setup(page, true, false);
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: {
        now,
        samples: [
          { at: now - 600, watts: 100 },
          { at: now - 540, watts: 100 },
        ],
        source: "Fixture",
        error: "Power telemetry unavailable",
      },
    }),
  );
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByTestId("daily-projection")).toHaveText("—");
  await expect(
    page.getByText("Power telemetry unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("1.7% · partial", { exact: true })).toBeVisible();
});

test("history survives API failure while current projections become unavailable", async ({
  page,
}) => {
  await setup(page, true, false);
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: {
        now,
        samples: [
          { at: now - 60, watts: 100 },
          { at: now, watts: 100 },
        ],
        source: "Fixture",
      },
    }),
  );
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByTestId("energy-cost-0")).toHaveText("$0.00");
  await expect(page.getByTestId("daily-projection")).toHaveText("$0.48");
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({ status: 502, json: { error: "History API unavailable" } }),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText("History API unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("energy-cost-0")).toHaveText("$0.00");
  await expect(page.getByTestId("daily-projection")).toHaveText("—");
});
