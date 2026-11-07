import {
  parseLayout,
  type DashboardLayout,
  type WidgetKind,
} from "./dashboard-layout";

export type DashboardContext = {
  instance: string;
  target: string;
  title: string;
  mode: "fleet" | "device" | "fixed" | "wall";
  deviceId?: string;
  revision: string;
  layout: DashboardLayout;
  catalog: {
    kind: WidgetKind;
    title: string;
    minW: number;
    minH: number;
    w: number;
    h: number;
  }[];
  draft?: boolean;
  summary?: string;
};
export type DashboardSurface = Omit<
  DashboardContext,
  "instance" | "revision" | "draft" | "summary"
> & {
  read: () => string | null;
  save: (layout: DashboardLayout) => void;
};
type Draft = {
  layout: DashboardLayout;
  baseline: DashboardLayout;
  raw: string | null;
  showCurrent: boolean;
};

export class DashboardDraftStore {
  private listeners = new Set<() => void>();
  private surfaces = new Map<string, DashboardSurface>();
  private drafts = new Map<string, Draft>();
  private revisions = new Map<string, string>();
  private baselines = new Map<string, string | null>();
  private active?: string;
  private version = 0;
  constructor(readonly instance: string = crypto.randomUUID()) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }
  register(surface: DashboardSurface) {
    const old = this.surfaces.get(surface.target);
    this.surfaces.set(surface.target, surface);
    const changed = JSON.stringify(old) !== JSON.stringify(surface);
    if (
      !this.revisions.has(surface.target) ||
      (changed && !this.drafts.has(surface.target))
    ) {
      this.revisions.set(surface.target, crypto.randomUUID());
      this.baselines.delete(surface.target);
    }
    if (changed || this.active !== surface.target) {
      this.active = surface.target;
      this.changed();
    }
  }
  unregister(target: string) {
    if (this.active === target) {
      this.active = undefined;
      this.changed();
    }
  }
  context(): DashboardContext | undefined {
    const surface = this.active && this.surfaces.get(this.active);
    if (!surface) return;
    if (!this.drafts.has(surface.target) && !this.baselines.has(surface.target))
      this.baselines.set(surface.target, surface.read());
    const { read: _read, save: _save, ...data } = surface;
    void _read;
    void _save;
    return {
      ...data,
      instance: this.instance,
      revision: this.revisions.get(surface.target)!,
      layout: this.drafts.get(surface.target)?.layout ?? surface.layout,
    };
  }
  draft(target: string) {
    return this.drafts.get(target);
  }
  receive(context: DashboardContext, expectedRevision?: string) {
    if (context.instance !== this.instance)
      throw Error("This proposal belongs to another browser.");
    const surface = this.surfaces.get(context.target);
    if (
      !surface ||
      context.mode !== surface.mode ||
      context.deviceId !== surface.deviceId
    )
      throw Error("Dashboard changed. Open its dashboard and try again.");
    if (
      !context.draft ||
      this.revisions.get(context.target) === context.revision
    )
      return;
    if (
      expectedRevision &&
      this.revisions.get(context.target) !== expectedRevision
    )
      throw Error(
        "Dashboard changed locally. Ask the assistant to revise the latest draft.",
      );
    const layout = parseLayout(JSON.stringify(context.layout));
    if (
      !layout ||
      layout.widgets.some(
        (w) =>
          !surface.catalog.some((c) => c.kind === w.kind) ||
          !!w.deviceIds !==
            (surface.mode === "fleet" || surface.mode === "wall"),
      )
    )
      throw Error("The proposal contains unsupported widgets.");
    if (
      layout.widgets.some((a, i) =>
        layout.widgets
          .slice(i + 1)
          .some(
            (b) =>
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y,
          ),
      )
    )
      throw Error("The proposal contains overlapping widgets.");
    const previous = this.drafts.get(context.target);
    this.drafts.set(context.target, {
      layout,
      baseline: previous?.baseline ?? surface.layout,
      raw: previous
        ? previous.raw
        : this.baselines.has(context.target)
          ? this.baselines.get(context.target)!
          : surface.read(),
      showCurrent: false,
    });
    this.revisions.set(context.target, context.revision);
    this.changed();
  }
  edit(target: string, layout: DashboardLayout) {
    const draft = this.drafts.get(target);
    if (!draft || draft.showCurrent) return;
    const safe = parseLayout(JSON.stringify(layout));
    if (!safe) throw Error("Invalid dashboard layout.");
    this.drafts.set(target, { ...draft, layout: safe });
    this.revisions.set(target, crypto.randomUUID());
    this.changed();
  }
  compare(target: string, showCurrent: boolean) {
    const draft = this.drafts.get(target);
    if (draft) {
      this.drafts.set(target, { ...draft, showCurrent });
      this.changed();
    }
  }
  apply(target: string) {
    const surface = this.surfaces.get(target),
      draft = this.drafts.get(target);
    if (!surface || !draft) return;
    if (surface.read() !== draft.raw)
      throw Error(
        "Saved layout changed. Discard this draft and reload the dashboard before trying again.",
      );
    surface.save(draft.layout);
    this.surfaces.set(target, { ...surface, layout: draft.layout });
    this.drafts.delete(target);
    this.baselines.delete(target);
    this.revisions.set(target, crypto.randomUUID());
    this.changed();
  }
  discard(target: string) {
    if (this.drafts.delete(target)) {
      this.baselines.delete(target);
      this.revisions.set(target, crypto.randomUUID());
      this.changed();
    }
  }
}
