import { sourcesFor, type Device } from "./device-identity";

export const tabs = [
  "Console",
  "Power usage",
  "Sensors",
  "Cooling",
  "Terminals",
  "Events",
  "Inventory",
  "Boot",
  "Server settings",
] as const;
export type Tab = (typeof tabs)[number] | "iBORK settings" | "Information";
export type Navigation = {
  deviceId: string;
  tab: Tab;
  view: "server" | "wall";
};
export const navigationKey = "ibork:navigation:v1";

export function defaultDeviceTab(device: Device): Tab {
  if (device.hasManagement !== false || sourcesFor(device).length)
    return "Console";
  if (device.hasSensors) return "Sensors";
  if (device.hasEnergy) return "Power usage";
  return "Console";
}

export function supportsTab(device: Device, tab: Tab) {
  if (tab === "Power usage")
    return device.hasEnergy ?? device.hasManagement !== false;
  if (tab === "Sensors")
    return device.hasSensors ?? device.hasManagement !== false;
  if (device.hasManagement !== false) return true;
  if (tab === "Console") return defaultDeviceTab(device) === "Console";
  return ["Server settings", "iBORK settings", "Information"].includes(tab);
}

export function readNavigation(devices: Device[]): Navigation {
  const fallback: Navigation = {
    deviceId: devices[0]?.id ?? "",
    tab: "Information",
    view: "server",
  };
  try {
    const raw = localStorage.getItem(navigationKey);
    if (!raw || raw.length > 2048) return fallback;
    const value = JSON.parse(raw) as Navigation | null;
    if (
      !value ||
      ![...tabs, "iBORK settings", "Information"].includes(value.tab)
    )
      return fallback;
    if (value.view !== "server" && value.view !== "wall") return fallback;
    const device = devices.find((item) => item.id === value.deviceId);
    if (!device) return fallback;
    if (globalThis.location?.hash.startsWith("#guide-"))
      return { ...fallback, deviceId: device.id };
    const tab = supportsTab(device, value.tab)
      ? value.tab
      : defaultDeviceTab(device);
    return { deviceId: device.id, tab, view: value.view };
  } catch {
    return fallback;
  }
}

export function writeNavigation(value: Navigation) {
  if (
    globalThis.location?.hash.startsWith("#guide-") &&
    (value.view !== "server" || value.tab !== "Information")
  )
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  try {
    localStorage.setItem(navigationKey, JSON.stringify(value));
  } catch {
    // Navigation must still work when browser storage is unavailable.
  }
}
