import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("password change verifies confirmation, handles rejection and signs out on success", async ({
  page,
}) => {
  await setup(page, true, false);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/screenshots/password-settings-fixture.png",
    fullPage: true,
  });
  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel("New password", { exact: true });
  const confirmation = page.getByLabel("Confirm new password", { exact: true });
  for (const field of [current, next, confirmation])
    await expect(field).toHaveAttribute("type", "password");
  const calls: unknown[] = [];
  let outcome = "reject";
  await page.route("**/api/app-password", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    calls.push(route.request().postDataJSON());
    if (outcome === "network") return route.abort("timedout");
    return route.fulfill({
      status: outcome === "reject" ? 400 : 200,
      json:
        outcome === "reject"
          ? { error: "Current password is incorrect" }
          : { saved: true, signInRequired: true },
    });
  });
  await current.fill("fixture-current-password");
  await next.fill("fixture-new-password");
  await confirmation.fill("fixture-other-password");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("do not match");
  expect(calls).toHaveLength(0);
  await next.fill("界".repeat(25));
  await confirmation.fill("界".repeat(25));
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("72 UTF-8 bytes");
  expect(calls).toHaveLength(0);
  await next.fill("fixture-new-password");
  await confirmation.fill("fixture-new-password");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Current password is incorrect",
  );
  await expect(current).toBeVisible();
  outcome = "network";
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Try signing in with the new password",
  );
  outcome = "success";
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByLabel("Management password", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Password changed. Sign in with your new password."),
  ).toBeVisible();
  expect(calls.at(-1)).toEqual({
    currentPassword: "fixture-current-password",
    newPassword: "fixture-new-password",
  });
  expect(
    JSON.stringify(
      await page.evaluate(() => ({ ...localStorage, ...sessionStorage })),
    ),
  ).not.toContain("fixture-new-password");
});

test("the pencil opens the widget catalog without a plus button or server dropdown", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page, true, false);
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: { now: Math.floor(Date.now() / 1000), samples: [] },
    }),
  );
  await expect(
    page.getByRole("combobox", { name: "Server", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add widget", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Widget catalog" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  const catalog = page.getByRole("region", { name: "Widget catalog" });
  await expect(catalog).toBeVisible();
  await catalog
    .getByRole("button", { name: "Power & cost", exact: true })
    .click();
  await catalog
    .getByRole("button", { name: "Current power", exact: true })
    .click();
  await expect(catalog).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(catalog).toHaveCount(0);
  await expect(page.locator("#widget-power-now")).toBeVisible();
  expect(errors).toEqual([]);
});
