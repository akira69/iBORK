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

// Split at sample boundaries; missing members never erase another server's history.
export function fleetHistory(
  ids: string[],
  readings: FleetReadings,
  seconds: number,
  elapsed = 0,
) {
  const members = [...new Set(ids)];
  const now = members.reduce((latest, id) => {
    const reading = readings.get(id);
    return reading?.data
      ? Math.max(latest, serviceTime(reading, elapsed))
      : latest;
  }, 0);
  const start = now - seconds;
  type Pair = readonly [PowerSample, PowerSample];
  const events: { at: number; id: string; pair: Pair | null }[] = [];
  const historyIds: string[] = [];
  for (const id of members) {
    const data = readings.get(id)?.data;
    if (!data) continue;
    const before = events.length;
    for (let i = 1; i < data.samples.length; i++) {
      const a = data.samples[i - 1],
        b = data.samples[i];
      if (
        !validInterval(a, b) ||
        b.at > data.now ||
        !Number.isFinite(a.watts) ||
        !Number.isFinite(b.watts) ||
        a.watts < 0 ||
        b.watts < 0
      )
        continue;
      const left = Math.max(start, a.at),
        right = Math.min(now, b.at);
      if (right <= left) continue;
      events.push(
        { at: left, id, pair: [a, b] },
        { at: right, id, pair: null },
      );
    }
    if (events.length > before) historyIds.push(id);
  }
  // End an old interval before starting the next at the same timestamp.
  events.sort((a, b) => a.at - b.at || Number(!!a.pair) - Number(!!b.pair));
  const active = new Map<string, Pair>();
  const lines: PowerSample[][] = [],
    contributors: string[][] = [];
  let wattSeconds = 0,
    coveredSeconds = 0,
    serverSeconds = 0;
  let minReporting = members.length,
    maxReporting = 0;
  for (let i = 0; i < events.length;) {
    const left = events[i].at;
    do {
      const { id, pair } = events[i++];
      if (pair) active.set(id, pair);
      else active.delete(id);
    } while (i < events.length && events[i].at === left);
    if (!active.size || i === events.length) continue;
    const right = events[i].at;
    const ids = members.filter((id) => active.has(id));
    const sumAt = (at: number) =>
      [...active.values()].reduce((sum, [a, b]) => sum + wattsAt(a, b, at), 0);
    const a = { at: left, watts: sumAt(left) },
      b = { at: right, watts: sumAt(right) };
    const last = lines.at(-1),
      previous = contributors.at(-1);
    if (
      last?.at(-1)?.at === left &&
      previous?.length === ids.length &&
      previous.every((id, i) => id === ids[i])
    )
      last.push(b);
    else {
      lines.push([a, b]);
      contributors.push(ids);
    }
    wattSeconds += ((a.watts + b.watts) / 2) * (right - left);
    coveredSeconds += right - left;
    serverSeconds += (right - left) * active.size;
    minReporting = Math.min(minReporting, active.size);
    maxReporting = Math.max(maxReporting, active.size);
  }
  return {
    lines,
    contributors,
    start,
    now,
    coveredSeconds,
    serverSeconds,
    kwh: wattSeconds / 3600000,
    coverage:
      members.length && seconds > 0
        ? serverSeconds / (members.length * seconds)
        : 0,
    historyIds,
    total: members.length,
    minReporting: maxReporting ? minReporting : 0,
    maxReporting,
  };
}
