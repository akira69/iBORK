import { expect, it, vi } from "vitest";
import { arrange, previewLayout } from "../../src/assistant-layout";
import { dashboardKey, type Device } from "../../src/device-identity";
import { type DashboardLayout } from "../../src/dashboard-layout";
const target: DashboardLayout = {
  version: 1,
  widgets: [
    { id: "health", kind: "health", x: 0, y: 7, w: 4, h: 3 },
    { id: "temp", kind: "sensor", sensorId: "cpu", x: 0, y: 14, w: 3, h: 3 },
  ],
};
it("closes gaps and preserves target widget identities", () => {
  const tidy = arrange(target);
  expect(tidy.widgets.map((w) => w.y)).toEqual([0, 3]);
  const source: DashboardLayout = {
    version: 1,
    widgets: [{ id: "health", kind: "health", x: 7, y: 0, w: 5, h: 4 }],
  };
  const copy = arrange(target, source);
  expect(copy.widgets[0]).toMatchObject({ x: 7, w: 5, h: 4 });
  expect(copy.widgets[1]).toEqual(target.widgets[1]);
  expect(target.widgets[0].y).toBe(7);
});

it("copies each sensor slot once while keeping destination IDs and bindings", () => {
  const sensor = target.widgets[1];
  const source: DashboardLayout = {
    version: 1,
    widgets: [
      { ...sensor, id: "shared", x: 0, y: 0 },
      { ...sensor, id: "source-only", x: 3, y: 1, w: 5, h: 4 },
    ],
  };
  const local = {
    ...sensor,
    id: "local",
    sensorMode: "fixed" as const,
    sensorIds: ["fan", "psu"],
  };
  const shared = { ...sensor, id: "shared", sensorId: "ambient" };
  const extra = { ...sensor, id: "extra", y: 22 };
  expect(
    arrange({ version: 1, widgets: [local, shared, extra] }, source).widgets,
  ).toEqual([
    { ...local, x: 3, y: 1, w: 5, h: 4 },
    { ...shared, x: 0, y: 0 },
    extra,
  ]);
});

it("copies the Comet geometry shown for a saved legacy console", () => {
  const source: Device = {
    id: "old",
    name: "source",
    bmcHost: "",
    bmcPort: 0,
    hasManagement: false,
    hasJetKVM: false,
    consoleSources: ["glinet"],
  };
  const dest = { ...source, id: "new" };
  const layout = {
    version: 1,
    widgets: [{ id: "jetkvm", kind: "jetkvm", x: 2, y: 1, w: 10, h: 5 }],
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === dashboardKey(source) ? JSON.stringify(layout) : null,
  });
  try {
    expect(previewLayout(source, dest).changes).toEqual([
      { ...layout.widgets[0], kind: "glinet", id: "glinet" },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
