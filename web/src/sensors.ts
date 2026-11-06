export type Sensor = {
  detailOnly?: boolean;
  warning?: number;
  critical?: number;
  id: string;
  name: string;
  value: string;
  unit: string;
  state: string;
};

const units: Record<string, string> = {
  "degrees C": "°C",
  "degrees F": "°F",
  Volts: "V",
  Amps: "A",
  Watts: "W",
  discrete: "",
  unspecified: "",
};

export function sensorReading(sensor: Pick<Sensor, "value" | "unit">): string {
  const unit = units[sensor.unit] ?? sensor.unit;
  const raw =
    sensor.unit && sensor.value.endsWith(` ${sensor.unit}`)
      ? sensor.value.slice(0, -sensor.unit.length).trim()
      : sensor.value.trim();
  if (!raw || !Number.isFinite(Number(raw))) return raw || "Unavailable";
  const digits = unit === "RPM" ? 0 : unit === "V" || unit === "A" ? 2 : 1;
  return [
    new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
      Number(raw),
    ),
    unit,
  ]
    .filter(Boolean)
    .join(" ");
}

export const powerSupplies = (sensors: Sensor[]) =>
  sensors.filter((sensor) =>
    /power\s*supply|psu|pws|\bps\s*\d+\b/i.test(sensor.name),
  );

export function sensorGroup(sensor: Sensor) {
  const name = sensor.name;
  // Match hardware before units: DIMM voltage and CPU temperature belong to their components.
  if (
    /dimm|memory|\bmem\b|\bram\b|ecc|ddr|\bp[12][-_ ]?[a-h][1-4]\b/i.test(name)
  )
    return "sensor-memory";
  if (/fan|cooling|rpm/i.test(name + " " + sensor.unit)) return "sensor-fans";
  if (sensor.detailOnly) return "sensor-other";
  if (/cpu|processor|\bproc\b|vcore|vrm|^(?:Core|Package id) \d+$/i.test(name))
    return "sensor-cpu";
  if (powerSupplies([sensor]).length || /pwr|power|\bwatt/i.test(name))
    return "sensor-power";
  if (
    /drive|disk|hdd|ssd|nvme|raid|backplane|sas|sata|storage|\bbp\b/i.test(name)
  )
    return "sensor-storage";
  if (/\bnic\b|ethernet|network|\blan\d?\b|link/i.test(name))
    return "sensor-network";
  if (
    /system|board|inlet|exhaust|ambient|pch|chipset|battery|vbat|chassis|intrusion|voltage|\b\d+(\.\d+)?v\b/i.test(
      name,
    ) ||
    /degrees [cf]|volts|amps/i.test(sensor.unit)
  )
    return "sensor-board";
  return "sensor-other";
}
