import { useEffect, useMemo, useReducer } from "react";
import { PowerPlot } from "./PowerPlot";
import { sampleStatus } from "./fleet-power";
import { type usePoll } from "./usePoll";
import { useElectricityRate } from "./ElectricityRate";
import {
  forecast,
  maxSampleGap,
  summarize,
  windows,
  type PowerHistory,
} from "./energy";

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value,
  );
const watts = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toFixed(1)} W`;
const timestamp = (value: number | undefined) =>
  value === undefined ? "No samples" : new Date(value * 1000).toLocaleString();
export function PowerUsage({
  history,
  mode,
}: {
  history: ReturnType<typeof usePoll<PowerHistory>>;
  mode?:
    | "power-now"
    | "energy-cost"
    | "statistics"
    | "hour"
    | "day"
    | "week"
    | "projections";
}) {
  const { rate } = useElectricityRate();
  const rateText =
    rate === null ? "Electricity rate unavailable" : `$${rate}/kWh`;
  const data = history.data;
  const summaries = useMemo(
    () =>
      windows.map((window) =>
        summarize(data?.samples ?? [], data?.now ?? 0, window.seconds),
      ),
    [data],
  );
  const latest = data?.samples.at(-1);
  const current =
    sampleStatus(history, performance.now()).watts !== null
      ? latest
      : undefined;
  const [, refresh] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!latest || !data) return;
    const expires =
      history.received + (maxSampleGap + 1 - (data.now - latest.at)) * 1000;
    const remaining = expires - performance.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(refresh, Math.ceil(remaining));
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [data, latest, history.received]);
  const peaks = summaries[2];
  if (mode === "power-now" || mode === "energy-cost") {
    const measured = summaries[1];
    return (
      <section className="compact-power">
        <p>
          {mode === "power-now"
            ? "Current draw"
            : "Measured cost · last 24 hours"}
        </p>
        <strong>
          {mode === "power-now"
            ? watts(current?.watts)
            : measured.coveredSeconds && rate !== null
              ? dollars(measured.kwh * rate)
              : "—"}
        </strong>
        <small>
          {mode === "power-now"
            ? current
              ? `Sampled ${timestamp(current.at)}`
              : "Awaiting a fresh power sample"
            : `${measured.kwh.toFixed(3)} kWh · ${(measured.coverage * 100).toFixed(1)}% coverage${measured.coverage < 0.999 ? " · partial" : ""}`}
        </small>
        {mode === "energy-cost" && (
          <small>
            {rateText} · set the rate in iBORK settings. Gaps are excluded.
          </small>
        )}
        {(history.error || data?.error || data?.storageError) && (
          <p role="status">
            {history.error ?? data?.error ?? data?.storageError}
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="power-usage" aria-label="Power consumption">
      {(!mode || mode === "statistics") && (
        <div className="panel data-panel">
          <div className="data-heading">
            <div>
              <h2>Power consumption</h2>
              <p>Live system power, recorded history and electricity cost.</p>
            </div>
            <p className="small-note">{rateText} · change in iBORK settings</p>
          </div>
          {(history.error || data?.error) && (
            <p role="status" className="notice">
              {history.error ?? data?.error}{" "}
              {data?.samples.length
                ? `Previous history retained; snapshot ${timestamp(data.now)}.`
                : "No history available yet."}
            </p>
          )}
          {data?.storageError && (
            <p role="status" className="notice">
              {data.storageError}
            </p>
          )}
          <div className="energy-cards">
            <div>
              <p>Current draw</p>
              <strong>{watts(current?.watts)}</strong>
              <small>
                {current
                  ? `Sampled ${timestamp(current.at)}`
                  : "Awaiting a fresh power sample"}
              </small>
            </div>
            <div>
              <p>Highest sampled · 7 days</p>
              <strong>{watts(peaks.maximum?.watts)}</strong>
              <small>{timestamp(peaks.maximum?.at)}</small>
            </div>
            <div>
              <p>Lowest sampled · 7 days</p>
              <strong>{watts(peaks.minimum?.watts)}</strong>
              <small>{timestamp(peaks.minimum?.at)}</small>
            </div>
          </div>
          <div className="energy-table">
            <table>
              <caption>Power statistics and cost of covered time</caption>
              <thead>
                <tr>
                  <th>Statistic</th>
                  {windows.map((window) => (
                    <th key={window.name}>{window.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["average", "minimum", "maximum"] as const).map((stat) => (
                  <tr key={stat}>
                    <th className={`legend-${stat}`}>
                      {stat === "average"
                        ? "Time-weighted average"
                        : `Sampled ${stat}`}
                    </th>
                    {summaries.map((summary, i) => (
                      <td key={i}>
                        {watts(
                          stat === "average"
                            ? summary.average
                            : summary[stat]?.watts,
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>Measured energy</th>
                  {summaries.map((s, i) => (
                    <td key={i}>
                      {s.coveredSeconds ? `${s.kwh.toFixed(4)} kWh` : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>Cost of covered time</th>
                  {summaries.map((s, i) => (
                    <td key={i} data-testid={`energy-cost-${i}`}>
                      {rate !== null && s.coveredSeconds
                        ? dollars(s.kwh * rate)
                        : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>Window coverage</th>
                  {summaries.map((s, i) => (
                    <td key={i}>
                      {(s.coverage * 100).toFixed(1)}%
                      {s.coverage < 0.999 ? " · partial" : ""}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small-note">
            Energy and cost cover only intervals between readings no more than
            150 seconds apart. Gaps are not filled with zero. History starts
            when collection is enabled; peaks are sampled, not instantaneous
            hardware extrema.
          </p>
        </div>
      )}
      {(!mode || ["hour", "day", "week"].includes(mode)) && (
        <div className="energy-charts">
          {windows.map(
            (window, i) =>
              (!mode || ["hour", "day", "week"][i] === mode) && (
                <PowerChart
                  key={window.name}
                  name={window.name}
                  summary={summaries[i]}
                  now={data?.now ?? Date.now() / 1000}
                  seconds={window.seconds}
                />
              ),
          )}
        </div>
      )}
      {(!mode || mode === "projections") && (
        <div className="panel data-panel">
          <h3>At the current load · projections</h3>
          <p className="small-note">
            Assumes the latest measured load stays constant for the full period.
            These are forecasts, not historical charges.
          </p>
          <div className="energy-projections">
            <span>
              24 hours{" "}
              <strong data-testid="daily-projection">
                {current && rate !== null
                  ? dollars(forecast(current.watts, rate, 24))
                  : "—"}
              </strong>
            </span>
            <span>
              30 days{" "}
              <strong>
                {current && rate !== null
                  ? dollars(forecast(current.watts, rate, 720))
                  : "—"}
              </strong>
            </span>
          </div>
          <p className="small-note">
            {data?.source ?? "Waiting for the history collector…"}
          </p>
        </div>
      )}
    </section>
  );
}

function PowerChart({
  name,
  summary,
  now,
  seconds,
}: {
  name: string;
  summary: ReturnType<typeof summarize>;
  now: number;
  seconds: number;
}) {
  const series = (["average", "minimum", "maximum"] as const).map((key) => ({
    name:
      key === "average" ? "Average" : key === "minimum" ? "Minimum" : "Maximum",
    color:
      key === "minimum" ? "#86baff" : key === "maximum" ? "#f1ca83" : undefined,
    points: summary.buckets.map((bucket, i) => ({
      at: now - seconds + ((i + 0.5) * seconds) / 12,
      watts: bucket?.[key] ?? null,
    })),
  }));
  return (
    <section className="panel power-chart">
      <h3>{name}</h3>
      <PowerPlot
        series={series}
        start={now - seconds}
        end={now}
        label={`${name} power consumption in watts`}
      />
      {!summary.minimum && <p className="small-note">Waiting for samples</p>}
      <p className="small-note">
        Bucket minimum / sample average / maximum. Empty buckets are gaps.
      </p>
    </section>
  );
}
