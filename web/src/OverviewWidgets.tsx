import type { ReactNode } from "react";
import { powerSupplies, sensorReading, type Sensor } from "./sensors";
import "./OverviewWidgets.css";

type LoadState = { error?: string; loading?: boolean };

function OverviewFrame({
  error,
  loading,
  children,
}: LoadState & { children: ReactNode }) {
  return (
    <div className="overview-widget">
      {error ? (
        <p className="notice" role="status">
          Unavailable · {error}
        </p>
      ) : loading ? (
        <p className="empty-data" role="status">
          Loading…
        </p>
      ) : (
        children
      )}
    </div>
  );
}

export function SensorOverview({
  kind,
  sensors,
  error,
  loading,
}: LoadState & {
  kind: "fans" | "temperatures" | "psu" | "alerts";
  sensors: Sensor[];
}) {
  const selected =
    kind === "psu"
      ? powerSupplies(sensors)
      : sensors.filter((sensor) =>
          kind === "fans"
            ? /^RPM$/i.test(sensor.unit)
            : kind === "temperatures"
              ? /^(degrees [CF]|°[CF])$/i.test(sensor.unit)
              : sensor.state === "warning" || sensor.state === "critical",
        );
  const unknown = sensors.filter(
    (sensor) => !["ok", "warning", "critical"].includes(sensor.state),
  ).length;
  return (
    <OverviewFrame error={error} loading={loading}>
      {selected.length ? (
        <dl className="overview-readings">
          {selected.map((sensor, index) => (
            <div key={sensor.id || index}>
              <dt>{sensor.name}</dt>
              <dd>
                <strong>{sensorReading(sensor)}</strong>
                <span className={`badge ${sensor.state}`}>
                  {sensor.state || "Unknown"}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="empty-data">
          {kind === "alerts" && sensors.length
            ? "No warnings or critical states reported."
            : "No readings reported."}
        </p>
      )}
      {kind === "alerts" && unknown > 0 && (
        <p className="small-note">
          {unknown} sensor {unknown === 1 ? "state is" : "states are"}{" "}
          unavailable or unclassified.
        </p>
      )}
    </OverviewFrame>
  );
}

type EventEntry = {
  id: string;
  timestamp: string;
  sensor: string;
  message: string;
  state: string;
};

export function RecentEvents({
  events,
  error,
  loading,
}: LoadState & { events: EventEntry[] }) {
  const recent = [...events]
    .sort(
      (a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0),
    )
    .slice(0, 8);
  return (
    <OverviewFrame error={error} loading={loading}>
      {recent.length ? (
        <>
          <ol className="overview-events">
            {recent.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.sensor || "Unspecified sensor"}</strong>
                  <span className={`badge ${event.state}`}>
                    {event.state || "Unknown"}
                  </span>
                </div>
                <p>{event.message}</p>
                <small>{event.timestamp || "Time unavailable"}</small>
              </li>
            ))}
          </ol>
          <p className="small-note">
            Showing {recent.length} of {events.length} reported events, newest
            dated entries first.
          </p>
        </>
      ) : (
        <p className="empty-data">No events reported.</p>
      )}
    </OverviewFrame>
  );
}

export function InventoryOverview({
  inventory,
  error,
  loading,
}: LoadState & { inventory?: { fields: Record<string, string> } }) {
  const fields = Object.entries(inventory?.fields ?? {});
  return (
    <OverviewFrame error={error} loading={loading}>
      {fields.length ? (
        <dl className="overview-readings">
          {fields.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value || "Unavailable"}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="empty-data">No inventory reported.</p>
      )}
    </OverviewFrame>
  );
}

export function ConnectionOverview({
  connections,
  error,
  loading,
}: LoadState & {
  connections: { name: string; status: string; detail?: string }[];
}) {
  return (
    <OverviewFrame error={error} loading={loading}>
      {connections.length ? (
        <dl className="overview-readings">
          {connections.map((connection) => (
            <div key={connection.name}>
              <dt>{connection.name}</dt>
              <dd>
                <strong>{connection.status}</strong>
                {connection.detail && <small>{connection.detail}</small>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="empty-data">No connections configured.</p>
      )}
    </OverviewFrame>
  );
}
