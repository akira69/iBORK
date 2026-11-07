import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ScopedKVM } from "../../src/ScopedKVM";
import type { Device } from "../../src/device-identity";

const store = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock("../../src/ConsoleSessions", () => ({
  useConsoleSessions: () => ({ store }),
  useConsoleSnapshot: () => ({ phase: "disconnected" }),
  ConsoleSlot: ({ sessionKey }: { sessionKey: string }) => (
    <div data-session={sessionKey} />
  ),
}));
const device: Device = {
  id: "rack-a",
  name: "Rack A",
  bmcHost: "",
  bmcPort: 0,
  hasManagement: false,
  hasJetKVM: false,
  consoleSources: ["glinet"],
};
beforeEach(() => vi.clearAllMocks());
it("mounts an available KVM-only console without opening a connection", () => {
  const html = renderToStaticMarkup(
    <ScopedKVM device={device} kind="glinet" />,
  );
  expect(html).toContain('data-session="rack-a:glinet"');
  expect(html).toContain(">Connect<");
  expect(html).toContain(">Disconnect<");
  expect(store.connect).not.toHaveBeenCalled();
  expect(store.disconnect).not.toHaveBeenCalled();
});
it("does not mount any console surface or controls while editing or previewing", () => {
  const html = renderToStaticMarkup(
    <ScopedKVM device={device} kind="glinet" editing />,
  );
  expect(html).toContain("disabled while editing");
  expect(html).not.toContain("data-session");
  expect(html).not.toContain("<button");
  expect(store.connect).not.toHaveBeenCalled();
});
it("handles removed servers and unavailable providers without console controls", () => {
  for (const current of [undefined, device]) {
    const html = renderToStaticMarkup(
      <ScopedKVM device={current} kind="vnc" />,
    );
    expect(html).toContain("Console unavailable");
    expect(html).not.toContain("<button");
  }
});
