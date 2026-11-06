import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("settings tabs preserve model drafts and copy the MCP configuration", async ({
  page,
  context,
}) => {
  await setup(page, true, false);
  await page.route("**/api/assistant/status", (route) =>
    route.fulfill({
      json: {
        revision: "fixture",
        model: "",
        baseUrl: "",
        state: { scope: "", servers: {} },
      },
    }),
  );
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  const settings = page.locator(".assistant-settings");
  await settings.locator("summary").click();
  const model = settings.getByRole("tab", { name: "Model connection" });
  await expect(model).toHaveAttribute("aria-selected", "true");
  await settings.getByLabel("Model ID").fill("test-model");
  await settings.screenshot({
    path: "test-results/screenshots/assistant-settings.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.screenshot({
    path: "test-results/screenshots/assistant-settings-mobile.png",
  });
  await model.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    settings.getByRole("tab", { name: "Discovery scope" }),
  ).toBeFocused();
  await expect(settings.getByLabel("Model ID")).toBeHidden();
  await page.keyboard.press("End");
  await expect(settings.getByLabel("MCP JSON")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await settings
    .getByRole("button", { name: "Copy MCP configuration" })
    .click();
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
      .mcpServers.ibork.headers.Authorization,
  ).toBe("Bearer <token>");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await model.click();
  await expect(settings.getByLabel("Model ID")).toHaveValue("test-model");
});
