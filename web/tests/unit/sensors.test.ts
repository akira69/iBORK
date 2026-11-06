import { expect, it } from "vitest";
import { sensorReading, powerSupplies, sensorGroup } from "../../src/sensors";

it("groups Mac mini CPU readings separately from unmapped SMC channels", () => {
  const reading = {
    id: "fixture",
    name: "Package id 0",
    unit: "degrees C",
    value: "69",
    state: "ok",
  };
  expect(sensorGroup(reading)).toBe("sensor-cpu");
  expect(sensorGroup({ ...reading, name: "Core 2" })).toBe("sensor-cpu");
  expect(sensorGroup({ ...reading, name: "TCPG", detailOnly: true })).toBe(
    "sensor-other",
  );
});

it("groups hardware before its measurement unit and retains unknown sensors", () => {
  for (const [name, unit, group] of [
    ["CPU1 Temp", "degrees C", "cpu"],
    ["CPU1 DIMM A1", "Volts", "memory"],
    ["P1-DIMMA1 Temp", "degrees C", "memory"],
    ["CPU1 Fan", "RPM", "fans"],
    ["PS1 Status", "discrete", "power"],
    ["PSU2 Temp", "degrees C", "power"],
    ["Disk 0", "discrete", "storage"],
    ["Inlet Temp", "degrees C", "board"],
    ["LAN1 Link", "discrete", "network"],
    ["OEM 42", "discrete", "other"],
  ])
    expect(sensorGroup({ id: name, name, unit, value: "0", state: "ok" })).toBe(
      `sensor-${group}`,
    );
});

it("formats sensor precision and compact units without duplicating legacy units", () => {
  for (const [value, unit, expected] of [
    ["30.000 degrees C", "degrees C", "30 °C"],
    ["2175.000 RPM", "RPM", "2,175 RPM"],
    ["30.125", "degrees C", "30.1 °C"],
    ["0.752", "Volts", "0.75 V"],
    ["Presence detected", "discrete", "Presence detected"],
    ["Unavailable", "RPM", "Unavailable"],
    ["0", "RPM", "0 RPM"],
  ])
    expect(sensorReading({ value, unit })).toBe(expected);
});

it("finds both Supermicro supplies and other vendor names without matching unrelated sensors", () => {
  const sensors = [
    "PS1 Status",
    "PS2 Status",
    "PSU1",
    "Power Supply 2",
    "PWS1",
    "CPU1 Temp",
    "PCH Temp",
  ].map((name) => ({
    id: name,
    name,
    value: "Presence detected",
    unit: "discrete",
    state: "ok",
  }));
  expect(powerSupplies(sensors).map((s) => s.name)).toEqual(
    sensors.slice(0, 5).map((s) => s.name),
  );
});
