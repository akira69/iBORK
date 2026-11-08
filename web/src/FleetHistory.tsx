import { useMemo } from "react";
import { useElectricityRate } from "./ElectricityRate";
import { fleetHistory, type FleetReadings } from "./fleet-power";
import { PowerPlot } from "./PowerPlot";

export function FleetHistory({
  ids,
  readings,
  elapsed,
  names = {},
}: {
  ids: string[];
  readings: FleetReadings;
  elapsed: number;
  names?: Record<string, string>;
}) {
  const hour = 3600,
    minute = Math.floor(elapsed / 60000) * 60000;
  const history = useMemo(
    () => fleetHistory(ids, readings, hour, minute),
    [ids, readings, minute],
  );
  const {
    lines,
    contributors,
    start,
    coveredSeconds,
    kwh,
    coverage,
    historyIds,
    total,
    minReporting,
    maxReporting,
  } = history;
  const { rate } = useElectricityRate();
  const peak = lines.reduce(
    (highest, line) =>
      line.reduce((value, p) => Math.max(value, p.watts), highest),
    0,
  );
  const fmtWatts = (watts: number) =>
    `${watts.toLocaleString(undefined, { maximumFractionDigits: 1 })} W`;
  const partial = coverage < 1 ? " · Partial" : "";
  const reporting = `${minReporting === maxReporting ? maxReporting : `${minReporting}–${maxReporting}`} of ${total} reporting`;
  const time = (at: number) => new Date(at * 1000).toLocaleTimeString();
  const descriptions = lines.map(
    (line, i) =>
      `${contributors[i].length < total ? "Partial · " : ""}${contributors[i].length} of ${total} reporting: ${contributors[i].map((id) => names[id] ?? id).join(", ")} · ${time(line[0].at)}–${time(line.at(-1)!.at)}`,
  );
  const missing = [...new Set(ids)]
    .filter((id) => !historyIds.includes(id))
    .map((id) => {
      const reading = readings.get(id),
        data = reading?.data;
      const error = reading?.error || data?.error;
      let reason = "Awaiting power history";
      if (error) reason = `Collection failed: ${error}`;
      else if (data && !data.source && !data.samples.length)
        reason = "No power source";
      else if (data) {
        const samples = data.samples.filter(
          (p) => p.at >= start && p.at <= data.now,
        );
        reason = !samples.length
          ? "No samples in this window"
          : samples.length === 1
            ? "Awaiting sufficient samples"
            : "No valid sample intervals in this window";
      }
      return `${names[id] ?? id}: ${reason}`;
    });
  return (
    <div className="fleet-history">
      {coveredSeconds > 0 ? (
        <>
          <PowerPlot
            start={start}
            end={start + hour}
            label={`Available measured watts over the last hour, peak ${fmtWatts(peak)}, ${reporting}`}
            series={lines.map((points, i) => ({
              points,
              partial: contributors[i].length < total,
              name: `${contributors[i].length < total ? "Partial · " : ""}${contributors[i].length} of ${total} reporting`,
            }))}
          />
          <strong>{`Recorded energy${partial}: ${kwh.toFixed(4)} kWh`}</strong>
          {rate !== null && (
            <small>{`Cost of recorded energy${partial}: $${(kwh * rate).toFixed(2)}`}</small>
          )}
        </>
      ) : (
        <strong>Unavailable</strong>
      )}
      <small>{`Last hour · ${(100 * coverage).toFixed(1)}% measured coverage`}</small>
      <small>{`${historyIds.length} of ${total} servers have history${maxReporting ? ` · ${reporting}` : ""}`}</small>
      {(descriptions.length > 0 || missing.length > 0) && (
        <details>
          <summary>History details</summary>
          <ul>
            {descriptions.map((description, i) => (
              <li key={lines[i][0].at}>{description}</li>
            ))}
            {missing.map((description) => (
              <li key={description}>{description}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
