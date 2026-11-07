import { expect, test, type Page } from "@playwright/test";
import { setup } from "./fixtures";
import type { DashboardContext } from "../../src/dashboard-draft";

async function assistant(page: Page) {
  const state = {
    dashboard: undefined as DashboardContext | undefined,
    turns: 0,
    fail: false,
    selectedModel: "",
  };
  await page.route("**/api/assistant/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").at(-1);
    const status = () => ({
      revision: "provider",
      baseUrl: "https://model.example/v1",
      model: "fixture",
      hasKey: true,
      state: {
        scope: "",
        servers: { default: "Fixture server" },
        dashboard: state.dashboard,
      },
    });
    if (path === "models")
      return route.fulfill({ json: { models: ["fixture", "alternate"] } });
    if (path === "dashboard") {
      const incoming = route.request().postDataJSON();
      if (
        state.dashboard &&
        (incoming.instance !== state.dashboard.instance ||
          incoming.expectedRevision !== state.dashboard.revision)
      )
        return route.fulfill({
          status: 409,
          json: { error: "Stale dashboard context" },
        });
      state.dashboard = incoming;
      return route.fulfill({ json: state.dashboard });
    }
    if (path === "chat") {
      expect(route.request().headers()["x-assistant-instance"]).toBe(
        state.dashboard?.instance,
      );
      if (state.fail)
        return route.fulfill({
          status: 504,
          json: { error: "Model timed out" },
        });
      state.selectedModel = route.request().postDataJSON().model ?? "";
      state.turns++;
      const layout = structuredClone(state.dashboard!.layout);
      if (state.dashboard!.mode === "device" && state.turns === 1)
        layout.widgets.push({
          id: "cpu-reading",
          kind: "sensor",
          sensorId: "1",
          x: 0,
          y: 8,
          w: 3,
          h: 1,
          title: "CPU temperature",
        });
      else if (state.dashboard!.mode === "fleet" && state.turns === 1)
        layout.widgets.push({
          id: "cpu-reading",
          kind: "sensor",
          deviceIds: ["default"],
          sensorId: "1",
          x: 0,
          y: 0,
          w: 3,
          h: 1,
          title: "CPU temperature",
        });
      else layout.widgets[0].y += 10;
      state.dashboard = {
        ...state.dashboard!,
        layout,
        revision: `proposal-${state.turns}`,
        draft: true,
        summary: "Updated dashboard preview.",
      };
      return route.fulfill({
        json: {
          ...status(),
          reply: "Updated the same draft.",
          activity: [{ name: "propose_dashboard", failed: false }],
        },
      });
    }
    return route.fulfill({ json: status() });
  });
  await page.locator(".assistant-tab").click();
  await expect(
    page.getByRole("textbox", { name: "Your question" }),
  ).toBeVisible();
  return state;
}
async function ask(page: Page, question: string) {
  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply dashboard", exact: true }),
  ).toBeEnabled();
}
test("iterative preview, manual resize and comparison do not save until Apply", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await ask(page, "Add a CPU reading");
  const target = state.dashboard!.target;
  expect(
    await page.evaluate((key) => localStorage.getItem(key), target),
  ).toBeNull();
  await expect(page.locator("#widget-cpu-reading")).toContainText("42 °C");
  await page.getByRole("button", { name: "Current", exact: true }).click();
  await expect(page.locator("#widget-cpu-reading")).toHaveCount(0);
  await page.getByRole("button", { name: "Draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "CPU temperature width", exact: true })
    .fill("4");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await ask(page, "Move the first card down");
  const moved = state.dashboard!.layout.widgets[0];
  await expect(page.locator(`[gs-id="${moved.id}"]`)).toHaveAttribute(
    "gs-y",
    String(moved.y),
  );
  await page.screenshot({
    path: "test-results/screenshots/dashboard-preview-desktop.png",
    fullPage: true,
  });
  expect(
    state.dashboard!.layout.widgets.find((w) => w.id === "cpu-reading")?.w,
  ).toBe(4);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), target),
  ).toBeNull();
  await page.getByRole("button", { name: "Apply dashboard" }).click();
  await expect(
    page.getByRole("region", { name: "Dashboard preview" }),
  ).toHaveCount(0);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    target,
  );
  expect(
    saved.widgets.find((w: { id: string }) => w.id === "cpu-reading").w,
  ).toBe(4);
  await page.reload();
  await expect(page.locator("#widget-cpu-reading")).toContainText("42 °C");
});
test("timeout retains draft; changed saved baseline cannot be overwritten", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await ask(page, "Add CPU");
  state.fail = true;
  await ask(page, "Try another change");
  await expect(
    page.getByText("Model timed out", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (key) => localStorage.setItem(key, "another-tab"),
    state.dashboard!.target,
  );
  await page.getByRole("button", { name: "Apply dashboard" }).click();
  await expect(page.getByRole("alert")).toContainText("Saved layout changed");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      state.dashboard!.target,
    ),
  ).toBe("another-tab");
});
test("server power dashboard participates and preview controls are inert", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  const state = await assistant(page);
  await ask(page, "Move the first panel down");
  expect(state.dashboard!.mode).toBe("fixed");
  expect(state.dashboard!.title).toContain("Power usage");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Cooling", exact: true }).click();
  await ask(page, "Move this panel down");
  expect(state.dashboard!.title).toContain("Cooling");
  await expect(page.locator(".widget-cooling")).toHaveAttribute("inert", "");
});
test("mobile chat and central preview switch without applying", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.evaluate(() => {
    localStorage.setItem(
      "ibork:navigation:v1",
      JSON.stringify({ deviceId: "default", view: "wall", tab: "Console" }),
    );
    localStorage.setItem("ibork:wall-view:v1", "Central Dashboard");
  });
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await assistant(page);
  await ask(page, "Add CPU");
  expect(state.dashboard!.mode).toBe("fleet");
  await page
    .locator(".assistant-drawer > header")
    .getByRole("button", { name: "View draft" })
    .click();
  await expect(page.locator("#widget-cpu-reading")).toBeVisible();
  await expect(page.locator(".assistant-drawer")).toBeHidden();
  await page.screenshot({
    path: "test-results/screenshots/dashboard-preview-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      state.dashboard!.target,
    ),
  ).toBeNull();
  await page
    .getByRole("button", { name: "Continue in chat", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Your question" }),
  ).toBeVisible();
});

test("wall preview changes geometry without changing console connection preferences", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.evaluate(() => {
    localStorage.setItem(
      "ibork:navigation:v1",
      JSON.stringify({ deviceId: "default", view: "wall", tab: "Console" }),
    );
    localStorage.setItem("ibork:wall-view:v1", "Consoles");
  });
  await page.reload();
  const state = await assistant(page);
  await ask(page, "Move the console down");
  expect(state.dashboard!.mode).toBe("wall");
  await expect(
    page.getByRole("button", { name: "Connect all", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("jet-supermicro:kvm-wall:v1"),
    ),
  ).toBeNull();
  await page.getByRole("button", { name: "Apply dashboard" }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("jet-supermicro:kvm-wall:v1")!),
  );
  expect(saved.entries[0]).toMatchObject({
    source: "jetkvm",
    connect: "manual",
    included: true,
    y: 10,
  });
});

test("MCP proposals appear through status polling and reload starts with saved layout", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await expect.poll(() => !!state.dashboard).toBe(true);
  const instance = state.dashboard!.instance;
  const layout = structuredClone(state.dashboard!.layout);
  layout.widgets[0].y = 10;
  state.dashboard = {
    ...state.dashboard!,
    layout,
    revision: "external",
    draft: true,
  };
  await expect(
    page.getByRole("region", { name: "Dashboard preview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      state.dashboard!.target,
    ),
  ).toBeNull();
  await page.reload();
  await page.locator(".assistant-tab").click();
  await expect.poll(() => state.dashboard?.draft).not.toBe(true);
  expect(state.dashboard!.instance).toBe(instance);
  await expect(
    page.getByRole("region", { name: "Dashboard preview" }),
  ).toHaveCount(0);
});

test("stopping a pending refinement preserves the last complete draft", async ({
  page,
}) => {
  await setup(page, true, false);
  await assistant(page);
  await ask(page, "Add CPU");
  await page.route("**/api/assistant/chat", () => new Promise<void>(() => {}));
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Revise this");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply dashboard" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply dashboard" }),
  ).toBeEnabled();
  await expect(page.locator("#widget-cpu-reading")).toBeVisible();
});

test("expired context is republished before the next chat", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await expect.poll(() => !!state.dashboard).toBe(true);
  state.dashboard = undefined;
  await ask(page, "Add CPU after expiry");
  await expect(page.locator("#widget-cpu-reading")).toBeVisible();
  state.dashboard = undefined;
  await expect.poll(() => !!state.dashboard).toBe(true);
  await expect(page.locator("#widget-cpu-reading")).toBeVisible();
});

test("a copied tab cannot reuse the live tab identity", async ({ page }) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await expect.poll(() => !!state.dashboard).toBe(true);
  const first = state.dashboard!.instance;
  const popupPromise = page.waitForEvent("popup");
  await page.evaluate(() => window.open("about:blank"));
  const popup = await popupPromise;
  // about:blank inherits the opener origin and its session storage snapshot.
  expect(
    await popup.evaluate(() =>
      sessionStorage.getItem("ibork:assistant-tab:v1"),
    ),
  ).toBe(first);
  await setup(popup, true, false);
  const second = await assistant(popup);
  await expect.poll(() => !!second.dashboard).toBe(true);
  expect(second.dashboard!.instance).not.toBe(first);
  await popup.close();
});

test("dashboard drafts preserve the conversation model and settings gear", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  const drawer = page.getByRole("dialog", { name: "iBORK Assistant" });
  await drawer
    .getByRole("combobox", { name: "Chat model" })
    .selectOption("alternate");
  await ask(page, "Add CPU with the selected model");
  expect(state.selectedModel).toBe("alternate");
  await drawer.getByRole("button", { name: "Assistant settings" }).click();
  await expect(
    page.getByRole("tab", { name: "Model connection" }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Connect my agent (MCP)" }).click();
  await expect(page.getByLabel("MCP JSON")).toBeVisible();
  await page.locator(".assistant-tab").click();
  await expect(drawer.getByText("Updated the same draft.")).toBeVisible();
  await expect(
    drawer.getByRole("combobox", { name: "Chat model" }),
  ).toHaveValue("alternate");
});

test("sending during background publication retries the cancelled sync", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await ask(page, "Add CPU");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/assistant/dashboard", async (route) => {
    if (!first) return route.fallback();
    first = false;
    await held;
    await route.abort();
  });
  try {
    const publishing = page.waitForRequest("**/api/assistant/dashboard");
    await page
      .getByRole("button", { name: "Edit layout", exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "CPU temperature width", exact: true })
      .fill("4");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await publishing;
    await ask(page, "Revise while the dashboard sync is pending");
    await expect.poll(() => state.turns).toBe(2);
    expect(
      state.dashboard!.layout.widgets.find((w) => w.id === "cpu-reading")?.w,
    ).toBe(4);
  } finally {
    release();
  }
});

test("late MCP proposals preserve manual edits and allow the next refinement", async ({
  page,
}) => {
  await setup(page, true, false);
  const state = await assistant(page);
  await ask(page, "Add CPU");
  const late = structuredClone(state.dashboard!);
  // Hold automatic publication until the late remote proposal is visible.
  await page.route("**/api/assistant/dashboard", (route) =>
    route.fulfill({ status: 503, json: { error: "Temporarily offline" } }),
  );
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "CPU temperature width", exact: true })
    .fill("4");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  state.dashboard = { ...late, revision: "late-mcp", draft: true };
  await expect(page.getByText(/Dashboard changed locally/)).toBeVisible();
  await expect(page.locator('[gs-id="cpu-reading"]')).toHaveAttribute(
    "gs-w",
    "4",
  );
  await page.unroute("**/api/assistant/dashboard");
  await ask(page, "Refine my manually resized draft");
  await expect.poll(() => state.turns).toBe(2);
  expect(
    state.dashboard!.layout.widgets.find((w) => w.id === "cpu-reading")?.w,
  ).toBe(4);
});
