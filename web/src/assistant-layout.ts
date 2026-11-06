import {
  defaultLayout,
  parseLayout,
  widgetAvailable,
  writeLayout,
  type DashboardLayout,
  type DashboardWidget,
} from "./dashboard-layout";
import { dashboardKey, sourcesFor, type Device } from "./device-identity";

const overlaps = (a: DashboardWidget, b: DashboardWidget) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export function arrange(
  target: DashboardLayout,
  source?: DashboardLayout,
): DashboardLayout {
  const placed: DashboardWidget[] = [];
  // Give matching panels their source geometry first; preserve each destination's sensor bindings.
  const proposals = target.widgets
    .map((widget) => {
      const match = source?.widgets.find(
        (s) => s.kind === widget.kind && s.id === widget.id,
      );
      const geometry = match
        ? { x: match.x, y: match.y, w: match.w, h: match.h }
        : {};
      return { widget: { ...widget, ...geometry }, matched: !!match };
    })
    .sort(
      (a, b) =>
        Number(b.matched) - Number(a.matched) ||
        a.widget.y - b.widget.y ||
        a.widget.x - b.widget.x,
    );
  for (const { widget } of proposals) {
    if (!source) widget.y = 0;
    while (placed.some((p) => overlaps(p, widget))) widget.y++;
    placed.push(widget);
  }
  return {
    version: 1,
    widgets: target.widgets.map((w) => placed.find((p) => p.id === w.id)!),
  };
}
function snapshot(d: Device) {
  const key = dashboardKey(d),
    comet = sourcesFor(d).includes("glinet");
  const raw = localStorage.getItem(key);
  if (raw !== null) {
    const layout = parseLayout(raw);
    if (!layout) throw Error("The saved dashboard is invalid.");
    return { key, raw, layout };
  }
  const layout = defaultLayout(
    !d.hasJetKVM && d.hasVNC,
    d.hasManagement,
    !d.hasJetKVM && !d.hasVNC && comet,
  );
  layout.widgets = layout.widgets.filter((w) =>
    widgetAvailable(w.kind, d.hasJetKVM, d.hasVNC, d.hasManagement, comet),
  );
  return { key, raw, layout };
}
export function previewLayout(source: Device, target: Device) {
  const from = snapshot(source),
    to = snapshot(target);
  const next = arrange(
    to.layout,
    source.id === target.id ? undefined : from.layout,
  );
  if (!parseLayout(JSON.stringify(next)))
    throw new Error("Panel positions exceed the dashboard limits.");
  const changes = next.widgets.filter(
    (w, i) => JSON.stringify(w) !== JSON.stringify(to.layout.widgets[i]),
  );
  return {
    changes,
    apply() {
      if (
        localStorage.getItem(from.key) !== from.raw ||
        localStorage.getItem(to.key) !== to.raw
      )
        throw new Error("Layout changed. Preview again.");
      const error = writeLayout(to.key, next);
      if (error) throw new Error(error);
    },
  };
}
