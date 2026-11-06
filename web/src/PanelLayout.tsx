import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  GripVertical,
  PanelsTopLeft,
} from "lucide-react";
import { api, APIError } from "./api";
import type { Workspace } from "./DeviceWorkspace";
import { PanelLayoutPreview } from "./PanelLayoutPreview";
import "./panel-layout.css";

export type PanelServer = {
  id: string;
  included: boolean;
  widgets: string[];
  available: string[];
};
export type PanelLayout = {
  revision: number;
  home: string[];
  servers: PanelServer[];
};
const homeNames: Record<string, string> = {
  power: "Fleet power",
  day: "24-hour chart",
  month: "30-day chart",
  servers: "Server tiles",
};
const widgetNames: Record<string, string> = {
  power: "Power draw",
  temperature: "Temperature",
  fan: "Fan speed",
  controls: "Power controls",
};

function validKeys(keys: string[], available: string[]) {
  return (
    Array.isArray(keys) &&
    new Set(keys).size === keys.length &&
    keys.every((k) => available.includes(k))
  );
}
function checked(value: PanelLayout) {
  if (
    !value ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !validKeys(value.home, Object.keys(homeNames)) ||
    !value.home.length ||
    !Array.isArray(value.servers) ||
    value.servers.length > 16 ||
    new Set(value.servers.map((s) => s.id)).size !== value.servers.length ||
    !value.servers.every(
      (s) =>
        typeof s.id === "string" &&
        s.id.length &&
        typeof s.included === "boolean" &&
        validKeys(s.available, Object.keys(widgetNames)) &&
        validKeys(s.widgets, s.available),
    )
  )
    throw Error("Invalid panel layout received.");
  return value;
}

type Choice = { id: string; label: string; checked: boolean };
function choices(
  selected: string[],
  available: string[],
  names: Record<string, string>,
) {
  return [...selected, ...available.filter((k) => !selected.includes(k))].map(
    (id) => ({ id, label: names[id], checked: selected.includes(id) }),
  );
}
function reorder<T>(items: T[], from: number, to: number) {
  const result = [...items];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}
function Checklist({
  label,
  items,
  onToggle,
  onMove,
  moveUnchecked = false,
}: {
  label: string;
  items: Choice[];
  onToggle: (id: string) => void;
  onMove: (from: number, to: number) => void;
  moveUnchecked?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const movable = moveUnchecked
    ? items.length
    : items.filter((i) => i.checked).length;
  return (
    <ul className="cl-list" aria-label={label}>
      {items.map((item, i) => (
        <li
          key={item.id}
          onDragOver={(e) => {
            if (drag !== null && i < movable) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drag !== null && i < movable && drag !== i) onMove(drag, i);
            setDrag(null);
          }}
        >
          <span
            className="cl-grip"
            aria-hidden="true"
            draggable={i < movable}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", item.id);
              setDrag(i);
            }}
            onDragEnd={() => setDrag(null)}
          >
            <GripVertical size={16} />
          </span>
          <label>
            <input
              type="checkbox"
              checked={item.checked}
              onChange={() => onToggle(item.id)}
            />
            {item.label}
          </label>
          <div className="cl-moves">
            <button
              type="button"
              aria-label={`Move ${item.label} up`}
              disabled={i === 0 || i >= movable}
              onClick={() => onMove(i, i - 1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              aria-label={`Move ${item.label} down`}
              disabled={i >= movable - 1}
              onClick={() => onMove(i, i + 1)}
            >
              <ArrowDown size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
function toggle(keys: string[], id: string) {
  return keys.includes(id) ? keys.filter((k) => k !== id) : [...keys, id];
}

export function PanelLayoutSettings({
  csrf,
  workspace,
  children,
}: {
  csrf: string;
  workspace?: Workspace;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<PanelLayout | null>();
  const [draft, setDraft] = useState<PanelLayout>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"home" | "servers">("home");
  const [serverId, setServerId] = useState("");
  const selected =
    draft?.servers.find((s) => s.id === serverId) ?? draft?.servers[0];
  const dirty = !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  const name = (id: string) =>
    workspace?.displays[id]?.name ||
    workspace?.devices.find((d) => d.id === id)?.name ||
    id;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = checked(
          await api<PanelLayout>("panel-layout", {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          }),
        );
        if (controller.signal.aborted) return;
        setSaved(data);
        setDraft(data);
        setConflict(false);
        setError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof APIError && e.status === 404) {
          setSaved(null);
          setOpen(false);
        } else
          setError(
            `Could not load the panel layout. ${e instanceof Error ? e.message : "Try again."}`,
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [reload]);
  function refresh() {
    setBusy(true);
    setMessage("");
    setReload((n) => n + 1);
  }
  function edit(next: PanelLayout) {
    if (busy || conflict) return;
    setDraft(next);
    setMessage("");
    setError("");
  }
  async function save() {
    if (!draft || !dirty || busy || conflict || !draft.home.length) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = checked(
        await api<PanelLayout>("panel-layout", {
          method: "PUT",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({
            ...draft,
            servers: draft.servers.map(({ id, included, widgets }) => ({
              id,
              included,
              widgets,
            })),
          }),
          signal: AbortSignal.timeout(15000),
        }),
      );
      setDraft(data);
      setSaved(data);
      setMessage("Layout saved.");
    } catch (e) {
      if (e instanceof APIError && e.status === 409) {
        setConflict(true);
        setError(
          "The panel layout changed elsewhere. Your edits are still shown. Reload the saved layout before editing again.",
        );
      } else if (e instanceof APIError && e.status === 404) {
        setSaved(null);
        setOpen(false);
      } else
        setError(
          `Could not confirm the layout was saved. ${e instanceof Error ? e.message : "Try again."}`,
        );
    } finally {
      setBusy(false);
    }
  }
  if (!open || !draft)
    return (
      <>
        {saved && (
          <button className="cl-entry" onClick={() => setOpen(true)}>
            <PanelsTopLeft size={17} />
            Edit display layout{dirty && " · unsaved edits"}
          </button>
        )}
        {!saved && saved !== null && error && (
          <div>
            <p role="alert">{error}</p>
            <button disabled={busy} onClick={refresh}>
              Retry loading layout
            </button>
          </div>
        )}
        {children}
      </>
    );
  function serverWidgets(widgets: string[]) {
    if (draft && selected)
      edit({
        ...draft,
        servers: draft.servers.map((s) =>
          s.id === selected.id ? { ...s, widgets } : s,
        ),
      });
  }
  return (
    <section className="cl-editor" aria-label="Display layout editor">
      <button className="cl-back" onClick={() => setOpen(false)}>
        <ArrowLeft size={15} />
        Back to iBORK settings
      </button>
      <header className="cl-heading">
        <div>
          <h2>Display layout</h2>
          <p>
            Choose the Home sections, server tiles, and widgets shown on the
            touchscreen.
          </p>
        </div>
        <div>
          {dirty && <span>Unsaved edits</span>}
          <button
            className="primary"
            disabled={busy || conflict || !dirty || !draft.home.length}
            onClick={save}
          >
            {busy ? "Updating…" : "Save layout"}
          </button>
        </div>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <button disabled={busy} onClick={refresh}>
          Discard edits and reload layout
        </button>
      )}
      {message && <p role="status">{message}</p>}
      <div className="cl-columns">
        <section className="panel cl-options" aria-label="Layout controls">
          <div className="cl-tabs">
            {(["home", "servers"] as const).map((t) => (
              <button
                key={t}
                aria-pressed={t === tab}
                onClick={() => setTab(t)}
              >
                {t === "home" ? "Home" : "Servers"}
              </button>
            ))}
          </div>
          <fieldset disabled={busy || conflict}>
            {tab === "home" ? (
              <>
                <h3>Home sections</h3>
                <p>Select and order sections on the Home screen.</p>
                <Checklist
                  label="Home sections"
                  items={choices(draft.home, Object.keys(homeNames), homeNames)}
                  onToggle={(id) =>
                    edit({ ...draft, home: toggle(draft.home, id) })
                  }
                  onMove={(a, b) =>
                    edit({ ...draft, home: reorder(draft.home, a, b) })
                  }
                />
                {!draft.home.length && (
                  <p role="alert">Select at least one Home section.</p>
                )}
                <hr />
                <h3>Servers on panel</h3>
                <p>Choose which servers appear and in what order.</p>
                {draft.servers.length ? (
                  <Checklist
                    label="Servers on panel"
                    moveUnchecked
                    items={draft.servers.map((s) => ({
                      id: s.id,
                      label: name(s.id),
                      checked: s.included,
                    }))}
                    onToggle={(id) =>
                      edit({
                        ...draft,
                        servers: draft.servers.map((s) =>
                          s.id === id ? { ...s, included: !s.included } : s,
                        ),
                      })
                    }
                    onMove={(a, b) =>
                      edit({ ...draft, servers: reorder(draft.servers, a, b) })
                    }
                  />
                ) : (
                  <p>No servers configured.</p>
                )}
              </>
            ) : (
              <>
                <h3>Server widgets</h3>
                <p>Choose the sections shown when you open a server.</p>
                {selected ? (
                  <>
                    <label className="cl-picker">
                      Server to edit
                      <select
                        value={selected.id}
                        onChange={(e) => setServerId(e.target.value)}
                      >
                        {draft.servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {name(s.id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!selected.included && (
                      <p>This server is hidden on the panel.</p>
                    )}
                    {selected.available.length ? (
                      <Checklist
                        label="Server widgets"
                        items={choices(
                          selected.widgets,
                          selected.available,
                          widgetNames,
                        )}
                        onToggle={(id) =>
                          serverWidgets(toggle(selected.widgets, id))
                        }
                        onMove={(a, b) =>
                          serverWidgets(reorder(selected.widgets, a, b))
                        }
                      />
                    ) : (
                      <p>No supported widgets for this server.</p>
                    )}
                  </>
                ) : (
                  <p>No servers configured.</p>
                )}
              </>
            )}
          </fieldset>
        </section>
        <PanelLayoutPreview
          layout={draft}
          workspace={workspace}
          detail={tab === "servers" ? selected : undefined}
          onHome={() => setTab("home")}
          onServer={(id) => {
            setServerId(id);
            setTab("servers");
          }}
        />
      </div>
    </section>
  );
}
