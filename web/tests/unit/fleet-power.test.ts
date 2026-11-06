import { describe, expect, it } from "vitest";
import {
  fleetHistory,
  fleetPower,
  sampleStatus,
  type FleetReading,
} from "../../src/fleet-power";
import { parseLayout } from "../../src/dashboard-layout";
const read = (samples: number[][], now = 1000): FleetReading => ({
  received: 2000,
  data: {
    samples: samples.map(([at, watts]) => ({ at, watts })),
    now,
    source: "fixture",
  },
});
describe("fleet coverage", () => {
  it("counts zero, deduplicates hosts and drops failed, stale and future readings using service time", () => {
    const a = read([[1000, 80]]),
      b = read([[851, 120]]);
    const map = new Map([
      ["a", a],
      ["b", b],
    ]);
    expect(fleetPower(["a", "b", "a", "unmetered"], map, 2000)).toEqual({
      watts: 200,
      reporting: 2,
      total: 3,
    });
    expect(sampleStatus(b, 3000).watts).toBe(120);
    expect(sampleStatus(b, 4000).watts).toBeNull();
    map.set("a", { ...a, error: "network failure" });
    map.set("b", { ...b, data: { ...b.data!, error: "collector failed" } });
    expect(fleetPower(["a", "b"], map, 2000)).toEqual({
      watts: null,
      reporting: 0,
      total: 2,
    });
    map.set("a", read([[1000, 0]]));
    expect(fleetPower(["a", "b"], map, 2000)).toEqual({
      watts: 0,
      reporting: 1,
      total: 2,
    });
    expect(sampleStatus(read([[1001, 3]]), 9000).watts).toBeNull();
    const storage = { ...a, data: { ...a.data!, storageError: "disk full" } };
    expect(sampleStatus(storage, 2000).watts).toBe(80);
  });
  it("interpolates staggered readings, charges only common time and splits at an outage", () => {
    const a = read(
      [
        [100, 0],
        [200, 100],
        [400, 40],
        [460, 40],
      ],
      460,
    );
    const b = read(
      [
        [150, 100],
        [250, 100],
        [400, 100],
        [460, 100],
      ],
      460,
    );
    const map = new Map([
      ["a", a],
      ["b", b],
    ]);
    const group = fleetHistory(["a", "b", "a"], map, 3600);
    expect(group.lines).toEqual([
      [
        { at: 150, watts: 150 },
        { at: 200, watts: 200 },
      ],
      [
        { at: 400, watts: 140 },
        { at: 460, watts: 140 },
      ],
    ]);
    expect(group.coveredSeconds).toBe(110);
    expect(fleetHistory(["a", "b"], map, 3600, 3602000).coveredSeconds).toBe(0);
    expect(group.kwh).toBeCloseTo((175 * 50 + 140 * 60) / 3600000, 10);
    expect(fleetHistory(["a", "b", "removed"], map, 3600).lines).toEqual([]);
    expect(fleetHistory(["a", "b"], map, 30).coveredSeconds).toBe(30);
  });
  it("validates persisted group identities and sensor scope", () => {
    const w = {
      id: "custom",
      kind: "power-now",
      deviceIds: ["a", "b"],
      x: 0,
      y: 0,
      w: 4,
      h: 4,
    };
    const parse = (patch: object) =>
      parseLayout(
        JSON.stringify({ version: 1, widgets: [{ ...w, ...patch }] }),
      );
    expect(parse({})?.widgets[0]).toEqual(w);
    for (const patch of [
      { deviceIds: [] },
      { deviceIds: ["a", "a"] },
      { deviceIds: ["../a"] },
      { kind: "sensor", sensorId: "rpm" },
      { kind: "vnc" },
      { id: "power-now" },
    ])
      expect(parse(patch)).toBeNull();
  });
});
