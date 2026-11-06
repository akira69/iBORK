import { afterEach, expect, it, vi } from "vitest";
import {
  navigationKey,
  defaultDeviceTab,
  supportsTab,
  readNavigation,
  writeNavigation,
} from "../../src/navigation";
import type { Device } from "../../src/device-identity";

const devices: Device[] = [
  {
    id: "first",
    name: "First",
    bmcHost: "192.0.2.1",
    bmcPort: 623,
    hasJetKVM: true,
  },
  {
    id: "second",
    name: "Second",
    bmcHost: "",
    bmcPort: 0,
    hasJetKVM: true,
    hasManagement: false,
  },
];
const fallback = {
  deviceId: "first",
  tab: "Information",
  view: "server",
} as const;
afterEach(() => vi.unstubAllGlobals());

it("opens telemetry-only servers on a supported page and restores their saved sensor view", () => {
  const mini = {
    ...devices[1],
    id: "mini",
    hasJetKVM: false,
    hasSensors: true,
    hasEnergy: false,
  };
  expect(defaultDeviceTab(mini)).toBe("Sensors");
  expect(supportsTab(mini, "Boot")).toBe(false);
  expect(supportsTab(mini, "Console")).toBe(false);
  expect(supportsTab(mini, "Power usage")).toBe(false);
  expect(
    defaultDeviceTab({ ...mini, hasSensors: false, hasEnergy: true }),
  ).toBe("Power usage");
  const saved = { deviceId: "mini", tab: "Sensors", view: "server" };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
  expect(readNavigation([mini])).toEqual(saved);
});

it.each([
  null,
  "{broken",
  "null",
  "[]",
  '"text"',
  "x".repeat(2049),
  JSON.stringify({ deviceId: "first", tab: "Unknown", view: "server" }),
  JSON.stringify({ deviceId: "first", tab: "Console", view: "unknown" }),
  JSON.stringify({ deviceId: "removed", tab: "Console", view: "wall" }),
])("opens Information for missing or invalid saved navigation: %s", (raw) => {
  vi.stubGlobal("localStorage", { getItem: () => raw });
  expect(readNavigation(devices)).toEqual(fallback);
});

it("round trips only navigation choices", () => {
  const values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const saved = {
    deviceId: "second",
    tab: "Server settings",
    view: "wall",
  } as const;
  writeNavigation(saved);
  expect(readNavigation(devices)).toEqual(saved);
  expect([...values.keys()]).toEqual([navigationKey]);
  expect(JSON.parse(values.get(navigationKey))).toEqual(saved);
});

it("does not restore management-only tabs for a standalone KVM", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        deviceId: "second",
        tab: "Sensors",
        view: "server",
      }),
  });
  expect(readNavigation(devices)).toEqual({
    deviceId: "second",
    tab: "Console",
    view: "server",
  });
});

it("survives denied or full storage and an empty device list", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("Storage denied");
    },
    setItem: () => {
      throw Error("Quota exceeded");
    },
  });
  expect(readNavigation(devices)).toEqual(fallback);
  expect(readNavigation([])).toEqual({ ...fallback, deviceId: "" });
  expect(() => writeNavigation(fallback)).not.toThrow();
});
