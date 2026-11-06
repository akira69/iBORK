import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";

for (const source of ["glinet", "vnc"]) {
  test(`${source} settings show only applicable controls and local dismissible feedback`, async ({
    page,
  }) => {
    await setup(page, true, false);
    const config = {
      deviceId: "default",
      serverName: "Console fixture",
      bmcHost: "",
      bmcPort: 0,
      jetUrl: "",
      timeoutSeconds: 1,
      ...(source === "glinet"
        ? { glUrl: "https://192.0.2.8", glUsername: "admin" }
        : { vncHost: "192.0.2.8", vncPort: 5900, vncTransport: "tls" }),
    };
    await page.route("**/api/devices", (route) =>
      route.fulfill({
        json: [
          {
            id: "default",
            name: "Console fixture",
            bmcHost: "",
            bmcPort: 0,
            hasManagement: false,
            hasJetKVM: false,
            hasVNC: source === "vnc",
            consoleSources: [source],
          },
        ],
      }),
    );
    await page.route("**/api/devices/default/config", (route) =>
      route.fulfill({ json: config }),
    );
    await page.route("**/api/device-settings", (route) =>
      route.fulfill({
        json: [
          {
            ...config,
            id: "default",
            name: "Console fixture",
            host: "",
            port: 0,
            username: "",
          },
        ],
      }),
    );
    await page.reload();
    if (source === "glinet") {
      await expect(
        page.getByText("Your dashboard is empty. Add a widget to get started."),
      ).toHaveCount(0);
      await expect(
        page.locator(".tiny-chip").getByText("GL.iNet Comet", { exact: true }),
      ).toBeVisible();
    }
    await page
      .getByRole("button", { name: "Server settings", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Test IPMI", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Test JetKVM", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Console compatibility", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('img[src*="jetkvm"]:visible')).toHaveCount(0);
    const connections = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Connections", exact: true }),
    });
    const path = source === "glinet" ? "glkvm/status" : "vnc/status";
    const testConnection = connections.getByRole("button", {
      name: source === "glinet" ? "Test GL.iNet Comet" : "Test VNC",
      exact: true,
    });
    await page.route(`**/api/devices/default/${path}`, (route) =>
      route.fulfill({
        json: {
          message: "Login verified. Video and keyboard control are not tested.",
        },
      }),
    );
    await testConnection.click();
    await expect(connections.getByRole("status")).toContainText(
      "Login verified",
    );
    await expect(connections.getByRole("status")).toHaveCSS(
      "color",
      "rgb(176, 235, 209)",
    );
    await expect(connections.getByRole("alert")).toHaveCount(0);
    await page.route(`**/api/devices/default/${path}`, (route) =>
      route.fulfill({
        status: 502,
        json: { error: "Fixture connection failed" },
      }),
    );
    await connections
      .getByRole("button", {
        name: source === "glinet" ? "Test GL.iNet Comet" : "Test VNC",
        exact: true,
      })
      .click();
    await expect(connections.getByRole("alert")).toContainText(
      "Fixture connection failed",
    );
    await connections
      .getByRole("button", { name: "Dismiss connection result" })
      .click();
    await expect(connections.getByRole("alert")).toHaveCount(0);
    if (source === "glinet") {
      await page
        .getByLabel("How to find the Comet certificate fingerprint")
        .click();
      await expect(page.getByRole("tooltip")).toContainText(
        "Certificate, not Public Key",
      );
      await expect(page.getByRole("tooltip")).toContainText(
        "64 hexadecimal characters",
      );
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const geometry = await page.getByRole("tooltip").evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            inside:
              rect.left >= 8 &&
              rect.top >= 8 &&
              rect.right <= innerWidth - 8 &&
              rect.bottom <= innerHeight - 8,
            unclipped: element.contains(
              document.elementFromPoint(rect.right - 4, rect.bottom - 4),
            ),
            font: getComputedStyle(element).fontFamily,
            size: parseFloat(getComputedStyle(element).fontSize),
          };
        });
        expect(geometry.inside).toBe(true);
        expect(geometry.unclipped).toBe(true);
        expect(geometry.font).toContain("monospace");
        expect(geometry.size).toBeLessThanOrEqual(12);
        await page.screenshot({
          path: `test-results/screenshots/certificate-help-${width}.png`,
        });
      }
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.screenshot({
        path: "test-results/screenshots/comet-settings-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: "test-results/screenshots/comet-settings-mobile.png",
        fullPage: true,
      });
    }
    await connections
      .getByRole("button", {
        name: source === "glinet" ? "Test GL.iNet Comet" : "Test VNC",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Console", exact: true }).click();
    await expect(page.getByText("Fixture connection failed")).toHaveCount(0);
    await page
      .getByRole("button", { name: "iBORK settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "KVM-only servers" }),
    ).toHaveCount(0);
  });
}

for (const timeout of [false, true]) {
  test(`connection save ${timeout ? "reports a bounded reload timeout" : "reloads while signed in"}`, async ({
    page,
  }) => {
    await setup(page, true, false);
    await page
      .getByRole("button", { name: "Server settings", exact: true })
      .click();
    await page.clock.install();
    let saved = false;
    let probes = 0;
    await page.route("**/api/device-settings", (route) => {
      if (route.request().method() === "GET") return route.fallback();
      saved = true;
      return route.fulfill({ json: { saved: true, signInRequired: false } });
    });
    await page.route("**/api/session", (route) => {
      if (!saved) return route.fallback();
      probes++;
      if (timeout || probes === 1)
        return route.fulfill({ status: 503, json: { error: "Reloading" } });
      return route.fulfill({ json: { csrf: "fixture" } });
    });
    await page.getByRole("button", { name: "Save server & reconnect" }).click();
    await expect(
      page.getByRole("button", { name: "Saved · reconnecting…" }),
    ).toBeVisible();
    await page.clock.runFor(600);
    await expect.poll(() => probes).toBeGreaterThan(0);
    if (timeout) {
      await page.clock.runFor(21000);
      await expect(page.getByRole("alert")).toContainText(
        "Settings saved. Reload the page to reconnect",
      );
    } else {
      const navigation = page.waitForEvent(
        "framenavigated",
        (frame) => frame === page.mainFrame(),
      );
      await page.clock.runFor(1000);
      await navigation;
      await expect(
        page.getByRole("button", { name: "Server settings", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toHaveCount(0);
    }
  });
}
