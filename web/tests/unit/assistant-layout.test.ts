import { expect, it } from "vitest";
import { arrange } from "../../src/assistant-layout";
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
