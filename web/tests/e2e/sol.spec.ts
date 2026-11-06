import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("SOL connects explicitly, streams input, fits resize and retains its transport across tabs", async ({
  page,
}) => {
  const urls: string[] = [];
  const input: string[] = [];
  let closed = 0;
  await page.routeWebSocket("**/sol", (socket) => {
    urls.push(socket.url());
    socket.onMessage((data) => {
      input.push(String(data));
    });
    socket.onClose(() => {
      closed++;
    });
    socket.send(Buffer.from("fixture serial console\r\nlogin: "));
  });
  await setup(page, true, false);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  const console = page.getByRole("region", { name: "Serial over LAN console" });
  await expect(console).toBeVisible();
  expect(urls).toEqual([]);
  await console
    .getByRole("button", { name: "Connect SOL", exact: true })
    .click();
  await expect(console.getByRole("status")).toHaveText(
    "Receiving console output",
  );
  expect(urls).toEqual([
    `ws://${new URL(page.url()).host}/api/devices/default/sol`,
  ]);
  await console.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("operator");
  await expect.poll(() => input.join("")).toBe("operator");
  await console.locator(".xterm-helper-textarea").evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "x".repeat(4097));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect(console.getByRole("alert")).toContainText("Input is too large");
  expect(input.join("")).toBe("operator");
  const before = await console.locator(".xterm-screen").boundingBox();
  await page.setViewportSize({ width: 1050, height: 800 });
  await expect
    .poll(
      async () => (await console.locator(".xterm-screen").boundingBox())?.width,
    )
    .toBeLessThan(before!.width);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .last()
    .click();
  await expect(console).toBeHidden();
  await page.keyboard.type("hidden");
  expect(input.join("")).toBe("operator");
  expect(closed).toBe(0);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await expect(console).toBeVisible();
  expect(urls).toHaveLength(1);
  await console
    .getByRole("button", { name: "Disconnect SOL", exact: true })
    .click();
  await expect.poll(() => closed).toBe(1);
  await expect(console.getByRole("status")).toHaveText("Disconnected");
});

test("SOL bounds unexpected oversized console output", async ({ page }) => {
  await page.routeWebSocket("**/sol", (socket) => {
    socket.send(Buffer.alloc(4097));
  });
  await setup(page, true, false);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  const console = page.getByRole("region", { name: "Serial over LAN console" });
  await console
    .getByRole("button", { name: "Connect SOL", exact: true })
    .click();
  await expect(console.getByRole("alert")).toContainText(
    "output exceeded its buffer limit",
  );
  await expect(console.getByRole("status")).toHaveText("Disconnected");
});

test("SOL reports a failed connection and can reconnect without automatic activation", async ({
  page,
}) => {
  let attempts = 0;
  await page.routeWebSocket("**/sol", (socket) => {
    attempts++;
    socket.close({ code: 1011, reason: "SOL unavailable" });
  });
  await setup(page, true, false);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  const console = page.getByRole("region", { name: "Serial over LAN console" });
  const connect = console.getByRole("button", {
    name: "Connect SOL",
    exact: true,
  });
  await connect.click();
  await expect(console.getByRole("alert")).toContainText("SOL disconnected");
  await expect(connect).toBeEnabled();
  expect(attempts).toBe(1);
  await connect.click();
  await expect.poll(() => attempts).toBe(2);
});
