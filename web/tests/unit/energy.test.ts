import { expect, it } from "vitest";
import { summarize, tariff, forecast } from "../../src/energy";
const start = 1800000000;
it("integrates 100W for one hour to 0.1kWh and $0.018", () => {
  const points = Array.from({ length: 61 }, (_, i) => ({
    at: start + i * 60,
    watts: 100,
  }));
  const result = summarize(points, start + 3600, 3600);
  expect(result.kwh).toBeCloseTo(0.1);
  expect(result.kwh * 0.18).toBeCloseTo(0.018);
  expect(result.coverage).toBe(1);
  expect(result.average).toBeCloseTo(100);
});
it("clips boundary intervals, integrates varying loads and excludes gaps", () => {
  const points = [
    { at: start - 60, watts: 0 },
    { at: start + 60, watts: 120 },
    { at: start + 120, watts: 120 },
    { at: start + 600, watts: 500 },
  ];
  const result = summarize(points, start + 600, 600);
  expect(result.coveredSeconds).toBe(120);
  expect(result.kwh).toBeCloseTo((90 + 120) / 60000);
  expect(result.coverage).toBe(0.2);
  expect(result.maximum?.watts).toBe(500);
});
it("empty or isolated samples have no observed energy duration", () => {
  expect(summarize([], start, 3600).average).toBeNull();
  expect(summarize([{ at: start, watts: 0 }], start, 3600).coveredSeconds).toBe(
    0,
  );
  expect(summarize([{ at: start, watts: 0 }], start, 3600).minimum?.watts).toBe(
    0,
  );
});
it("leaves missing chart buckets empty and computes min/average/max", () => {
  const result = summarize(
    [
      { at: start + 30, watts: 50 },
      { at: start + 90, watts: 150 },
    ],
    start + 3600,
    3600,
  );
  expect(result.buckets[0]).toMatchObject({
    minimum: 50,
    average: 100,
    maximum: 150,
  });
  expect(result.buckets[1]).toBeNull();
});
it("validates tariff and separates constant-load projections", () => {
  for (const value of ["", "-1", "Infinity", "NaN", "abc", "1e", "1000.01"])
    expect(tariff(value)).toBeNull();
  expect(tariff("0")).toBe(0);
  expect(tariff("0.18")).toBe(0.18);
  expect(tariff("0.2345")).toBe(0.2345);
  expect(tariff("1e-8")).toBe(1e-8);
  expect(tariff("1000")).toBe(1000);
  expect(forecast(100, 0.18, 24)).toBeCloseTo(0.432);
  expect(forecast(100, 0.18, 720)).toBeCloseTo(12.96);
});
