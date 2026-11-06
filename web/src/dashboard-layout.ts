export type WidgetKind =
  | "sensor-cpu"
  | "sensor-memory"
  | "sensor-fans"
  | "sensor-power"
  | "sensor-storage"
  | "sensor-board"
  | "sensor-network"
  | "sensor-other"
  | "power-statistics"
  | "power-hour"
  | "power-day"
  | "power-week"
  | "power-projections"
  | "jetkvm"
  | "vnc"
  | "glinet"
  | "power-control"
  | "health"
  | "power-usage"
  | "sensor"
  | "cooling"
  | "fans"
  | "temperatures"
  | "psu"
  | "alerts"
  | "events"
  | "inventory"
  | "connections"
  | "power-now"
  | "energy-cost"
  | "boot"
  | "media"
  | "sol"
  | "diagnostics";
export type DashboardWidget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  deviceIds?: string[];
  sensorId?: string;
  sensorIds?: string[];
  sensorMode?: "fixed" | "selectable";
};
export const validDashboardSensorId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 128;
export const selectedSensors = (widget: DashboardWidget): string[] =>
  widget.sensorMode === "selectable"
    ? widget.sensorId
      ? [widget.sensorId]
      : []
    : (widget.sensorIds ?? (widget.sensorId ? [widget.sensorId] : []));
export type DashboardLayout = { version: 1; widgets: DashboardWidget[] };

export const catalog: Record<
  WidgetKind,
  { title: string; minW: number; minH: number; w: number; h: number }
> = {
  "sensor-cpu": { title: "CPU", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-memory": { title: "Memory / RAM", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-fans": { title: "Fans", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-power": { title: "Power supplies", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-storage": { title: "Storage", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-board": {
    title: "System / motherboard",
    minW: 2,
    minH: 2,
    w: 4,
    h: 4,
  },
  "sensor-network": { title: "Network", minW: 2, minH: 2, w: 4, h: 4 },
  "sensor-other": { title: "Other sensors", minW: 2, minH: 2, w: 4, h: 4 },
  "power-statistics": {
    title: "Power statistics & cost",
    minW: 4,
    minH: 4,
    w: 7,
    h: 6,
  },
  "power-hour": { title: "Last hour", minW: 3, minH: 3, w: 4, h: 4 },
  "power-day": { title: "Last day", minW: 3, minH: 3, w: 4, h: 4 },
  "power-week": { title: "Last week", minW: 3, minH: 3, w: 4, h: 4 },
  "power-projections": {
    title: "Projected cost",
    minW: 3,
    minH: 2,
    w: 5,
    h: 3,
  },
  jetkvm: { title: "JetKVM", minW: 6, minH: 4, w: 8, h: 6 },
  glinet: { title: "GL.iNet Comet", minW: 6, minH: 4, w: 8, h: 6 },
  vnc: { title: "iDRAC console", minW: 6, minH: 4, w: 8, h: 6 },
  "power-control": { title: "Power control", minW: 3, minH: 3, w: 4, h: 3 },
  health: { title: "At a glance", minW: 3, minH: 3, w: 4, h: 3 },
  "power-usage": { title: "Power consumption", minW: 6, minH: 6, w: 12, h: 10 },
  sensor: { title: "Sensor reading", minW: 2, minH: 2, w: 3, h: 3 },
  cooling: { title: "Cooling", minW: 3, minH: 2, w: 4, h: 3 },
  fans: { title: "Fan speeds", minW: 2, minH: 3, w: 4, h: 4 },
  temperatures: { title: "Temperatures", minW: 2, minH: 3, w: 4, h: 4 },
  psu: { title: "Power supplies", minW: 2, minH: 3, w: 4, h: 3 },
  alerts: { title: "Sensor warnings", minW: 2, minH: 3, w: 4, h: 4 },
  events: { title: "Recent events", minW: 3, minH: 3, w: 6, h: 5 },
  inventory: { title: "Server inventory", minW: 3, minH: 3, w: 4, h: 5 },
  connections: { title: "Connections", minW: 2, minH: 3, w: 4, h: 3 },
  "power-now": { title: "Current power", minW: 2, minH: 2, w: 3, h: 3 },
  "energy-cost": {
    title: "Measured energy & cost",
    minW: 3,
    minH: 3,
    w: 6,
    h: 4,
  },
  boot: { title: "Next boot", minW: 3, minH: 3, w: 4, h: 4 },
  media: { title: "Virtual media", minW: 3, minH: 3, w: 6, h: 4 },
  sol: { title: "Serial over LAN", minW: 4, minH: 4, w: 6, h: 6 },
  diagnostics: { title: "IPMI diagnostics", minW: 3, minH: 4, w: 6, h: 6 },
};

export const widgetGroups: Record<string, WidgetKind[]> = {
  "Health & cooling": [
    "health",
    "cooling",
    "fans",
    "temperatures",
    "psu",
    "alerts",
    "sensor",
  ],
  "Power & cost": [
    "power-control",
    "power-now",
    "energy-cost",
    "power-usage",
    "power-hour",
    "power-day",
    "power-week",
    "power-statistics",
    "power-projections",
  ],
  "Server details": ["events", "inventory", "connections"],
  "Console & tools": [
    "jetkvm",
    "vnc",
    "glinet",
    "sol",
    "diagnostics",
    "boot",
    "media",
  ],
};

export const widgetAvailable = (
  kind: WidgetKind,
  jetAvailable = true,
  vncAvailable = false,
  managementAvailable = true,
  cometAvailable = false,
) =>
  !managementAvailable && !["jetkvm", "vnc", "glinet", "media"].includes(kind)
    ? false
    : kind === "glinet"
      ? cometAvailable
      : kind === "vnc"
        ? vncAvailable
        : jetAvailable || (kind !== "jetkvm" && kind !== "media");

export function defaultLayout(
  vnc = false,
  management = true,
  comet = false,
): DashboardLayout {
  const consoleKind = vnc ? "vnc" : comet ? "glinet" : "jetkvm";
  return {
    version: 1,
    widgets: [
      {
        id: consoleKind,
        kind: consoleKind,
        x: 0,
        y: 0,
        w: management ? 8 : 12,
        h: 6,
      },
      { id: "power-control", kind: "power-control", x: 8, y: 0, w: 4, h: 3 },
      { id: "health", kind: "health", x: 8, y: 3, w: 4, h: 3 },
    ],
  };
}

export function parseLayout(raw: string | null): DashboardLayout | null {
  if (!raw || new TextEncoder().encode(raw).length > 65536) return null;
  try {
    const data = JSON.parse(raw);
    if (
      data?.version !== 1 ||
      !Array.isArray(data.widgets) ||
      data.widgets.length > 24
    )
      return null;
    const ids = new Set<string>(),
      widgets: DashboardWidget[] = [];
    for (const item of data.widgets) {
      if (
        !item ||
        typeof item.kind !== "string" ||
        !Object.hasOwn(catalog, item.kind)
      )
        return null;
      const kind = item.kind as WidgetKind,
        limits = catalog[kind];
      const scoped = item.deviceIds !== undefined;
      if (
        scoped &&
        (!["sensor", "power-now", "power-hour"].includes(kind) ||
          !Array.isArray(item.deviceIds) ||
          !item.deviceIds.length ||
          item.deviceIds.length > 16 ||
          item.deviceIds.some(
            (id: unknown) =>
              typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id),
          ) ||
          new Set(item.deviceIds).size !== item.deviceIds.length ||
          (kind === "sensor" &&
            (item.deviceIds.length !== 1 || !item.sensorId)))
      )
        return null;
      if (
        typeof item.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) ||
        ids.has(item.id) ||
        ((scoped || kind === "sensor") && Object.hasOwn(catalog, item.id)) ||
        (!scoped && kind !== "sensor" && item.id !== kind)
      )
        return null;
      if (
        ![item.x, item.y, item.w, item.h].every(Number.isInteger) ||
        item.x < 0 ||
        item.y < 0 ||
        item.y > 200 ||
        item.w < limits.minW ||
        item.w > 12 ||
        item.x + item.w > 12 ||
        item.h < limits.minH ||
        item.h > 24
      )
        return null;
      if (
        item.sensorId !== undefined &&
        (kind !== "sensor" ||
          (item.sensorId !== "" && !validDashboardSensorId(item.sensorId)))
      )
        return null;
      ids.add(item.id);
      if (
        (item.sensorMode !== undefined &&
          (kind !== "sensor" ||
            !["fixed", "selectable"].includes(item.sensorMode))) ||
        (item.sensorIds !== undefined &&
          (kind !== "sensor" ||
            !Array.isArray(item.sensorIds) ||
            item.sensorIds.length > 64 ||
            item.sensorIds.some((id: unknown) => !validDashboardSensorId(id)) ||
            new Set(item.sensorIds).size !== item.sensorIds.length))
      )
        return null;
      widgets.push({
        id: item.id,
        kind,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        ...(scoped ? { deviceIds: item.deviceIds } : {}),
        ...(item.sensorId === undefined ? {} : { sensorId: item.sensorId }),
        ...(item.sensorIds === undefined ? {} : { sensorIds: item.sensorIds }),
        ...(item.sensorMode === undefined
          ? {}
          : { sensorMode: item.sensorMode }),
      });
    }
    return { version: 1, widgets };
  } catch {
    return null;
  }
}

export function readLayout(
  key: string,
  defaults = defaultLayout(),
): {
  layout: DashboardLayout;
  error?: string;
} {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { layout: defaults };
    const layout = parseLayout(raw);
    return layout
      ? { layout }
      : {
          layout: defaults,
          error:
            "Saved dashboard is invalid. Defaults are shown; your saved data has not been overwritten.",
        };
  } catch {
    return {
      layout: defaults,
      error:
        "Browser storage is unavailable. Layout changes will not be saved.",
    };
  }
}

export function writeLayout(
  key: string,
  layout: DashboardLayout,
): string | undefined {
  const safe = parseLayout(JSON.stringify(layout));
  if (!safe) return "Layout not saved: invalid widget positions.";
  try {
    localStorage.setItem(key, JSON.stringify(safe));
  } catch {
    return "Layout not saved. Browser storage is unavailable or full.";
  }
}
