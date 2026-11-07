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
  it("interpolates staggered readings, sums recorded intervals and splits changing contributors", () => {
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
        { at: 100, watts: 0 },
        { at: 150, watts: 50 },
      ],
      [
        { at: 150, watts: 150 },
        { at: 200, watts: 200 },
      ],
      [
        { at: 200, watts: 100 },
        { at: 250, watts: 100 },
        { at: 400, watts: 100 },
      ],
      [
        { at: 400, watts: 140 },
        { at: 460, watts: 140 },
      ],
    ]);
    expect(group.coveredSeconds).toBe(360);
    expect(group.contributors).toEqual([["a"], ["a", "b"], ["b"], ["a", "b"]]);
    expect(group.serverSeconds).toBe(470);
    expect(group.coverage).toBeCloseTo(470 / 7200, 10);
    expect(group.historyIds).toEqual(["a", "b"]);
    expect([group.minReporting, group.maxReporting]).toEqual([1, 2]);
    expect(fleetHistory(["a", "b"], map, 3600, 3602000).coveredSeconds).toBe(0);
    expect(group.kwh).toBeCloseTo(
      (50 * 100 + 40 * 60 + 100 * 310) / 3600000,
      10,
    );
    const partial = fleetHistory(["a", "b", "removed"], map, 3600);
    expect(partial.lines).toEqual(group.lines);
    expect(partial.coverage).toBeCloseTo(470 / 10800, 10);
    expect(partial.kwh).toBe(group.kwh);
    expect(fleetHistory(["a", "b"], map, 30).coveredSeconds).toBe(30);
  });
  it("breaks the chart when equally sized contributor sets change", () => {
    const result = fleetHistory(
      ["a", "b"],
      new Map([
        [
          "a",
          read(
            [
              [100, 10],
              [200, 10],
            ],
            300,
          ),
        ],
        [
          "b",
          read(
            [
              [200, 20],
              [300, 20],
            ],
            300,
          ),
        ],
      ]),
      200,
    );
    expect(result.lines).toEqual([
      [
        { at: 100, watts: 10 },
        { at: 200, watts: 10 },
      ],
      [
        { at: 200, watts: 20 },
        { at: 300, watts: 20 },
      ],
    ]);
    expect(result.contributors).toEqual([["a"], ["b"]]);
    expect(result.coverage).toBe(0.5);
    expect(result.kwh).toBeCloseTo(3000 / 3600000, 10);
  });
  it("counts zero as coverage, clips the requested window and retains old history after collection fails", () => {
    const a = {
      ...read(
        [
          [100, 0],
          [200, 0],
        ],
        250,
      ),
      error: "Request timed out",
    };
    const b = read(
      [
        [100, 20],
        [200, 40],
      ],
      250,
    );
    const result = fleetHistory(
      ["a", "b", "a", "missing"],
      new Map([
        ["a", a],
        ["b", b],
      ]),
      100,
    );
    expect(result.lines).toEqual([
      [
        { at: 150, watts: 30 },
        { at: 200, watts: 40 },
      ],
    ]);
    expect(result.serverSeconds).toBe(100);
    expect(result.coverage).toBeCloseTo(1 / 3, 10);
    expect(result.kwh).toBeCloseTo(1750 / 3600000, 10);
    expect(result.total).toBe(3);
    expect(sampleStatus(a, 2000).watts).toBeNull();
    expect(
      fleetHistory(["a"], new Map([["a", a]]), 3600, 200000).serverSeconds,
    ).toBe(100);
  });
  it("leaves outages empty and rejects future, isolated and invalid samples", () => {
    const result = fleetHistory(
      ["a", "single", "future"],
      new Map([
        [
          "a",
          read(
            [
              [100, 10],
              [200, 10],
              [351, 10],
              [400, 10],
              [401, 100],
            ],
            400,
          ),
        ],
        ["single", read([[200, 10]], 400)],
        [
          "future",
          read(
            [
              [401, 100],
              [450, 100],
            ],
            400,
          ),
        ],
      ]),
      300,
    );
    expect(result.lines).toEqual([
      [
        { at: 100, watts: 10 },
        { at: 200, watts: 10 },
      ],
      [
        { at: 351, watts: 10 },
        { at: 400, watts: 10 },
      ],
    ]);
    expect(result.serverSeconds).toBe(149);
    expect(result.coverage).toBeCloseTo(149 / 900, 10);
    expect(result.historyIds).toEqual(["a"]);
    for (const samples of [
      [],
      [[200, 10]],
      [
        [401, 10],
        [450, 10],
      ],
      [
        [100, -1],
        [200, 10],
      ],
      [
        [100, NaN],
        [200, 10],
      ],
    ]) {
      const empty = fleetHistory(
        ["a"],
        new Map([["a", read(samples, 400)]]),
        300,
      );
      expect(empty.lines).toEqual([]);
      expect(empty.serverSeconds).toBe(0);
      expect(empty.kwh).toBe(0);
    }
  });
  it("measures three full histories out of four as 75% coverage", () => {
    const samples = Array.from({ length: 37 }, (_, i) => [i * 100, 100]);
    const result = fleetHistory(
      ["a", "b", "c", "missing"],
      new Map(["a", "b", "c"].map((id) => [id, read(samples, 3600)])),
      3600,
    );
    expect(result.coverage).toBe(0.75);
    expect(result.serverSeconds).toBe(10800);
    expect(result.coveredSeconds).toBe(3600);
    expect(result.kwh).toBeCloseTo(0.3, 10);
    expect(result.historyIds).toHaveLength(3);
    expect([result.minReporting, result.maxReporting]).toEqual([3, 3]);
    expect(fleetHistory([], new Map(), 3600).coverage).toBe(0);
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
