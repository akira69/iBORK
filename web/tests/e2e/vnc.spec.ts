import { expect, test } from "@playwright/test";
import { dell, rfbServer } from "./vnc-fixture";

test("VNC explicitly connects, decodes video, scales and stays view only", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const console = page.getByRole("region", { name: "iDRAC view-only console" });
  for (const name of [
    "Connect VNC",
    "Control VNC",
    "Disconnect VNC",
    "Fullscreen VNC",
  ]) {
    const button = console.getByRole("button", { name, exact: true });
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveAttribute("title", /.+/);
    await expect(button).toHaveText("");
  }
  const appFont = await page
    .locator("body")
    .evaluate((element) => getComputedStyle(element).fontFamily);
  await expect(console.getByRole("status")).toHaveCSS("font-family", appFont);
  await expect(console.getByRole("status")).toHaveCSS("font-size", "12px");
  expect(traffic.urls).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        readText: () => {
          throw new Error("Unexpected clipboard read");
        },
        writeText: () => {
          throw new Error("Unexpected clipboard write");
        },
      },
    });
  });
  await console
    .getByRole("button", { name: "Connect VNC", exact: true })
    .click();
  await expect(console.getByRole("status")).toHaveText("Connected · view only");
  await console.screenshot({
    path: "test-results/screenshots/vnc-controls-updated.png",
  });
  await expect(
    page.locator(".workspace-title").getByLabel("KVM: Online", { exact: true }),
  ).toBeVisible();
  const canvas = console.locator("canvas");
  await expect
    .poll(() =>
      canvas.evaluate((node: HTMLCanvasElement) => [
        ...node.getContext("2d")!.getImageData(20, 20, 1, 1).data,
      ]),
    )
    .toEqual([40, 160, 80, 255]);
  expect(traffic.urls).toEqual([
    `ws://${new URL(page.url()).host}/api/devices/dell/vnc`,
  ]);
  expect(traffic.shared).toEqual([1]);
  expect(traffic.encodings).toHaveLength(1);
  expect(traffic.encodings[0]).toEqual(expect.arrayContaining([7, 0]));
  expect(traffic.encodings[0]).not.toContain(-260);
  await canvas.click();
  await canvas.focus();
  await page.keyboard.type("never send keys");
  await canvas.hover();
  await page.mouse.wheel(0, 50);
  await canvas.evaluate((node) => {
    const data = new DataTransfer();
    data.setData("text/plain", "never send clipboard");
    node.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  const before = await canvas.boundingBox();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await page.getByLabel("iDRAC console width").fill("6");
  await expect
    .poll(async () => (await canvas.boundingBox())!.width)
    .toBeLessThan(before!.width);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await console.getByRole("button", { name: "Fullscreen VNC" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("vnc-console");
  await page.evaluate(() => document.exitFullscreen());
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await page.keyboard.type("hidden");
  await expect.poll(() => traffic.closed).toBe(1);
  await page
    .getByRole("button", { name: "iBORK settings", exact: true })
    .first()
    .click();
  await expect(
    page
      .locator(".workspace-title")
      .getByLabel("KVM: Offline", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back to server" }).click();
  await page.getByRole("button", { name: "Console", exact: true }).click();
  expect(traffic.urls).toHaveLength(1);
  expect(traffic.types.filter((kind) => [4, 5, 6, 251].includes(kind))).toEqual(
    [],
  );
  await expect(console.getByRole("status")).toHaveText("Disconnected");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("testonly");
  expect(errors).toEqual([]);
});

test("VNC authentication failure reports a safe error and never retries", async ({
  page,
}) => {
  const traffic = await rfbServer(page, true);
  await dell(page);
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "VNC authentication failed",
  );
  await expect(
    page.getByRole("button", { name: "Connect VNC", exact: true }),
  ).toBeEnabled();
  expect(traffic.urls).toHaveLength(1);
});

test("switching devices closes VNC and hides unavailable widgets", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect(
    page.getByText("Connected · view only", { exact: true }),
  ).toBeVisible();
  await page.locator(".server-quicklinks button").last().click();
  await expect.poll(() => traffic.closed).toBe(1);
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "iDRAC console", exact: true }),
  ).toHaveCount(0);
});

test("disconnect cancels delayed credentials before a websocket opens", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/vnc/session", async (route) => {
    requested = true;
    await response;
    await route.fulfill({ json: { password: "testonly" } });
  });
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page
    .getByRole("button", { name: "Disconnect VNC", exact: true })
    .click();
  release();
  await expect(
    page.getByRole("button", { name: "Connect VNC", exact: true }),
  ).toBeEnabled();
  expect(traffic.urls).toEqual([]);
});

test("VNC handshake timeout releases the transport without reconnecting", async ({
  page,
}) => {
  let closed = 0;
  await page.routeWebSocket("**/vnc", (socket) =>
    socket.onClose(() => closed++),
  );
  await dell(page);
  await page.clock.install();
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect(page.locator(".vnc-screen canvas")).toHaveCount(1);
  await page.clock.fastForward(15001);
  await expect(page.getByRole("alert")).toContainText("timed out");
  await expect.poll(() => closed).toBe(1);
});

test("VNC control releases held keys and pointer before returning to view only", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  const panel = page.getByRole("region", { name: "iDRAC view-only console" });
  await panel.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Connected");
  await panel.getByRole("button", { name: "Control VNC", exact: true }).click();
  const canvas = panel.locator("canvas");
  await expect(canvas).toBeFocused();
  await page.keyboard.down("a");
  await canvas.hover();
  await page.mouse.down();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 1 && m[7] === 97),
    )
    .toBe(true);
  await expect
    .poll(() => traffic.messages.some((m) => m[0] === 5 && m[1] === 1))
    .toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    panel.getByRole("button", { name: "Control VNC", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 97),
    )
    .toBe(true);
  await expect
    .poll(() => traffic.messages.filter((m) => m[0] === 5).at(-1)?.[1])
    .toBe(0);
  const count = traffic.types.filter((t) => t === 4 || t === 5).length;
  await page.keyboard.up("a");
  await page.mouse.up();
  await page.keyboard.type("ignored");
  expect(traffic.types.filter((t) => t === 4 || t === 5)).toHaveLength(count);
  await panel.getByRole("button", { name: "Control VNC", exact: true }).click();
  await page.keyboard.down("b");
  await page.keyboard.press("Shift+Escape");
  await expect(
    panel.getByRole("button", { name: "Control VNC", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 98),
    )
    .toBe(true);
  expect(
    traffic.messages.some((m) => m[0] === 4 && m[6] === 255 && m[7] === 27),
  ).toBe(false);
  expect(traffic.types).not.toContain(6);
  expect(traffic.types).not.toContain(251);
});
for (const action of ["release", "disconnect", "edit", "hide"]) {
  test(`VNC releases held input on ${action}`, async ({ page }) => {
    const traffic = await rfbServer(page);
    await dell(page);
    const panel = page.getByRole("region", { name: "iDRAC view-only console" });
    await panel
      .getByRole("button", { name: "Connect VNC", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText("Connected");
    await panel
      .getByRole("button", { name: "Control VNC", exact: true })
      .click();
    await page.keyboard.down("c");
    await panel.locator("canvas").hover();
    await page.mouse.down();
    if (action === "hide") {
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } else {
      const button =
        action === "edit"
          ? page.getByRole("button", { name: "Edit layout", exact: true })
          : panel.getByRole("button", {
              name: action === "release" ? "Release control" : "Disconnect VNC",
              exact: true,
            });
      await button.evaluate((node: HTMLButtonElement) => node.click());
    }
    await expect
      .poll(() =>
        traffic.messages.some((m) => m[0] === 4 && m[1] === 0 && m[7] === 99),
      )
      .toBe(true);
    await expect
      .poll(() => traffic.messages.filter((m) => m[0] === 5).at(-1)?.[1])
      .toBe(0);
    await expect(
      panel.getByRole("button", { name: "Release control", exact: true }),
    ).toHaveCount(0);
    if (action === "disconnect")
      await expect.poll(() => traffic.closed).toBe(1);
    expect(traffic.types).not.toContain(6);
    expect(traffic.types).not.toContain(251);
  });
}
for (const [code, message] of [
  [4403, "certificate rejected"],
  [4409, "busy"],
  [4401, "authentication"],
  [4406, "Unsupported VNC authentication"],
] as const) {
  test(`VNC terminal close ${code} never retries`, async ({ page }) => {
    let connections = 0;
    await page.routeWebSocket("**/vnc", (socket) => {
      connections++;
      socket.close({ code, reason: "Fixture rejection" });
    });
    await dell(page);
    await page.clock.install();
    await page
      .getByRole("button", { name: "Connect VNC", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(message);
    await page.clock.fastForward(60000);
    expect(connections).toBe(1);
  });
}

test("unsupported VNC authentication stops without retry", async ({ page }) => {
  let attempts = 0;
  await page.routeWebSocket("**/vnc", (socket) => {
    attempts++;
    socket.onMessage(() => socket.send(Buffer.from([1, 99])));
    socket.send(Buffer.from("RFB 003.008\n"));
  });
  await dell(page);
  await page.clock.install();
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    /unsupported.*authentication/i,
  );
  await page.clock.fastForward(60000);
  expect(attempts).toBe(1);
});

test("VNC network close before handshake remains retryable", async ({
  page,
}) => {
  let attempts = 0;
  await page.routeWebSocket("**/vnc", (socket) => {
    attempts++;
    socket.close({ code: 1011, reason: "temporary" });
  });
  await dell(page);
  await page.clock.install();
  await page.getByRole("button", { name: "Connect VNC", exact: true }).click();
  await expect.poll(() => attempts).toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: "Reconnecting" }),
  ).toBeVisible();
  await page.clock.fastForward(1000);
  await expect.poll(() => attempts).toBe(2);
});
