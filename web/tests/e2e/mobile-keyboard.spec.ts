import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";
import { dell, rfbServer } from "./vnc-fixture";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe("phone browser focus", () => {
  test.use({ isMobile: true });
  for (const source of ["jet", "vnc"])
    test(`${source} pinch and pan enlarge text without remote mouse input`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        browserName !== "chromium",
        "Real multi-touch injection uses Chromium CDP",
      );
      const traffic = source === "vnc" ? await rfbServer(page) : null;
      if (traffic) {
        await dell(page);
        await page
          .getByRole("button", { name: "Connect VNC", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Control VNC", exact: true }),
        ).toBeEnabled();
      } else await setup(page, true, true);
      await page
        .getByRole("button", { name: "Show keyboard", exact: true })
        .tap();
      const display =
        source === "vnc"
          ? page.getByLabel("Remote display").locator("canvas")
          : page.getByLabel("Remote server video and keyboard control");
      await expect(
        page.locator(".mobile-console-view:popover-open"),
      ).toBeVisible();
      await page.waitForTimeout(100);
      const inputCount = async () =>
        traffic
          ? traffic.messages.filter((m) => m[0] === 5).length
          : page.evaluate(
              () =>
                (window as unknown as { telemetry: { hid: number[][] } })
                  .telemetry.hid.length,
            );
      const before = await inputCount();
      const cdp = await page.context().newCDPSession(page);
      const rect = (await display.boundingBox())!;
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      const points = (spread: number) => [
        { x: x - spread, y, id: 0 },
        { x: x + spread, y, id: 1 },
      ];
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: points(40),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(100),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect
        .poll(() =>
          display.evaluate(
            (node) => new DOMMatrix(getComputedStyle(node).transform).a,
          ),
        )
        .toBeGreaterThan(2);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 0 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - 50, y: y - 80, id: 0 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect
        .poll(() =>
          display.evaluate(
            (node) => new DOMMatrix(getComputedStyle(node).transform).f,
          ),
        )
        .toBeLessThan(-50);
      expect(await inputCount()).toBe(before);
      await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
      await page
        .getByRole("button", { name: "Fit console", exact: true })
        .tap();
      await expect(display).toHaveCSS("transform", "none");
      await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
      await expect(page.locator(".mobile-console-view")).toHaveCount(0);
      if (traffic) expect(traffic.urls).toHaveLength(1);
      await cdp.detach();
    });
  test("VNC takeover fits its canvas and native Done restores the widget", async ({
    page,
  }) => {
    const traffic = await rfbServer(page);
    await dell(page);
    await page.getByRole("button", { name: "Connect VNC", exact: true }).tap();
    await expect(
      page.getByRole("status").filter({ hasText: "Connected" }),
    ).toBeVisible();
    const canvas = page.getByLabel("Remote display").locator("canvas");
    await canvas.evaluate((node) => {
      (window as unknown as { originalCanvas: Element }).originalCanvas = node;
    });
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    await expect(
      page.locator(".mobile-console-view:popover-open"),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: 420,
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(async () => {
        const box = (await canvas.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(364);
    await page.getByLabel("Remote keyboard input").blur();
    await expect(page.locator(".mobile-console-view")).toHaveCount(0);
    expect(
      await canvas.evaluate(
        (node) =>
          node ===
          (window as unknown as { originalCanvas: Element }).originalCanvas,
      ),
    ).toBe(true);
    expect(traffic.urls).toHaveLength(1);
  });
  test("live video remains fully visible above the phone keyboard", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Windows WebKit has no live WebRTC fixture",
    );
    await setup(page, true, true);
    const video = page.getByLabel("Remote server video and keyboard control");
    await expect
      .poll(() => video.evaluate((node: HTMLVideoElement) => node.videoHeight))
      .toBe(720);
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: 420,
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(async () => {
        const box = (await video.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(364);
    await expect(video).toHaveCSS("object-fit", "contain");
    expect((await video.boundingBox())!.height).toBeGreaterThan(200);
    expect((await video.boundingBox())!.width).toBeGreaterThan(300);
    expect((await video.boundingBox())!.y).toBeGreaterThanOrEqual(64);
    await page.screenshot({
      path: "test-results/screenshots/mobile-takeover-fixture.png",
      clip: { x: 0, y: 0, width: 390, height: 420 },
    });
  });
  test("typing takes over the visible screen and Done restores the same console", async ({
    page,
  }) => {
    await setup(page, true, true, false);
    const video = page.getByLabel("Remote server video and keyboard control");
    const original = await video.boundingBox();
    await video.evaluate((node) => {
      (window as unknown as { originalDisplay: Element }).originalDisplay =
        node;
    });
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    await expect(
      page.locator(".mobile-console-view:popover-open"),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: 420,
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(async () => {
        const box = (await video.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(364);
    const keys = (await page
      .getByLabel("Server keyboard controls")
      .boundingBox())!;
    expect(keys.y + keys.height).toBeLessThanOrEqual(
      (await video.boundingBox())!.y,
    );
    await page.getByRole("button", { name: "Tab", exact: true }).tap();
    await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
    await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
    await expect(page.locator(".mobile-console-view")).toHaveCount(0);
    expect(
      await video.evaluate(
        (node) =>
          node ===
          (window as unknown as { originalDisplay: Element }).originalDisplay,
      ),
    ).toBe(true);
    expect(await video.boundingBox()).toEqual(original);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { telemetry: { peers: number } }).telemetry
            .peers,
      ),
    ).toBe(1);
  });
  test("Tab keeps native typing focused and sends one remote Tab", async ({
    page,
  }) => {
    await setup(page, true, true, false);
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    const field = page.getByLabel("Remote keyboard input");
    const before = (await reports(page)).length;
    await page.getByRole("button", { name: "Tab", exact: true }).tap();
    await expect(field).toBeFocused();
    await page.keyboard.insertText("a");
    expect(
      (await reports(page))
        .slice(before)
        .filter((r) => r[0] === 2 && r.length > 2),
    ).toEqual([
      [2, 0, 43],
      [2, 0, 4],
    ]);
  });
  test("server-key taps restore typing when the browser focuses the button", async ({
    page,
  }) => {
    await setup(page, true, true, false);
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    const tab = page.getByRole("button", { name: "Tab", exact: true });
    // Model a browser transferring focus before dispatching the tap's click.
    await tab.focus();
    await tab.tap();
    await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
    await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
    await expect(page.getByLabel("Remote keyboard input")).not.toBeFocused();
  });
});

for (const viewport of [
  { width: 320, height: 700 },
  { width: 844, height: 390 },
]) {
  test(`server keys stay one compact row at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page, true, true, false);
    const originalWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    const bar = page.getByLabel("Server keyboard controls");
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(52);
    await page.getByRole("button", { name: "Ctrl", exact: true }).tap();
    const next = page.getByRole("button", { name: /Next key row/ });
    await next.tap();
    await expect(
      page.getByRole("button", { name: "ArrowLeft", exact: true }),
    ).toBeVisible();
    await next.tap();
    await page.getByRole("button", { name: "F1", exact: true }).tap();
    expect(await reports(page)).toContainEqual([2, 1, 58]);
    await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
    await page.getByRole("button", { name: "F12", exact: true }).tap();
    expect(await reports(page)).toContainEqual([2, 0, 69]);
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(52);
    const bounds = (await bar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(originalWidth);
    await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
    await expect(page.getByLabel("Remote keyboard input")).not.toBeFocused();
    await expect(bar).toHaveCount(0);
  });
}
async function input(page: Page, text: string, inputType = "insertText") {
  await page.getByLabel("Remote keyboard input").evaluate(
    (node, { text, inputType }) => {
      const field = node as HTMLTextAreaElement;
      field.value = " " + text;
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType }),
      );
    },
    { text, inputType },
  );
}
async function reports(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { telemetry: { hid: number[][] } }).telemetry.hid,
  );
}
test("JetKVM touch opens phone input and server keys send complete chords", async ({
  page,
}) => {
  await setup(page, true, true, false);
  const video = page.getByLabel("Remote server video and keyboard control");
  await expect(
    page.getByText("WebRTC connected", { exact: true }),
  ).toBeVisible();
  await video.tap();
  await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
  expect(
    (await reports(page)).filter(
      (report) => report[0] === 3 && report[9] !== 0,
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Ctrl", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: "Ctrl", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await input(page, "c");
  await expect(
    page.getByRole("button", { name: "Ctrl", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(await reports(page)).toContainEqual([2, 1, 6]);
  await page.getByRole("button", { name: "Esc", exact: true }).tap();
  expect(await reports(page)).toContainEqual([2, 0, 41]);
  await input(page, "", "deleteContentBackward");
  expect(await reports(page)).toContainEqual([2, 0, 42]);
  await input(page, "\n", "insertLineBreak");
  expect(await reports(page)).toContainEqual([2, 0, 40]);
  expect((await reports(page)).at(-1)).toEqual([2, 0]);
  await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
  await expect(page.getByLabel("Remote keyboard input")).not.toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("VNC native input and Ctrl chord use the existing focused session", async ({
  page,
}) => {
  const traffic = await rfbServer(page);
  await dell(page);
  await page.getByRole("button", { name: "Connect VNC", exact: true }).tap();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toBeVisible();
  await page.getByLabel("Remote display").locator("canvas").tap();
  await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
  await page.getByRole("button", { name: "Ctrl", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: "Ctrl", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await input(page, "c");
  await expect
    .poll(() => traffic.messages.filter((m) => m[0] === 4).length)
    .toBe(4);
  const keys = traffic.messages
    .filter((m) => m[0] === 4)
    .map((m) => [m[1], Buffer.from(m).readUInt32BE(4)]);
  expect(keys).toEqual([
    [1, 0xffe3],
    [1, 99],
    [0, 99],
    [0, 0xffe3],
  ]);
  expect(traffic.urls).toHaveLength(1);
  expect(traffic.messages.filter((m) => m[0] === 5 && m[1] !== 0)).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
  await page.getByLabel("Remote display").locator("canvas").tap();
  await expect
    .poll(() => traffic.messages.filter((m) => m[0] === 5 && m[1] !== 0).length)
    .toBeGreaterThan(0);
});

test("first native character and repeated backspace have no extra spaces", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  const before = (await reports(page)).length;
  await page.keyboard.insertText("a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  const pressed = (await reports(page))
    .slice(before)
    .filter((report) => report[0] === 2 && report.length > 2)
    .map((report) => report[2]);
  expect(pressed).toEqual([4, 42, 42]);
});

test("iPhone VNC server Alt sends Alt rather than a local Option remapping", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "iPhone" }),
  );
  const traffic = await rfbServer(page);
  await dell(page);
  await page.getByRole("button", { name: "Connect VNC", exact: true }).tap();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await page.getByRole("button", { name: "Alt", exact: true }).tap();
  await page.getByRole("button", { name: "Tab", exact: true }).tap();
  await expect
    .poll(() =>
      traffic.messages
        .filter((m) => m[0] === 4)
        .map((m) => [m[1], Buffer.from(m).readUInt32BE(4)]),
    )
    .toEqual([
      [1, 0xffe9],
      [1, 0xff09],
      [0, 0xff09],
      [0, 0xffe9],
    ]);
});

test("hiding the keyboard cancels composition and late commits", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  const field = page.getByLabel("Remote keyboard input");
  await field.evaluate((node) => {
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    (node as HTMLTextAreaElement).value = " pending";
  });
  await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
  const before = (await reports(page)).length;
  await field.evaluate((node) =>
    node.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "pending",
      }),
    ),
  );
  await input(page, "late");
  expect((await reports(page)).length).toBe(before);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await page.keyboard.insertText("a");
  expect(
    (await reports(page))
      .slice(before)
      .filter((r) => r[0] === 2 && r.length > 2),
  ).toEqual([[2, 0, 4]]);
});

test("switching from physical input to phone input releases held modifiers", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
  await page.keyboard.down("ControlLeft");
  expect((await reports(page)).at(-1)).toEqual([2, 1]);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await page.keyboard.up("ControlLeft");
  await page.keyboard.insertText("a");
  expect((await reports(page)).filter((r) => r[0] === 2).slice(-2)).toEqual([
    [2, 0, 4],
    [2, 0],
  ]);
  const traffic = await rfbServer(page);
  await dell(page);
  await page.getByRole("button", { name: "Connect VNC", exact: true }).tap();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Control VNC", exact: true }).tap();
  await page.keyboard.down("ControlLeft");
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await page.keyboard.up("ControlLeft");
  await page.keyboard.insertText("a");
  await expect
    .poll(() =>
      traffic.messages
        .filter((m) => m[0] === 4)
        .map((m) => [m[1], Buffer.from(m).readUInt32BE(4)]),
    )
    .toEqual([
      [1, 0xffe3],
      [0, 0xffe3],
      [1, 97],
      [0, 97],
    ]);
});

test("composition commits once, invalid text is atomic, and disconnect cancels input", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  const field = page.getByLabel("Remote keyboard input");
  await field.evaluate((node) => {
    const input = node as HTMLTextAreaElement;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = " ok";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true, data: "ok" }),
    );
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "ok" }),
    );
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "ok",
        inputType: "insertFromComposition",
      }),
    );
  });
  expect(
    (await reports(page)).filter(
      (report) => report[0] === 2 && report[2] === 18,
    ),
  ).toHaveLength(1);
  const before = (await reports(page)).length;
  await input(page, "bad😀");
  await expect(page.getByRole("alert")).toContainText("US keyboard");
  expect((await reports(page)).length).toBe(before);
  await field.evaluate((node) =>
    node.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await page
    .getByRole("button", { name: "Disconnect console", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  const after = (await reports(page)).length;
  await input(page, "x");
  expect((await reports(page)).length).toBe(after);
});

test("mobile wall enlargement and fullscreen keep keyboard controls usable", async ({
  page,
}) => {
  await setup(page, true, true, false);
  await page
    .getByRole("button", { name: "KVM Wall", exact: true })
    .first()
    .tap();
  await page
    .getByRole("button", { name: /Enlarge/ })
    .first()
    .tap();
  const video = page.getByLabel("Remote server video and keyboard control");
  await video.tap();
  await expect(page.getByLabel("Remote keyboard input")).toBeFocused();
  await page.getByRole("button", { name: "Shift", exact: true }).tap();
  await input(page, "a");
  expect(await reports(page)).toContainEqual([2, 2, 4]);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 430,
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(
      async () =>
        (await page.getByLabel("Server keyboard controls").boundingBox())!.y +
        (await page.getByLabel("Server keyboard controls").boundingBox())!
          .height,
    )
    .toBeLessThanOrEqual(430);
  await page.evaluate(() => {
    delete (window.visualViewport as unknown as { height?: number }).height;
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await page.screenshot({
    path: "test-results/screenshots/mobile-keyboard-fixture.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Done — hide keyboard" }).tap();
  await page
    .getByRole("button", { name: "Fullscreen console", exact: true })
    .tap();
  await page.getByRole("button", { name: "Show keyboard" }).tap();
  await expect(
    page
      .locator(":fullscreen")
      .getByRole("button", { name: "Ctrl", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 420,
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => {
      const box = (await video.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(364);
  expect((await video.boundingBox())!.y).toBeGreaterThanOrEqual(64);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".mobile-console-view")).toHaveCount(0);
  await expect(page.getByLabel("Server keyboard controls")).toHaveCount(0);
});
