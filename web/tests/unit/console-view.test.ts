import { expect, it } from "vitest";
import { boundConsoleView } from "../../src/useConsoleZoom";
import { fitWall, readWallPreferences } from "../../src/kvm-wall";

it("clamps zoom and pan so the console cannot be lost outside the viewport", () => {
  expect(boundConsoleView({ scale: 9, x: 9000, y: -9000 }, 400, 300)).toEqual({
    scale: 5,
    x: 800,
    y: -600,
  });
  expect(boundConsoleView({ scale: 0.5, x: 50, y: 50 }, 400, 300)).toEqual({
    scale: 1,
    x: 0,
    y: 0,
  });
});
it("packs 4:3 previews using available width and height without changing selection or connection mode", () => {
  const entries = readWallPreferences(
    Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      name: String(i),
      bmcHost: "",
      bmcPort: 0,
      hasJetKVM: true,
    })),
    { getItem: () => null },
  ).value.entries;
  for (const [width, height] of [
    [2400, 950],
    [1200, 600],
    [390, 600],
  ]) {
    const result = fitWall(entries, width, height);
    expect(result.width).toBeLessThanOrEqual(width);
    for (const item of result.entries) {
      const previewWidth = (result.width * item.w) / 12 - 16;
      const previewHeight = result.cellHeight * item.h - 68;
      expect(previewWidth / previewHeight).toBeCloseTo(4 / 3);
      expect(item.included).toBe(true);
      expect(item.connect).toBe("manual");
    }
  }
});
