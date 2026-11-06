import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { DashboardGrid, type ScopedWidget } from "./DashboardGrid";
import { catalog, validDashboardSensorId } from "./dashboard-layout";
import type { Device, Display } from "./device-identity";
import type { PowerHistory } from "./energy";
import {
  fleetHistory,
  fleetPower,
  sampleStatus,
  type FleetReading,
  type FleetReadings,
} from "./fleet-power";
import { useElectricityRate } from "./ElectricityRate";
import { sensorReading, type Sensor } from "./sensors";
import { usePoll } from "./usePoll";
import "./FleetTelemetry.css";

type Fleet = { devices: Device[]; displays: Record<string, Display> };
type Group = { ids: string[]; readings: FleetReadings; elapsed: number };
type SensorResult = ReturnType<typeof usePoll<Sensor[]>>;
const hasEnergy = (d: Device) => d.hasEnergy ?? d.hasManagement !== false;
const hasSensors = (d: Device) => d.hasSensors ?? d.hasManagement !== false;
const fmtWatts = (value: number | null) =>
  value === null
    ? "Unavailable"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} W`;

function EnergyFeed({
  id,
  report,
}: {
  id: string;
  report: (id: string, reading: FleetReading) => void;
}) {
  const { data, error, received } = usePoll<PowerHistory>(
    `devices/${id}/energy`,
    60000,
    true,
    0,
    true,
  );
  useEffect(() => {
    if (data || error) report(id, { data, error, received });
  }, [id, data, error, received, report]);
  return null;
}
function SensorFeed({
  id,
  report,
}: {
  id: string;
  report: (id: string, result: SensorResult) => void;
}) {
  const result = usePoll<Sensor[]>(`devices/${id}/sensors`, 20000);
  useEffect(() => {
    report(id, result);
  }, [id, result, report]);
  return null;
}
function Current({ ids, readings, elapsed }: Group) {
  const { watts, reporting, total } = fleetPower(ids, readings, elapsed);
  return (
    <div className="compact-power">
      <strong>{fmtWatts(watts)}</strong>
      <small>
        {reporting} of {total} reporting
      </small>
    </div>
  );
}
function History({ ids, readings, elapsed }: Group) {
  const hour = 3600,
    minute = Math.floor(elapsed / 60000) * 60000;
  const { lines, start, coveredSeconds, kwh } = useMemo(
    () => fleetHistory(ids, readings, hour, minute),
    [ids, readings, minute],
  );
  const { rate } = useElectricityRate();
  const peak = lines.reduce(
    (highest, line) => line.reduce((v, p) => Math.max(v, p.watts), highest),
    0,
  );
  return (
    <div className="fleet-history">
      {coveredSeconds > 0 ? (
        <>
          <svg
            viewBox="0 0 320 100"
            role="img"
            aria-label={`Combined watts over the last hour, peak ${fmtWatts(peak)}`}
          >
            <path className="fleet-axis" d="M42 5V76H318" />
            <text x="0" y="12">
              {fmtWatts(peak)}
            </text>
            <text x="0" y="76">
              0 W
            </text>
            <text x="42" y="94">
              −60 min
            </text>
            <text x="318" y="94" textAnchor="end">
              Now
            </text>
            {lines.map((line) => (
              <polyline
                key={line[0].at}
                points={line
                  .map(
                    (p) =>
                      `${42 + (276 * (p.at - start)) / hour},${76 - (72 * p.watts) / Math.max(1, peak)}`,
                  )
                  .join(" ")}
              />
            ))}
          </svg>
          <strong>
            {kwh.toFixed(4)} kWh
            {rate !== null && ` · $${(kwh * rate).toFixed(2)}`}
          </strong>
        </>
      ) : (
        <strong>Unavailable</strong>
      )}
      <small>
        Last hour · {((100 * coveredSeconds) / hour).toFixed(1)}% common
        coverage
      </small>
    </div>
  );
}

function SensorWidget({
  result,
  sensorId,
}: {
  result?: SensorResult;
  sensorId?: string;
}) {
  const sensor = result?.data?.find((s) => s.id === sensorId);
  return (
    <div className="compact-power">
      <p>{sensor?.name ?? sensorId}</p>
      <strong>{sensor ? sensorReading(sensor) : "Unavailable"}</strong>
      {result?.error && <small>{result.error}</small>}
    </div>
  );
}

function FleetCatalog({
  devices,
  name,
  source,
  setSource,
  sensors,
  add,
  count,
}: {
  devices: Device[];
  name: (id: string) => string;
  source: string;
  setSource: (id: string) => void;
  sensors?: SensorResult;
  add: (widget: ScopedWidget) => void;
  count: number;
}) {
  const [members, setMembers] = useState<string[]>([]),
    [metric, setMetric] = useState("");
  const selected = devices.find((d) => d.id === source);
  const options = [
    ...(!selected || hasEnergy(selected)
      ? (["power-now", "power-hour"] as const).map((value) => ({
          value,
          label: catalog[value].title,
        }))
      : []),
    ...(selected && hasSensors(selected)
      ? (sensors?.data ?? [])
          .filter((s) => validDashboardSensorId(s.id))
          .map((s) => ({
            value: `sensor:${s.id}`,
            label: s.name,
          }))
      : []),
  ];
  const active =
    options.find((o) => o.value === metric)?.value ?? options[0]?.value;
  const ids = selected ? [selected.id] : members;
  return (
    <section
      className="widget-catalog fleet-catalog"
      aria-label="Widget catalog"
    >
      <h2>
        <Plus size={18} /> Add widget <small>{count}/24</small>
      </h2>
      <label>
        Source
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setMetric("");
          }}
        >
          <option value="">Combined power</option>
          {devices
            .filter((d) => hasEnergy(d) || hasSensors(d))
            .map((d) => (
              <option value={d.id} key={d.id}>
                {name(d.id)}
              </option>
            ))}
        </select>
      </label>
      {!selected && (
        <fieldset>
          <legend>Servers in group</legend>
          {devices.map((d) => (
            <label key={d.id}>
              <input
                type="checkbox"
                checked={members.includes(d.id)}
                onChange={(e) =>
                  setMembers(
                    e.target.checked
                      ? [...members, d.id]
                      : members.filter((id) => id !== d.id),
                  )
                }
              />
              {name(d.id)}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Metric
        <select
          value={active ?? ""}
          onChange={(e) => setMetric(e.target.value)}
        >
          {options.length ? (
            options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ) : (
            <option value="">No readings available</option>
          )}
        </select>
      </label>
      {selected && sensors?.error && <small>{sensors.error}</small>}
      <button
        disabled={!active || !ids.length || count >= 24}
        onClick={() => {
          if (active === "power-now" || active === "power-hour")
            add({ kind: active, deviceIds: ids });
          else if (active?.startsWith("sensor:"))
            add({ kind: "sensor", deviceIds: ids, sensorId: active.slice(7) });
        }}
      >
        <Plus size={16} />
        Add widget
      </button>
    </section>
  );
}

export function FleetTelemetry({
  devices,
  displays,
  view,
}: Fleet & { view: "Power Overview" | "Central Dashboard" }) {
  const [readings, setReadings] = useState(new Map<string, FleetReading>());
  const [sensors, setSensors] = useState(new Map<string, SensorResult>());
  const [source, setSource] = useState("");
  const [elapsed, setElapsed] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setElapsed(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const report = useCallback((id: string, reading: FleetReading) => {
    setReadings((prev) => new Map(prev).set(id, reading));
  }, []);
  const reportSensors = useCallback((id: string, result: SensorResult) => {
    setSensors((previous) => new Map(previous).set(id, result));
  }, []);
  const ids = useMemo(() => devices.map((d) => d.id), [devices]);
  const name = (id: string) => {
    const device = devices.find((d) => d.id === id);
    return device
      ? displays[id]?.name || device.name
      : `Removed server (${id})`;
  };
  const group = { ids, readings, elapsed };
  const energyFeeds = (members: string[]) =>
    devices
      .filter((device) => hasEnergy(device) && members.includes(device.id))
      .map((device) => (
        <EnergyFeed key={device.id} id={device.id} report={report} />
      ));
  return (
    <>
      {view === "Central Dashboard" ? (
        <DashboardGrid
          storageKey="ibork:fleet-dashboard:v1"
          fleet={{
            title: (w) =>
              `${w.deviceIds!.map(name).join(" + ")} · ${catalog[w.kind].title}`,
            feeds: (widgets, editing) => {
              const powered = widgets
                .filter((w) => w.kind !== "sensor")
                .flatMap((w) => w.deviceIds!);
              const watched = new Set(
                widgets
                  .filter((w) => w.kind === "sensor")
                  .map((w) => w.deviceIds![0]),
              );
              if (editing) watched.add(source);
              return (
                <>
                  {energyFeeds(powered)}
                  {devices
                    .filter((d) => watched.has(d.id) && hasSensors(d))
                    .map((d) => (
                      <SensorFeed key={d.id} id={d.id} report={reportSensors} />
                    ))}
                </>
              );
            },
            catalog: (add, count) => (
              <FleetCatalog
                devices={devices}
                name={name}
                source={source}
                setSource={setSource}
                sensors={sensors.get(source)}
                add={add}
                count={count}
              />
            ),
          }}
          renderWidget={(w) => {
            const members = w.deviceIds!;
            if (w.kind === "sensor") {
              const device = devices.find((d) => d.id === members[0]);
              return (
                <SensorWidget
                  result={
                    device && hasSensors(device)
                      ? sensors.get(device.id)
                      : undefined
                  }
                  sensorId={w.sensorId}
                />
              );
            }
            return w.kind === "power-hour" ? (
              <History {...group} ids={members} />
            ) : (
              <Current {...group} ids={members} />
            );
          }}
        />
      ) : (
        <section
          className="panel data-panel fleet-overview"
          aria-label="Power Overview"
        >
          {energyFeeds(ids)}
          <h2>Measured power</h2>
          <Current {...group} />
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Watts</th>
                <th>Source</th>
                <th>Sample age</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const read = readings.get(d.id),
                  { age, watts } = sampleStatus(read, elapsed);
                const error = read?.error || read?.data?.error;
                return (
                  <tr key={d.id}>
                    <th scope="row">{name(d.id)}</th>
                    <td>{fmtWatts(watts)}</td>
                    <td>
                      {read?.data?.source ||
                        (hasEnergy(d) ? "Awaiting source" : "No power source")}
                      {error && <small>Collection: {error}</small>}
                      {read?.data?.storageError && (
                        <small>Storage: {read.data.storageError}</small>
                      )}
                    </td>
                    <td>{age !== null && age >= 0 ? `${age} s` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h3>All servers · last hour</h3>
          <History {...group} />
        </section>
      )}
    </>
  );
}
