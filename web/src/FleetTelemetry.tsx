import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { DashboardGrid, type ScopedWidget } from "./DashboardGrid";
import { catalog, validDashboardSensorId } from "./dashboard-layout";
import { sourcesFor, type Device, type Display } from "./device-identity";
import type { PowerHistory } from "./energy";
import {
  fleetPower,
  sampleStatus,
  type FleetReading,
  type FleetReadings,
} from "./fleet-power";
import { FleetHistory } from "./FleetHistory";
import { ScopedKVM } from "./ScopedKVM";
import { SensorReadings } from "./SensorReadings";
import { sensorGroup, type Sensor } from "./sensors";
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
    <div className="fleet-current">
      <strong>{fmtWatts(watts)}</strong>
      <small>
        {reporting} of {total} reporting
      </small>
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
  const availableSensors = (sensors?.data ?? []).filter((s) =>
    validDashboardSensorId(s.id),
  );
  const cpuTemperatures = availableSensors.filter(
    (s) =>
      sensorGroup(s) === "sensor-cpu" &&
      ["degrees C", "degrees F", "°C", "°F"].includes(s.unit),
  );
  const fans = availableSensors.filter((s) => s.unit === "RPM");
  const options = [
    ...(!selected || hasEnergy(selected)
      ? (["power-now", "power-hour"] as const).map((value) => ({
          value,
          label: catalog[value].title,
        }))
      : []),
    ...(selected && hasSensors(selected)
      ? [
          ...(cpuTemperatures.length
            ? [{ value: "cpu-temperatures", label: "CPU temperatures" }]
            : []),
          ...(fans.length
            ? [{ value: "highest-fan", label: "Highest fan RPM" }]
            : []),
          ...availableSensors.map((s) => ({
            value: `sensor:${s.id}`,
            label: s.name,
          })),
        ]
      : []),
    ...(selected
      ? sourcesFor(selected).map((value) => ({
          value,
          label: catalog[value].title,
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
            .filter(
              (d) => hasEnergy(d) || hasSensors(d) || sourcesFor(d).length,
            )
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
          else if (active === "cpu-temperatures" || active === "highest-fan")
            add({
              kind: "sensor",
              deviceIds: ids,
              sensorIds: (active === "highest-fan" ? fans : cpuTemperatures)
                .slice(0, 64)
                .map((s) => s.id),
              title:
                active === "highest-fan" ? "Highest fan" : "CPU temperatures",
              ...(active === "highest-fan" ? { aggregate: "max" } : {}),
            });
          else if (
            active === "jetkvm" ||
            active === "vnc" ||
            active === "glinet"
          )
            add({ kind: active, deviceIds: ids });
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
  const names = Object.fromEntries(
    devices.map((device) => [device.id, name(device.id)]),
  );
  const energyFeeds = (members: string[]) =>
    devices
      .filter((device) => hasEnergy(device) && members.includes(device.id))
      .map((device) => (
        <EnergyFeed key={device.id} id={device.id} report={report} />
      ));
  return (
    <section aria-label={view}>
      <DashboardGrid
        key={view}
        dashboardTitle={view}
        storageKey={
          view === "Central Dashboard"
            ? "ibork:fleet-dashboard:v1"
            : "ibork:power-overview:v1"
        }
        initialLayout={
          view === "Power Overview"
            ? {
                version: 1,
                widgets: [
                  {
                    id: "fleet-current",
                    kind: "power-now",
                    deviceIds: ids,
                    title: "Current measured power",
                    x: 0,
                    y: 0,
                    w: 4,
                    h: 1,
                  },
                  {
                    id: "fleet-hour",
                    kind: "power-hour",
                    deviceIds: ids,
                    x: 4,
                    y: 0,
                    w: 8,
                    h: 4,
                  },
                ],
              }
            : undefined
        }
        fleet={{
          title: (w) =>
            `${w.deviceIds!.map(name).join(" + ")} · ${w.title || catalog[w.kind].title}`,
          feeds: (widgets, editing) => {
            const powered = widgets
              .filter((w) => w.kind === "power-now" || w.kind === "power-hour")
              .flatMap((w) => w.deviceIds!);
            const watched = new Set(
              widgets
                .filter((w) => w.kind === "sensor")
                .map((w) => w.deviceIds![0]),
            );
            if (editing) watched.add(source);
            return (
              <>
                {view === "Central Dashboard" && energyFeeds(powered)}
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
        renderWidget={(w, editing) => {
          const members = w.deviceIds!;
          const device = devices.find((d) => d.id === members[0]);
          if (w.kind === "jetkvm" || w.kind === "vnc" || w.kind === "glinet")
            return (
              <ScopedKVM device={device} kind={w.kind} editing={editing} />
            );
          if (w.kind === "sensor") {
            const result =
              device && hasSensors(device) ? sensors.get(device.id) : undefined;
            return (
              <SensorReadings
                widget={w}
                sensors={result?.data}
                error={result?.error}
                editing={editing}
              />
            );
          }
          return w.kind === "power-hour" ? (
            <FleetHistory {...group} ids={members} names={names} />
          ) : (
            <Current {...group} ids={members} />
          );
        }}
      />
      {view === "Power Overview" && (
        <section
          className="panel data-panel fleet-overview"
          aria-label="Power sources"
        >
          {energyFeeds(ids)}
          <h2>Measured power</h2>
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
                  <tr key={d.id} role="row">
                    <th scope="row" role="rowheader">
                      {name(d.id)}
                    </th>
                    <td role="cell">
                      <span className="fleet-cell-label" aria-hidden="true">
                        Watts
                      </span>
                      {fmtWatts(watts)}
                    </td>
                    <td role="cell">
                      <span className="fleet-cell-label" aria-hidden="true">
                        Source
                      </span>
                      <span>
                        {read?.data?.source ||
                          (hasEnergy(d)
                            ? "Awaiting source"
                            : "No power source")}
                        {error && <small>Collection: {error}</small>}
                        {read?.data?.storageError && (
                          <small>Storage: {read.data.storageError}</small>
                        )}
                      </span>
                    </td>
                    <td role="cell">
                      <span className="fleet-cell-label" aria-hidden="true">
                        Sample age
                      </span>
                      {age !== null && age >= 0 ? `${age} s` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
