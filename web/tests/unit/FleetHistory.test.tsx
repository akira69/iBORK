import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FleetHistory } from "../../src/FleetHistory";
import type { FleetReading } from "../../src/fleet-power";

vi.mock("../../src/ElectricityRate", () => ({
  useElectricityRate: () => ({ rate: 0.2 }),
}));
const full: FleetReading = {
  received: 0,
  data: {
    now: 3600,
    source: "fixture",
    samples: Array.from({ length: 37 }, (_, i) => ({
      at: i * 100,
      watts: 100,
    })),
  },
};
describe("fleet history presentation", () => {
  it("labels partial recorded energy and cost, and exposes named contributors without markup injection", () => {
    const html = renderToStaticMarkup(
      <FleetHistory
        ids={["a", "missing"]}
        readings={new Map([["a", full]])}
        elapsed={0}
        names={{ a: "<script>A</script>", missing: "Unmetered" }}
      />,
    );
    expect(html).toContain("Recorded energy · Partial: 0.1000 kWh");
    expect(html).toContain("Cost of recorded energy · Partial: $0.02");
    expect(html).toContain("50.0% measured coverage");
    expect(html).toContain("1 of 2 servers have history");
    expect(html).toContain("Partial · 1 of 2 reporting");
    expect(html).toContain("&lt;script&gt;A&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("History details");
    expect(html).toContain("Unmetered: Awaiting power history");
    expect(html).toContain(
      'aria-label="Available measured watts over the last hour, peak 100 W, 1 of 2 reporting"',
    );
  });
  it("shows complete measured zero as recorded energy with full coverage", () => {
    const zero = {
      ...full,
      data: {
        ...full.data!,
        samples: full.data!.samples.map((p) => ({ ...p, watts: 0 })),
      },
    };
    const html = renderToStaticMarkup(
      <FleetHistory
        ids={["a"]}
        readings={new Map([["a", zero]])}
        elapsed={0}
      />,
    );
    expect(html).toContain("Recorded energy: 0.0000 kWh");
    expect(html).toContain("100.0% measured coverage");
    expect(html).not.toContain("Partial");
    expect(html).not.toContain("Unavailable");
  });
  it("explains unavailable history using source, collection and sample evidence", () => {
    const readings = new Map<string, FleetReading>([
      ["source", { received: 0, data: { now: 3600, source: "", samples: [] } }],
      ["failed", { received: 0, error: "Request timed out" }],
      [
        "single",
        {
          ...full,
          data: { ...full.data!, samples: [{ at: 3600, watts: 10 }] },
        },
      ],
      [
        "old",
        {
          ...full,
          data: {
            ...full.data!,
            samples: [
              { at: -1000, watts: 10 },
              { at: -900, watts: 10 },
            ],
          },
        },
      ],
    ]);
    const html = renderToStaticMarkup(
      <FleetHistory
        ids={[...readings.keys()]}
        readings={readings}
        elapsed={0}
      />,
    );
    expect(html).toContain("Unavailable");
    expect(html).toContain("No power source");
    expect(html).toContain("Collection failed: Request timed out");
    expect(html).toContain("Awaiting sufficient samples");
    expect(html).toContain("No samples in this window");
    expect(html).not.toContain("kWh");
  });
});
