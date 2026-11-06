import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

const defaults = [
  { start: 60, brightness: 0 },
  { start: 300, brightness: 25 },
  { start: 420, brightness: 100 },
  { start: 1140, brightness: 25 },
];

test("four panel periods retain drafts on conflict and use the freshly loaded revision after saving", async ({
  page,
}) => {
  await setup(page, true, false);
  let revision = 1,
    periods = defaults;
  const writes: number[] = [];
  await page.route("**/api/panel-display", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { revision, periods } });
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    const body = route.request().postDataJSON();
    writes.push(body.revision);
    if (body.revision !== revision)
      return route.fulfill({
        status: 409,
        json: { error: "Schedule changed" },
      });
    periods = body.periods;
    revision += 3;
    return route.fulfill({ json: { ok: true } });
  });
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  const card = page.getByRole("region", { name: "Display settings" });
  const start = card.getByLabel("Start time");
  const mode = card.getByRole("combobox", { name: "Display", exact: true });
  const save = card.getByRole("button", { name: "Save display schedule" });
  await expect(start).toHaveCount(4);
  await expect(mode.nth(0)).toHaveValue("0");
  await expect(mode.nth(1)).toHaveValue("dim");
  await expect(mode.nth(2)).toHaveValue("100");
  await start.first().fill("05:00");
  await save.click();
  await expect(card.getByRole("alert")).toContainText("different start time");
  expect(writes).toEqual([]);
  await start.first().fill("22:40");
  revision = 2;
  await save.click();
  await expect(card.getByRole("alert")).toContainText("changed elsewhere");
  await expect(start.first()).toHaveValue("22:40");
  await expect(save).toBeDisabled();
  await card.getByRole("button", { name: "Discard edits and reload" }).click();
  await expect(start.first()).toHaveValue("01:00");
  await start.first().fill("23:15");
  await mode.first().selectOption("dim");
  const dim = card.getByRole("spinbutton").first();
  await dim.fill("100");
  await save.click();
  expect(writes).toEqual([1]);
  await dim.fill("63");
  await save.click();
  await expect(save).toBeEnabled();
  await expect(card.getByRole("status")).toContainText("saved");
  expect(periods).toEqual([
    { start: 1395, brightness: 63 },
    ...defaults.slice(1),
  ]);
  await save.click();
  await expect(save).toBeEnabled();
  expect(writes).toEqual([1, 2, 5]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await card.screenshot({
    path: test.info().outputPath("display-settings-390.png"),
  });
});

test("empty fleet hides disabled panels and recovers from load and save failures", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.reload();
  await expect(
    page.getByText("No devices saved.", { exact: false }),
  ).toBeVisible();
  const card = page.getByRole("region", { name: "Display settings" });
  await expect(card).toHaveCount(0);
  let fail = true;
  await page.route("**/api/panel-display", (route) =>
    fail || route.request().method() === "PUT"
      ? route.abort("timedout")
      : route.fulfill({ json: { revision: 1, periods: defaults } }),
  );
  await page.reload();
  await expect(card.getByRole("alert")).toContainText("Could not load");
  fail = false;
  await card.getByRole("button", { name: "Retry loading schedule" }).click();
  await card.getByRole("button", { name: "Save display schedule" }).click();
  await expect(card.getByRole("alert")).toContainText("Could not confirm");
  await expect(
    card.getByRole("button", { name: "Save display schedule" }),
  ).toBeEnabled();
});

test("publish copies custom, preset and initials icons with bounded JPEGs and Unicode labels", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: ["Supermicro", "Dell T320", "Archive"].map((name, i) => ({
        id: String(i),
        name,
        bmcHost: "",
        bmcPort: 623,
        hasJetKVM: false,
      })),
    }),
  );
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 1, 1);
    localStorage.setItem(
      "jet-supermicro:display:v1:device:0",
      JSON.stringify({
        icon: "custom",
        iconImage: canvas.toDataURL(),
        iconText: "NAS",
      }),
    );
    localStorage.setItem(
      "jet-supermicro:display:v1:device:2",
      JSON.stringify({ name: "Vault🌙7", icon: "initials", pinned: false }),
    );
  });
  await page.route("**/api/panel-display", (route) =>
    route.fulfill({ json: { revision: 1, periods: defaults } }),
  );
  let fail = true;
  await page.route("**/api/panel-icons", (route) =>
    fail ? route.abort("timedout") : route.fulfill({ json: { ok: true } }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .click();
  const copy = page.getByRole("button", {
    name: "Copy sidebar icons to panel",
  });
  await copy.click();
  await expect(page.getByRole("alert")).toContainText("Could not copy");
  fail = false;
  const sent = page.waitForRequest("**/api/panel-icons");
  await copy.click();
  const request = await sent;
  expect(request.method()).toBe("PUT");
  expect(request.headers()["x-csrf-token"]).toBe("fixture");
  const icons: {
    id: string;
    label: string;
    image: string;
    detailImage: string;
  }[] = request.postDataJSON().icons;
  expect(icons.map(({ id, label }) => [id, label])).toEqual([
    ["0", "NAS"],
    ["1", "T320"],
    ["2", "Vault🌙"],
  ]);
  expect(new Set(icons.map((icon) => icon.image)).size).toBe(3);
  for (const icon of icons) {
    for (const [image, size, limit] of [
      [icon.image, 40, 2048],
      [icon.detailImage, 80, 8192],
    ] as const) {
      expect(Buffer.from(image, "base64").length).toBeLessThanOrEqual(limit);
      expect(image).toMatch(/^\/9j\//);
      expect(
        await page.evaluate(async (data) => {
          const img = new Image();
          img.src = "data:image/jpeg;base64," + data;
          await img.decode();
          return [img.width, img.height];
        }, image),
      ).toEqual([size, size]);
    }
  }
  await expect(
    page.getByText("Sidebar icons and labels copied to the panel settings."),
  ).toBeVisible();
});
