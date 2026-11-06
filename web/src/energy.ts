export type PowerSample = { at: number; watts: number };
export type PowerHistory = {
  samples: PowerSample[];
  now: number;
  source: string;
  error?: string;
  storageError?: string;
};
export const maxSampleGap = 150;
export function validInterval(a: PowerSample, b: PowerSample) {
  return b.at > a.at && b.at - a.at <= maxSampleGap;
}
export function wattsAt(a: PowerSample, b: PowerSample, t: number) {
  return a.watts + ((b.watts - a.watts) * (t - a.at)) / (b.at - a.at);
}
export const windows = [
  { name: "Last hour", seconds: 3600 },
  { name: "Last 24 hours", seconds: 86400 },
  { name: "Last 7 days", seconds: 604800 },
];
export function tariff(value: string): number | null {
  if (!/^\d*\.?\d+(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000
    ? parsed
    : null;
}
export function forecast(watts: number, rate: number, hours: number) {
  return (watts / 1000) * hours * rate;
}
export function summarize(
  samples: PowerSample[],
  now: number,
  seconds: number,
) {
  const start = now - seconds;
  let wattSeconds = 0,
    coveredSeconds = 0,
    minimum: PowerSample | null = null,
    maximum: PowerSample | null = null;
  const bins: Array<PowerSample[]> = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    if (p.at > now) continue;
    if (p.at >= start) {
      if (!minimum || p.watts < minimum.watts) minimum = p;
      if (!maximum || p.watts > maximum.watts) maximum = p;
      bins[Math.min(11, Math.floor(((p.at - start) / seconds) * 12))].push(p);
    }
    const prev = samples[i - 1];
    if (!prev || !validInterval(prev, p)) continue;
    const left = Math.max(start, prev.at),
      right = Math.min(now, p.at);
    if (right <= left) continue;
    wattSeconds +=
      ((wattsAt(prev, p, left) + wattsAt(prev, p, right)) / 2) * (right - left);
    coveredSeconds += right - left;
  }
  const buckets = bins.map((bin) =>
    bin.length
      ? {
          minimum: Math.min(...bin.map((p) => p.watts)),
          maximum: Math.max(...bin.map((p) => p.watts)),
          average: bin.reduce((sum, p) => sum + p.watts, 0) / bin.length,
        }
      : null,
  );
  return {
    minimum,
    maximum,
    average: coveredSeconds ? wattSeconds / coveredSeconds : null,
    kwh: wattSeconds / 3600000,
    coveredSeconds,
    coverage: coveredSeconds / seconds,
    buckets,
  };
}
