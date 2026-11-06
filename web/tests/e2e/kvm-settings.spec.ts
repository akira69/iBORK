import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

for (const source of [
  "JetKVM",
  "Dell iDRAC VNC",
  "Generic VNC",
  "GL.iNet Comet Pro",
]) {
  test(`add standalone ${source} without IPMI fields`, async ({ page }) => {
    await setup(page, true, false);
    await page.route("**/api/device-settings", (route) =>
      route.fulfill({ json: [] }),
    );
    await page
      .getByRole("button", { name: "iBORK settings", exact: true })
      .first()
      .click();
    await page.getByText("Add server", { exact: true }).first().click();
    await page
      .getByRole("combobox", { name: "Device type", exact: true })
      .selectOption("standalone");
    await page
      .getByRole("combobox", { name: "Console provider", exact: true })
      .selectOption({ label: source });
    await expect(page.getByLabel("BMC address", { exact: true })).toHaveCount(
      0,
    );
    await page
      .getByLabel("Server name", { exact: true })
      .fill("Fixture console");
    if (source === "JetKVM") {
      await page
        .getByLabel("JetKVM address", { exact: true })
        .fill("http://192.0.2.8");
      await page
        .getByLabel("This JetKVM is configured without a password")
        .check();
    } else if (source === "GL.iNet Comet Pro") {
      await page
        .getByLabel("Comet address", { exact: true })
        .fill("https://192.0.2.8");
      await page
        .getByLabel("Comet password", { exact: true })
        .fill("fixture-secret");
      await page
        .getByLabel("Comet certificate SHA256", { exact: true })
        .fill("a".repeat(64));
      await expect(
        page.getByText(
          "Live video and keyboard control use the pinned connection. HDMI must be active for video.",
          { exact: true },
        ),
      ).toBeVisible();
    } else {
      await page.getByLabel("VNC host", { exact: true }).fill("192.0.2.8");
      await page.getByLabel("VNC password", { exact: true }).fill("testpass");
      if (source === "Generic VNC") {
        await page
          .getByRole("combobox", { name: "VNC transport", exact: true })
          .selectOption("tcp");
        await expect(page.getByText(/Plaintext TCP exposes/)).toBeVisible();
      } else
        await page
          .getByLabel("VNC certificate SHA256", { exact: true })
          .fill("a".repeat(64));
    }
    let sent: Record<string, unknown> | undefined;
    await page.route("**/api/device-settings", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { saved: true, signInRequired: false } });
    });
    await page.getByRole("button", { name: "Save server & reconnect" }).click();
    await expect.poll(() => sent?.host).toBe("");
    expect(sent?.port).toBe(0);
    expect(sent?.username).toBe("");
    expect(sent?.password).toBeUndefined();
    expect(sent?.kgKey).toBeUndefined();
  });
}

test("empty inventory keeps app settings and add connection available", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/device-settings", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "iBORK Settings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Device type", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Dashboard login password" }),
  ).toBeVisible();
});

test("standalone removal requires visible confirmation and sends no secrets", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/device-settings", (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          name: "Jet fixture",
          host: "",
          port: 0,
          username: "",
          jetUrl: "http://192.0.2.8",
        },
      ],
    }),
  );
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  let request: unknown;
  await page.route("**/api/device-settings", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    request = route.request().postDataJSON();
    return route.fulfill({ json: { saved: true, signInRequired: false } });
  });
  await page.getByRole("button", { name: "Remove standalone KVM" }).click();
  expect(request).toBeUndefined();
  await page.getByRole("button", { name: "Cancel removal" }).click();
  expect(request).toBeUndefined();
  await page.getByRole("button", { name: "Remove standalone KVM" }).click();
  await page
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect
    .poll(() => request)
    .toEqual({ id: "default", confirm: "default" });
});
