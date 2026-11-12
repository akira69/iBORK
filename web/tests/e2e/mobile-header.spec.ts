import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setup } from "./fixtures";

test("desktop header retains its layout", async ({ page }) => {
  await setup(page, true, false);
  await expect(page.getByLabel("IPMI: Online", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit layout", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".rail")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Switch server" }),
  ).toHaveCount(0);
  const screenshot = await page.locator(".topbar").screenshot();
  // Optional local before/after proof; CI does not depend on a generated baseline.
  if (process.env.HEADER_BASELINE === "write") {
    await mkdir(".tools", { recursive: true });
    await writeFile(".tools/mobile-header-desktop-before.png", screenshot);
  }
  if (process.env.HEADER_BASELINE === "compare")
    expect(
      screenshot.equals(
        await readFile(".tools/mobile-header-desktop-before.png"),
      ),
    ).toBe(true);
});

test("mobile switches servers from console, settings and wall in a compact header", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "Demo compute",
          bmcHost: "192.0.2.50",
          bmcPort: 623,
          hasJetKVM: true,
        },
        {
          id: "dell",
          name: "Demo storage with a long descriptive name",
          bmcHost: "192.0.2.2",
          bmcPort: 623,
          hasJetKVM: false,
        },
      ],
    }),
  );
  await page.reload();
  const header = page.locator(".topbar");
  const selector = header.getByRole("combobox", { name: "Switch server" });
  for (const width of [390, 320, 520]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(selector).toBeVisible();
    await expect(page.locator(".rail")).toBeHidden();
    await selector.selectOption("dell");
    await expect(header.getByRole("heading")).toHaveText(
      "Demo storage with a long descriptive name",
    );
    await expect(
      page.getByRole("region", { name: "JetKVM widget", exact: true }),
    ).toHaveCount(0);
    await header
      .getByRole("button", { name: "iBORK settings", exact: true })
      .click();
    await expect(header.getByRole("heading")).toHaveText("iBORK Settings");
    await expect(selector).toHaveValue("");
    await selector.selectOption("default");
    await expect(header.getByRole("heading")).toHaveText("Demo compute");
    await header.getByRole("button", { name: "KVM Wall", exact: true }).click();
    await expect(header.getByRole("heading")).toHaveText("KVM Wall");
    await selector.selectOption("default");
    await expect(
      page.getByRole("button", { name: "Console", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("button", { name: "Server settings", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const box = (await header.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(130);
    for (const button of await header.getByRole("button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(40);
      expect(bounds.height).toBeGreaterThanOrEqual(40);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/screenshots/mobile-header-${width}.png`,
    });
  }
});
