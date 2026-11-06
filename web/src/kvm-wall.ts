import { sourcesFor, type Device, type ConsoleSource } from "./device-identity";
import { catalog } from "./dashboard-layout";
export type WallEntry = {
  deviceId: string;
  source: ConsoleSource;
  connect: "manual" | "auto";
  included: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type WallPreferences = {
  version: 1;
  entries: WallEntry[];
  automatic?: boolean;
  cellHeight?: number;
  gridWidth?: number;
};
export const wallStorageKey = "jet-supermicro:kvm-wall:v1";
export const wallLimits = (source: ConsoleSource) => ({
  ...catalog[source === "vnc" ? "vnc" : "jetkvm"],
  minW: 3,
});
function defaults(devices: Device[]): WallPreferences {
  return {
    version: 1,
    automatic: true,
    entries: devices
      .filter((d) => sourcesFor(d).length)
      .slice(0, 16)
      .map((d, index) => ({
        deviceId: d.id,
        source: sourcesFor(d).includes("jetkvm") ? "jetkvm" : sourcesFor(d)[0],
        connect: "manual",
        included: true,
        x: (index % 2) * 6,
        y: Math.floor(index / 2) * 4,
        w: 6,
        h: 4,
      })),
  };
}
function valid(entry: WallEntry) {
  if (
    !entry ||
    typeof entry.deviceId !== "string" ||
    !["jetkvm", "vnc", "glinet"].includes(entry.source) ||
    !["manual", "auto"].includes(entry.connect) ||
    typeof entry.included !== "boolean"
  )
    return false;
  const limits = wallLimits(entry.source);
  return (
    [entry.x, entry.y, entry.w, entry.h].every(Number.isInteger) &&
    entry.x >= 0 &&
    entry.y >= 0 &&
    entry.y <= 200 &&
    entry.w >= limits.minW &&
    entry.w <= 12 &&
    entry.x + entry.w <= 12 &&
    entry.h >= limits.minH &&
    entry.h <= 24
  );
}
const clean = ({
  deviceId,
  source,
  connect,
  included,
  x,
  y,
  w,
  h,
}: WallEntry): WallEntry => ({
  deviceId,
  source,
  connect,
  included,
  x,
  y,
  w,
  h,
});
export function readWallPreferences(
  devices: Device[],
  storage?: Pick<Storage, "getItem">,
): { value: WallPreferences; warning?: string } {
  const value = defaults(devices);
  try {
    const raw = (storage ?? localStorage).getItem(wallStorageKey);
    if (!raw) return { value };
    if (raw.length > 65536) throw Error();
    const parsed = JSON.parse(raw) as WallPreferences;
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > 16
    )
      throw Error();
    const seen = new Set<string>();
    value.automatic = parsed.automatic === true;
    if (
      typeof parsed.cellHeight === "number" &&
      Number.isFinite(parsed.cellHeight) &&
      parsed.cellHeight >= 20 &&
      parsed.cellHeight <= 1000
    )
      value.cellHeight = parsed.cellHeight;
    if (
      typeof parsed.gridWidth === "number" &&
      Number.isFinite(parsed.gridWidth) &&
      parsed.gridWidth > 0 &&
      parsed.gridWidth <= 16384
    )
      value.gridWidth = parsed.gridWidth;
    let warning: string | undefined;
    for (const entry of parsed.entries) {
      if (!valid(entry) || seen.has(entry.deviceId)) throw Error();
      seen.add(entry.deviceId);
      const index = value.entries.findIndex(
        (item) => item.deviceId === entry.deviceId,
      );
      if (index < 0) continue;
      const device = devices.find((d) => d.id === entry.deviceId)!;
      if (!sourcesFor(device).includes(entry.source)) {
        warning = "An unavailable console source was reset to its default.";
        continue;
      }
      value.entries[index] = clean(entry);
    }
    return { value, warning };
  } catch {
    return {
      value: defaults(devices),
      warning:
        "Wall preferences could not be restored. Defaults are shown; saved data has not been overwritten.",
    };
  }
}
export function writeWallPreferences(
  value: WallPreferences,
  storage?: Pick<Storage, "setItem">,
): string {
  try {
    if (
      value.version !== 1 ||
      value.entries.length > 16 ||
      !value.entries.every(valid) ||
      new Set(value.entries.map((e) => e.deviceId)).size !==
        value.entries.length
    )
      throw Error();
    (storage ?? localStorage).setItem(
      wallStorageKey,
      JSON.stringify({
        version: 1,
        automatic: value.automatic === true,
        cellHeight: value.cellHeight,
        gridWidth: value.gridWidth,
        entries: value.entries.map(clean),
      }),
    );
    return "";
  } catch {
    return "Wall changes are not saved. Browser storage may be unavailable or full.";
  }
}

// Each tile reserves 52px for its title/actions and 16px for grid gutters.
export function fitWall(entries: WallEntry[], width: number, height: number) {
  const count = entries.filter((entry) => entry.included).length;
  let columns = 1,
    tile = 0;
  for (const cols of [1, 2, 3, 4]) {
    if (cols > Math.max(1, count) || (cols > 1 && width / cols < 280)) continue;
    const candidate = Math.min(
      width / cols,
      Math.max(
        280,
        ((height / Math.ceil(Math.max(1, count) / cols) - 68) * 4) / 3 + 16,
      ),
    );
    if (candidate > tile) {
      columns = cols;
      tile = candidate;
    }
  }
  let index = 0;
  return {
    width: tile * columns,
    cellHeight: (((tile - 16) * 3) / 4 + 68) / 4,
    entries: entries.map((entry) => {
      if (!entry.included) return entry;
      const i = index++;
      return {
        ...entry,
        x: (i % columns) * (12 / columns),
        y: Math.floor(i / columns) * 4,
        w: 12 / columns,
        h: 4,
      };
    }),
  };
}
