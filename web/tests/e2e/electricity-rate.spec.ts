import { expect, test, type Route } from "@playwright/test";
import { setup } from "./fixtures";

test("one confirmed server rate drives costs in an independent browser and survives reload", async ({
  page,
  browser,
  baseURL,
}) => {
  const other = await browser.newContext({ baseURL });
  try {
    const reader = await other.newPage();
    await setup(page, true, false);
    await setup(reader, true, false);
    let usdPerKwh = 0.2;
    let writes = 0,
      reads = 0;
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function handle(route: Route) {
      if (route.request().method() === "PUT") {
        expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
        expect(route.request().postDataJSON()).toEqual({ usdPerKwh: 0 });
        writes++;
        await gate;
        usdPerKwh = 0;
      }
      await route.fulfill({ json: { usdPerKwh } });
    }
    await page.route("**/api/electricity-rate", handle);
    await reader.route("**/api/electricity-rate", (route) => {
      reads++;
      return handle(route);
    });
    await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
    await reader.route("**/api/devices/default/energy", (route) =>
      route.fulfill({
        json: {
          now: 10000,
          source: "Fixture",
          samples: [
            { at: 9940, watts: 100 },
            { at: 10000, watts: 100 },
          ],
        },
      }),
    );
    await reader.addInitScript(() =>
      localStorage.setItem("jet-supermicro:usd-per-kwh:v1", "99"),
    );
    await reader.clock.install();
    await page.reload();
    await Promise.all([
      reader.waitForResponse("**/api/electricity-rate"),
      reader.reload(),
    ]);
    const initialReads = reads;
    await reader
      .getByRole("button", { name: "Power usage", exact: true })
      .click();
    await expect(reader.getByTestId("daily-projection")).toHaveText("$0.48");
    expect(reads).toBe(initialReads);
    const input = page.getByLabel("Electricity rate · $/kWh");
    const save = page.getByRole("button", { name: "Save electricity rate" });
    await expect(input).toHaveValue("0.2");
    await input.fill("");
    await expect(save).toBeDisabled();
    await input.fill("1000.01");
    await expect(save).toBeDisabled();
    await input.fill("0");
    expect(writes).toBe(0);
    await save.click();
    await expect(
      page.getByRole("button", { name: "Saving rate…" }),
    ).toBeDisabled();
    await expect(reader.getByTestId("daily-projection")).toHaveText("$0.48");
    release!();
    await expect(page.getByText("Electricity rate saved.")).toBeVisible();
    const readsBeforeRefresh = reads;
    await reader.clock.fastForward(30001);
    await expect(reader.getByTestId("daily-projection")).toHaveText("$0.00");
    expect(reads).toBe(readsBeforeRefresh + 1);
    await reader.reload();
    await expect(reader.getByTestId("daily-projection")).toHaveText("$0.00");
    await page.reload();
    await expect(input).toHaveValue("0");
    expect(writes).toBe(1);
  } finally {
    await other.close();
  }
});

test("a failed or invalid rate read leaves costs unavailable while measured energy stays visible", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices/default/energy", (route) =>
    route.fulfill({
      json: {
        now: 10000,
        source: "Fixture",
        samples: [
          { at: 9940, watts: 100 },
          { at: 10000, watts: 100 },
        ],
      },
    }),
  );
  let invalid = false;
  await page.route("**/api/electricity-rate", (route) =>
    invalid
      ? route.fulfill({ json: { usdPerKwh: null } })
      : route.abort("timedout"),
  );
  await page.reload();
  await page.getByRole("button", { name: "Power usage", exact: true }).click();
  await expect(page.getByTestId("daily-projection")).toHaveText("—");
  await expect(page.getByTestId("energy-cost-0")).toHaveText("—");
  await expect(
    page.getByRole("row", { name: /Measured energy/ }),
  ).toContainText("0.0017 kWh");
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load the electricity rate",
  );
  invalid = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.getByRole("alert")).toContainText("Invalid rate received");
  await expect(
    page.getByRole("button", { name: "Save electricity rate" }),
  ).toBeDisabled();
});
