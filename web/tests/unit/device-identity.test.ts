import { expect, it } from "vitest";
import { identify, readDisplay, writeDisplay } from "../../src/device-identity";

it("prefers explicit overrides, then inventory, without guessing a vendor", () => {
  expect(
    identify(
      { manufacturer: "Dell Inc.", model: "R730" },
      { "Board Manufacturer": "Supermicro", "Board Product Name": "X9" },
      {},
    ),
  ).toEqual({ manufacturer: "Dell Inc.", model: "R730", brand: "dell" });
  expect(
    identify(
      {},
      {
        "FRU0.BoardManufacturer": "Supermicro",
        "FRU0.BoardPartNumber": "DEMO-BOARD",
      },
      {},
    ),
  ).toEqual({
    manufacturer: "Supermicro",
    model: "DEMO-BOARD",
    brand: "supermicro",
  });
  expect(
    identify(
      {},
      { Manufacturer: "Dell", Board: "R730" },
      { manufacturer: "Other", model: "Custom" },
    ),
  ).toEqual({ manufacturer: "Other", model: "Custom", brand: null });
  expect(identify({}, {}, {})).toEqual({
    manufacturer: "Unknown vendor",
    model: "Model unavailable",
    brand: null,
  });
});

it("bounds stored display preferences and reports failed writes", () => {
  const storage = {
    getItem: () =>
      '{"name":123,"model":"Model","manufacturer":"Dell","pinned":true}',
    setItem: () => {
      throw new Error("Quota");
    },
  };
  expect(readDisplay("key", storage)).toEqual({
    model: "Model",
    manufacturer: "Dell",
    pinned: true,
  });
  expect(writeDisplay("key", { name: "Rack" }, storage)).toContain("not saved");
});

it("retains bounded icon preferences without accepting remote or SVG images", () => {
  const read = (value: unknown) =>
    readDisplay("fixture", { getItem: () => JSON.stringify(value) });
  expect(read({ icon: "t320", iconText: "DEMO-A" })).toEqual({
    icon: "t320",
    iconText: "DEMO-A",
  });
  for (const iconImage of [
    "https://example.com/track.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64," + "A".repeat(70000),
  ]) {
    expect(read({ icon: "custom", iconImage, iconText: "too-long" })).toEqual({
      icon: "custom",
    });
  }
  expect(
    read({ icon: "custom", iconImage: "data:image/png;base64,iVBORw0KGgo=" }),
  ).toEqual({
    icon: "custom",
    iconImage: "data:image/png;base64,iVBORw0KGgo=",
  });
});

it("detects identity from the IPMI adapter's FRU labels", () => {
  expect(
    identify(
      {},
      {
        "FRU 0 / Board Mfg": "Supermicro",
        "FRU 0 / Board Product": "DEMO-BOARD",
        "FRU 1 / Board Mfg": "PSU vendor",
      },
      {},
    ),
  ).toEqual({
    manufacturer: "Supermicro",
    model: "DEMO-BOARD",
    brand: "supermicro",
  });
  expect(
    identify(
      {},
      {
        "FRU 0 / Product Mfg": "Dell Inc.",
        "FRU 0 / Product Name": "PowerEdge R730",
      },
      {},
    ),
  ).toEqual({
    manufacturer: "Dell Inc.",
    model: "PowerEdge R730",
    brand: "dell",
  });
});
