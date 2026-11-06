import { useEffect, useState, type FormEvent } from "react";
import { Monitor } from "lucide-react";
import { api, APIError } from "./api";
import type { Workspace } from "./DeviceWorkspace";
import { panelIcon } from "./panel-icon";

type Period = { start: number; brightness: number };
type Schedule = { revision: number; periods: Period[] };

function PeriodFields({ period, index }: { period: Period; index: number }) {
  const [mode, setMode] = useState(
    period.brightness === 0 ? "0" : period.brightness === 100 ? "100" : "dim",
  );
  const time = [Math.floor(period.start / 60), period.start % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return (
    <fieldset className="panel-period" aria-label={`Period ${index + 1}`}>
      <label>
        Start time
        <input type="time" name="start" defaultValue={time} required />
      </label>
      <label>
        Display
        <select
          name="mode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="0">Screen off</option>
          <option value="dim">Dim</option>
          <option value="100">Normal</option>
        </select>
      </label>
      <label hidden={mode !== "dim"}>
        Brightness (%)
        <input
          name={`dim${index}`}
          type="number"
          min={1}
          max={99}
          step={1}
          defaultValue={
            period.brightness > 0 && period.brightness < 100
              ? period.brightness
              : 25
          }
          disabled={mode !== "dim"}
          required
        />
      </label>
    </fieldset>
  );
}

export function PanelDisplaySettings({
  csrf,
  workspace,
}: {
  csrf: string;
  workspace?: Workspace;
}) {
  const [schedule, setSchedule] = useState<Schedule | null>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(true);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const next = await api<Schedule>("panel-display", {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (controller.signal.aborted) return;
        if (
          !Number.isSafeInteger(next.revision) ||
          next.revision < 1 ||
          next.periods?.length !== 4 ||
          !next.periods.every(
            (p) =>
              Number.isInteger(p.start) &&
              p.start >= 0 &&
              p.start < 1440 &&
              Number.isInteger(p.brightness) &&
              p.brightness >= 0 &&
              p.brightness <= 100,
          ) ||
          new Set(next.periods.map((p) => p.start)).size !== 4
        )
          throw Error("Invalid schedule received.");
        setSchedule(next);
        setNeedsReload(false);
        setError("");
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof APIError && reason.status === 404)
          setSchedule(null);
        else {
          setNeedsReload(true);
          setError(
            `Could not load the display schedule. ${reason instanceof Error ? reason.message : "Try again."}`,
          );
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [reload]);

  function refresh() {
    setBusy(true);
    setReload((n) => n + 1);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedule || busy || needsReload) return;
    const fields = new FormData(event.currentTarget);
    const modes = fields.getAll("mode");
    const periods = fields.getAll("start").map((time, i) => {
      const [hour, minute] = String(time).split(":").map(Number);
      return {
        start: hour * 60 + minute,
        brightness: Number(
          modes[i] === "dim" ? fields.get(`dim${i}`) : modes[i],
        ),
      };
    });
    setSaved("");
    if (new Set(periods.map((p) => p.start)).size !== 4) {
      setError("Choose a different start time for each period.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("panel-display", {
        method: "PUT",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({ revision: schedule.revision, periods }),
        signal: AbortSignal.timeout(15000),
      });
      setSaved("Display schedule saved.");
      refresh();
    } catch (reason) {
      if (reason instanceof APIError && reason.status === 409) {
        setNeedsReload(true);
        setError(
          "The schedule changed elsewhere. Your edits are still shown. Reload the saved schedule before editing again.",
        );
      } else if (reason instanceof APIError && reason.status === 404)
        setSchedule(null);
      else
        setError(
          `Could not confirm the schedule was saved. ${reason instanceof Error ? reason.message : "Try again."}`,
        );
      setBusy(false);
    }
  }

  if (schedule === null) return null;
  return (
    <section
      className="panel data-panel panel-display"
      aria-label="Display settings"
    >
      <h2 className="settings-card-title">
        <Monitor size={20} /> Display settings
      </h2>
      <p className="small-note">
        All panels follow this daily schedule in their local time. A first tap
        wakes a dim or sleeping screen. It stays at normal brightness for five
        minutes after the last touch.
      </p>
      {schedule && (
        <form
          onSubmit={save}
          onChange={() => {
            setSaved("");
            if (!needsReload) setError("");
          }}
        >
          <fieldset
            className="panel-periods"
            disabled={busy || needsReload}
            key={schedule.revision}
          >
            {schedule.periods.map((period, i) => (
              <PeriodFields key={i} index={i} period={period} />
            ))}
            <button type="submit" className="primary">
              Save display schedule
            </button>
          </fieldset>
        </form>
      )}
      {busy && <p role="status">Updating display schedule…</p>}
      {saved && <p role="status">{saved}</p>}
      {error && <p role="alert">{error}</p>}
      {needsReload && (
        <button disabled={busy} onClick={refresh}>
          {schedule ? "Discard edits and reload" : "Retry loading schedule"}
        </button>
      )}
      {schedule && workspace && (
        <PanelIcons csrf={csrf} workspace={workspace} />
      )}
    </section>
  );
}

function PanelIcons({
  csrf,
  workspace,
}: {
  csrf: string;
  workspace: Workspace;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function publish() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (workspace.devices.length > 16)
        throw Error("The panel supports up to 16 servers.");
      const signal = AbortSignal.timeout(15000);
      const icons = await Promise.all(
        workspace.devices.map((device) =>
          panelIcon(device, workspace.displays[device.id], signal),
        ),
      );
      await api("panel-icons", {
        method: "PUT",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({ icons }),
        signal,
      });
      setMessage("Sidebar icons and labels copied to the panel settings.");
    } catch (reason) {
      setError(
        `Could not copy sidebar icons. ${reason instanceof Error ? reason.message : "Try again."}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel-icons">
      <p className="small-note">
        Use the server icons and short labels saved in this browser on all
        panels.
      </p>
      <button disabled={busy} onClick={publish}>
        {busy ? "Copying icons…" : "Copy sidebar icons to panel"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
