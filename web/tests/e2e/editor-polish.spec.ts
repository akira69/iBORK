import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";
import { dell } from "./vnc-fixture";

test("widget chooser groups cards, searches across categories and labels added widgets", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  const chooser = page.getByRole("region", { name: "Widget catalog" });
  await expect(
    chooser.getByRole("button", { name: "Health & cooling", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const search = chooser.getByRole("searchbox", { name: "Find widget" });
  await search.fill("week");
  const week = chooser.getByRole("button", { name: "Last week", exact: true });
  await expect(chooser.locator(".widget-choice")).toHaveCount(1);
  await week.click();
  await expect(week).toBeDisabled();
  await expect(week).toContainText("Added");
  await search.fill("nothing matches");
  await expect(chooser.getByText("No matching widgets.")).toBeVisible();
  await chooser
    .getByRole("button", { name: "Power & cost", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await chooser.screenshot({
    path: "test-results/screenshots/design/widget-chooser-after.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(
      async () => (await page.locator("#widget-jetkvm").boundingBox())!.width,
    )
    .toBeGreaterThan(340);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/screenshots/design/widget-chooser-mobile-after.png",
    fullPage: true,
  });
});

test("desktop hides the touch keyboard and settings prioritize adding servers", async ({
  page,
}) => {
  await setup(page, true, false);
  await expect(
    page.getByRole("button", { name: "Show keyboard", exact: true }),
  ).toBeHidden();
  const settings = page
    .locator(".rail-bottom")
    .getByRole("button", { name: "iBORK settings", exact: true });
  expect((await settings.locator("svg").boundingBox())!.width).toBe(42);
  await settings.click();
  const cards = page.locator(".settings-grid");
  await expect(cards.locator(":scope > :first-child")).toHaveClass(
    /connection-settings/,
  );
  await page.screenshot({
    path: "test-results/screenshots/design/editor-settings-after.png",
    fullPage: true,
  });
});

test("single readings fit their content and an independent week chart survives reload", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  const catalog = page.getByRole("region", { name: "Widget catalog" });
  await catalog
    .getByRole("button", { name: "Sensor reading", exact: true })
    .click();
  const sensor = page.getByRole("region", {
    name: "Sensor reading widget",
    exact: true,
  });
  await sensor.getByRole("button", { name: "Configure sensor" }).click();
  const before = (await sensor.locator(".widget-body").boundingBox())!;
  await expect(
    sensor.getByRole("dialog", { name: "Sensor settings" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/design/sensor-popover-after.png",
    fullPage: true,
  });
  await sensor
    .getByRole("checkbox", { name: "CPU1 Temp", exact: true })
    .check();
  await sensor.getByRole("button", { name: "Close sensor settings" }).click();
  expect((await sensor.locator(".widget-body").boundingBox())!.height).toBe(
    before.height,
  );
  await expect(sensor.locator(".widget-body select")).toHaveCount(0);
  await sensor.getByLabel("Sensor reading height", { exact: true }).fill("8");
  await sensor
    .getByRole("button", { name: "Fit Sensor reading content" })
    .click();
  expect(
    Number(
      await sensor
        .getByLabel("Sensor reading height", { exact: true })
        .inputValue(),
    ),
  ).toBeLessThan(4);
  await catalog
    .getByRole("button", { name: "Power & cost", exact: true })
    .click();
  await catalog.getByRole("button", { name: "Last week", exact: true }).click();
  const editingReading = (await sensor
    .locator(".sensor-reading")
    .boundingBox())!;
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect((await sensor.locator(".sensor-reading").boundingBox())!.height).toBe(
    editingReading.height,
  );
  const value = sensor.getByText("42 °C", { exact: true });
  const outer = (await sensor.boundingBox())!,
    inner = (await value.boundingBox())!;
  expect(inner.y + inner.height).toBeLessThan(outer.y + outer.height);
  await page.reload();
  const week = page.getByRole("region", {
    name: "Last week widget",
    exact: true,
  });
  await expect(week).toBeVisible();
  await expect(week.getByText("Last hour", { exact: true })).toHaveCount(0);
  await expect(week.getByText("Last day", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: "test-results/screenshots/design/editor-fitted-after.png",
    fullPage: true,
  });
});

test("wall tools stay in the header, manual drags survive viewport changes and settings open the right server", async ({
  page,
}) => {
  await dell(page);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  const tile = page.getByRole("region", {
    name: "Dell fixture console tile",
    exact: true,
  });
  for (const name of ["Connect", "Disconnect", "Open server"])
    await expect(
      tile.locator("header").getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await page.getByRole("button", { name: "Edit wall layout" }).click();
  await page.getByLabel("Dell fixture width", { exact: true }).fill("6");
  const handle = tile.locator(".widget-grip"),
    rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + 30, rect.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 300, rect.y + 20, { steps: 10 });
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.mouse.up();
  const node = page.locator('.wall-grid [gs-id="dell"]');
  await expect(node).not.toHaveAttribute("gs-x", "0");
  await expect(tile).toBeVisible();
  await expect(
    page.getByLabel("Dell fixture width", { exact: true }),
  ).toHaveValue("6");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.getByLabel("Dell fixture width", { exact: true }).fill("3");
  expect((await handle.boundingBox())!.width).toBeGreaterThanOrEqual(80);
  const header = tile.locator("header");
  const bounds = (await header.boundingBox())!;
  for (const button of await header.getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  await page.screenshot({
    path: "test-results/screenshots/design/wall-narrow-edit-after.png",
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await expect(tile).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Server settings for Dell fixture" })
    .click();
  await expect(
    page.getByRole("button", { name: "Server settings", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".topbar h1")).toHaveText("Dell fixture");
});

test("pointer dragging preserves every widget across collisions, grid edges and refreshes", async ({
  page,
}) => {
  await setup(page, true, false);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("region", { name: "Widget catalog" })
    .getByRole("button", { name: "Sensor reading", exact: true })
    .click();
  const sensor = page.getByRole("region", {
    name: "Sensor reading widget",
    exact: true,
  });
  await sensor.getByRole("button", { name: "Configure sensor" }).click();
  await sensor
    .getByRole("checkbox", { name: "CPU1 Temp", exact: true })
    .check();
  await sensor.getByRole("button", { name: "Close sensor settings" }).click();
  for (const destination of [
    [200, 500],
    [1300, 450],
    [50, 200],
    [850, 650],
    [300, 450],
  ]) {
    const handle = sensor.locator(".widget-grip");
    await handle.scrollIntoViewIfNeeded();
    const r = (await handle.boundingBox())!;
    await page.mouse.move(r.x + Math.min(45, r.width / 2), r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination[0], destination[1], { steps: 12 });
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.waitForTimeout(100);
    await page.mouse.up();
    await expect(page.locator(".widget-dashboard .widget-shell")).toHaveCount(
      4,
    );
    await expect(sensor.getByText("42 °C", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await expect(page.locator(".widget-dashboard .widget-shell")).toHaveCount(4);
  expect(errors).toEqual([]);
});
