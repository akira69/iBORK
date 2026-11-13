import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";
import { dell, rfbServer } from "./vnc-fixture";

test("settings have the right header, compact fields and responsive card columns", async ({
  page,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(page.locator(".topbar h1")).toHaveText("iBORK Settings");
  await expect(page.locator(".topbar .connection-status")).toHaveCount(0);
  await expect(page.getByLabel("BMC address", { exact: true })).toBeVisible();
  const address = page.getByLabel("BMC address", { exact: true });
  const addressWidth = (await address.boundingBox())!.width;
  for (const control of [
    page.getByRole("textbox", { name: "Glances API origin", exact: true }),
    page.getByRole("combobox", { name: "Power source", exact: true }),
  ]) {
    expect((await control.boundingBox())!.width).toBeGreaterThanOrEqual(
      addressWidth,
    );
  }
  await expect(
    page.locator(".settings-grid .connection-settings h2 svg"),
  ).toHaveCount(1);
  const cards = page.locator(".settings-grid > .panel");
  for (const [width, columns] of [
    [2560, 4],
    [1920, 3],
    [1440, 2],
    [1000, 1],
    [390, 1],
  ]) {
    await page.setViewportSize({ width, height: 1050 });
    const boxes = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      }),
    );
    expect(boxes.filter((box) => box.y === boxes[0].y)).toHaveLength(columns);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1920, height: 1050 });
  await page.screenshot({
    path: "test-results/screenshots/design/settings-after.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/screenshots/design/settings-mobile.png",
    fullPage: true,
  });
});

test("server auto-connect defaults on, persists off, and respects manual disconnect across visibility refresh", async ({
  page,
}) => {
  await setup(page, true, true, false, true);
  await expect(
    page.getByText("WebRTC connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disconnect console", exact: true })
    .click();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText("Console not connected", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { telemetry: { peers: number } }).telemetry.peers,
    ),
  ).toBe(1);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: /Auto-connect KVM/ });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(
    page.getByText("Console not connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(
    page.getByText("WebRTC connected", { exact: true }),
  ).toBeVisible();
});

test("wall packs real 4:3 displays, connects all, and reset preserves clients and preferences", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: Array.from({ length: 3 }, (_, i) => ({
        id: i ? `other${i}` : "dell",
        name: ["Demo storage", "Demo backup", "Demo compute"][i],
        bmcHost: `192.0.2.${10 + i}`,
        bmcPort: 623,
        hasJetKVM: false,
        hasVNC: true,
      })),
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  const previews = page.locator(".wall-preview");
  const checkRatio = async () => {
    await expect
      .poll(async () => {
        const boxes = await previews.evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return Math.abs(r.width / r.height - 4 / 3);
          }),
        );
        return Math.max(...boxes);
      })
      .toBeLessThan(0.03);
  };
  await checkRatio();
  await expect(page.locator(".wall-tile .server-icon")).toHaveCount(3);
  await page.getByRole("button", { name: "Connect all", exact: true }).click();
  await expect.poll(() => traffic.urls.length).toBe(3);
  await page.screenshot({
    path: "test-results/screenshots/design/wall-after.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Auto-connect all", exact: true })
    .click();
  for (const toggle of await page
    .getByRole("switch", { name: /^Auto-connect / })
    .all())
    await expect(toggle).toBeChecked();
  await page.screenshot({
    path: "test-results/screenshots/design/wall-settings-after.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Set all to manual", exact: true })
    .click();
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  const beforeEdit = await previews.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { width, height } = node.getBoundingClientRect();
      return { width, height };
    }),
  );
  await page.getByRole("button", { name: "Edit wall layout" }).click();
  await expect
    .poll(async () =>
      previews.evaluateAll((nodes) =>
        nodes.map((node) => {
          const { width, height } = node.getBoundingClientRect();
          return { width, height };
        }),
      ),
    )
    .toEqual(beforeEdit);
  await page.getByRole("button", { name: "Done editing wall" }).click();
  await page.getByRole("button", { name: "Edit wall layout" }).click();
  await expect
    .poll(async () =>
      previews.evaluateAll((nodes) =>
        nodes.map((node) => {
          const { width, height } = node.getBoundingClientRect();
          return { width, height };
        }),
      ),
    )
    .toEqual(beforeEdit);
  await page.getByLabel("Demo storage width", { exact: true }).fill("9");
  await page.getByRole("button", { name: "Reset wall layout" }).click();
  await page.getByRole("button", { name: "Confirm wall reset" }).click();
  await checkRatio();
  expect(traffic.closed).toBe(0);
  await expect(
    page.getByRole("button", { name: "Edit wall layout" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkRatio();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("a removed console stays disconnected when its dashboard reopens", async ({
  page,
}) => {
  await setup(page, true, true, false, true);
  await expect(
    page.getByRole("button", { name: "Disconnect console", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove JetKVM", exact: true })
    .click();
  await page.getByRole("button", { name: "Sensors", exact: true }).click();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "At a glance widget" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { telemetry: { peers: number } }).telemetry.peers,
    ),
  ).toBe(0);
});
