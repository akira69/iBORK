import { type DashboardLayout, type WidgetKind } from "./dashboard-layout";

export function panelLayout(
  panels: [WidgetKind, number, number, number, number][],
): DashboardLayout {
  return {
    version: 1,
    widgets: panels.map(([kind, x, y, w, h]) => ({
      id: kind,
      kind,
      x,
      y,
      w,
      h,
    })),
  };
}

export const powerLayout = panelLayout([
  ["power-statistics", 0, 0, 7, 6],
  ["power-projections", 7, 0, 5, 3],
  ["power-hour", 0, 6, 4, 4],
  ["power-day", 4, 6, 4, 4],
  ["power-week", 8, 6, 4, 4],
]);
export const terminalLayout = panelLayout([
  ["sol", 0, 0, 6, 6],
  ["diagnostics", 6, 0, 6, 6],
]);
