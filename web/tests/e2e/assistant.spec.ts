import { expect, test, type Page } from "@playwright/test";
import { setup } from "./fixtures";

const state = { scope: "", servers: {} };
const provider = {
  state,
  baseUrl: "https://models.invalid/v1",
  model: "fixture",
  revision: "1",
  hasKey: false,
};

async function mockStatus(page: Page, status: () => typeof provider) {
  await page.route("**/api/assistant/status", (route) =>
    route.fulfill({ json: status() }),
  );
}

test("desktop chat keeps its draft and transcript while the operator navigates", async ({
  page,
}) => {
  await setup(page, true, false);
  await mockStatus(page, () => ({
    ...provider,
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier reply" },
    ],
  }));
  await page.route("**/api/assistant/models", (route) =>
    route.fulfill({ status: 502, json: { error: "Provider unavailable" } }),
  );
  await page.route("**/api/assistant/chat", (route) =>
    route.fulfill({ status: 504, json: { error: "Model timed out" } }),
  );
  const launcher = page.locator(".assistant-tab");
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  const modelsResponse = page.waitForResponse("**/api/assistant/models");
  await launcher.click();
  expect((await modelsResponse).status()).toBe(502);
  const picker = drawer.getByRole("combobox", { name: "Chat model" });
  await expect(picker).toHaveValue("fixture");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await expect(drawer.getByText("Earlier reply")).toBeVisible();
  const question = drawer.getByLabel("Your question");
  await question.fill("What devices are configured?");
  await page.locator(".rail").getByRole("button", { name: "KVM Wall" }).click();
  await expect(
    page.getByRole("heading", { name: "KVM Wall", exact: true }),
  ).toBeVisible();
  await expect(question).toHaveValue("What devices are configured?");
  const sent = page.waitForRequest("**/api/assistant/chat");
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  expect((await sent).postDataJSON().model).toBeUndefined();
  await expect(drawer.getByRole("status")).toHaveText("Model timed out");
  await expect(question).toHaveValue("What devices are configured?");
  await drawer.getByRole("button", { name: "Assistant settings" }).click();
  await expect(
    page.getByRole("tab", { name: "Model connection" }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Discovery scope" }).click();
  await expect(
    page.getByLabel("Private IPv4 addresses or subnet"),
  ).toBeVisible();
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
  await mockStatus(page, () => ({ ...provider, baseUrl: "", model: "" }));
  await page.reload();
  await page.getByRole("button", { name: "Remote display" }).click();
  await page.locator(".assistant-tab").click();
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((node) => node.matches(":modal"))).toBe(true);
  expect(await drawer.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
    320,
  );
  await drawer.getByRole("button", { name: "Assistant settings" }).click();
  await expect(
    page.getByRole("tab", { name: "Model connection" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Connect my agent (MCP)" }).click();
  await expect(page.getByLabel("MCP JSON")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remote display" }),
  ).toBeVisible();
});

test("reopening loads the current model and proposals; choosing a chat model keeps the shared default", async ({
  page,
}) => {
  await setup(page, true, false);
  let model = "first";
  let available = "alternate";
  await mockStatus(page, () => ({
    ...provider,
    model,
    revision: model,
    state: {
      ...state,
      draft: {
        id: model,
        name: model + " server",
        host: "192.0.2.5",
        jetUrl: "",
      },
    },
  }));
  await page.route("**/api/assistant/models", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { models: [model, available] } });
  });
  const providerWrites: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/assistant/provider"))
      providerWrites.push(request.method());
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/assistant/chat", async (route) => {
    await delayed;
    await route.fulfill({
      json: { state, reply: "Completed turn", activity: [] },
    });
  });
  const launcher = page.locator(".assistant-tab");
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  const picker = drawer.getByRole("combobox", { name: "Chat model" });
  await launcher.click();
  await expect(picker).toHaveValue("first");
  await expect(
    drawer.getByRole("button", { name: "Refresh proposals" }),
  ).toHaveCount(0);
  await expect(drawer.getByText(/first server/)).toBeVisible();
  await drawer.getByRole("button", { name: "Close assistant" }).click();
  model = "second";
  await launcher.click();
  await expect(drawer.getByText(/second server/)).toBeVisible();
  await expect(picker).toHaveValue("second");
  await picker.selectOption("alternate");
  const question = drawer.getByLabel("Your question");
  await question.fill("First line");
  await question.press("Shift+Enter");
  await question.pressSequentially("Second line");
  await expect(question).toHaveValue("First line\nSecond line");
  const sent = page.waitForRequest("**/api/assistant/chat");
  await question.press("Enter");
  expect((await sent).postDataJSON()).toMatchObject({
    message: "First line\nSecond line",
    model: "alternate",
    revision: "second",
  });
  const log = drawer.getByRole("log");
  await expect(log).toContainText("First line");
  await expect(log).toContainText("Working…");
  await expect(drawer.getByRole("button", { name: "Stop" })).toBeVisible();
  await question.fill("Next question");
  release();
  await expect(log).toContainText("Completed turn");
  await expect(question).toHaveValue("Next question");
  await drawer.getByRole("button", { name: "Close assistant" }).click();
  available = "replacement";
  await launcher.click();
  await expect(picker.getByRole("option", { name: available })).toBeAttached();
  await expect(picker).toHaveValue("second");
  const next = page.waitForRequest("**/api/assistant/chat");
  await question.press("Enter");
  expect((await next).postDataJSON().model).toBeUndefined();
  await expect(log.getByText("Completed turn", { exact: true })).toHaveCount(2);
  await drawer.getByRole("button", { name: "Assistant settings" }).click();
  await expect(page.getByLabel("Default model ID")).toHaveValue("second");
  expect(providerWrites).toEqual([]);
});

test.describe("Spanish assistant", () => {
  test.use({ locale: "es-ES" });

  test("stops a pending turn and allows another question", async ({ page }) => {
    await setup(page, true, false);
    await mockStatus(page, () => provider);
    await page.route("**/api/assistant/models", (route) =>
      route.fulfill({ json: { models: ["fixture"] } }),
    );
    let turns = 0;
    await page.route("**/api/assistant/chat", () => {
      turns++;
    });
    await page.locator(".assistant-tab").click();
    const drawer = page.getByRole("dialog", { name: "Asistente de iBORK" });
    await expect(
      drawer.getByRole("combobox", { name: "Modelo del chat" }),
    ).toHaveValue("fixture");
    const question = drawer.getByLabel("Tu pregunta");
    await question.fill("¿Qué está configurado?");
    const pending = page.waitForRequest("**/api/assistant/chat");
    await drawer.getByRole("button", { name: "Enviar" }).click();
    await pending;
    await drawer.getByRole("button", { name: "Detener" }).click();
    await expect(drawer.getByRole("status")).toHaveText("Detenido");
    await question.fill("Otra pregunta");
    await expect(drawer.getByRole("button", { name: "Enviar" })).toBeEnabled();
    expect(turns).toBe(1);
  });
});
