import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("desktop chat keeps its draft and transcript while the operator navigates", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = { scope: "", servers: {} };
  await page.route("**/api/assistant/status", (route) =>
    route.fulfill({
      json: {
        state,
        baseUrl: "https://models.invalid/v1",
        model: "fixture",
        revision: "1",
        hasKey: false,
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier reply" },
        ],
      },
    }),
  );
  await page.route("**/api/assistant/chat", (route) =>
    route.fulfill({ status: 504, json: { error: "Model timed out" } }),
  );
  const launcher = page.locator(".assistant-tab");
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await launcher.click();
  await expect(drawer.getByText("Earlier reply")).toBeVisible();
  await drawer.getByLabel("Your question").fill("What devices are configured?");
  await page.locator(".rail").getByRole("button", { name: "KVM Wall" }).click();
  await expect(
    page.getByRole("heading", { name: "KVM Wall", exact: true }),
  ).toBeVisible();
  await expect(drawer.getByLabel("Your question")).toHaveValue(
    "What devices are configured?",
  );
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(drawer.getByRole("status")).toHaveText("Model timed out");
  await drawer.getByRole("button", { name: "Discovery scope" }).click();
  await expect(
    page.getByLabel("Private IPv4 addresses or subnet"),
  ).toBeVisible();
  await expect(page.locator('[data-section="scope"]')).toBeFocused();
  await launcher.click();
  await expect(drawer.getByText("Earlier reply")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
});

test("empty fleet opens assistant settings from the mobile Remote display page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await setup(page, true, false);
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/panel-layout", (route) =>
    route.fulfill({ json: { revision: 1, home: ["servers"], servers: [] } }),
  );
  await page.route("**/api/assistant/status", (route) =>
    route.fulfill({
      json: {
        state: { scope: "", servers: {} },
        baseUrl: "",
        model: "",
        revision: "1",
        hasKey: false,
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Remote display" }).click();
  await page.locator(".assistant-tab").click();
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((node) => node.matches(":modal"))).toBe(true);
  expect(await drawer.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
    320,
  );
  await drawer.getByRole("button", { name: "Connect my agent (MCP)" }).click();
  await expect(page.getByLabel("MCP JSON")).toBeVisible();
  await expect(page.locator('[data-section="connect"]')).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Remote display" }),
  ).toBeVisible();
});

test("reopening uses the current model and keeps text typed during a turn", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = { scope: "", servers: {} };
  let revision = "first";
  await page.route("**/api/assistant/status", (route) =>
    route.fulfill({
      json: {
        state,
        revision,
        model: revision,
        baseUrl: "https://models.invalid/v1",
        hasKey: false,
      },
    }),
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/assistant/chat", async (route) => {
    const submitted = route.request().postDataJSON();
    await delayed;
    await route.fulfill({
      json: { state, reply: submitted.revision, activity: [] },
    });
  });
  const launcher = page.locator(".assistant-tab");
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await launcher.click();
  await expect(drawer.getByText(/Model connection: first/)).toBeVisible();
  await drawer.getByRole("button", { name: "Close assistant" }).click();
  revision = "second";
  await launcher.click();
  await expect(drawer.getByText(/Model connection: second/)).toBeVisible();
  const question = drawer.getByLabel("Your question");
  await question.fill("First question");
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Stop" })).toBeVisible();
  await question.fill("Next question");
  release();
  await expect(drawer.getByRole("log")).toContainText("second");
  await expect(question).toHaveValue("Next question");
});
