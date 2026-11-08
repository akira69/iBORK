import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catalog,
  widgetGroups,
  widgetAvailable,
  type WidgetKind,
  defaultLayout,
  parseLayout,
  readLayout,
  writeLayout,
} from "../../src/dashboard-layout";

afterEach(() => vi.unstubAllGlobals());
const sensor = (id = "reading") => ({
  id,
  kind: "sensor",
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  sensorId: "CPU1",
});
const parse = (widgets: unknown[], version = 1) =>
  parseLayout(JSON.stringify({ version, widgets }));

describe("saved dashboard boundary", () => {
  it("round trips bounded appearance without changing legacy widgets", () => {
    const appearance = {
      density: "comfortable",
      valueSize: "large",
      accent: "violet",
      showTitle: false,
      showLegend: false,
      plotHeight: 320,
    };
    const widget = { ...sensor(), appearance };
    expect(parse([widget])?.widgets).toEqual([widget]);
    expect(parse([sensor()])?.widgets).toEqual([sensor()]);
    for (const bad of [
      null,
      [],
      "blue",
      { density: "huge" },
      { valueSize: 4 },
      { accent: "url(evil)" },
      { showTitle: "false" },
      { showLegend: 0 },
      { plotHeight: 119 },
      { plotHeight: 801 },
      { plotHeight: 120.5 },
      { css: "display:none" },
    ]) {
      expect(parse([{ ...sensor(), appearance: bad }])).toBeNull();
    }
  });
  it("round trips every singleton and reserves its identity", () => {
    for (const kind of Object.keys(catalog) as WidgetKind[]) {
      if (kind === "sensor") continue;
      const { w, h } = catalog[kind];
      const widget = { id: kind, kind, x: 0, y: 0, w, h };
      expect(parse([widget])?.widgets).toEqual([widget]);
      expect(parse([widget, widget])).toBeNull();
      expect(parse([{ ...widget, id: `${kind}-copy` }])).toBeNull();
      expect(parse([{ ...widget, sensorMode: "fixed" }])).toBeNull();
      expect(parse([{ ...widget, sensorIds: [] }])).toBeNull();
      expect(parse([sensor(kind)])).toBeNull();
      expect(parse([{ ...widget, w: catalog[kind].minW - 1 }])).toBeNull();
      expect(parse([{ ...widget, h: catalog[kind].minH - 1 }])).toBeNull();
    }
  });
  it("offers unique supported console widgets and excludes Jet tools on IPMI-only devices", () => {
    const offered = Object.values(widgetGroups).flat();
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered.every((kind) => kind in catalog)).toBe(true);
    const kinds = Object.keys(catalog) as WidgetKind[];
    expect(kinds.filter((kind) => !widgetAvailable(kind, false))).toEqual([
      "jetkvm",
      "glinet",
      "vnc",
      "media",
    ]);
    expect(
      kinds.every((kind) => widgetAvailable(kind, true, true, true, true)),
    ).toBe(true);
    expect(widgetAvailable("vnc", false, true)).toBe(true);
    expect(widgetAvailable("vnc")).toBe(false);
    expect(widgetAvailable("glinet", false, false, false, true)).toBe(true);
    expect(widgetAvailable("glinet")).toBe(false);
    expect(defaultLayout(false, false, true).widgets[0].kind).toBe("glinet");
  });
  it("uses VNC defaults only when no saved layout exists", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(readLayout("dell", defaultLayout(true)).layout.widgets[0].kind).toBe(
      "vnc",
    );
    const saved = defaultLayout();
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
    expect(readLayout("dell", defaultLayout(true)).layout).toEqual(saved);
  });
  it("preserves legacy sensor IDs and both selection modes beside new widgets", () => {
    const widgets = [
      ...defaultLayout().widgets,
      sensor("legacy-reading"),
      { ...sensor("selectable-reading"), sensorMode: "selectable" },
      {
        ...sensor("fixed-readings"),
        sensorMode: "fixed",
        sensorIds: ["CPU1", "FAN1"],
      },
      { id: "fans", kind: "fans", x: 0, y: 10, w: 4, h: 4 },
    ];
    expect(parse(widgets)?.widgets).toEqual(widgets);
  });
  it("preserves sensor modes and multiple selections but rejects invalid selections", () => {
    const widget = {
      ...sensor(),
      sensorIds: ["CPU1", "FAN1"],
      sensorMode: "fixed",
    };
    expect(parse([widget])?.widgets[0]).toEqual(widget);
    for (const patch of [
      { sensorIds: ["CPU1", "CPU1"] },
      { sensorIds: [0] },
      { sensorIds: Array(65).fill("x") },
      { sensorMode: "html" },
    ])
      expect(parse([{ ...widget, ...patch }])).toBeNull();
  });
  it("restores defaults and accepts intentional empty dashboards", () => {
    expect(
      defaultLayout().widgets.map((w) => [w.id, w.x, w.y, w.w, w.h]),
    ).toEqual([
      ["jetkvm", 0, 0, 8, 6],
      ["power-control", 8, 0, 4, 3],
      ["health", 8, 3, 4, 3],
    ]);
    expect(parse([])).toEqual({ version: 1, widgets: [] });
    expect(parseLayout(JSON.stringify(defaultLayout()))).toEqual(
      defaultLayout(),
    );
  });
  it("drops untrusted HTML, options and arbitrary extra properties", () => {
    expect(
      parse([
        {
          ...sensor(),
          content: "<script>attack()</script>",
          props: { password: "never" },
          subGridOpts: {},
        },
      ])?.widgets,
    ).toEqual([sensor()]);
  });
  it.each([null, -1, 0.5, Infinity, NaN, 201])(
    "rejects invalid y coordinate %s",
    (y) => {
      expect(parse([{ ...sensor(), y }])).toBeNull();
    },
  );
  it("rejects invalid geometry, identities, kinds and versions", () => {
    expect(parse([sensor("jetkvm")])).toBeNull();
    for (const patch of [
      { x: -1 },
      { x: 11, w: 2 },
      { w: 13 },
      { w: 1 },
      { h: 0 },
      { h: 25 },
      { kind: "html" },
      { id: "" },
      { id: "a".repeat(65) },
      { sensorId: "s".repeat(129) },
    ])
      expect(parse([{ ...sensor(), ...patch }])).toBeNull();
    expect(parse([sensor(), sensor()])).toBeNull();
    expect(
      parse([{ ...defaultLayout().widgets[0], id: "other-console" }]),
    ).toBeNull();
    expect(parse([], 2)).toBeNull();
    expect(parseLayout("{")).toBeNull();
    expect(parseLayout(" ".repeat(65537))).toBeNull();
    expect(
      parse(Array.from({ length: 24 }, (_, i) => sensor(`s${i}`))),
    ).not.toBeNull();
    expect(
      parse(Array.from({ length: 25 }, (_, i) => sensor(`s${i}`))),
    ).toBeNull();
  });
  it("retains corrupted storage on read and reports blocked writes", () => {
    const setItem = vi.fn(() => {
      throw new Error("Quota");
    });
    vi.stubGlobal("localStorage", { getItem: () => "bad", setItem });
    expect(readLayout("layout").error).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(writeLayout("layout", defaultLayout())).toContain("not saved");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Denied");
      },
    });
    expect(readLayout("layout").layout).toEqual(defaultLayout());
  });
  it("accepts compact readings without resizing saved widgets", () => {
    expect(catalog.sensor).toMatchObject({ minW: 2, minH: 1, h: 1 });
    expect(catalog["power-now"]).toMatchObject({ minH: 1, h: 1 });
    expect(parse([{ ...sensor(), h: 1 }])?.widgets[0].h).toBe(1);
    expect(parse([sensor()])?.widgets[0].h).toBe(2);
  });
  it("preserves bounded titles and scoped lists and maxima", () => {
    const widget = {
      ...sensor(),
      sensorId: undefined,
      deviceIds: ["rack-a"],
      sensorIds: ["FAN1", "FAN2"],
      aggregate: "max",
      title: "Highest fan",
    };
    expect(parse([widget])?.widgets[0]).toEqual(widget);
    for (const patch of [
      { aggregate: "sum" },
      { sensorIds: [] },
      { title: "a".repeat(101) },
      { title: 1 },
    ])
      expect(parse([{ ...widget, ...patch }])).toBeNull();
    const titled = { ...defaultLayout().widgets[0], title: "Remote console" };
    expect(parse([titled])?.widgets[0]).toEqual(titled);
  });
  it("limits scoped consoles to one server and rejects sensor-only fields", () => {
    for (const kind of ["jetkvm", "vnc", "glinet"] as const) {
      const widget = {
        id: `scoped-${kind}`,
        kind,
        x: 0,
        y: 0,
        w: 8,
        h: 6,
        deviceIds: ["rack-a"],
      };
      expect(parse([widget])?.widgets[0]).toEqual(widget);
      expect(parse([widget, { ...widget, id: `second-${kind}` }])).toBeNull();
      expect(
        parse([
          widget,
          { ...widget, id: `second-${kind}`, deviceIds: ["rack-b"] },
        ]),
      ).not.toBeNull();
      for (const patch of [
        { deviceIds: ["rack-a", "rack-b"] },
        { sensorId: "fan" },
        { sensorIds: ["fan"] },
        { sensorMode: "fixed" },
        { aggregate: "max" },
      ])
        expect(parse([{ ...widget, ...patch }])).toBeNull();
    }
  });
});
