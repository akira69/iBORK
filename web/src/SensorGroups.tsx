import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { DashboardGrid } from "./DashboardGrid";
import { catalog, type WidgetKind } from "./dashboard-layout";
import { panelLayout } from "./page-layouts";
import { sensorGroup, sensorReading, type Sensor } from "./sensors";

const order: WidgetKind[] = [
  "sensor-cpu",
  "sensor-memory",
  "sensor-fans",
  "sensor-power",
  "sensor-storage",
  "sensor-board",
  "sensor-network",
  "sensor-other",
];

export function SensorGroups({
  sensors,
  error,
  loading,
  storageKey,
  toolbarTarget,
  refresh,
}: {
  sensors?: Sensor[];
  error?: string;
  loading: boolean;
  storageKey: string;
  toolbarTarget: HTMLElement | null;
  refresh: () => void;
}) {
  const preferenceKey = storageKey + ":hide-unavailable";
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) === "true";
    } catch {
      return false;
    }
  });
  const [storageError, setStorageError] = useState("");
  const groups = order.filter((kind) =>
    sensors?.some((sensor) => sensorGroup(sensor) === kind),
  );
  const defaults = panelLayout(
    groups.map((kind, i) => {
      const count =
        sensors?.filter((sensor) => sensorGroup(sensor) === kind).length ?? 0;
      return [
        kind,
        (i % 3) * 4,
        Math.floor(i / 3) * 6,
        4,
        Math.min(6, Math.max(3, Math.ceil((count * 36 + 80) / 80))),
      ];
    }),
  );
  return (
    <section aria-label="System sensors">
      <div className="sensor-options">
        <label>
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => {
              setHidden(event.target.checked);
              try {
                localStorage.setItem(
                  preferenceKey,
                  String(event.target.checked),
                );
                setStorageError("");
              } catch {
                setStorageError(
                  "Preference not saved. Browser storage is unavailable.",
                );
              }
            }}
          />
          Hide unavailable
        </label>
        <button className="quiet" onClick={refresh}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {error && (
        <p role="status" className="notice">
          Readings are stale or unavailable: {error}
        </p>
      )}
      {storageError && <p role="status">{storageError}</p>}
      {groups.length ? (
        <DashboardGrid
          key={groups.join(":")}
          fixedLayout={defaults}
          storageKey={storageKey}
          toolbarTarget={toolbarTarget}
          renderWidget={(widget) => {
            const readings = (sensors ?? []).filter(
              (sensor) =>
                sensorGroup(sensor) === widget.kind &&
                (!hidden || sensor.state !== "unavailable"),
            );
            return (
              <div className="sensor-group">
                <table aria-label={catalog[widget.kind].title}>
                  <thead>
                    <tr>
                      <th>Sensor</th>
                      <th>Reading</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map((sensor, index) => (
                      <tr key={sensor.id || index}>
                        <td>
                          {sensor.name}
                          {sensor.warning != null && (
                            <small>
                              {" "}
                              · Warning{" "}
                              {sensorReading({
                                value: String(sensor.warning),
                                unit: sensor.unit,
                              })}
                            </small>
                          )}
                          {sensor.critical != null && (
                            <small>
                              {" "}
                              · Critical{" "}
                              {sensorReading({
                                value: String(sensor.critical),
                                unit: sensor.unit,
                              })}
                            </small>
                          )}
                        </td>
                        <td className="mono">
                          {error ? "Unavailable" : sensorReading(sensor)}
                        </td>
                        <td>
                          <span
                            className={`badge ${error ? "unavailable" : sensor.state}`}
                          >
                            <i />
                            {error ? "stale" : sensor.state}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!readings.length && (
                  <p className="small-note">Unavailable readings hidden.</p>
                )}
              </div>
            );
          }}
        />
      ) : (
        <p className="empty-data">
          {loading ? "Reading sensors…" : "No sensor readings available."}
        </p>
      )}
    </section>
  );
}
