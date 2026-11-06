import {
  maxSampleGap,
  validInterval,
  wattsAt,
  type PowerHistory,
  type PowerSample,
} from "./energy";

export type FleetReading = {
  data?: PowerHistory;
  error?: string;
  received: number; // Monotonic browser time when the service returned its snapshot.
};
export type FleetReadings = ReadonlyMap<string, FleetReading>;
function serviceTime(reading: FleetReading, elapsed: number) {
  return (
    reading.data!.now +
    Math.floor(Math.max(0, elapsed - reading.received) / 1000)
  );
}
export function sampleStatus(
  reading: FleetReading | undefined,
  elapsed: number,
) {
  const data = reading?.data;
  const latest = data?.samples.at(-1);
  const age =
    reading && data && latest
      ? serviceTime(reading, elapsed) - latest.at
      : null;
  const fresh =
    latest &&
    data &&
    latest.at <= data.now &&
    age !== null &&
    age <= maxSampleGap &&
    !data.error &&
    !reading?.error;
  return { age, watts: fresh ? latest.watts : null };
}
export function fleetPower(
  ids: string[],
  readings: FleetReadings,
  elapsed: number,
) {
  let watts = 0,
    reporting = 0;
  const members = new Set(ids);
  for (const id of members) {
    const sample = sampleStatus(readings.get(id), elapsed);
    if (sample.watts === null) continue;
    reporting++;
    watts += sample.watts;
  }
  return { watts: reporting ? watts : null, reporting, total: members.size };
}

// Walk the sorted intervals together. Only an overlap shared by every server contributes.
export function fleetHistory(
  ids: string[],
  readings: FleetReadings,
  seconds: number,
  elapsed = 0,
) {
  const members = [...new Set(ids)].map((id) => readings.get(id));
  const now = members.reduce(
    (latest, r) =>
      r?.data ? Math.max(latest, serviceTime(r, elapsed)) : latest,
    0,
  );
  const start = now - seconds;
  const lines: PowerSample[][] = [];
  let wattSeconds = 0,
    coveredSeconds = 0;
  const cursors = members.map((h) => {
    const samples = h?.data?.samples ?? [];
    const first = samples.findIndex((p) => p.at >= start);
    return {
      samples,
      through: h?.data?.now ?? 0,
      i: first < 0 ? samples.length : Math.max(1, first),
    };
  });
  while (
    cursors.length &&
    cursors.every(
      (c) => c.i < c.samples.length && c.samples[c.i].at <= c.through,
    )
  ) {
    const pairs = cursors.map(
      (c) => [c.samples[c.i - 1], c.samples[c.i]] as const,
    );
    const end = Math.min(...pairs.map(([, b]) => b.at));
    const left = Math.max(start, ...pairs.map(([a]) => a.at)),
      right = Math.min(now, end);
    if (right > left && pairs.every(([a, b]) => validInterval(a, b))) {
      const sumAt = (t: number) =>
        pairs.reduce((sum, [a, b]) => sum + wattsAt(a, b, t), 0);
      const a = { at: left, watts: sumAt(left) },
        b = { at: right, watts: sumAt(right) };
      const last = lines.at(-1);
      if (last?.at(-1)?.at === left) last.push(b);
      else lines.push([a, b]);
      wattSeconds += ((a.watts + b.watts) / 2) * (right - left);
      coveredSeconds += right - left;
    }
    for (const c of cursors) if (c.samples[c.i].at === end) c.i++;
  }
  return { lines, start, now, coveredSeconds, kwh: wattSeconds / 3600000 };
}
