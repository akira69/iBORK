import { selectedSensors, type DashboardWidget } from "./dashboard-layout";
import { sensorReading, type Sensor } from "./sensors";
import "./SensorReadings.css";

export function SensorReadings({
  widget,
  sensors,
  error,
  editing = false,
}: {
  widget: Pick<
    DashboardWidget,
    "sensorId" | "sensorIds" | "sensorMode" | "aggregate"
  >;
  sensors?: Sensor[];
  error?: string;
  editing?: boolean;
}) {
  const selected = selectedSensors(widget);
  let rows = selected.map((id) => ({
    id,
    sensor: sensors?.find((s) => s.id === id),
  }));
  let detail: string | undefined;
  if (widget.aggregate === "max") {
    const valid = rows.flatMap(({ sensor }) => {
      if (!sensor || sensor.unit !== "RPM" || sensor.state === "unavailable")
        return [];
      const raw = sensor.value.replace(/\s+RPM$/, "").trim();
      const rpm = Number(raw);
      return raw !== "" && Number.isFinite(rpm) && rpm >= 0
        ? [{ sensor, rpm }]
        : [];
    });
    const highest = valid.reduce<(typeof valid)[number] | undefined>(
      (best, row) => (!best || row.rpm > best.rpm ? row : best),
      undefined,
    );
    rows = [{ id: "highest-fan", sensor: highest?.sensor }];
    detail = `${error ? 0 : valid.length} of ${selected.length} reporting`;
  }
  return (
    <div className="measurement-readings">
      {!selected.length && (
        <p className="empty-data">
          {editing
            ? "Choose readings for this widget."
            : "Edit layout to choose readings."}
        </p>
      )}
      {selected.length > 0 &&
        rows.map(({ id, sensor }) => {
          const status = error || !sensor ? "unavailable" : sensor.state;
          return (
            <article className={`measurement-reading ${status}`} key={id}>
              <strong>
                {error || !sensor ? "Unavailable" : sensorReading(sensor)}
              </strong>
              <span>
                {sensor?.name ??
                  (widget.aggregate === "max" ? "Highest fan" : id)}
              </span>
              <small title={error}>
                {detail ?? (status === "ok" ? "OK" : status)}
              </small>
            </article>
          );
        })}
      {error && <small className="measurement-error">{error}</small>}
    </div>
  );
}
