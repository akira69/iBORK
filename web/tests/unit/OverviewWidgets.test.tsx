import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConnectionOverview,
  InventoryOverview,
  RecentEvents,
  SensorOverview,
} from "../../src/OverviewWidgets";
import type { Sensor } from "../../src/sensors";

const sensors: Sensor[] = [
  { id: "fan", name: "FAN1", value: "2175", unit: "RPM", state: "ok" },
  {
    id: "temp",
    name: "CPU1 Temp",
    value: "90",
    unit: "degrees C",
    state: "critical",
  },
  {
    id: "psu",
    name: "PS1 Status",
    value: "Presence detected",
    unit: "discrete",
    state: "ok",
  },
  {
    id: "missing",
    name: "FAN2",
    value: "Unavailable",
    unit: "RPM",
    state: "unavailable",
  },
  { id: "voltage", name: "12V", value: "10", unit: "Volts", state: "warning" },
];

describe("overview telemetry", () => {
  it("selects real sensor categories, formats readings and retains missing readings", () => {
    const fans = renderToStaticMarkup(
      <SensorOverview kind="fans" sensors={sensors} />,
    );
    expect(fans).toContain("2,175 RPM");
    expect(fans).toContain("FAN2");
    expect(fans).toContain("Unavailable");
    expect(fans).not.toContain("CPU1 Temp");
    const temperatures = renderToStaticMarkup(
      <SensorOverview kind="temperatures" sensors={sensors} />,
    );
    expect(temperatures).toContain("90 °C");
    expect(temperatures).toContain(">critical<");
    expect(temperatures).not.toContain("FAN1");
    const supplies = renderToStaticMarkup(
      <SensorOverview kind="psu" sensors={sensors} />,
    );
    expect(supplies).toContain("Presence detected");
    expect(supplies).not.toContain("12V");
  });
  it("distinguishes warning states from missing data and does not infer healthy from an empty response", () => {
    const alerts = renderToStaticMarkup(
      <SensorOverview kind="alerts" sensors={sensors} />,
    );
    expect(alerts).toContain("CPU1 Temp");
    expect(alerts).toContain("12V");
    expect(alerts).not.toContain("FAN1");
    expect(alerts).toContain("1 sensor state is unavailable or unclassified");
    expect(
      renderToStaticMarkup(<SensorOverview kind="alerts" sensors={[]} />),
    ).toContain("No readings reported");
    expect(
      renderToStaticMarkup(
        <SensorOverview kind="alerts" sensors={[sensors[0]]} />,
      ),
    ).toContain("No warnings or critical states reported");
  });
  it("hides previous readings on failed or loading requests", () => {
    for (const state of [{ error: "Request timed out" }, { loading: true }]) {
      const html = renderToStaticMarkup(
        <SensorOverview kind="fans" sensors={sensors} {...state} />,
      );
      expect(html).not.toContain("2,175 RPM");
      expect(html).toContain('role="status"');
    }
  });
  it("sorts and bounds recent events without mutating shared data, leaving unknown severity visible", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      timestamp: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      sensor: `Sensor ${i}`,
      message: `Message ${i}`,
      state: "unknown",
    }));
    const html = renderToStaticMarkup(<RecentEvents events={events} />);
    expect(html.indexOf("Message 9")).toBeLessThan(html.indexOf("Message 8"));
    expect(html).not.toContain("Message 0");
    expect(html).toContain("Showing 8 of 10");
    expect(html).toContain(">unknown<");
    expect(events[0].id).toBe("0");
    expect(
      renderToStaticMarkup(<RecentEvents events={events} error="Offline" />),
    ).not.toContain("Message 9");
    expect(renderToStaticMarkup(<RecentEvents events={[]} />)).toContain(
      "No events reported",
    );
  });
  it("renders inventory and connection text safely and explicitly handles absent values", () => {
    const inventory = renderToStaticMarkup(
      <InventoryOverview
        inventory={{
          fields: { Model: "<script>alert(1)</script>", Serial: "" },
        }}
      />,
    );
    expect(inventory).not.toContain("<script>");
    expect(inventory).toContain("&lt;script&gt;");
    expect(inventory).toContain("Unavailable");
    expect(renderToStaticMarkup(<InventoryOverview />)).toContain(
      "No inventory reported",
    );
    const connections = renderToStaticMarkup(
      <ConnectionOverview
        connections={[
          { name: "IPMI", status: "Offline", detail: "Connection timed out" },
          { name: "JetKVM", status: "Not configured" },
        ]}
      />,
    );
    expect(connections).toContain("Offline");
    expect(connections).toContain("Connection timed out");
    expect(connections).toContain("Not configured");
  });
});
