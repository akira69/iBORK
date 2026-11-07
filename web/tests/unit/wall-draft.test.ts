import { expect, it } from "vitest";
import {
  wallDashboard,
  applyWallDashboard,
  type WallPreferences,
} from "../../src/kvm-wall";
const value: WallPreferences = {
  version: 1,
  automatic: true,
  entries: [
    {
      deviceId: "a",
      source: "jetkvm",
      connect: "auto",
      included: true,
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    },
    {
      deviceId: "b",
      source: "vnc",
      connect: "manual",
      included: false,
      x: 6,
      y: 0,
      w: 6,
      h: 4,
    },
  ],
};
it("applies wall geometry without changing sources, inclusion or connection settings", () => {
  const layout = wallDashboard(value);
  layout.widgets[0].y = 4;
  const next = applyWallDashboard(value, layout);
  expect(next.entries[0]).toEqual({ ...value.entries[0], y: 4 });
  expect(next.entries[1]).toEqual(value.entries[1]);
  expect(next.automatic).toBe(false);
  expect(value.automatic).toBe(true);
});
