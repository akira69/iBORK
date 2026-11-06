import { useState, type ReactNode } from "react";
import { usePoll } from "./usePoll";
import { ServerIconPicker } from "./ServerIconPicker";
import { Server, PlugZap } from "lucide-react";
import { ServerIcon } from "./ServerIcon";
import { defaultDeviceTab, readNavigation, type Tab } from "./navigation";
import {
  displayKey,
  readDisplay,
  sourcesFor,
  writeDisplay,
  type Device,
  type Display,
} from "./device-identity";

export type Workspace = {
  device: Device;
  devices: Device[];
  displays: Record<string, Display>;
  select: (id: string, tab?: Tab) => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
  saveDisplay: (id: string, value: Display) => string;
};

export function DeviceWorkspace({
  children,
  empty,
}: {
  children: (workspace: Workspace) => ReactNode;
  empty?: ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  const devices = usePoll<Device[]>("devices", 0, true, revision);
  if (devices.data?.length === 0) return empty;
  if (!devices.data?.length)
    return (
      <main className="main">
        <p role="status">{devices.error || "Loading servers…"}</p>
        <button onClick={() => setRevision((v) => v + 1)}>Retry</button>
      </main>
    );
  return (
    <WorkspaceSelection
      key={JSON.stringify(
        devices.data.map((device) => [
          device.id,
          displayKey(device),
          device.hasManagement,
          device.hasEnergy,
          device.hasSensors,
          sourcesFor(device),
        ]),
      )}
      devices={devices.data}
    >
      {children}
    </WorkspaceSelection>
  );
}

function WorkspaceSelection({
  devices,
  children,
}: {
  devices: Device[];
  children: (workspace: Workspace) => ReactNode;
}) {
  const [navigation, setNavigation] = useState(() => readNavigation(devices));
  const select = (deviceId: string, tab?: Tab) => {
    const target = devices.find((item) => item.id === deviceId);
    if (target)
      setNavigation((previous) => ({
        ...previous,
        deviceId,
        tab: tab ?? defaultDeviceTab(target),
      }));
  };
  const setTab = (tab: Tab) =>
    setNavigation((previous) => ({ ...previous, tab }));
  const [displays, setDisplays] = useState(() =>
    Object.fromEntries(
      devices.map((device) => [device.id, readDisplay(displayKey(device))]),
    ),
  );
  const device =
    devices.find((device) => device.id === navigation.deviceId) ?? devices[0];
  function saveDisplay(id: string, value: Display) {
    const target = devices.find((device) => device.id === id);
    if (!target) return "Server unavailable";
    setDisplays((previous) => ({ ...previous, [id]: value }));
    return writeDisplay(displayKey(target), value);
  }
  return children({
    device,
    devices,
    displays,
    select,
    tab: navigation.tab,
    setTab,
    saveDisplay,
  });
}

export function DisplaySettings({ workspace }: { workspace: Workspace }) {
  const { device, displays, saveDisplay } = workspace;
  const [draft, setDraft] = useState(displays[device.id] ?? {});
  const [message, setMessage] = useState("");
  return (
    <section className="panel data-panel display-settings">
      <h2>Server appearance</h2>
      <p>
        Appearance for {device.name}
        {device.bmcHost && ` (${device.bmcHost})`}. Display names, icons and
        sidebar shortcuts apply to this browser.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setMessage(
            saveDisplay(device.id, {
              ...draft,
              pinned: displays[device.id]?.pinned,
              autoConnect: displays[device.id]?.autoConnect,
            }) || "Display preferences saved.",
          );
        }}
      >
        {(
          [
            ["name", "Display name"],
            ["manufacturer", "Manufacturer override"],
            ["model", "Model override"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              maxLength={100}
              value={draft[key] ?? ""}
              placeholder="Automatic"
              onChange={(event) =>
                setDraft({ ...draft, [key]: event.target.value.trimStart() })
              }
            />
          </label>
        ))}
        <ServerIconPicker device={device} value={draft} onChange={setDraft} />
        <button type="submit">Save display preferences</button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function SidebarSettings({
  workspace,
  openServer,
}: {
  workspace: Workspace;
  openServer: (id: string) => void;
}) {
  const { devices, displays, saveDisplay } = workspace;
  const [message, setMessage] = useState("");
  return (
    <section className="panel data-panel display-settings">
      <h2 className="settings-card-title">
        <Server size={20} /> Sidebar servers
      </h2>
      <p>Choose shortcuts for this browser, or open any saved server here.</p>
      <fieldset>
        <legend>Show saved servers in sidebar</legend>
        {devices.map((item) => (
          <div key={item.id} className="sidebar-setting-row">
            <ServerIcon device={item} display={displays[item.id]} />
            <label>
              <input
                type="checkbox"
                checked={displays[item.id]?.pinned !== false}
                onChange={(event) =>
                  setMessage(
                    saveDisplay(item.id, {
                      ...displays[item.id],
                      pinned: event.target.checked,
                    }),
                  )
                }
              />
              {displays[item.id]?.name || item.name}
            </label>
            <button
              type="button"
              className="quiet"
              onClick={() => openServer(item.id)}
              aria-label={`Open ${displays[item.id]?.name || item.name}`}
            >
              Open
            </button>
          </div>
        ))}
      </fieldset>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function ConsolePreferences({ workspace }: { workspace: Workspace }) {
  const { device, displays, saveDisplay } = workspace;
  const [message, setMessage] = useState("");
  return (
    <section className="panel data-panel">
      <h2 className="settings-card-title">
        <PlugZap size={20} /> KVM connection
      </h2>
      <label className="switch-label">
        <span>
          Auto-connect KVM
          <small>
            Connect when this server’s Console opens. Saved in this browser.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={displays[device.id]?.autoConnect !== false}
          onChange={(event) =>
            setMessage(
              saveDisplay(device.id, {
                ...displays[device.id],
                autoConnect: event.target.checked,
              }),
            )
          }
        />
      </label>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
