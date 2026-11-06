import {
  lazy,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  GridStack,
  type GridStackHandle,
  type GridStackOptions,
} from "gridstack/dist/react";
import {
  Grip,
  Pencil,
  RotateCcw,
  PlugZap,
  Settings,
  Monitor,
  Zap,
  LayoutDashboard,
  Plus,
  Expand,
  Unplug,
  ArrowUpRight,
  ArrowLeft,
} from "lucide-react";
import {
  ConsoleSlot,
  useConsoleSessions,
  useConsoleSnapshot,
} from "./ConsoleSessions";
import { sourcesFor, type Device, type Display } from "./device-identity";
import {
  fitWall,
  readWallPreferences,
  writeWallPreferences,
  wallLimits,
  type WallEntry,
  type WallPreferences,
} from "./kvm-wall";
import "gridstack/dist/gridstack.css";
import { ServerIcon } from "./ServerIcon";
const FleetTelemetry = lazy(async () => ({
  default: (await import("./FleetTelemetry")).FleetTelemetry,
}));
const wallViews = {
  Consoles: Monitor,
  "Power Overview": Zap,
  "Central Dashboard": LayoutDashboard,
  Settings,
};
type WallView = keyof typeof wallViews;
const tabKey = "ibork:wall-view:v1";
const labels = { jetkvm: "JetKVM", vnc: "VNC", glinet: "Comet Pro" };
type Board = {
  devices: Device[];
  displays: Record<string, Display>;
  value: WallPreferences;
  editing: boolean;
  narrow: boolean;
  enlarged: string | null;
  enlarge: (id: string) => void;
  openServer: (id: string, settings?: boolean) => void;
  resize: (id: string, patch: Partial<WallEntry>) => void;
};
const BoardContext = createContext<Board | null>(null);
function Tile({ deviceId }: Record<string, unknown>) {
  const board = useContext(BoardContext)!;
  const entry = board.value.entries.find((e) => e.deviceId === deviceId)!;
  const device = board.devices.find((d) => d.id === deviceId)!;
  const key = `${entry.deviceId}:${entry.source}` as const;
  const { store } = useConsoleSessions(),
    snapshot = useConsoleSnapshot(key);
  const enlargeButton = useRef<HTMLButtonElement>(null);
  const wasEnlarged = useRef(false);
  useEffect(() => {
    const active = board.enlarged === device.id;
    if (wasEnlarged.current && !active) enlargeButton.current?.focus();
    wasEnlarged.current = active;
  }, [board.enlarged, device.id]);
  const live = snapshot.phase === "live" || snapshot.phase === "no-signal";
  return (
    <section
      className="widget-shell wall-tile"
      aria-label={`${device.name} console tile`}
    >
      <header className="widget-bar">
        <span
          className="widget-grip"
          tabIndex={board.editing && !board.narrow ? 0 : undefined}
          title={
            board.editing ? "Drag to move; arrow keys move the tile" : undefined
          }
          onKeyDown={(event) => {
            if (!board.editing || board.narrow) return;
            const moves: Record<string, Partial<WallEntry>> = {
              ArrowLeft: { x: Math.max(0, entry.x - 1) },
              ArrowRight: { x: Math.min(12 - entry.w, entry.x + 1) },
              ArrowUp: { y: Math.max(0, entry.y - 1) },
              ArrowDown: { y: Math.min(200, entry.y + 1) },
            };
            if (moves[event.key]) {
              event.preventDefault();
              board.resize(entry.deviceId, moves[event.key]);
            }
          }}
        >
          {board.editing && <Grip size={15} />}
          <ServerIcon device={device} display={board.displays[device.id]} />
          <strong>{board.displays[device.id]?.name || device.name}</strong>
        </span>
        {board.editing && !board.narrow && (
          <span className="widget-adjust">
            {(["w", "h"] as const).map((dimension) => (
              <label key={dimension}>
                {dimension.toUpperCase()}
                <input
                  aria-label={`${device.name} ${dimension === "w" ? "width" : "height"}`}
                  type="number"
                  min={
                    dimension === "w"
                      ? wallLimits(entry.source).minW
                      : wallLimits(entry.source).minH
                  }
                  max={dimension === "w" ? 12 : 24}
                  value={entry[dimension]}
                  onChange={(event) => {
                    if (Number.isInteger(event.target.valueAsNumber))
                      board.resize(entry.deviceId, {
                        [dimension]: event.target.valueAsNumber,
                      });
                  }}
                />
              </label>
            ))}
          </span>
        )}
        <div className="wall-tile-tools">
          <span
            role="status"
            className={live ? "wall-live" : ""}
            title={`${labels[entry.source]} · ${snapshot.phase}`}
            aria-label={snapshot.phase}
          >
            {snapshot.phase}
          </span>
          <button
            aria-label="Connect"
            title="Connect"
            disabled={
              live || ["connecting", "reconnecting"].includes(snapshot.phase)
            }
            onClick={() => store.connect(key)}
          >
            <PlugZap size={16} />
          </button>
          <button
            aria-label="Disconnect"
            title="Disconnect"
            disabled={snapshot.phase === "disconnected"}
            onClick={() => store.disconnect(key)}
          >
            <Unplug size={16} />
          </button>
          <button
            aria-label="Open server"
            title="Open server"
            onClick={() => board.openServer(device.id)}
          >
            <ArrowUpRight size={16} />
          </button>
        </div>
      </header>
      <div className="wall-preview">
        <ConsoleSlot
          sessionKey={key}
          visible={board.enlarged !== device.id}
          interactive={!board.editing}
        />
        {board.enlarged !== device.id && (
          <button
            ref={enlargeButton}
            className="wall-enlarge"
            disabled={!live || board.editing}
            aria-label={`Enlarge ${device.name}`}
            title="Hover to type · click to enlarge · Shift+Escape releases keyboard"
            onPointerEnter={(event) => {
              if (
                event.pointerType === "mouse" &&
                live &&
                !board.editing &&
                !board.enlarged &&
                document.hasFocus()
              )
                store.setControl(key);
            }}
            onPointerLeave={() => {
              if (!board.enlarged && store.isControlling(key))
                store.setControl(null);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              board.enlarge(device.id);
            }}
          />
        )}
      </div>
      {snapshot.error && (
        <p role="alert" className="small-note">
          {snapshot.error}
        </p>
      )}
    </section>
  );
}
const components = { tile: Tile };
const nodeFor = (e: WallEntry) => ({
  id: e.deviceId,
  x: e.x,
  y: e.y,
  w: e.w,
  h: e.h,
  minW: wallLimits(e.source).minW,
  minH: wallLimits(e.source).minH,
  maxH: 24,
  component: "tile",
  props: { deviceId: e.deviceId },
});
export function KVMWall({
  devices,
  displays,
  openServer,
  openSettings,
}: {
  devices: Device[];
  displays: Record<string, Display>;
  openServer: (id: string, settings?: boolean) => void;
  openSettings: () => void;
}) {
  const { store } = useConsoleSessions();
  const [initial] = useState(() => readWallPreferences(devices));
  const [value, setValue] = useState(initial.value),
    [warning, setWarning] = useState(initial.warning || "");
  const current = useRef(value),
    gridRef = useRef<GridStackHandle>(null),
    container = useRef<HTMLDivElement>(null),
    expanded = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false),
    [narrow, setNarrow] = useState(false),
    [resetting, setResetting] = useState(false),
    [enlarged, setEnlarged] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [wallTab, setWallTab] = useState<WallView>(() => {
    try {
      const saved = localStorage.getItem(tabKey);
      if (saved && Object.hasOwn(wallViews, saved)) return saved as WallView;
    } catch {
      /* Browser storage is optional. */
    }
    return "Consoles";
  });
  const enteredConsoles = useRef(false);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [options] = useState<GridStackOptions>(() => ({
    column: 12,
    cellHeight: 80,
    margin: 8,
    animate: false,
    disableDrag: true,
    disableResize: true,
    handle: ".widget-grip",
    draggable: { cancel: "button,input,select,video,canvas" },
    children: initial.value.entries.filter((e) => e.included).map(nodeFor),
  }));
  useEffect(() => {
    store.setControl(null);
  }, [store]);
  useEffect(() => {
    if (wallTab !== "Consoles" || enteredConsoles.current) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      enteredConsoles.current = true;
      for (const device of devices)
        for (const source of sourcesFor(device)) {
          const entry = current.current.entries.find(
            (e) => e.deviceId === device.id,
          );
          if (!entry?.included || entry.source !== source)
            store.disconnect(`${device.id}:${source}`);
        }

      for (const entry of current.current.entries)
        if (entry.included && entry.connect === "auto")
          store.connect(`${entry.deviceId}:${entry.source}`);
    });
    return () => {
      cancelled = true;
    };
  }, [store, wallTab, devices]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      const style = getComputedStyle(element);
      const width =
        element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      setNarrow(width < 768);
      setSize({
        width,
        height: Math.max(
          320,
          innerHeight - element.getBoundingClientRect().top - 100,
        ),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  useEffect(() => {
    const grid = gridRef.current?.getGrid();
    grid?.enableMove(editing && !narrow);
    grid?.enableResize(editing && !narrow);
  }, [editing, narrow]);
  const fitted = fitWall(value.entries, size.width, size.height);
  // Manual layouts must not reload during drag-induced scrolling or height changes.
  const fitWidth = value.automatic ? size.width : 0;
  const fitHeight = value.automatic ? size.height : 0;
  const structure = value.entries
    .filter((e) => e.included)
    .map((e) => `${e.deviceId}:${e.source}`)
    .join("|");
  useEffect(() => {
    const grid = gridRef.current?.getGrid();
    if (!grid) return;
    grid.column(!value.automatic && narrow ? 1 : 12);
    grid.cellHeight(
      value.automatic
        ? fitWall(current.current.entries, fitWidth, fitHeight).cellHeight
        : (value.cellHeight ?? 80),
    );
    grid.load(
      (value.automatic
        ? fitWall(current.current.entries, fitWidth, fitHeight).entries
        : current.current.entries
      )
        .filter((e) => e.included)
        .map(nodeFor),
    );
  }, [
    structure,
    value.automatic,
    value.cellHeight,
    narrow,
    fitWidth,
    fitHeight,
  ]);
  const selected = value.entries.find((e) => e.deviceId === enlarged);
  const selectedKey = selected
    ? (`${selected.deviceId}:${selected.source}` as const)
    : null;
  useEffect(() => {
    if (selectedKey) store.setControl(selectedKey);
    const element = expanded.current;
    // Portals follow React ancestry, so capture activation on the physical container.
    const resume = (event: PointerEvent) => {
      if (
        selectedKey &&
        event.pointerType !== "touch" &&
        !store.isControlling(selectedKey) &&
        (event.target as HTMLElement).matches("canvas,video")
      ) {
        event.preventDefault();
        event.stopPropagation();
        store.setControl(selectedKey);
      }
    };
    element?.addEventListener("pointerdown", resume, true);
    return () => {
      element?.removeEventListener("pointerdown", resume, true);
      store.setControl(null);
    };
  }, [store, selectedKey]);
  function save(next: WallPreferences) {
    current.current = next;
    setValue(next);
    setWarning(writeWallPreferences(next));
  }
  function saveGeometry() {
    const grid = gridRef.current?.getGrid();
    if (!grid || grid.getColumn() !== 12) return;
    const nodes = grid.save(false, false, undefined, 12);
    if (!Array.isArray(nodes)) return;
    save({
      version: 1,
      automatic: false,
      cellHeight: grid.getCellHeight(),
      gridWidth: grid.el.getBoundingClientRect().width,
      entries: current.current.entries.map((entry) => {
        const node = nodes.find((n) => n.id === entry.deviceId);
        return node
          ? {
              ...entry,
              x: node.x ?? 0,
              y: node.y ?? 0,
              w: node.w ?? node.minW ?? 6,
              h: node.h ?? node.minH ?? 4,
            }
          : entry;
      }),
    });
  }
  function resize(id: string, patch: Partial<WallEntry>) {
    const grid = gridRef.current?.getGrid();
    if (!grid || grid.getColumn() !== 12) return;
    const entry = current.current.entries.find((e) => e.deviceId === id)!;
    const limits = wallLimits(entry.source);
    const w = Math.max(limits.minW, Math.min(12, patch.w ?? entry.w)),
      h = Math.max(limits.minH, Math.min(24, patch.h ?? entry.h));
    const node = grid
      .getGridItems()
      .find((item) => item.gridstackNode?.id === id);
    if (!node) return;
    grid.update(node, {
      x: Math.max(0, Math.min(12 - w, patch.x ?? entry.x)),
      y: Math.max(0, Math.min(200, patch.y ?? entry.y)),
      w,
      h,
    });
    saveGeometry();
  }
  function change(entry: WallEntry, patch: Partial<WallEntry>) {
    if (patch.source !== undefined || patch.included === false) {
      store.disconnect(`${entry.deviceId}:${entry.source}`);
      if (enlarged === entry.deviceId) setEnlarged(null);
    }
    save({
      ...value,
      entries: value.entries.map((e) =>
        e.deviceId === entry.deviceId ? { ...e, ...patch } : e,
      ),
    });
  }
  function setAll(connect: WallEntry["connect"]) {
    save({
      ...value,
      entries: value.entries.map((entry) => ({ ...entry, connect })),
    });
  }
  const settings = (
    <section
      className="wall-settings"
      aria-label="Wall settings"
      hidden={wallTab !== "Settings"}
    >
      <div className="wall-settings-actions">
        <button onClick={() => setAll("manual")}>Set all to manual</button>
        <button onClick={() => setAll("auto")}>
          <PlugZap size={16} />
          Auto-connect all
        </button>
        <button className="quiet" onClick={openSettings}>
          <Plus size={16} />
          Add server
        </button>
      </div>
      <p className="small-note">
        Choose the consoles on your wall. Auto-connect applies when you open the
        wall; these choices are saved in this browser.
      </p>
      <div className="wall-server-options">
        {value.entries.map((entry) => {
          const device = devices.find((d) => d.id === entry.deviceId)!;
          return (
            <section
              key={device.id}
              className="panel data-panel wall-server-option"
            >
              <header>
                <ServerIcon device={device} display={displays[device.id]} />
                <strong>{displays[device.id]?.name || device.name}</strong>
                <button
                  className="quiet"
                  aria-label={`Server settings for ${device.name}`}
                  title="Server settings"
                  onClick={() => openServer(device.id, true)}
                >
                  <Settings size={18} />
                </button>
              </header>
              <label className="switch-label">
                <span>Include {device.name}</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={entry.included}
                  onChange={(e) =>
                    change(entry, { included: e.target.checked })
                  }
                />
              </label>
              {sourcesFor(device).length > 1 && (
                <label>
                  Console source for {device.name}
                  <select
                    aria-label={`Console source for ${device.name}`}
                    value={entry.source}
                    onChange={(e) =>
                      change(entry, {
                        source: e.target.value as WallEntry["source"],
                      })
                    }
                  >
                    {sourcesFor(device).map((source) => (
                      <option key={source} value={source}>
                        {labels[source]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="switch-label">
                <span>
                  Auto-connect
                  <small>
                    {entry.connect === "auto"
                      ? "When the wall opens"
                      : "Connect manually"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`Auto-connect ${device.name}`}
                  checked={entry.connect === "auto"}
                  onChange={(e) =>
                    change(entry, {
                      connect: e.target.checked ? "auto" : "manual",
                    })
                  }
                />
              </label>
            </section>
          );
        })}
      </div>
    </section>
  );
  return (
    <BoardContext.Provider
      value={{
        devices,
        displays,
        value,
        editing,
        narrow,
        enlarged,
        enlarge: setEnlarged,
        openServer,
        resize,
      }}
    >
      <section className="kvm-wall main" aria-label="KVM wall" ref={container}>
        <header className="wall-heading">
          <nav className="tabs wall-tabs" aria-label="Wall views">
            {(Object.keys(wallViews) as WallView[]).map((name) => {
              const Icon = wallViews[name];
              return (
                <button
                  key={name}
                  className={wallTab === name ? "active" : ""}
                  aria-current={wallTab === name ? "page" : undefined}
                  onClick={() => {
                    setWallTab(name);
                    try {
                      localStorage.setItem(tabKey, name);
                    } catch {
                      /* Browser storage is optional. */
                    }
                    setResetting(false);
                    setEditing(false);
                    store.setControl(null);
                    setEnlarged(null);
                  }}
                >
                  <Icon size={16} />
                  {name}
                </button>
              );
            })}
          </nav>
          {wallTab === "Consoles" && (
            <div className="dashboard-actions">
              <button
                onClick={() =>
                  value.entries
                    .filter((entry) => entry.included)
                    .forEach((entry) =>
                      store.connect(`${entry.deviceId}:${entry.source}`),
                    )
                }
              >
                <PlugZap size={16} />
                Connect all
              </button>
              <button
                aria-label={editing ? "Done editing wall" : "Edit wall layout"}
                title={editing ? "Done editing wall" : "Edit wall layout"}
                onClick={() => {
                  store.setControl(null);
                  setEnlarged(null);
                  if (!editing && value.automatic && !narrow) saveGeometry();
                  setEditing(!editing);
                }}
              >
                <Pencil size={18} />
              </button>
              <button
                aria-label="Reset wall layout"
                title="Reset wall layout"
                hidden={!editing}
                onClick={() => setResetting(true)}
              >
                <RotateCcw size={18} />
              </button>
            </div>
          )}
        </header>
        {(wallTab === "Power Overview" || wallTab === "Central Dashboard") && (
          <Suspense fallback={<p role="status">Loading telemetry…</p>}>
            <FleetTelemetry
              devices={devices}
              displays={displays}
              view={wallTab}
            />
          </Suspense>
        )}
        {warning && (
          <p role="status" className="notice">
            {warning}
          </p>
        )}
        {settings}
        {resetting && (
          <div className="notice">
            <p>
              Fit selected consoles to the page using 4:3 screens? Connections
              and server selection stay unchanged.
            </p>
            <button
              onClick={() => {
                save({ ...value, automatic: true });
                setEditing(false);
                setResetting(false);
              }}
            >
              Confirm wall reset
            </button>
            <button onClick={() => setResetting(false)}>Cancel reset</button>
          </div>
        )}
        {editing && (
          <p className="small-note">
            {narrow
              ? "Move and resize on a wider screen."
              : "Drag a title bar, use arrow keys on its handle, or edit width and height."}{" "}
            Remote input is paused.
          </p>
        )}
        <div
          hidden={wallTab !== "Consoles"}
          className={`wall-grid ${editing ? "is-editing" : ""}`}
          style={{ maxWidth: value.automatic ? fitted.width : value.gridWidth }}
        >
          <GridStack
            ref={gridRef}
            options={options}
            components={components}
            onDragStop={saveGeometry}
            onResizeStop={saveGeometry}
            emptyContent={
              <p>
                No consoles included. Open Wall settings or add a KVM-only
                server.
              </p>
            }
          />
        </div>
        {selected && (
          <section
            className="wall-enlarged"
            aria-label="Enlarged console"
            ref={expanded}
          >
            <header className="wall-heading">
              <button
                aria-label="Back to wall"
                title="Back to wall"
                onClick={() => {
                  store.setControl(null);
                  setEnlarged(null);
                }}
              >
                <ArrowLeft size={18} />
              </button>
              <strong>
                {devices.find((d) => d.id === selected.deviceId)?.name}
              </strong>
              <button
                aria-label="Open server"
                title="Open server"
                onClick={() => openServer(selected.deviceId)}
              >
                <ArrowUpRight size={18} />
              </button>
              <button
                aria-label="Fullscreen enlarged console"
                title="Fullscreen console"
                onClick={() =>
                  void expanded.current
                    ?.requestFullscreen()
                    .catch(() =>
                      setNotice("Fullscreen is unavailable in this browser."),
                    )
                }
              >
                <Expand size={18} />
              </button>
            </header>
            {notice && <p role="alert">{notice}</p>}
            <ConsoleSlot sessionKey={selectedKey!} />
            <p className="small-note">
              Shift+Escape releases control. Click the display to resume; Escape
              is sent remotely.
            </p>
          </section>
        )}
      </section>
    </BoardContext.Provider>
  );
}
