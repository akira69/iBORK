import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { env, stdout } from "node:process";
import { chromium, expect } from "@playwright/test";
const fixture = JSON.parse(
  await readFile(env.IBORK_ASSISTANT_TEST_PROFILE, "utf8"),
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    locale: "en-US",
    viewport: { width: 390, height: 844 },
  });
  let toolRequests = 0;
  let chatRequests = 0;
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/assistant/")) toolRequests++;
    if (path === "/api/assistant/chat") chatRequests++;
  });
  await page.goto(env.IBORK_TEST_ORIGIN);
  await page.getByLabel("Management password").fill(env.IBORK_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in to console" }).click();
  const launcher = page.locator(".assistant-tab");
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await expect(launcher).toBeVisible();
  await expect(drawer).toBeHidden();
  expect(toolRequests).toBe(0);
  await launcher.click();
  await drawer.getByRole("button", { name: "Assistant settings" }).click();
  await expect(page.getByRole("heading", { name: "Add server" })).toBeVisible();
  await expect(drawer).toBeHidden();
  await page.getByLabel("OpenAI-compatible endpoint").fill(fixture.baseUrl);
  await page.getByLabel("Default model ID").fill(fixture.model);
  if (fixture.key)
    await page.getByLabel("API key (optional)").fill(fixture.key);
  await page.getByRole("button", { name: "Test & save model" }).click();
  await expect(
    page
      .locator(".assistant-settings")
      .getByText("Model listed and tool call verified."),
  ).toBeVisible({ timeout: 60000 });
  await page
    .locator(".connection-settings")
    .getByRole("button", { name: "iBORK Assistant" })
    .click();
  await expect(
    drawer.getByRole("combobox", { name: "Chat model" }),
  ).toHaveValue(fixture.model);
  await drawer.getByRole("button", { name: "Check my setup" }).click();
  await expect(page.getByLabel("Your question")).toHaveValue(/setup_status/);
  expect(chatRequests).toBe(0);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/assistant/chat",
    { timeout: 62000 },
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const turn = await (await response).json();
  expect(turn.error).toBeUndefined();
  expect(turn.reply.trim().length).toBeGreaterThan(0);
  const log = drawer.getByRole("log");
  await expect(log).toContainText("setup_status ✓");
  await expect(log.getByText(turn.reply, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.getByLabel("Switch server").selectOption("vault");
  await launcher.click();
  await expect(log.getByText(turn.reply, { exact: true })).toBeVisible();
  const followUp = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/assistant/chat",
    { timeout: 62000 },
  );
  await page
    .getByLabel("Your question")
    .fill("In one short sentence, what was my last question about?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const follow = await (await followUp).json();
  expect(follow.error).toBeUndefined();
  expect(follow.reply.trim().length).toBeGreaterThan(0);
  await expect(
    log.getByText(follow.reply, { exact: true }).last(),
  ).toBeVisible();
  const target = "jet-supermicro:dashboard:v1:192.0.2.2:623";
  await page.evaluate((target) => {
    const widget = { id: "health", kind: "health", x: 0, y: 0, w: 4, h: 3 };
    globalThis.localStorage.setItem(
      "jet-supermicro:dashboard:v1:192.0.2.1:623",
      JSON.stringify({ version: 1, widgets: [{ ...widget, x: 6, y: 5 }] }),
    );
    globalThis.localStorage.setItem(
      target,
      JSON.stringify({ version: 1, widgets: [widget] }),
    );
  }, target);
  const geometry = () =>
    page.evaluate(
      (k) => JSON.parse(globalThis.localStorage.getItem(k)).widgets[0],
      target,
    );
  for (const [prompt, x, y] of [
    [
      "Copy the Console layout from atlas to vault. Propose it using the layout tool now.",
      6,
      5,
    ],
    [
      "Tidy vault's Console panels. Propose the layout with vault as both source and target.",
      6,
      0,
    ],
  ]) {
    const original = await geometry();
    await page.getByLabel("Your question").fill(prompt);
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/assistant/chat",
      { timeout: 62000 },
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const result = await (await response).json();
    expect(result.error).toBeUndefined();
    expect(result.reply.trim()).toBeTruthy();
    expect(result.activity).toContainEqual(
      expect.objectContaining({ name: "propose_layout", failed: false }),
    );
    await page
      .getByRole("button", { name: "Preview dashboard changes" })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply to this browser" }),
    ).toBeVisible();
    expect(await geometry()).toEqual(original);
    await page.getByRole("button", { name: "Apply to this browser" }).click();
    expect(await geometry()).toMatchObject({ x, y });
  }
  stdout.write(
    "Browser login, mobile drawer, settings navigation, server switch, provider test, editable preset, shared setup_status call, model reply, follow-up and reviewed layout copy and tidy passed.\n",
  );
} finally {
  await browser.close();
}
