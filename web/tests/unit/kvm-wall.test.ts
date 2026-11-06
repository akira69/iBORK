import { describe, it, expect } from "vitest";
import {
  readWallPreferences,
  writeWallPreferences,
  type WallPreferences,
} from "../../src/kvm-wall";
import type { Device } from "../../src/device-identity";
const devices: Device[] = [
  {
    id: "one",
    name: "One",
    bmcHost: "",
    bmcPort: 0,
    hasJetKVM: true,
    hasVNC: true,
  },
  {
    id: "two",
    name: "Two",
    bmcHost: "",
    bmcPort: 0,
    hasJetKVM: false,
    hasVNC: true,
  },
  {
    id: "ipmi",
    name: "IPMI",
    bmcHost: "192.0.2.1",
    bmcPort: 623,
    hasJetKVM: false,
  },
];
const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
describe("wall preferences", () => {
  it("preserves the fitted width for manual editing and ignores invalid saved widths", () => {
    const value = readWallPreferences(devices, { getItem: () => null }).value;
    value.automatic = false;
    value.gridWidth = 988.53125;
    let raw = "";
    expect(
      writeWallPreferences(value, {
        setItem: (_key, data) => {
          raw = data;
        },
      }),
    ).toBe("");
    expect(
      readWallPreferences(devices, { getItem: () => raw }).value.gridWidth,
    ).toBe(value.gridWidth);
    for (const gridWidth of [0, -1, 20000, "988", null]) {
      expect(
        readWallPreferences(devices, storage({ ...value, gridWidth })).value
          .gridWidth,
      ).toBeUndefined();
    }
  });
  it("defaults included and Manual with JetKVM preferred", () => {
    const result = readWallPreferences(devices, { getItem: () => null });
    expect(
      result.value.entries.map((e) => [
        e.deviceId,
        e.source,
        e.connect,
        e.included,
      ]),
    ).toEqual([
      ["one", "jetkvm", "manual", true],
      ["two", "vnc", "manual", true],
    ]);
  });
  it("ignores removed devices and resets unavailable sources", () => {
    const value = readWallPreferences(devices, { getItem: () => null }).value;
    value.entries[0].source = "glinet";
    value.entries[1].deviceId = "removed";
    const result = readWallPreferences(devices, storage(value));
    expect(result.value.entries[0].source).toBe("jetkvm");
    expect(result.value.entries[1].deviceId).toBe("two");
    expect(result.warning).toBeTruthy();
  });
  it("rejects duplicate IDs, excess entries and nonfinite or out of bounds geometry", () => {
    for (const mutation of [
      (v: WallPreferences) => v.entries.push(v.entries[0]),
      (v: WallPreferences) => (v.entries = Array(17).fill(v.entries[0])),
      (v: WallPreferences) => (v.entries[0].x = -1),
      (v: WallPreferences) => (v.entries[0].w = 13),
      (v: WallPreferences) => (v.entries[0].h = 25),
      (v: WallPreferences) => (v.entries[0].h = NaN),
      (v: WallPreferences) => (v.entries[0].y = 201),
    ]) {
      const value = readWallPreferences(devices, { getItem: () => null }).value;
      mutation(value);
      expect(readWallPreferences(devices, storage(value)).warning).toBeTruthy();
    }
  });
  it("bounds restores and reports denied or full storage without writing on load", () => {
    expect(
      readWallPreferences(devices, { getItem: () => " ".repeat(65537) })
        .warning,
    ).toBeTruthy();
    expect(
      readWallPreferences(devices, {
        getItem: () => {
          throw Error("denied");
        },
      }).warning,
    ).toBeTruthy();
    const value = readWallPreferences(devices, { getItem: () => null }).value;
    expect(
      writeWallPreferences(value, {
        setItem: () => {
          throw Error("full");
        },
      }),
    ).toBeTruthy();
  });
  it("writes only the approved nonsecret DTO", () => {
    const value = readWallPreferences(devices, { getItem: () => null }).value;
    Object.assign(value.entries[0], {
      url: "secret-url",
      password: "secret-password",
    });
    let encoded = "";
    expect(
      writeWallPreferences(value, {
        setItem: (_key, data) => {
          encoded = data;
        },
      }),
    ).toBe("");
    expect(encoded).not.toContain("secret");
    expect(
      readWallPreferences(devices, { getItem: () => encoded }).value,
    ).toEqual(readWallPreferences(devices, { getItem: () => null }).value);
  });
});
