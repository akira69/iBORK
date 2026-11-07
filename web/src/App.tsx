import { dashboardKey, endpointKeyFor } from "./device-identity";
import {
  useEffect,
  lazy,
  Suspense,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BookOpen,
  CircleHelp,
  CircleCheck,
  CircleAlert,
  LayoutGrid,
  Github,
  HardDrive,
  LockKeyhole,
  LogOut,
  Power,
  RefreshCw,
  Settings,
  ShieldCheck,
  Thermometer,
  Wind,
  Zap,
} from "lucide-react";
import {
  DeviceWorkspace,
  DisplaySettings,
  ConsolePreferences,
  SidebarSettings,
  type Workspace,
} from "./DeviceWorkspace";
import { identify } from "./device-identity";
import dellLogo from "./assets/dell.svg";
import { api, mutate } from "./api";
import { usePoll } from "./usePoll";
import { type JetKVMProvider, type KVMState } from "./kvm";
import { KVMWall } from "./KVMWall";
import { DashboardGrid } from "./DashboardGrid";
import { DashboardAssistant, DashboardScope } from "./DashboardAssistant";
import { SensorReadings } from "./SensorReadings";
import { SensorGroups } from "./SensorGroups";
import { panelLayout, powerLayout, terminalLayout } from "./page-layouts";
import { type WidgetKind } from "./dashboard-layout";
import { sensorReading, powerSupplies, type Sensor } from "./sensors";
import { ConnectionSettings } from "./ConnectionSettings";
import { Information } from "./Information";
import {
  defaultDeviceTab,
  supportsTab,
  tabs,
  writeNavigation,
} from "./navigation";
import { CoolingPanel, type CoolingState } from "./CoolingPanel";
import { DiagnosticsTerminal } from "./DiagnosticsTerminal";
import {
  SensorOverview,
  RecentEvents,
  InventoryOverview,
  ConnectionOverview,
} from "./OverviewWidgets";
import {
  ConsoleSessions,
  ConsoleSlot,
  useConsoleSessions,
  useConsoleSnapshot,
  sourcesFor,
} from "./ConsoleSessions";
import { ServerIcon } from "./ServerIcon";
import { PasswordSettings } from "./PasswordSettings";
import { AssistantDrawer, type AssistantControls } from "./AssistantDrawer";
import { PanelLayoutSettings } from "./PanelLayout";
import { PowerUsage } from "./PowerUsage";
import {
  ElectricityRateProvider,
  ElectricityRateSettings,
} from "./ElectricityRate";
import { type PowerHistory } from "./energy";
import finchLogo from "./assets/finch13.png";
import jetLogo from "./assets/jetkvm.svg";
import supermicroLogo from "./assets/supermicro.svg";

const LazySOLConsole = lazy(() =>
  import("./SOLConsole").then((module) => ({ default: module.SOLConsole })),
);
function SerialConsole(props: { apiPrefix: string; active: boolean }) {
  return (
    <Suspense fallback={<p className="empty-data">Loading serial console…</p>}>
      <LazySOLConsole {...props} />
    </Suspense>
  );
}

type EventEntry = {
  id: string;
  timestamp: string;
  sensor: string;
  message: string;
  state: string;
};
type Configuration = {
  jetUrl: string;
  glUrl?: string;
  glUsername?: string;
  vncHost?: string;
  vncPort?: number;
  vncTransport?: string;
  bmcHost: string;
  bmcUsername: string;
  bmcPort: number;
  timeoutSeconds: number;
  serverName: string;
  manufacturer?: string;
  model?: string;
};
type Confirmation = {
  title: string;
  detail: string;
  run: () => Promise<unknown>;
};
const actions = [
  { id: "on", name: "Power on" },
  { id: "soft", name: "Graceful shutdown" },
  { id: "reset", name: "Reset server" },
  { id: "cycle", name: "Power cycle" },
  { id: "off", name: "Force power off" },
];
const bootTargets = [
  {
    id: "default",
    name: "Normal boot",
    detail: "Follow the configured boot order",
  },
  { id: "bios", name: "BIOS setup", detail: "Enter system firmware setup" },
  { id: "pxe", name: "Network · PXE", detail: "Boot from a network server" },
  { id: "disk", name: "Local disk", detail: "Boot from the primary disk" },
  {
    id: "cdrom",
    name: "CD / DVD",
    detail: "Boot from optical or virtual media",
  },
];

function OwnerLinks() {
  return (
    <div className="owner-links">
      <img src={finchLogo} alt="Finch13" width="48" height="48" />
      <a
        href="https://github.com/akira69/iBORK"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="iBORK on GitHub"
      >
        <Github size={20} />
      </a>
    </div>
  );
}

function Badge({
  state,
  children,
}: {
  state: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`badge ${state}`}>
      <i />
      {children}
    </span>
  );
}
function Notice({ message }: { message?: string }) {
  return message ? (
    <div className="notice" role="status">
      <CircleHelp size={16} />
      {message}
    </div>
  ) : null;
}

export function App() {
  const [csrf, setCSRF] = useState<string | null>(null),
    [checking, setChecking] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    const expired = () => {
      setCSRF(null);
      setError("Session expired. Sign in to reconnect.");
    };
    window.addEventListener("session-expired", expired);
    api<{ csrf: string }>("session")
      .then((data) => setCSRF(data.csrf))
      .catch(() => undefined)
      .finally(() => setChecking(false));
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password"));
    form.reset();
    setChecking(true);
    setError("");
    try {
      const result = await api<{ csrf: string }>("login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setCSRF(result.csrf);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    } finally {
      setChecking(false);
    }
  }
  if (!csrf)
    return (
      <main className="login">
        <div className="login-card">
          <div className="login-brand">
            <img src="/ibork.svg" alt="iBORK" width="80" height="80" />
            <h1>iBORK</h1>
          </div>
          <p className="login-description">
            <strong>IPMI</strong> · Bare-metal Operations &amp; Remote KVM
          </p>
          <p className="login-tagline">Less bork. More uptime.</p>
          <form onSubmit={login}>
            <label htmlFor="password">Management password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={72}
              autoFocus
            />
            <button className="primary" disabled={checking}>
              <LockKeyhole size={16} />
              {checking ? "Connecting…" : "Sign in to console"}
            </button>
          </form>
          <Notice message={error} />
          <div className="developer-credit">
            <img src={finchLogo} alt="Finch13" width="32" height="32" />
            <span>by Finch13</span>
          </div>
          <p className="login-foot">
            <ShieldCheck size={14} />
            Private infrastructure · 30-minute sessions
          </p>
        </div>
      </main>
    );
  return (
    <ElectricityRateProvider csrf={csrf}>
      <DeviceWorkspace
        empty={
          <AssistantDrawer csrf={csrf}>
            {({ openAssistant, settings, settingsRequest }) => (
              <main className="main app-settings">
                <PanelLayoutSettings
                  csrf={csrf}
                  settingsRequest={settingsRequest}
                >
                  <img src="/ibork.svg" alt="iBORK" width="64" height="64" />
                  <h1>Information</h1>
                  <Information emptyFleet />
                  <h2 id="add-first-server" tabIndex={-1}>
                    iBORK settings
                  </h2>
                  <p>
                    No devices saved. Add a server or standalone KVM to begin.
                  </p>
                  <ConnectionSettings
                    csrf={csrf}
                    openAssistant={openAssistant}
                  />
                  {settings}
                  <PasswordSettings
                    csrf={csrf}
                    onChanged={() => setCSRF(null)}
                  />
                  <ElectricityRateSettings />
                  <button
                    onClick={async () => {
                      await api("logout", {
                        method: "POST",
                        headers: { "X-CSRF-Token": csrf },
                        body: "{}",
                      });
                      setCSRF(null);
                    }}
                  >
                    Sign out
                  </button>
                </PanelLayoutSettings>
              </main>
            )}
          </AssistantDrawer>
        }
      >
        {(workspace) => (
          <ConsoleSessions devices={workspace.devices} csrf={csrf}>
            <DashboardAssistant devices={workspace.devices} csrf={csrf}>
              <FleetDashboard
                workspace={workspace}
                csrf={csrf}
                passwordChanged={() => {
                  setCSRF(null);
                  setError("Password changed. Sign in with your new password.");
                }}
                logout={async () => {
                  await api("logout", {
                    method: "POST",
                    headers: { "X-CSRF-Token": csrf },
                    body: "{}",
                  });
                  setCSRF(null);
                }}
              />
            </DashboardAssistant>
          </ConsoleSessions>
        )}
      </DeviceWorkspace>
    </ElectricityRateProvider>
  );
}

type DashboardProps = {
  workspace: Workspace;
  csrf: string;
  logout: () => Promise<void>;
  passwordChanged: () => void;
};
function FleetDashboard(props: DashboardProps) {
  const { setView } = useConsoleSessions();
  const [dashboardVersion, setDashboardVersion] = useState(0);
  return (
    <AssistantDrawer
      csrf={props.csrf}
      onSettings={() => {
        setView("server");
        props.workspace.setTab("iBORK settings");
      }}
      onLayout={(id) => {
        if (id === props.workspace.device.id) setDashboardVersion((v) => v + 1);
      }}
    >
      {(assistant) => (
        <Dashboard
          key={props.workspace.device.id}
          {...props}
          assistant={assistant}
          dashboardVersion={dashboardVersion}
        />
      )}
    </AssistantDrawer>
  );
}
function Dashboard({
  workspace,
  csrf,
  logout,
  passwordChanged,
  assistant,
  dashboardVersion,
}: DashboardProps & {
  assistant: AssistantControls;
  dashboardVersion: number;
}) {
  const { device, devices, displays, select, tab, setTab } = workspace;
  const apiPrefix = `devices/${device.id}/`;
  const display = displays[device.id] ?? {};
  const [revision, setRevision] = useState(0);
  const appPage = tab === "iBORK settings" || tab === "Information";
  const [loadedWidgetKinds, setWidgetKinds] = useState<WidgetKind[]>();
  const widgetKinds = loadedWidgetKinds ?? [];
  const hasPowerWidget = widgetKinds.some(
    (kind) =>
      (kind.startsWith("power-") && kind !== "power-control") ||
      kind === "energy-cost",
  );
  const hasSOLWidget = widgetKinds.includes("sol");
  const hasDiagnosticsWidget = widgetKinds.includes("diagnostics");
  const [terminalVisited, setTerminalVisited] = useState(tab === "Terminals");
  const [media, setMedia] = useState("Not read"),
    [iso, setISO] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const { store: consoleStore, jets, view, setView } = useConsoleSessions();
  useEffect(() => {
    writeNavigation({ deviceId: device.id, tab, view });
  }, [device.id, tab, view]);
  useEffect(() => {
    function openGuide() {
      if (location.hash.startsWith("#guide-")) {
        setView("server");
        setTab("Information");
        // The guide may already be mounted behind the wall.
        requestAnimationFrame(() =>
          document.getElementById(location.hash.slice(1))?.scrollIntoView(),
        );
      }
    }
    window.addEventListener("hashchange", openGuide);
    return () => window.removeEventListener("hashchange", openGuide);
  }, [setTab, setView]);
  const jetSnapshot = useConsoleSnapshot(`${device.id}:jetkvm`);
  const vncSnapshot = useConsoleSnapshot(`${device.id}:vnc`);
  const cometSnapshot = useConsoleSnapshot(`${device.id}:glinet`);
  const state: KVMState =
    jetSnapshot.phase === "live"
      ? "connected"
      : jetSnapshot.phase === "busy"
        ? "failed"
        : jetSnapshot.phase;
  const vncStatus =
    vncSnapshot.phase === "live"
      ? "Online"
      : ["connecting", "reconnecting"].includes(vncSnapshot.phase)
        ? "Linking"
        : "Offline";
  const kvm = jets.get(`${device.id}:jetkvm`) ?? null;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    consoleStore.setControl(null);
    if (view === "wall") return;
    for (const item of devices)
      for (const source of sourcesFor(item))
        if (item.id !== device.id || tab !== "Console")
          consoleStore.disconnect(`${item.id}:${source}`);
  }, [consoleStore, devices, device.id, tab, view]);
  const autoConnect = displays[device.id]?.autoConnect !== false;
  const visibleSources =
    loadedWidgetKinds &&
    sourcesFor(device)
      .filter((source) => loadedWidgetKinds.includes(source))
      .join("|");
  const previousAutoSources = useRef<string[]>([]);
  useEffect(() => {
    if (
      view !== "server" ||
      tab !== "Console" ||
      visibleSources === undefined
    ) {
      previousAutoSources.current = [];
      return;
    }
    const eligible = autoConnect ? visibleSources.split("|") : [];
    // A geometry edit must not reconnect a source the operator disconnected.
    for (const source of sourcesFor(device))
      if (
        eligible.includes(source) &&
        !previousAutoSources.current.includes(source)
      )
        consoleStore.connect(`${device.id}:${source}`);
    previousAutoSources.current = eligible;
  }, [consoleStore, device, visibleSources, view, tab, autoConnect]);
  const hasManagement = device.hasManagement !== false;
  const hasComet = sourcesFor(device).includes("glinet");
  const endpointKey = endpointKeyFor(device);
  const config = usePoll<Configuration>(apiPrefix + "config", 0);
  const power = usePoll<{ state: string }>(
    apiPrefix + "power",
    5000,
    hasManagement,
    revision,
  );
  const sensors = usePoll<Sensor[]>(
    apiPrefix + "sensors",
    20000,
    view === "server" &&
      supportsTab(device, "Sensors") &&
      (tab === "Console" ||
        tab === "Sensors" ||
        widgetKinds.some((kind) =>
          [
            "health",
            "sensor",
            "fans",
            "temperatures",
            "psu",
            "alerts",
          ].includes(kind),
        )),
    revision,
  );
  const cooling = usePoll<CoolingState>(
    apiPrefix + "cooling",
    30000,
    hasManagement &&
      (tab === "Cooling" ||
        (tab === "Console" && widgetKinds.includes("cooling"))),
    revision,
  );
  const history = usePoll<PowerHistory>(
    apiPrefix + "energy",
    60000,
    view === "server" &&
      supportsTab(device, "Power usage") &&
      (hasPowerWidget || tab === "Power usage"),
    0,
    true,
  );
  const events = usePoll<EventEntry[]>(
    apiPrefix + "events",
    30000,
    hasManagement &&
      (tab === "Events" ||
        (tab === "Console" && widgetKinds.includes("events"))),
    revision,
  );
  const inventory = usePoll<{ fields: Record<string, string> }>(
    apiPrefix + "inventory",
    0,
    hasManagement,
    revision,
  );
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);
  const identity = identify(
    config.data ?? device,
    inventory.data?.fields ?? {},
    display,
  );
  const serverName = display.name || device.name;
  const bmcOnline = !!power.data && !power.error;
  const connected = state === "connected" || state === "no-signal";
  const connectionStatus = (
    <div className="connection-status" aria-label="Connections">
      {[
        ...(hasManagement
          ? [
              {
                label: "IPMI",
                online: bmcOnline,
                text: bmcOnline
                  ? "Online"
                  : power.loading
                    ? "Checking"
                    : "Offline",
              },
            ]
          : []),
        ...(!hasManagement && device.hasSensors && tab === "Sensors"
          ? [
              {
                label: "Glances",
                online: !!sensors.data && !sensors.error,
                text: sensors.error
                  ? "Unavailable"
                  : sensors.loading
                    ? "Checking"
                    : "Reporting",
              },
            ]
          : []),
        ...(device.hasJetKVM || device.hasVNC || hasComet
          ? [
              {
                label: "KVM",
                online: device.hasJetKVM
                  ? connected
                  : device.hasVNC
                    ? vncStatus === "Online"
                    : ["live", "no-signal"].includes(cometSnapshot.phase),
                text:
                  !device.hasJetKVM && !device.hasVNC
                    ? cometSnapshot.phase === "live"
                      ? "Online"
                      : cometSnapshot.phase === "no-signal"
                        ? "No signal"
                        : ["connecting", "reconnecting"].includes(
                              cometSnapshot.phase,
                            )
                          ? "Linking"
                          : "Offline"
                    : !device.hasJetKVM
                      ? vncStatus
                      : connected
                        ? "Online"
                        : state === "connecting" || state === "reconnecting"
                          ? "Linking"
                          : "Offline",
              },
            ]
          : []),
      ].map((item) => (
        <div
          key={item.label}
          className={item.online ? "online" : "offline"}
          aria-label={`${item.label}: ${item.text}`}
          title={`${item.label}: ${item.text}`}
        >
          <strong>
            <i />
            {item.label}
          </strong>
          <small>{item.text}</small>
        </div>
      ))}
    </div>
  );

  const temp = sensors.data?.find((s) => /cpu.*temp/i.test(s.name));
  const fan = sensors.data?.find(
    (s) => /fan/i.test(s.name) && s.state !== "unavailable",
  );
  const supplies = powerSupplies(sensors.data ?? []);
  const confirm = (
    title: string,
    detail: string,
    run: () => Promise<unknown>,
  ) => {
    setFeedback("");
    setConfirmation({ title, detail, run });
  };
  const control = (
    path: string,
    action: string,
    title: string,
    detail: string,
  ) => confirm(title, detail, () => mutate(apiPrefix + path, action, csrf));
  const bootPanel = (
    <section className="panel data-panel">
      <PanelHeading
        title="Next boot"
        detail="One-time override. Selecting a target does not restart the server."
      />
      <div className="boot-grid">
        {bootTargets.map((target) => (
          <button
            disabled={!bmcOnline}
            key={target.id}
            onClick={() =>
              control(
                "boot",
                target.id,
                `Next boot: ${target.name}`,
                "Apply a one-time boot override? The server will not restart automatically.",
              )
            }
          >
            <HardDrive size={21} />
            <strong>{target.name}</strong>
            <span>{target.detail}</span>
          </button>
        ))}
      </div>
      <Notice message={power.error} />
    </section>
  );
  const mediaPanel = (
    <VirtualMedia
      kvm={kvm}
      connected={connected}
      confirm={confirm}
      feedback={setFeedback}
      media={media}
      setMedia={setMedia}
      iso={iso}
      setISO={setISO}
    />
  );
  const pageStorage = `jet-supermicro:pages:v1:${endpointKey}:`;
  const coolingPanel = (
    <CoolingPanel
      cooling={cooling.data}
      loading={cooling.loading}
      error={cooling.error}
    />
  );
  function openTerminalWidget(kind: "sol" | "diagnostics") {
    setTab("Console");
    requestAnimationFrame(() =>
      document
        .getElementById(`widget-${kind}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }
  async function execute() {
    if (!confirmation || busy) return;
    setBusy(true);
    try {
      await confirmation.run();
      setConfirmation(null);
      setFeedback("Action accepted. Refresh status to verify the result.");
      setRevision((v) => v + 1);
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Action failed");
      setConfirmation(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="rail-brand">
          <img src="/ibork.svg" alt="iBORK" width="76" height="76" />
          <strong>iBORK</strong>
        </div>
        <button
          className={view === "wall" ? "rail-active" : undefined}
          aria-label="KVM Wall"
          title="KVM Wall"
          aria-current={view === "wall" ? "page" : undefined}
          onClick={() => setView("wall")}
        >
          <LayoutGrid size={24} />
          <span className="rail-wall-label">KVM Wall</span>
        </button>
        <nav className="server-quicklinks" aria-label="Server quicklinks">
          {devices
            .filter((item) => displays[item.id]?.pinned !== false)
            .map((item) => (
              <button
                key={item.id}
                aria-label={`Select ${displays[item.id]?.name || item.name}`}
                title={displays[item.id]?.name || item.name}
                aria-current={
                  view === "server" && !appPage && device.id === item.id
                    ? "true"
                    : undefined
                }
                onClick={() => {
                  setView("server");
                  select(item.id);
                }}
              >
                <ServerIcon device={item} display={displays[item.id]} />
              </button>
            ))}
        </nav>
        <div className="rail-bottom">
          <button
            className={
              view === "server" && tab === "Information"
                ? "rail-active"
                : undefined
            }
            aria-label="Information"
            title="Information and documentation"
            aria-current={
              view === "server" && tab === "Information" ? "page" : undefined
            }
            onClick={() => {
              setView("server");
              setTab("Information");
            }}
          >
            <BookOpen size={36} />
          </button>
          <button
            className={
              view === "server" && tab === "iBORK settings"
                ? "rail-active"
                : undefined
            }
            aria-label="iBORK settings"
            title="iBORK settings"
            aria-current={
              view === "server" && tab === "iBORK settings" ? "page" : undefined
            }
            onClick={() => {
              setView("server");
              setTab("iBORK settings");
            }}
          >
            <Settings size={42} />
          </button>

          <OwnerLinks />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          {view !== "wall" && !appPage && identity.brand && (
            <img
              className="vendor-logo"
              src={identity.brand === "dell" ? dellLogo : supermicroLogo}
              alt={identity.brand === "dell" ? "Dell" : "Supermicro"}
            />
          )}
          {view === "wall" ? (
            <LayoutGrid className="page-heading-icon" size={32} />
          ) : tab === "iBORK settings" ? (
            <Settings className="page-heading-icon" size={32} />
          ) : tab === "Information" ? (
            <BookOpen className="page-heading-icon" size={32} />
          ) : null}
          <div className="workspace-title">
            <p className="eyebrow">
              IPMI · Bare-metal Operations &amp; Remote KVM
            </p>
            <div className="workspace-heading">
              <h1>
                {view === "wall"
                  ? "KVM Wall"
                  : tab === "iBORK settings"
                    ? "iBORK Settings"
                    : tab === "Information"
                      ? "Information"
                      : serverName}
              </h1>
              {view !== "wall" && !appPage && connectionStatus}
            </div>
            <p>
              {view === "wall"
                ? "Consoles, power and hardware sensors"
                : tab === "iBORK settings"
                  ? "Preferences, servers and sign-in security"
                  : tab === "Information"
                    ? "Your guide to using iBORK"
                    : hasManagement
                      ? `${identity.manufacturer} · ${identity.model} · IPMI`
                      : sourcesFor(device).length
                        ? "Standalone console"
                        : "Hardware telemetry"}
            </p>
          </div>
          <div
            className="topbar-tools"
            ref={setToolbarTarget}
            hidden={view === "wall" || appPage || tab === "Server settings"}
          />
          <nav
            className="mobile-navigation"
            aria-label="Mobile workspace navigation"
          >
            <select
              aria-label="Switch server"
              value={view === "server" && !appPage ? device.id : ""}
              onChange={(event) => {
                consoleStore.setControl(null);
                setView("server");
                select(event.target.value);
              }}
            >
              <option value="" disabled>
                Switch server…
              </option>
              {devices.map((item) => (
                <option key={item.id} value={item.id}>
                  {displays[item.id]?.name || item.name}
                </option>
              ))}
            </select>
            <button
              className="quiet"
              aria-label="KVM Wall"
              title="KVM Wall"
              onClick={() => setView("wall")}
            >
              <LayoutGrid size={21} />
            </button>
            <button
              className="quiet"
              aria-label="Information"
              title="Information and documentation"
              onClick={() => {
                setView("server");
                setTab("Information");
              }}
            >
              <BookOpen size={21} />
            </button>
            <button
              className="quiet"
              aria-label="iBORK settings"
              title="iBORK settings"
              onClick={() => {
                setView("server");
                setTab("iBORK settings");
              }}
            >
              <Settings size={21} />
            </button>
            <button
              className="quiet"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void logout().catch((e) => setFeedback(String(e)))}
            >
              <LogOut size={20} />
            </button>
          </nav>
          <button
            className="quiet signout"
            onClick={() => void logout().catch((e) => setFeedback(String(e)))}
          >
            <LogOut size={15} />
            Sign out
          </button>
        </header>
        {view === "wall" && (
          <KVMWall
            devices={devices}
            displays={displays}
            openServer={(id, settings) => {
              consoleStore.setControl(null);
              setView("server");
              select(id, settings ? "Server settings" : undefined);
            }}
            openSettings={() => {
              setView("server");
              setTab("iBORK settings");
            }}
          />
        )}
        <DashboardScope.Provider
          value={{
            deviceId: device.id,
            title: `${device.name} · ${tab}`,
            active: view === "server",
          }}
        >
          <main className="main" hidden={view === "wall"}>
            <nav
              className="tabs"
              aria-label="Management views"
              hidden={appPage}
            >
              {tabs
                .filter((name) => supportsTab(device, name))
                .map((name) => (
                  <button
                    aria-current={tab === name ? "page" : undefined}
                    className={tab === name ? "active" : ""}
                    key={name}
                    onClick={() => {
                      setTab(name);
                      if (name === "Terminals") setTerminalVisited(true);
                    }}
                  >
                    {name}
                  </button>
                ))}
              <span className="tabs-end">
                <ShieldCheck size={14} />
                Private session
              </span>
            </nav>
            <Notice message={feedback} />
            <Notice message={config.error} />
            <div hidden={tab !== "Console"}>
              {config.data && (
                <DashboardGrid
                  active={view === "server" && tab === "Console"}
                  toolbarTarget={toolbarTarget}
                  jetAvailable={device.hasJetKVM}
                  vncAvailable={device.hasVNC}
                  cometAvailable={hasComet}
                  managementAvailable={hasManagement}
                  key={endpointKey + ":" + dashboardVersion}
                  storageKey={dashboardKey(device)}
                  onKindsChange={setWidgetKinds}
                  sensors={sensors.data ?? []}
                  onEditStart={() => consoleStore.setControl(null)}
                  beforeRemove={(widget) => {
                    if (
                      widget.kind === "jetkvm" ||
                      widget.kind === "vnc" ||
                      widget.kind === "glinet"
                    )
                      consoleStore.disconnect(`${device.id}:${widget.kind}`);
                  }}
                  renderWidget={(widget, editing) => {
                    if (
                      ["fans", "temperatures", "psu", "alerts"].includes(
                        widget.kind,
                      )
                    )
                      return (
                        <SensorOverview
                          kind={
                            widget.kind as
                              "fans" | "temperatures" | "psu" | "alerts"
                          }
                          sensors={
                            sensors.data?.filter(
                              (sensor) => !sensor.detailOnly,
                            ) ?? []
                          }
                          error={sensors.error}
                          loading={sensors.loading}
                        />
                      );
                    if (widget.kind === "events")
                      return (
                        <RecentEvents
                          events={events.data ?? []}
                          error={events.error}
                          loading={events.loading}
                        />
                      );
                    if (widget.kind === "inventory")
                      return (
                        <InventoryOverview
                          inventory={inventory.data}
                          error={inventory.error}
                          loading={inventory.loading}
                        />
                      );
                    if (widget.kind === "connections")
                      return (
                        <ConnectionOverview
                          connections={[
                            {
                              name: "IPMI",
                              status: bmcOnline
                                ? "Online"
                                : power.loading
                                  ? "Checking"
                                  : "Offline",
                              detail: `${device.bmcHost}:${device.bmcPort}`,
                            },
                            ...(device.hasJetKVM
                              ? [
                                  {
                                    name: "JetKVM",
                                    status: state,
                                    detail: config.data?.jetUrl,
                                  },
                                ]
                              : []),
                            ...(hasComet
                              ? [
                                  {
                                    name: "GL.iNet Comet",
                                    status: cometSnapshot.phase,
                                    detail: config.data?.glUrl,
                                  },
                                ]
                              : []),
                            ...(device.hasVNC
                              ? [
                                  {
                                    name: "VNC",
                                    status: vncStatus,
                                    detail: config.data?.vncHost,
                                  },
                                ]
                              : []),
                          ]}
                        />
                      );
                    if (widget.kind === "cooling") return coolingPanel;
                    if (widget.kind === "boot") return bootPanel;
                    if (widget.kind === "media")
                      return (
                        <section className="panel data-panel">
                          {mediaPanel}
                        </section>
                      );
                    if (widget.kind === "vnc" || widget.kind === "glinet")
                      return (
                        <ConsoleSlot
                          sessionKey={`${device.id}:${widget.kind}`}
                          visible={view === "server" && tab === "Console"}
                          interactive={!editing}
                        />
                      );
                    if (widget.kind === "sol")
                      return (
                        <SerialConsole
                          apiPrefix={apiPrefix}
                          active={!editing && tab === "Console"}
                        />
                      );
                    if (widget.kind === "diagnostics")
                      return (
                        <DiagnosticsTerminal
                          apiPrefix={apiPrefix}
                          csrf={csrf}
                          active={!editing && tab === "Console"}
                        />
                      );
                    if (
                      widget.kind === "power-now" ||
                      widget.kind === "energy-cost"
                    )
                      return (
                        <PowerUsage history={history} mode={widget.kind} />
                      );
                    if (widget.kind === "jetkvm")
                      return (
                        <ConsoleSlot
                          sessionKey={`${device.id}:jetkvm`}
                          visible={view === "server" && tab === "Console"}
                          interactive={!editing}
                        />
                      );
                    if (widget.kind === "power-control")
                      return (
                        <section className="panel power-panel">
                          <div className="section-title">
                            <Power size={17} />
                            <h2>Power control</h2>
                            <Badge state={bmcOnline ? "ok" : "unavailable"}>
                              {power.data?.state ?? "Unknown"}
                            </Badge>
                          </div>
                          <p>Manage the server through IPMI.</p>
                          <div className="power-buttons">
                            {actions.map((action) => (
                              <button
                                key={action.id}
                                disabled={!bmcOnline || busy}
                                className={
                                  action.id === "off" ? "danger-text" : ""
                                }
                                onClick={() =>
                                  control(
                                    "power",
                                    action.id,
                                    action.name,
                                    action.id === "on"
                                      ? "Power on this server?"
                                      : "This can interrupt running workloads. Unsaved data may be lost. Proceed only when the server is ready.",
                                  )
                                }
                              >
                                <Power size={14} />
                                {action.name}
                                <span>↗</span>
                              </button>
                            ))}
                          </div>
                          <Notice message={power.error} />
                        </section>
                      );
                    if (widget.kind === "health")
                      return (
                        <section className="panel health-panel">
                          {[
                            {
                              icon: Thermometer,
                              label: "CPU temperature",
                              sensor: temp,
                            },
                            { icon: Wind, label: "Fan speed", sensor: fan },
                            ...(supplies.length
                              ? supplies.map((sensor) => ({
                                  icon: Zap,
                                  label: sensor.name,
                                  sensor,
                                }))
                              : [
                                  {
                                    icon: Zap,
                                    label: "Power supply",
                                    sensor: undefined,
                                  },
                                ]),
                          ].map(({ icon: Icon, label, sensor }) => (
                            <div className="metric" key={label}>
                              <Icon size={17} />
                              <span>{label}</span>
                              <strong
                                className={
                                  sensors.error ? "unavailable" : sensor?.state
                                }
                              >
                                {sensors.error
                                  ? "Unavailable"
                                  : sensor
                                    ? sensorReading(sensor)
                                    : sensors.loading
                                      ? "Loading…"
                                      : "Not reported"}
                              </strong>
                              {sensor && (
                                <span className="sr-only">
                                  {sensors.error ? "Unavailable" : sensor.state}
                                </span>
                              )}
                            </div>
                          ))}
                          <p className="small-note">
                            {sensors.error
                              ? "Sensor readings unavailable"
                              : "Readings refresh every 20 seconds"}
                          </p>
                        </section>
                      );
                    if (widget.kind === "power-usage")
                      return tab === "Console" ? (
                        <PowerUsage history={history} />
                      ) : null;
                    if (
                      widget.kind === "power-hour" ||
                      widget.kind === "power-day" ||
                      widget.kind === "power-week" ||
                      widget.kind === "power-statistics" ||
                      widget.kind === "power-projections"
                    )
                      return (
                        <PowerUsage
                          history={history}
                          mode={
                            widget.kind.slice(6) as
                              | "hour"
                              | "day"
                              | "week"
                              | "statistics"
                              | "projections"
                          }
                        />
                      );
                    return (
                      <SensorReadings
                        widget={widget}
                        sensors={sensors.data}
                        error={sensors.error}
                        editing={editing}
                      />
                    );
                  }}
                />
              )}
            </div>
            {tab === "Power usage" && (
              <DashboardGrid
                fixedLayout={powerLayout}
                storageKey={pageStorage + "power"}
                toolbarTarget={toolbarTarget}
                renderWidget={(widget) => (
                  <PowerUsage
                    history={history}
                    mode={
                      widget.kind.slice(6) as
                        "statistics" | "hour" | "day" | "week" | "projections"
                    }
                  />
                )}
              />
            )}
            {tab === "Cooling" && (
              <DashboardGrid
                fixedLayout={panelLayout([["cooling", 0, 0, 5, 3]])}
                storageKey={pageStorage + "cooling"}
                toolbarTarget={toolbarTarget}
                renderWidget={() => coolingPanel}
              />
            )}
            {terminalVisited && (
              <section className="terminal-area" hidden={tab !== "Terminals"}>
                <DashboardGrid
                  fixedLayout={terminalLayout}
                  storageKey={pageStorage + "terminals"}
                  toolbarTarget={toolbarTarget}
                  active={tab === "Terminals"}
                  renderWidget={(widget, editing) =>
                    widget.kind === "sol" ? (
                      hasSOLWidget ? (
                        <button onClick={() => openTerminalWidget("sol")}>
                          Open serial console widget
                        </button>
                      ) : (
                        <SerialConsole
                          apiPrefix={apiPrefix}
                          active={tab === "Terminals" && !editing}
                        />
                      )
                    ) : hasDiagnosticsWidget ? (
                      <button onClick={() => openTerminalWidget("diagnostics")}>
                        Open diagnostics widget
                      </button>
                    ) : (
                      <DiagnosticsTerminal
                        apiPrefix={apiPrefix}
                        csrf={csrf}
                        active={tab === "Terminals" && !editing}
                      />
                    )
                  }
                />
              </section>
            )}
            {tab === "Sensors" && (
              <SensorGroups
                sensors={sensors.data}
                error={sensors.error}
                loading={sensors.loading}
                storageKey={pageStorage + "sensors"}
                toolbarTarget={toolbarTarget}
                refresh={() => setRevision((v) => v + 1)}
              />
            )}
            {tab === "Events" && (
              <DashboardGrid
                fixedLayout={panelLayout([["events", 0, 0, 9, 6]])}
                storageKey={pageStorage + "events"}
                toolbarTarget={toolbarTarget}
                renderWidget={() => (
                  <section className="panel data-panel">
                    <PanelHeading
                      title="System event log"
                      detail="Events reported by the BMC; unknown severity is left unclassified"
                      refresh={() => setRevision((v) => v + 1)}
                    />
                    <Notice message={events.error} />
                    <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Sensor</th>
                          <th>Event</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.data?.map((event) => (
                          <tr key={event.id}>
                            <td className="mono">{event.timestamp}</td>
                            <td>{event.sensor}</td>
                            <td>{event.message}</td>
                            <td>
                              <Badge state={event.state}>{event.state}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!events.data?.length && (
                      <Empty loading={events.loading} noun="events" />
                    )}
                    <button
                      className="danger-text"
                      disabled={!bmcOnline}
                      onClick={() =>
                        control(
                          "events/clear",
                          "clear",
                          "Clear system event log",
                          "This permanently erases the BMC event log. Export any required records first.",
                        )
                      }
                    >
                      Clear event log
                    </button>
                  </section>
                )}
              />
            )}
            {tab === "Inventory" && (
              <DashboardGrid
                fixedLayout={panelLayout([["inventory", 0, 0, 7, 6]])}
                storageKey={pageStorage + "inventory"}
                toolbarTarget={toolbarTarget}
                renderWidget={() => (
                  <section className="panel data-panel">
                    <PanelHeading
                      title="System inventory & FRU"
                      detail="Manufacturer, board, chassis and controller information"
                      refresh={() => setRevision((v) => v + 1)}
                    />
                    <Notice message={inventory.error} />
                    <dl className="inventory">
                      {Object.entries(inventory.data?.fields ?? {}).map(
                        ([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd>{value || "Unavailable"}</dd>
                          </div>
                        ),
                      )}
                    </dl>
                    {!inventory.data && (
                      <Empty
                        loading={inventory.loading}
                        noun="inventory data"
                      />
                    )}
                  </section>
                )}
              />
            )}
            {tab === "Boot" && (
              <DashboardGrid
                fixedLayout={panelLayout([["boot", 0, 0, 7, 4]])}
                storageKey={pageStorage + "boot"}
                toolbarTarget={toolbarTarget}
                renderWidget={() => bootPanel}
              />
            )}
            {tab === "Information" && <Information />}
            {tab === "iBORK settings" && (
              <section aria-label="iBORK settings" className="app-settings">
                <PanelLayoutSettings
                  csrf={csrf}
                  workspace={workspace}
                  settingsRequest={assistant.settingsRequest}
                >
                  <button
                    className="quiet"
                    onClick={() => setTab(defaultDeviceTab(device))}
                  >
                    Back to server
                  </button>
                  <p className="small-note settings-intro">
                    Connections, login security, and the electricity rate are
                    saved on iBORK. Sidebar preferences apply to this browser.
                  </p>
                  <div className="settings-grid">
                    <ConnectionSettings
                      csrf={csrf}
                      openAssistant={assistant.openAssistant}
                    />
                    {assistant.settings}
                    <PasswordSettings csrf={csrf} onChanged={passwordChanged} />
                    <ElectricityRateSettings />
                    <SidebarSettings
                      workspace={workspace}
                      openServer={select}
                    />
                  </div>
                </PanelLayoutSettings>
              </section>
            )}
            {tab === "Server settings" && (
              <div className="server-settings">
                <div className="server-settings-main">
                  <ConnectionSettings deviceId={device.id} csrf={csrf} />
                  <div className="server-preferences">
                    {!!sourcesFor(device).length && (
                      <ConsolePreferences workspace={workspace} />
                    )}
                    <DisplaySettings workspace={workspace} />
                  </div>
                </div>
                {(hasManagement || !!sourcesFor(device).length) && (
                  <SettingsPanel
                    onConnect={() =>
                      consoleStore.connect(`${device.id}:jetkvm`)
                    }
                    connecting={
                      state === "connecting" || state === "reconnecting"
                    }
                    mediaPanel={mediaPanel}
                    apiPrefix={apiPrefix}
                    config={config.data}
                    kvm={kvm}
                    connected={connected}
                    confirm={confirm}
                    feedback={setFeedback}
                  />
                )}
              </div>
            )}
            <div className="mobile-owner">
              <OwnerLinks />
            </div>
          </main>
        </DashboardScope.Provider>
      </div>
      <dialog
        ref={dialog}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setConfirmation(null);
        }}
      >
        <div className="dialog-icon">
          <ShieldCheck size={24} />
        </div>
        <h2>{confirmation?.title}</h2>
        <p>{confirmation?.detail}</p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={() => setConfirmation(null)}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void execute()}
          >
            {busy ? "Applying…" : "Confirm action"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
function Empty({ loading, noun }: { loading: boolean; noun: string }) {
  return (
    <p className="empty-data">
      {loading ? "Loading…" : `No ${noun} to display.`}
    </p>
  );
}
function PanelHeading({
  title,
  detail,
  refresh,
  logo,
}: {
  title: string;
  detail: string;
  refresh?: () => void;
  logo?: string;
}) {
  return (
    <div className="data-heading">
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {logo && <img className="widget-logo" src={logo} alt="" />}
      {refresh && (
        <button className="quiet" onClick={refresh}>
          <RefreshCw size={14} />
          Refresh
        </button>
      )}
    </div>
  );
}

function SettingsPanel({
  onConnect,
  connecting,
  mediaPanel,
  apiPrefix,
  config,
  kvm,
  connected,
  confirm,
  feedback,
}: {
  onConnect: () => void;
  connecting: boolean;
  mediaPanel: ReactNode;
  apiPrefix: string;
  config?: Configuration;
  kvm: JetKVMProvider | null;
  connected: boolean;
  confirm: (title: string, detail: string, run: () => Promise<unknown>) => void;
  feedback: (message: string) => void;
}) {
  const [edid, setEDID] = useState("Not read");
  const [connectionResult, setConnectionResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  async function test(path: string) {
    setTesting(true);
    setConnectionResult(null);
    try {
      const result = await api<{ message?: string }>(apiPrefix + path);
      setConnectionResult({
        ok: true,
        message: result.message ?? "Connection test succeeded.",
      });
    } catch (e) {
      setConnectionResult({
        ok: false,
        message: e instanceof Error ? e.message : "Connection failed",
      });
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="settings-grid">
      <section className="panel data-panel">
        <PanelHeading
          title="Connections"
          detail="Credentials stay on the management service."
        />
        <dl className="inventory">
          {config?.bmcHost && (
            <>
              <div>
                <dt>BMC address</dt>
                <dd>
                  {config?.bmcHost}:{config?.bmcPort}
                </dd>
              </div>
              <div>
                <dt>BMC username</dt>
                <dd>{config?.bmcUsername}</dd>
              </div>
            </>
          )}
          {config?.jetUrl && (
            <div>
              <dt>JetKVM address</dt>
              <dd>{config?.jetUrl || "Not paired"}</dd>
            </div>
          )}
          {config?.vncPort ? (
            <div>
              <dt>VNC address</dt>
              <dd>
                {config.vncHost}:{config.vncPort} ·{" "}
                {config.vncTransport === "tcp" ? "Plaintext TCP" : "Pinned TLS"}
              </dd>
            </div>
          ) : null}
          {config?.glUrl && (
            <>
              <div>
                <dt>GL.iNet Comet address</dt>
                <dd>{config.glUrl}</dd>
              </div>
              <div>
                <dt>Comet username</dt>
                <dd>{config.glUsername || "admin"}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Operation timeout</dt>
            <dd>{config?.timeoutSeconds} seconds</dd>
          </div>
        </dl>
        <div className="button-row">
          {config?.bmcHost && (
            <button disabled={testing} onClick={() => void test("power")}>
              Test IPMI
            </button>
          )}
          {config?.jetUrl && (
            <button
              disabled={testing}
              onClick={() => void test("jetkvm/status")}
            >
              Test JetKVM
            </button>
          )}
          {config?.vncPort ? (
            <button disabled={testing} onClick={() => void test("vnc/status")}>
              Test VNC
            </button>
          ) : null}
          {config?.glUrl && (
            <button
              disabled={testing}
              onClick={() => void test("glkvm/status")}
            >
              Test GL.iNet Comet
            </button>
          )}
        </div>
        {testing && <p role="status">Testing connection…</p>}
        {connectionResult && (
          <div
            className={`notice notice-${connectionResult.ok ? "success" : "error"}`}
            role={connectionResult.ok ? "status" : "alert"}
          >
            {connectionResult.ok ? (
              <CircleCheck size={16} aria-hidden="true" />
            ) : (
              <CircleAlert size={16} aria-hidden="true" />
            )}
            <span>{connectionResult.message}</span>
            <button
              type="button"
              aria-label="Dismiss connection result"
              onClick={() => setConnectionResult(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        <p className="small-note">
          Use Server connection above to change addresses and credentials.
        </p>
        <p className="small-note">
          Dashboard layouts are saved in this browser.
          {config?.bmcHost &&
            " Power history is collected by the service, even when the dashboard is closed."}
        </p>
        {config?.jetUrl && (
          <p className="small-note">
            JetKVM uses stock firmware. Video and input connect directly through
            WebRTC.
          </p>
        )}
      </section>
      {config?.jetUrl && (
        <section className="panel data-panel">
          <PanelHeading
            title="Console compatibility"
            detail="Settings are applied to stock JetKVM only when confirmed."
            logo={jetLogo}
          />
          {config?.jetUrl && (
            <button disabled={connected || connecting} onClick={onConnect}>
              {connecting
                ? "Connecting JetKVM…"
                : "Connect JetKVM for settings"}
            </button>
          )}
          <div className="setting-block">
            <h3>Server-compatible EDID</h3>
            <p>Use the device’s 1280 × 1024, 60 Hz server preset.</p>
            <button
              disabled={!connected}
              onClick={() =>
                void kvm
                  ?.rpc<string>("getEDID")
                  .then((value) => setEDID(value))
                  .catch((e) => feedback(String(e)))
              }
            >
              Read current EDID
            </button>
            <output className="edid-output">{edid}</output>
            <button
              disabled={!connected}
              onClick={() =>
                confirm(
                  "Use server-compatible EDID",
                  "Changing EDID can briefly interrupt video. Apply the stock server preset?",
                  async () => {
                    const presets =
                      await kvm!.rpc<Array<{ name: string; edid: string }>>(
                        "getEDIDPresets",
                      );
                    const preset = presets.find(
                      (p) => /idrac/i.test(p.name) && /1280x1024/i.test(p.name),
                    );
                    if (!preset)
                      throw new Error(
                        "No stock server-compatible preset reported. No change made.",
                      );
                    await kvm!.rpc("setEDID", { edid: preset.edid });
                    setEDID(preset.edid);
                  },
                )
              }
            >
              Use Server-Compatible EDID
            </button>
          </div>
          {mediaPanel}
        </section>
      )}
    </div>
  );
}
function VirtualMedia({
  kvm,
  connected,
  confirm,
  feedback,
  media,
  setMedia,
  iso,
  setISO,
}: {
  kvm: JetKVMProvider | null;
  connected: boolean;
  confirm: (title: string, detail: string, run: () => Promise<unknown>) => void;
  feedback: (message: string) => void;
  media: string;
  setMedia: (s: string) => void;
  iso: string;
  setISO: (s: string) => void;
}) {
  const isoID = useId();
  return (
    <div className="setting-block">
      <h3>Virtual media</h3>
      <p>
        Mount a trusted HTTP(S) ISO URL reachable from JetKVM. The ISO server
        must support byte ranges.
      </p>
      <label htmlFor={isoID}>ISO URL</label>
      <input
        id={isoID}
        type="url"
        placeholder="https://images.example.net/installer.iso"
        value={iso}
        onChange={(e) => setISO(e.target.value)}
      />
      <div className="button-row">
        <button
          disabled={!connected || !iso}
          onClick={() => {
            try {
              const url = new URL(iso);
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password
              )
                throw new Error();
              confirm(
                "Mount virtual media",
                "Expose this ISO to the server as a virtual CD-ROM? Use only a trusted ISO source.",
                () =>
                  kvm!.rpc("mountWithHTTP", {
                    url: url.toString(),
                    mode: "CDROM",
                  }),
              );
            } catch {
              feedback("Enter an HTTP(S) URL without embedded credentials.");
            }
          }}
        >
          Mount ISO
        </button>
        <button
          disabled={!connected}
          onClick={() =>
            confirm(
              "Eject virtual media",
              "Eject the mounted media? This may interrupt an installation.",
              () => kvm!.rpc("unmountImage"),
            )
          }
        >
          Eject
        </button>
        <button
          disabled={!connected}
          onClick={() =>
            void kvm
              ?.rpc("getVirtualMediaState")
              .then((value) => setMedia(JSON.stringify(value)))
              .catch((e) => feedback(String(e)))
          }
        >
          Read status
        </button>
      </div>
      <output className="edid-output">{media}</output>
      <p className="small-note">
        Local uploads are deferred. Unsupported firmware reports an error
        without changing configuration.
      </p>
    </div>
  );
}
