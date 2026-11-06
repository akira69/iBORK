import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function add(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find widget" }).fill(title);
  await page
    .getByRole("region", { name: "Widget catalog" })
    .getByRole("button", { name: title, exact: true })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

test("cooling and extended widgets reuse shared readings and retain layout", async ({
  page,
}) => {
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/sensors")) reads++;
  });
  await setup(page, true, false);
  await page.getByRole("button", { name: "Cooling", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fan mode" })).toContainText(
    "Unknown (0x03)",
  );
  await expect(
    page.getByRole("button", { name: "Change fan mode" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Custom fan curve" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/screenshots/cooling-fixture.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Console", exact: true })
    .last()
    .click();
  for (const name of [
    "Fan speeds",
    "Temperatures",
    "Power supplies",
    "Sensor warnings",
    "Recent events",
    "Server inventory",
    "Connections",
    "Next boot",
    "Virtual media",
  ]) {
    await add(page, name);
  }
  await expect(page.locator("#widget-fans")).toContainText("3,200 RPM");
  await expect(page.locator("#widget-psu")).toContainText("PS1 Status");
  await expect(page.locator("#widget-alerts")).toContainText(
    "No warnings or critical",
  );
  await expect(page.locator("#widget-inventory")).toContainText("DEMO-BOARD");
  expect(reads).toBe(1);
  await page
    .locator("#widget-boot")
    .getByRole("button", { name: /BIOS setup/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await expect(page.locator("#widget-fans")).toContainText("3,200 RPM");
  await expect(page.locator("#widget-media")).toBeAttached();
});

test("diagnostics history, cancellation and view changes isolate late responses", async ({
  page,
}) => {
  await setup(page, true, false);
  let finish: () => void = () => {};
  await page.route("**/api/devices/default/diagnostics", async (route) => {
    const command = route.request().postDataJSON().command;
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    if (command === "sensor list") {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await route
        .fulfill({ json: { output: "late old response", truncated: false } })
        .catch(() => {});
    } else
      await route.fulfill({
        json: {
          output: "Read-only commands: help, power status",
          truncated: false,
        },
      });
  });
  await page.getByRole("button", { name: "Terminals", exact: true }).click();

  const input = page.getByRole("textbox", { name: "Command", exact: true });
  await input.fill("help");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("log", { name: "Diagnostic output" }),
  ).toContainText("Read-only commands:");
  await page.screenshot({
    path: "test-results/screenshots/diagnostics-fixture.png",
    fullPage: true,
  });
  await input.press("ArrowUp");
  await expect(input).toHaveValue("help");
  await input.fill("sensor list");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  finish();
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole("log", { name: "Diagnostic output" }),
  ).toContainText("Canceled.");
  await expect(
    page.getByRole("log", { name: "Diagnostic output" }),
  ).not.toContainText("late old response");
  await input.fill("sensor list");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cooling", exact: true }).click();
  finish();
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole("log", { name: "Diagnostic output" }),
  ).not.toContainText("late old response");
});

test("compact power cost shares the tariff and labels partial coverage", async ({
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
  await add(page, "Current power");
  await add(page, "Measured energy & cost");
  await expect(page.locator("#widget-power-now")).toContainText("100.0 W");
  await expect(page.locator("#widget-energy-cost")).toContainText("partial");
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await page.getByLabel("Electricity rate · $/kWh").fill("0.36");
  await page.getByRole("button", { name: "Save electricity rate" }).click();
  await expect(page.getByText("Electricity rate saved.")).toBeVisible();
  await page.locator(".server-quicklinks button").first().click();
  await expect(page.locator("#widget-energy-cost")).toContainText("$0.36/kWh");
});
