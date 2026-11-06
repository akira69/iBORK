import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

test("standalone consoles never poll IPMI or offer management widgets", async ({
  page,
}) => {
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "standalone",
          name: "Standalone JetKVM",
          bmcHost: "",
          bmcPort: 0,
          hasManagement: false,
          hasJetKVM: true,
          consoleSources: ["jetkvm"],
        },
      ],
    }),
  );
  await page.route("**/api/devices/standalone/config", (route) =>
    route.fulfill({
      json: {
        deviceId: "standalone",
        serverName: "Standalone JetKVM",
        bmcHost: "",
        bmcPort: 0,
        jetUrl: "http://192.0.2.8",
        timeoutSeconds: 10,
      },
    }),
  );
  const management: string[] = [];
  page.on("request", (r) => {
    if (
      /\/devices\/standalone\/(power|energy|sensors|inventory|events|cooling|sol|diagnostics)(\?|$)/.test(
        r.url(),
      )
    )
      management.push(r.url());
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Select Standalone JetKVM", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Standalone JetKVM", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sensors", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#widget-power-control")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  const catalog = page.getByRole("region", { name: "Widget catalog" });
  await expect(
    catalog.getByRole("button", { name: "Sensor reading", exact: true }),
  ).toHaveCount(0);
  expect(management).toEqual([]);
});
