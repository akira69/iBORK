import { expect, it } from "vitest";
import {
  DashboardDraftStore,
  type DashboardSurface,
} from "../../src/dashboard-draft";
import { type DashboardLayout } from "../../src/dashboard-layout";

const layout: DashboardLayout = {
  version: 1,
  widgets: [{ id: "health", kind: "health", x: 0, y: 0, w: 4, h: 3 }],
};
function fixture() {
  let saved: string | null = null;
  let fail = false;
  const store = new DashboardDraftStore("browser-one");
  const surface: DashboardSurface = {
    target: "console",
    title: "Server Console",
    mode: "device",
    deviceId: "server",
    layout,
    catalog: [
      { kind: "health", title: "Health", minW: 3, minH: 3, w: 4, h: 3 },
    ],
    read: () => saved,
    save: (next) => {
      if (fail) throw Error("Storage full");
      saved = JSON.stringify(next);
    },
  };
  store.register(surface);
  return {
    store,
    surface,
    saved: () => saved,
    change: (v: string) => {
      saved = v;
    },
    fail: () => {
      fail = true;
    },
  };
}
it("iterates and compares one draft without saving until Apply", () => {
  const f = fixture(),
    original = f.store.context()!;
  f.store.receive({
    ...original,
    revision: "proposal1",
    draft: true,
    layout: { ...layout, widgets: [{ ...layout.widgets[0], x: 4 }] },
  });
  expect(f.saved()).toBeNull();
  expect(f.store.draft("console")?.layout.widgets[0].x).toBe(4);
  f.store.edit("console", {
    ...layout,
    widgets: [{ ...layout.widgets[0], y: 5 }],
  });
  expect(f.store.context()?.layout.widgets[0].y).toBe(5);
  f.store.compare("console", true);
  expect(f.store.draft("console")?.showCurrent).toBe(true);
  expect(f.saved()).toBeNull();
  f.store.apply("console");
  expect(JSON.parse(f.saved()!).widgets[0].y).toBe(5);
  expect(f.store.draft("console")).toBeUndefined();
});
it("rejects foreign, unsupported and overlapping proposals without losing valid work", () => {
  const { store, surface } = fixture(),
    c = store.context()!;
  expect(() =>
    store.receive({ ...c, instance: "other", draft: true }),
  ).toThrow();
  expect(() =>
    store.receive({
      ...c,
      revision: "bad",
      draft: true,
      layout: {
        version: 1,
        widgets: [{ ...layout.widgets[0], kind: "events", id: "events" }],
      },
    }),
  ).toThrow();
  expect(store.draft("console")).toBeUndefined();
  store.register({
    ...surface,
    catalog: [
      ...surface.catalog,
      { kind: "events", title: "Events", minW: 3, minH: 3, w: 4, h: 3 },
    ],
  });
  store.receive({ ...c, revision: "valid", draft: true });
  expect(() =>
    store.receive({
      ...c,
      revision: "overlap",
      draft: true,
      layout: {
        version: 1,
        widgets: [
          layout.widgets[0],
          { ...layout.widgets[0], id: "events", kind: "events" },
        ],
      },
    }),
  ).toThrow(/overlapping/);
  expect(store.context()?.revision).toBe("valid");
  expect(store.draft("console")?.layout).toEqual(layout);
});
it("storage errors and concurrent edits preserve the pending draft", () => {
  const f = fixture();
  f.store.receive({ ...f.store.context()!, revision: "p1", draft: true });
  f.fail();
  expect(() => f.store.apply("console")).toThrow("Storage full");
  expect(f.store.draft("console")).toBeDefined();
  f.change("another tab's edit");
  expect(() => f.store.apply("console")).toThrow(/changed/);
  expect(f.saved()).toBe("another tab's edit");
});
it("navigation keeps drafts bound to their target and discard never writes", () => {
  const f = fixture(),
    c = f.store.context()!;
  f.store.register({ ...f.surface, target: "power", title: "Power" });
  f.store.receive({ ...c, revision: "p1", draft: true });
  expect(f.store.context()?.target).toBe("power");
  expect(f.store.draft("power")).toBeUndefined();
  expect(f.store.draft("console")).toBeDefined();
  f.store.discard("console");
  expect(f.saved()).toBeNull();
});
it("a late proposal cannot overwrite a manual draft revision", () => {
  const { store } = fixture(),
    c = store.context()!;
  store.receive({ ...c, revision: "p1", draft: true });
  store.edit("console", {
    ...layout,
    widgets: [{ ...layout.widgets[0], y: 4 }],
  });
  expect(() =>
    store.receive({ ...c, revision: "p2", draft: true }, "p1"),
  ).toThrow(/changed locally/);
  expect(store.draft("console")!.layout.widgets[0].y).toBe(4);
});
it("captures the saved baseline before the assistant request, not after its reply", () => {
  const f = fixture(),
    context = f.store.context()!;
  f.change("concurrent edit while generating");
  f.store.receive({ ...context, draft: true, revision: "reply" });
  expect(() => f.store.apply("console")).toThrow(/changed/);
});
it("rejects widget bindings incompatible with the dashboard mode", () => {
  const { store, surface } = fixture();
  surface.catalog = [
    { kind: "power-now", title: "Power", minW: 2, minH: 1, w: 3, h: 1 },
  ];
  store.register(surface);
  const context = store.context()!;
  expect(() =>
    store.receive({
      ...context,
      draft: true,
      revision: "bad-binding",
      layout: {
        version: 1,
        widgets: [
          {
            id: "scoped-power",
            kind: "power-now",
            deviceIds: ["server"],
            x: 0,
            y: 0,
            w: 3,
            h: 1,
          },
        ],
      },
    }),
  ).toThrow(/unsupported/);
});
