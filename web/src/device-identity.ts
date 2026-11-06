export const iconKinds = [
  "automatic",
  "initials",
  "supermicro",
  "t320",
  "t440",
  "custom",
] as const;
export type Display = {
  name?: string;
  manufacturer?: string;
  model?: string;
  pinned?: boolean;
  autoConnect?: boolean;
  icon?: (typeof iconKinds)[number];
  iconText?: string;
  iconImage?: string;
};
export type ConsoleSource = "jetkvm" | "vnc" | "glinet";
export type Device = {
  hasManagement?: boolean;
  hasSensors?: boolean;
  hasEnergy?: boolean;
  consoleSources?: ConsoleSource[];
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  bmcHost: string;
  bmcPort: number;
  hasJetKVM: boolean;
  hasVNC?: boolean;
};
export const endpointKeyFor = (d: Device) =>
  d.hasManagement !== false ? d.bmcHost + ":" + d.bmcPort : "device:" + d.id;
export const dashboardKey = (d: Device) =>
  "jet-supermicro:dashboard:v1:" + endpointKeyFor(d);
export const displayKey = (device: Device) =>
  `jet-supermicro:display:v1:${device.bmcHost ? `${device.bmcHost}:${device.bmcPort}` : `device:${device.id}`}`;

export function identify(
  config: Display,
  fields: Record<string, string>,
  overrides: Display,
) {
  const entries = Object.entries(fields).map(([key, value]) => [
    key.replace(/[^a-z0-9]/gi, "").toLowerCase(),
    value,
  ]);
  const field = (...names: string[]) =>
    names
      .map(
        (name) =>
          entries.find(
            ([key, value]) =>
              (key === name || key === `fru0${name}`) && value.trim(),
          )?.[1],
      )
      .find(Boolean);
  const manufacturer =
    overrides.manufacturer ||
    config.manufacturer ||
    field(
      "boardmfg",
      "boardmanufacturer",
      "productmfg",
      "productmanufacturer",
      "manufacturer",
    ) ||
    "Unknown vendor";
  const model =
    overrides.model ||
    config.model ||
    field(
      "boardproduct",
      "boardproductname",
      "boardpartnumber",
      "productname",
      "board",
    ) ||
    "Model unavailable";
  const brand = /super\s*micro/i.test(manufacturer)
    ? "supermicro"
    : /\bdell\b/i.test(manufacturer)
      ? "dell"
      : null;
  return { manufacturer, model, brand };
}

export function readDisplay(
  key: string,
  storage?: Pick<Storage, "getItem">,
): Display {
  try {
    const raw = (storage ?? localStorage).getItem(key);
    if (!raw || raw.length > 100000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Display = {};
    for (const name of ["name", "manufacturer", "model"] as const) {
      const text = (value as Display)[name];
      if (typeof text === "string" && text.length <= 100)
        result[name] = text.trim();
    }
    if (typeof (value as Display).pinned === "boolean")
      result.pinned = (value as Display).pinned;
    if (typeof (value as Display).autoConnect === "boolean")
      result.autoConnect = (value as Display).autoConnect;
    const icon = (value as Display).icon;
    if (icon && iconKinds.includes(icon)) result.icon = icon;
    const text = (value as Display).iconText;
    if (typeof text === "string" && text.length <= 6)
      result.iconText = text.trim();
    const image = (value as Display).iconImage;
    if (
      typeof image === "string" &&
      image.length <= 65536 &&
      /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    )
      result.iconImage = image;
    return result;
  } catch {
    return {};
  }
}

export function writeDisplay(
  key: string,
  value: Display,
  storage?: Pick<Storage, "setItem">,
): string {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(value));
    return "";
  } catch {
    return "Display preferences were not saved. Browser storage is unavailable.";
  }
}

export function sourcesFor(device: Device): ConsoleSource[] {
  return (
    device.consoleSources ?? [
      ...(device.hasJetKVM ? ["jetkvm" as const] : []),
      ...(device.hasVNC ? ["vnc" as const] : []),
    ]
  );
}
