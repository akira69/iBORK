import { test, expect, type Page } from "@playwright/test";
declare global {
  interface Window {
    originalCanvas?: Element;
  }
}
import { dell, rfbServer } from "./vnc-fixture";
const jetKeys = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { telemetry: { hid: number[][] } }
    ).telemetry.hid.filter((p) => p[0] === 2),
  );

async function wall(page: Page, multi = false) {
  const traffic = await rfbServer(page);
  await dell(page);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "dell",
          name: "Dell fixture",
          bmcHost: "192.0.2.10",
          bmcPort: 623,
          hasJetKVM: multi,
          hasVNC: true,
        },
        {
          id: "other",
          name: "Other fixture",
          bmcHost: "192.0.2.11",
          bmcPort: 623,
          hasJetKVM: false,
          hasVNC: true,
        },
      ],
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  return traffic;
}
test("wall_enlarge_back_preserves_clients", async ({ page }) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await page
    .getByRole("region", { name: "Other fixture console tile" })
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect.poll(() => traffic.urls.length).toBe(2);
  await tile.locator("canvas").evaluate((node) => {
    window.originalCanvas = node;
  });
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).click();
  const enlarged = page.getByRole("region", { name: "Enlarged console" });
  await expect(enlarged).toBeVisible();
  expect(
    await enlarged
      .locator("canvas")
      .evaluate((node) => node === window.originalCanvas),
  ).toBe(true);
  await page.getByRole("button", { name: "Back to wall", exact: true }).click();
  expect(
    await tile
      .locator("canvas")
      .evaluate((node) => node === window.originalCanvas),
  ).toBe(true);
  expect(traffic.urls).toHaveLength(2);
  expect(traffic.closed).toBe(0);
  await expect(
    tile.getByRole("button", { name: "Enlarge Dell fixture" }),
  ).toBeFocused();
});

test("wall hover outlines the image and directs typing to one VNC until exit or release", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tiles = page.locator(".wall-tile");
  await page.getByRole("button", { name: "Connect all", exact: true }).click();
  for (const tile of await tiles.all())
    await expect(tile.getByRole("status")).toHaveText("live");
  const first = tiles.first(),
    second = tiles.last();
  const hover = first.getByRole("button", { name: /Enlarge/ });
  await hover.hover();
  await expect(hover).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(hover).toHaveCSS("outline-style", "solid");
  await expect(first.locator("canvas")).toBeFocused();
  await page.keyboard.down("a");
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 1 && m[7] === 97),
    )
    .toBe(true);
  await second.getByRole("button", { name: /Enlarge/ }).hover();
  await expect(second.locator("canvas")).toBeFocused();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 97),
    )
    .toBe(true);
  await page.keyboard.up("a");
  await page.keyboard.press("Shift+Escape");
  await expect(second.locator("canvas")).not.toBeFocused();
  const count = traffic.messages.filter((m) => m[0] === 4).length;
  await page.keyboard.type("ignored");
  expect(traffic.messages.filter((m) => m[0] === 4)).toHaveLength(count);
  await page.getByRole("heading", { name: "KVM Wall", exact: true }).hover();
  await hover.hover();
  await expect(first.locator("canvas")).toBeFocused();
  await page.keyboard.down("b");
  await page.getByRole("heading", { name: "KVM Wall", exact: true }).hover();
  await expect(first.locator("canvas")).not.toBeFocused();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 98),
    )
    .toBe(true);
  await page.keyboard.up("b");
  await page.getByRole("button", { name: "Edit wall layout" }).click();
  await hover.hover({ force: true });
  await expect(first.locator("canvas")).not.toBeFocused();
  const afterEdit = traffic.messages.filter((m) => m[0] === 4).length;
  await page.keyboard.type("ignored");
  expect(traffic.messages.filter((m) => m[0] === 4)).toHaveLength(afterEdit);
  expect(
    traffic.messages.filter((m) => m[0] === 5).every((m) => m[1] === 0),
  ).toBe(true);
});

test("JetKVM wall hover types without a click and releases held keys on exit", async ({
  page,
}) => {
  const { setup } = await import("./fixtures");
  await setup(page, true, true);
  await expect(
    page.getByText("WebRTC connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  const tile = page.locator(".wall-tile").first();
  await expect(tile.getByRole("status")).toHaveText("live");
  const video = tile.locator("video");
  await tile.getByRole("button", { name: /Enlarge/ }).hover();
  await expect(video).toBeFocused();
  await page.keyboard.down("a");
  await expect
    .poll(async () => (await jetKeys(page)).at(-1))
    .toEqual([2, 0, 4]);
  await page.getByRole("heading", { name: "KVM Wall", exact: true }).hover();
  await expect(video).not.toBeFocused();
  await expect.poll(async () => (await jetKeys(page)).at(-1)).toEqual([2, 0]);
  await page.keyboard.up("a");
});

test("hover switches between JetKVM and VNC without a stale blur cancelling the new owner", async ({
  page,
}) => {
  const { setup } = await import("./fixtures");
  await setup(page, true, true);
  const traffic = await wall(page);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "jet",
          name: "Jet fixture",
          bmcHost: "192.0.2.10",
          bmcPort: 623,
          hasJetKVM: true,
          hasVNC: false,
        },
        {
          id: "dell",
          name: "Dell fixture",
          bmcHost: "192.0.2.11",
          bmcPort: 623,
          hasJetKVM: false,
          hasVNC: true,
        },
      ],
    }),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Connect all", exact: true }).click();
  const jet = page.getByRole("region", { name: "Jet fixture console tile" });
  const vnc = page.getByRole("region", { name: "Dell fixture console tile" });
  await expect(jet.getByRole("status")).toHaveText("live");
  await expect(vnc.getByRole("status")).toHaveText("live");
  for (let i = 0; i < 2; i++) {
    await jet.getByRole("button", { name: /Enlarge/ }).hover();
    await expect(jet.locator("video")).toBeFocused();
    await page.keyboard.down("a");
    await expect
      .poll(async () => (await jetKeys(page)).at(-1))
      .toEqual([2, 0, 4]);
    await vnc.getByRole("button", { name: /Enlarge/ }).hover();
    await expect(vnc.locator("canvas")).toBeFocused();
    await expect.poll(async () => (await jetKeys(page)).at(-1)).toEqual([2, 0]);
    await jet
      .locator("video")
      .evaluate((video) =>
        video.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
      );
    await expect(vnc.locator("canvas")).toBeFocused();
    await page.keyboard.up("a");
    await page.keyboard.press("b");
    await expect
      .poll(
        () =>
          traffic.messages.filter(
            (m) => m[0] === 4 && m[1] === 1 && m[7] === 98,
          ).length,
      )
      .toBe(i + 1);
  }
  await jet.getByRole("button", { name: /Enlarge/ }).hover();
  await expect(jet.locator("video")).toBeFocused();
  await page.keyboard.down("c");
  await expect
    .poll(async () => (await jetKeys(page)).at(-1))
    .toEqual([2, 0, 6]);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(jet.locator("video")).not.toBeFocused();
  await expect.poll(async () => (await jetKeys(page)).at(-1)).toEqual([2, 0]);
  await page.keyboard.up("c");
  expect(
    traffic.messages.filter((m) => m[0] === 5).every((m) => m[1] === 0),
  ).toBe(true);
});
test("wall without hover ignores typing and keyboard enlargement sends no opening input", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).focus();
  await page.keyboard.type("ignored");
  expect(traffic.types.filter((t) => t === 4 || t === 5)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Enlarged console" }).locator("canvas"),
  ).toBeFocused();
  expect(traffic.types.filter((t) => t === 4 || t === 5)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => traffic.messages.some((m) => m[0] === 4 && m[7] === 27))
    .toBe(true);
  await page.keyboard.down("a");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 97),
    )
    .toBe(true);
});
test("wall_server_round_trip_reuses_selected_session", async ({ page }) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.locator("canvas").evaluate((node) => {
    window.originalCanvas = node;
  });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Open server", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "iDRAC console widget" }),
  ).toBeVisible();
  expect(
    await page
      .locator("canvas")
      .evaluate((node) => node === window.originalCanvas),
  ).toBe(true);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await expect(tile.getByRole("status")).toHaveText("live");
  expect(traffic.urls).toHaveLength(1);
  expect(traffic.closed).toBe(0);
});

test("wall_preferences_resize_and_mobile_preserve_desktop_geometry", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.locator("canvas").evaluate((node) => {
    window.originalCanvas = node;
  });
  await page
    .getByRole("button", { name: "Edit wall layout", exact: true })
    .click();
  await page.getByLabel("Dell fixture width", { exact: true }).fill("12");
  await page.getByLabel("Dell fixture height", { exact: true }).fill("5");
  await page
    .getByRole("button", { name: "Done editing wall", exact: true })
    .click();
  expect(
    await tile
      .locator("canvas")
      .evaluate((node) => node === window.originalCanvas),
  ).toBe(true);
  const saved = await page.evaluate(() =>
    localStorage.getItem("jet-supermicro:kvm-wall:v1"),
  );
  expect(JSON.parse(saved!).entries[0]).toMatchObject({ w: 12, h: 5 });
  await page.screenshot({
    path: "test-results/screenshots/kvm-wall-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("jet-supermicro:kvm-wall:v1"),
    ),
  ).toBe(saved);
  await expect
    .poll(async () => {
      const a = await tile.boundingBox();
      const b = await page
        .getByRole("region", { name: "Other fixture console tile" })
        .boundingBox();
      return Math.abs(a!.width - b!.width) + Math.abs(a!.x - b!.x);
    })
    .toBeLessThan(2);
  await page.screenshot({
    path: "test-results/screenshots/kvm-wall-mobile.png",
    fullPage: true,
  });
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).click();
  await expect(
    page.getByRole("region", { name: "Enlarged console" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to wall", exact: true }).click();
  expect(traffic.urls).toHaveLength(1);
  await page.reload();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .last()
    .click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("jet-supermicro:kvm-wall:v1"),
    ),
  ).toBe(saved);
});
test("wall_auto_only_runs_on_entry_and_manual_disconnect_suppresses_retry", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("switch", { name: "Auto-connect Dell fixture", exact: true })
    .check();
  expect(traffic.urls).toHaveLength(0);
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Open server", exact: true }).click();
  expect(traffic.urls).toHaveLength(0);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.clock.install();
  await page.clock.fastForward(60000);
  expect(traffic.urls).toHaveLength(1);
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Open server", exact: true }).click();
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await expect.poll(() => traffic.urls.length).toBe(2);
});
test("wall_exclusion_and_source_change_disconnect_before_replacing", async ({
  page,
}) => {
  const traffic = await wall(page, true);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Console source for Dell fixture", { exact: true })
    .selectOption("vnc");
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Console source for Dell fixture", { exact: true })
    .selectOption("jetkvm");
  await expect.poll(() => traffic.closed).toBe(1);
  await page.getByLabel("Include Dell fixture", { exact: true }).uncheck();
  await expect(tile).toHaveCount(0);
  const saved = JSON.parse(
    (await page.evaluate(() =>
      localStorage.getItem("jet-supermicro:kvm-wall:v1"),
    ))!,
  );
  expect(
    saved.entries.find(
      (entry: { deviceId: string }) => entry.deviceId === "dell",
    ),
  ).toMatchObject({ source: "jetkvm", included: false });
});
test("wall_fullscreen_keeps_canvas_and_rejection_is_visible", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.locator("canvas").evaluate((node) => {
    window.originalCanvas = node;
  });
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).click();
  const enlarged = page.getByRole("region", { name: "Enlarged console" });
  await enlarged
    .getByRole("button", { name: "Fullscreen enlarged console", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("wall-enlarged");
  expect(
    await enlarged
      .locator("canvas")
      .evaluate((node) => node === window.originalCanvas),
  ).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = () =>
      Promise.reject(new Error("denied"));
  });
  await enlarged
    .getByRole("button", { name: "Fullscreen enlarged console", exact: true })
    .click();
  await expect(enlarged.getByRole("alert")).toContainText(
    "Fullscreen is unavailable",
  );
  expect(traffic.urls).toHaveLength(1);
});

test("wall failed peer stays isolated and hidden tab releases control", async ({
  page,
}) => {
  const traffic = await wall(page);
  await page.routeWebSocket("**/devices/other/vnc", (socket) =>
    socket.close({ code: 4409, reason: "busy" }),
  );
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  const other = page.getByRole("region", {
    name: "Other fixture console tile",
  });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await expect(other.getByRole("status")).toHaveText("busy");
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).click();
  await page.keyboard.down("a");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 97),
    )
    .toBe(true);
  const count = traffic.messages.filter((m) => m[0] === 4).length;
  await page.keyboard.press("b");
  expect(traffic.messages.filter((m) => m[0] === 4)).toHaveLength(count);
  await page.getByRole("button", { name: "Back to wall", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Edit wall layout" }).click();
  await page.getByRole("button", { name: "Reset wall layout" }).click();
  expect(traffic.closed).toBe(0);
  await page.getByRole("button", { name: "Confirm wall reset" }).click();
  expect(traffic.closed).toBe(0);
  await expect(tile.getByRole("status")).toHaveText("live");
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("jet-supermicro:kvm-wall:v1")!),
  );
  expect(
    stored.entries.every(
      (e: { included: boolean; connect: string }) =>
        e.included && e.connect === "manual",
    ),
  ).toBe(true);
});

test("wall source change cancels connecting credentials and server navigation closes peers", async ({
  page,
}) => {
  const traffic = await wall(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Console source for Dell fixture", { exact: true })
    .selectOption("vnc");
  let finish: (() => Promise<void>) | undefined;
  await page.route(
    "**/devices/dell/vnc/session",
    (route) =>
      new Promise<void>((resolve) => {
        finish = async () => {
          await route
            .fulfill({ json: { password: "testonly" } })
            .catch(() => {});
          resolve();
        };
      }),
  );
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Console source for Dell fixture", { exact: true })
    .selectOption("jetkvm");
  await finish!();
  expect(traffic.urls).toHaveLength(0);
  await page.unroute("**/devices/dell/vnc/session");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Console source for Dell fixture", { exact: true })
    .selectOption("vnc");
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  const other = page.getByRole("region", {
    name: "Other fixture console tile",
  });
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await expect(other.getByRole("status")).toHaveText("live");
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Open server", exact: true }).click();
  await expect.poll(() => traffic.closed).toBe(1);
  expect(traffic.urls).toHaveLength(2);
});

test("wall JetKVM video survives enlargement without forwarding the opening click", async ({
  page,
}) => {
  const { setup } = await import("./fixtures");
  await setup(page, true, true);
  const video = page.getByLabel("Remote server video and keyboard control");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBe(1280);
  await video.evaluate((node) => {
    window.originalCanvas = node;
  });
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  const tile = page.locator(".wall-tile").first();
  await expect(tile.getByRole("status")).toHaveText("live");
  const stats = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            telemetry: { peers: number; closed: number; hid: number[][] };
          }
        ).telemetry,
    );
  const before = (await stats()).hid.length;
  await tile.getByRole("button", { name: /Enlarge/ }).click();
  await expect(video).toBeVisible();
  expect(await video.evaluate((node) => node === window.originalCanvas)).toBe(
    true,
  );
  expect(
    (await stats()).hid
      .slice(before)
      .every(
        (packet) =>
          (packet[0] === 2 && packet.length === 2 && packet[1] === 0) ||
          (packet[0] === 3 && packet[9] === 0),
      ),
  ).toBe(true);
  await video.click();
  await page.keyboard.down("a");
  await page.keyboard.press("Shift+Escape");
  expect((await stats()).hid.filter((p) => p[0] === 2).at(-1)).toEqual([2, 0]);
  await page.getByRole("button", { name: "Back to wall", exact: true }).click();
  expect(await video.evaluate((node) => node === window.originalCanvas)).toBe(
    true,
  );
  expect(await stats()).toMatchObject({ peers: 1, closed: 0 });
});

test("enlarged VNC consumes resume clicks after blur and Shift Escape", async ({
  page,
}) => {
  const traffic = await wall(page);
  const tile = page.getByRole("region", { name: "Dell fixture console tile" });
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tile.getByRole("status")).toHaveText("live");
  await tile.getByRole("button", { name: "Enlarge Dell fixture" }).click();
  const enlarged = page.getByRole("region", { name: "Enlarged console" });
  for (const method of ["blur", "shortcut"]) {
    if (method === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await page.keyboard.press("Shift+Escape");
    await expect(enlarged.getByRole("status")).toContainText("view only");
    const before = traffic.messages.length;
    await enlarged.locator("canvas").click();
    await expect(enlarged.getByRole("status")).toContainText("controlling");
    expect(
      traffic.messages.slice(before).some((m) => m[0] === 5 && m[1] !== 0),
    ).toBe(false);
    await page.keyboard.press("z");
    await expect
      .poll(() =>
        traffic.messages
          .slice(before)
          .some((m) => m[0] === 4 && m[1] === 1 && m[7] === 122),
      )
      .toBe(true);
  }
});

test("opening saved telemetry releases input and preserves an excluded live server until Consoles opens", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  await page.evaluate(() => {
    localStorage.setItem("ibork:wall-view:v1", "Power Overview");
    localStorage.setItem(
      "jet-supermicro:kvm-wall:v1",
      JSON.stringify({
        version: 1,
        automatic: true,
        entries: [
          {
            deviceId: "dell",
            source: "vnc",
            connect: "manual",
            included: false,
            x: 0,
            y: 0,
            w: 6,
            h: 4,
          },
        ],
      }),
    );
  });
  const console = page.getByRole("region", { name: "iDRAC view-only console" });
  await console
    .getByRole("button", { name: "Connect VNC", exact: true })
    .click();
  await expect(console.getByRole("status")).toHaveText("Connected · view only");
  await console
    .getByRole("button", { name: "Control VNC", exact: true })
    .click();
  await page.keyboard.down("a");
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 1 && m[7] === 97),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Power Overview", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 97),
    )
    .toBe(true);
  await page.keyboard.up("a");
  expect(traffic.closed).toBe(0);
  await page.getByRole("button", { name: "Consoles", exact: true }).click();
  await expect.poll(() => traffic.closed).toBe(1);
  expect(traffic.urls).toHaveLength(1);
});
