import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("KG keys import privately, show managed storage, and require explicit removal", async ({
  page,
}) => {
  await setup(page, true, false);
  let body: Record<string, unknown> = {};
  await page.route("**/api/device-settings", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: [
          {
            id: "default",
            name: "Dell fixture",
            host: "192.0.2.20",
            port: 623,
            username: "root",
            jetUrl: "",
            kgKeyLocation: "/var/lib/jet-supermicro/settings/.settings-fixture",
          },
        ],
      });
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      json: { error: "Fixture save rejected" },
    });
  });
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("/var/lib/jet-supermicro/settings/.settings-fixture", {
      exact: true,
    }),
  ).toBeVisible();
  const key = page.getByLabel("IPMI KG key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveValue("");
  const save = page.getByRole("button", { name: "Save server & reconnect" });
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Fixture save rejected");
  expect(body).not.toHaveProperty("kgKey");
  expect(body).not.toHaveProperty("kgKeyLocation");
  const file = page.getByLabel("Import KG key file");
  await file.setInputFiles({
    name: "bad.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not-a-key"),
  });
  await expect(page.getByRole("alert")).toContainText("40 hexadecimal");
  await expect(key).toHaveValue("");
  await file.setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(129, 97),
  });
  await expect(page.getByRole("alert")).toContainText("40 hexadecimal");
  await expect(key).toHaveValue("");
  const fixture = "a1".repeat(20);
  await file.setInputFiles({
    name: "key.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(fixture + "\n"),
  });
  await expect(key).toHaveValue(fixture);
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Fixture save rejected");
  expect(body.kgKey).toBe(fixture);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain(fixture);
  await page.getByLabel("Remove saved KG key").check();
  await expect(key).toBeDisabled();
  await expect(key).toHaveValue("");
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Fixture save rejected");
  expect(body.kgKey).toBe("");
  await page.getByLabel("Remove saved KG key").uncheck();
  await page.screenshot({
    path: "test-results/screenshots/kg-settings-fixture.png",
    fullPage: true,
  });
});
