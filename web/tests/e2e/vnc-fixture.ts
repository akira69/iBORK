import { expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";
export async function dell(page: Page) {
  await page.addInitScript(() => {
    const Original = WebSocket;
    // noVNC checks immediate own properties; Playwright puts mock methods deeper in the prototype chain.
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        for (const key of [
          "send",
          "close",
          "binaryType",
          "onerror",
          "onmessage",
          "onopen",
          "onclose",
          "protocol",
          "readyState",
        ]) {
          let parent = Object.getPrototypeOf(this);
          while (parent) {
            const descriptor = Object.getOwnPropertyDescriptor(parent, key);
            if (descriptor) {
              Object.defineProperty(this, key, {
                ...descriptor,
                enumerable: true,
              });
              break;
            }
            parent = Object.getPrototypeOf(parent);
          }
        }
      }
    };
  });
  await setup(page, true, false);
  await page.route("**/api/devices", (route) =>
    route.fulfill({
      json: [
        {
          id: "dell",
          name: "Dell fixture",
          bmcHost: "192.0.2.10",
          bmcPort: 623,
          hasJetKVM: false,
          hasVNC: true,
        },
        {
          id: "other",
          name: "Other fixture",
          bmcHost: "192.0.2.11",
          bmcPort: 623,
          hasJetKVM: false,
          hasVNC: false,
        },
      ],
    }),
  );
  await page.route("**/vnc/session", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ json: { password: "testonly" } });
  });
  await page.evaluate(() =>
    localStorage.setItem(
      "ibork:navigation:v1",
      JSON.stringify({
        deviceId: "dell",
        tab: "Console",
        view: "server",
      }),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "iDRAC console widget" }),
  ).toBeVisible();
}

export async function rfbServer(page: Page, reject = false) {
  const traffic = {
    urls: [] as string[],
    types: [] as number[],
    messages: [] as number[][],
    closed: 0,
    shared: [] as number[],
    encodings: [] as number[][],
  };
  await page.routeWebSocket("**/vnc", (socket) => {
    traffic.urls.push(socket.url());
    let stage = 0;
    socket.onClose(() => traffic.closed++);
    socket.onMessage((message) => {
      const bytes = Buffer.from(message);
      if (stage === 0) {
        expect(bytes.toString()).toBe("RFB 003.008\n");
        socket.send(Buffer.from([1, 2]));
      } else if (stage === 1) {
        expect([...bytes]).toEqual([2]);
        socket.send(Buffer.alloc(16, 1));
      } else if (stage === 2) {
        expect(bytes.length).toBe(16);
        socket.send(
          Buffer.from(
            reject
              ? [0, 0, 0, 1, 0, 0, 0, 6, ...Buffer.from("denied")]
              : [0, 0, 0, 0],
          ),
        );
      } else if (stage === 3) {
        traffic.shared.push(bytes[0]);
        const init = Buffer.alloc(24);
        init.writeUInt16BE(640, 0);
        init.writeUInt16BE(360, 2);
        init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
        socket.send(init);
        const update = Buffer.alloc(16 + 640 * 360 * 4);
        update[3] = 1;
        update.writeUInt16BE(640, 8);
        update.writeUInt16BE(360, 10);
        for (let i = 16; i < update.length; i += 4)
          update.set([40, 160, 80, 0], i);
        socket.send(update);
        // A remote clipboard update must never touch the browser clipboard.
        socket.send(
          Buffer.from([3, 0, 0, 0, 0, 0, 0, 6, ...Buffer.from("remote")]),
        );
      } else {
        traffic.types.push(bytes[0]);
        traffic.messages.push([...bytes]);
        if (bytes[0] === 2)
          traffic.encodings.push(
            Array.from({ length: bytes.readUInt16BE(2) }, (_, i) =>
              bytes.readInt32BE(4 + i * 4),
            ),
          );
      }
      stage++;
    });
    socket.send(Buffer.from("RFB 003.008\n"));
  });
  return traffic;
}
