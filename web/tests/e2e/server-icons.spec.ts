import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";
import { readFile } from "node:fs/promises";

test("icon URLs and clipboard images share crop validation and preserve the last selection", async ({
  page,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const png = await readFile("src/assets/t440.png");
  const preview = page
    .getByRole("img", { name: "Sidebar icon preview" })
    .locator("img");
  await page.route("https://icons.example.test/**", (route) =>
    route.fulfill({
      body: png,
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  const url = page.getByLabel("Image URL", { exact: true });
  const load = page.getByRole("button", { name: "Use image URL" });
  for (const invalid of [
    "http://icons.example.test/icon.png",
    "https://user:secret@icons.example.test/icon.png",
    "javascript:alert(1)",
  ]) {
    await url.fill(invalid);
    await load.click();
    await expect(page.getByRole("alert")).toContainText(
      "HTTPS image URL without a username or password",
    );
  }
  await url.fill("https://icons.example.test/icon.png");
  await load.click();
  await expect(preview).toHaveAttribute("src", /^data:image\/png;base64,/);
  const original = await preview.getAttribute("src");
  await page.route("https://icons.example.test/broken.png", (route) =>
    route.abort(),
  );
  await url.fill("https://icons.example.test/broken.png");
  await load.click();
  await expect(page.getByRole("alert")).toContainText("Upload or paste");
  await expect(preview).toHaveAttribute("src", original!);
  await page.getByLabel("Icon image", { exact: true }).selectOption("initials");
  await url.evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([bytes], "pasted.png", { type: "image/png" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png.toString("base64"));
  await expect(preview).toHaveAttribute("src", original!);
  await expect(page.getByLabel("Zoom", { exact: true })).toBeVisible();
  // A slow URL must time out, and must never overwrite a newer preset selection.
  await page.clock.install();
  await page.route("https://icons.example.test/slow.png", () => {});
  await url.fill("https://icons.example.test/slow.png");
  await load.click();
  await page.clock.runFor(10001);
  await expect(page.getByRole("alert")).toContainText("Upload or paste");
  await load.click();
  await page.getByLabel("Icon image", { exact: true }).selectOption("initials");
  await page.clock.runFor(10001);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Icon image", { exact: true })).toHaveValue(
    "initials",
  );
  await url.fill("icons.example/icon.png");
  await page.getByLabel("Short text", { exact: true }).fill("PASTED");
  await page.getByRole("button", { name: "Save display preferences" }).click();
  await expect(
    page.getByRole("button", { name: "Select Demo compute", exact: true }),
  ).toContainText("PASTED");
  await page.screenshot({
    path: "test-results/screenshots/icon-import-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/screenshots/icon-import-mobile.png",
    fullPage: true,
  });
});

test("circular sidebar icons have bounded labels and persist custom crops per device", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "Demo compute",
          manufacturer: "Supermicro",
          model: "X9",
          bmcHost: "192.0.2.50",
          bmcPort: 623,
          hasJetKVM: true,
        },
        {
          id: "t320",
          name: "Dell T320",
          manufacturer: "Dell",
          model: "T320",
          bmcHost: "192.0.2.20",
          bmcPort: 623,
          hasJetKVM: false,
        },
        {
          id: "t440",
          name: "Dell T440",
          manufacturer: "Dell",
          model: "T440",
          bmcHost: "192.0.2.40",
          bmcPort: 623,
          hasJetKVM: false,
        },
      ],
    }),
  );
  await page.reload();
  const links = page.getByRole("navigation", { name: "Server quicklinks" });
  await expect(links.locator("img")).toHaveCount(3);
  await expect(links.getByText("T320", { exact: true })).toBeVisible();
  await expect(links.getByText("T440", { exact: true })).toBeVisible();
  const dellIcon = links.getByRole("button", {
    name: "Select Dell T320",
    exact: true,
  });
  const circle = await dellIcon.locator(".server-icon-circle").boundingBox();
  expect(circle!.width).toBe(62);
  expect(circle!.height).toBe(62);
  const label = await dellIcon.locator(".server-icon-label").boundingBox();
  await expect(dellIcon.locator("img")).toHaveJSProperty("complete", true);
  const photo = await dellIcon.locator("img").boundingBox();
  expect(photo!.width).toBeLessThanOrEqual(circle!.width);
  expect(photo!.height).toBeLessThanOrEqual(circle!.height);
  expect(label!.x + label!.width).toBeGreaterThan(circle!.x + circle!.width);
  expect(label!.x).toBeGreaterThan(circle!.x);
  await page.screenshot({
    path: "test-results/screenshots/sidebar-icons-defaults.png",
  });
  const sidebar = page.getByRole("button", {
    name: "Select Demo compute",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await page.getByLabel("Short text", { exact: true }).fill("DEMO-A2345");
  await expect(page.getByLabel("Short text", { exact: true })).toHaveValue(
    "DEMO-A",
  );
  await page.getByLabel("Choose icon image").setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(page.getByRole("alert")).toContainText("PNG, JPEG or WebP");
  await page
    .getByLabel("Choose icon image")
    .setInputFiles("src/assets/t440.png");
  await expect(page.getByLabel("Zoom", { exact: true })).toBeVisible();
  await page.getByLabel("Zoom", { exact: true }).fill("1.8");
  await page.getByLabel("Horizontal position", { exact: true }).fill("20");
  await page.getByLabel("Vertical position", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Save display preferences" }).click();
  await expect(sidebar).toContainText("DEMO-A");
  const source = await sidebar.locator("img").getAttribute("src");
  expect(source).toMatch(/^data:image\/png;base64,/);
  expect(source!.length).toBeLessThan(65536);
  const badge = await sidebar.locator(".server-icon-label").boundingBox();
  const rail = await page.locator(".rail").boundingBox();
  expect(badge!.x).toBeGreaterThanOrEqual(rail!.x);
  expect(badge!.x + badge!.width).toBeLessThanOrEqual(rail!.x + rail!.width);
  await page.reload();
  await expect(sidebar.locator("img")).toHaveAttribute("src", source!);
  await expect(links.getByText("T320", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/sidebar-icons-fixture.png",
  });
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await page.getByLabel("Short text", { exact: true }).fill("WWWWWW");
  await page.getByRole("button", { name: "Save display preferences" }).click();
  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".rail")).toHaveCSS("width", "112px");
    const metrics = await links.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.scrollWidth).toBe(metrics.width);
    expect(metrics.scrollHeight).toBe(metrics.height);
    const nav = await links.boundingBox();
    const text = await sidebar.locator(".server-icon-label").boundingBox();
    expect(text!.x).toBeGreaterThanOrEqual(nav!.x);
    expect(text!.x + text!.width).toBeLessThanOrEqual(nav!.x + nav!.width);
    expect(
      await page
        .locator(".workspace")
        .evaluate((element) => element.getBoundingClientRect().left),
    ).toBe(112);
  }
});
