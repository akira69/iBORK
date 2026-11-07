import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SensorReadings } from "../../src/SensorReadings";
import type { Sensor } from "../../src/sensors";

const fan = (id: string, value: string, unit = "RPM"): Sensor => ({
  id,
  name: id,
  value,
  unit,
  state: "ok",
});
const render = (sensors: Sensor[], aggregate?: "max", error?: string) =>
  renderToStaticMarkup(
    <SensorReadings
      widget={{ sensorIds: ["one", "two", "gone"], aggregate }}
      sensors={sensors}
      error={error}
    />,
  );
describe("compact sensor measurements", () => {
  it("renders CPU temperature lists and keeps selectable widgets on the active reading", () => {
    const sensors = [
      fan("one", "41", "degrees C"),
      fan("two", "52", "degrees C"),
    ];
    const list = render(sensors);
    expect(list).toContain("41 °C");
    expect(list).toContain("52 °C");
    const selectable = renderToStaticMarkup(
      <SensorReadings
        widget={{
          sensorMode: "selectable",
          sensorId: "two",
          sensorIds: ["one", "two"],
        }}
        sensors={sensors}
      />,
    );
    expect(selectable).toContain("52 °C");
    expect(selectable).not.toContain("41 °C");
  });
  it("renders lists, missing readings and escaped names", () => {
    const html = render([fan("one", "1200"), fan("two", "<bad>")]);
    expect(html).toContain("1,200 RPM");
    expect(html).toContain("Unavailable");
    expect(html).toContain("&lt;bad&gt;");
  });
  it("finds highest valid RPM, counts partial readings and keeps zero", () => {
    expect(render([fan("one", "0"), fan("two", "n/a")], "max")).toContain(
      "0 RPM",
    );
    const highest = render([fan("one", "1200 RPM"), fan("two", "2400")], "max");
    expect(highest).toContain("2,400 RPM");
    expect(highest).toContain("2 of 3 reporting");
    expect(highest).not.toContain("1,200 RPM");
  });
  it("rejects invalid numbers, negative speeds, wrong units and failed reads", () => {
    for (const sensors of [
      [fan("one", "")],
      [fan("one", "Infinity")],
      [fan("one", "-1")],
      [fan("one", "999", "degrees C")],
      [{ ...fan("one", "100"), state: "unavailable" }],
    ])
      expect(render(sensors, "max")).toContain("Unavailable");
    const failed = render([fan("one", "1200")], "max", "Read timed out");
    expect(failed).toContain("Unavailable");
    expect(failed).toContain("0 of 3 reporting");
    expect(failed).not.toContain("1,200 RPM");
  });
});
