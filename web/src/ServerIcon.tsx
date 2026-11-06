import type { Device, Display } from "./device-identity";
import supermicro from "./assets/supermicro.svg";
import t320 from "./assets/t320.png";
import t440 from "./assets/t440.png";

export function resolveServerIcon(device: Device, display: Display = {}) {
  let kind = display.icon ?? "automatic";
  if (kind === "automatic") {
    const identity = [
      display.manufacturer,
      display.model,
      device.manufacturer,
      device.model,
      device.name,
    ].join(" ");
    kind = /\bT320\b/i.test(identity)
      ? "t320"
      : /\bT440\b/i.test(identity)
        ? "t440"
        : /super\s*micro/i.test(identity)
          ? "supermicro"
          : "initials";
  }
  const source =
    kind === "custom"
      ? display.iconImage
      : kind === "supermicro"
        ? supermicro
        : kind === "t320"
          ? t320
          : kind === "t440"
            ? t440
            : undefined;
  const defaultLabel = kind === "t320" ? "T320" : kind === "t440" ? "T440" : "";
  const label = display.iconText ?? defaultLabel;
  const shortLabel = [
    ...(label.trim() || defaultLabel || display.name || device.name),
  ]
    .slice(0, 6)
    .join("");
  const initials = [...(display.name || device.name)]
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return { kind, source, label, shortLabel, initials };
}

export function ServerIcon({
  device,
  display,
}: {
  device: Device;
  display?: Display;
}) {
  const { kind, source, label, initials } = resolveServerIcon(device, display);
  return (
    <span className="server-icon" aria-hidden="true">
      <span
        className={`server-icon-circle ${kind === "supermicro" ? "server-icon-logo" : ""}`}
      >
        {source ? <img src={source} alt="" /> : initials}
      </span>
      {label && <span className="server-icon-label">{label}</span>}
    </span>
  );
}
