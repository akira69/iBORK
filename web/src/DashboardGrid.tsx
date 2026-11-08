import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useId,
  useState,
  type ReactNode,
} from "react";
import {
  GridStack,
  type GridStackHandle,
  type GridStackOptions,
} from "gridstack/dist/react";
import jetLogo from "./assets/jetkvm.svg";
import { createPortal } from "react-dom";
import {
  Grip,
  Pencil,
  RotateCcw,
  X,
  Minimize2,
  Rows3,
  SlidersHorizontal,
} from "lucide-react";
import "gridstack/dist/gridstack.css";
import "./OverviewWidgets.css";
import { WidgetCatalog } from "./WidgetCatalog";
import { AppearanceContext, AppearanceEditor } from "./WidgetAppearance";
import "./WidgetAppearance.css";
import {
  DashboardScope,
  DashboardPreview,
  useDashboardSurface,
} from "./DashboardAssistant";
import {
  catalog,
  validDashboardSensorId,
  availableDashboardLayout,
  widgetAvailable,
  selectedSensors,
  defaultLayout,
  readLayout,
  writeLayout,
  type DashboardLayout,
  type DashboardWidget,
  type WidgetKind,
} from "./dashboard-layout";

export type ScopedWidget = Pick<
  DashboardWidget,
  "deviceIds" | "sensorId" | "sensorIds" | "aggregate" | "title"
> & {
  kind: "power-now" | "power-hour" | "sensor" | "jetkvm" | "vnc" | "glinet";
};
type Props = {
  fleet?: {
    catalog: (add: (widget: ScopedWidget) => void, count: number) => ReactNode;
    title: (widget: DashboardWidget) => string;
    feeds: (widgets: DashboardWidget[], editing: boolean) => ReactNode;
  };
  storageKey: string;
  dashboardTitle?: string;
  initialLayout?: DashboardLayout;
  jetAvailable?: boolean;
  vncAvailable?: boolean;
  cometAvailable?: boolean;
  managementAvailable?: boolean;
  toolbarTarget?: HTMLElement | null;
  active?: boolean;
  fixedLayout?: DashboardLayout;
  renderWidget: (widget: DashboardWidget, editing: boolean) => ReactNode;
  onKindsChange?: (kinds: WidgetKind[]) => void;
  beforeRemove?: (widget: DashboardWidget) => void;
  onEditStart?: () => void;
  sensors?: { id: string; name: string }[];
};
type Board = Props & {
  previewing: boolean;
  sensors: { id: string; name: string }[];
  layout: DashboardLayout;
  editing: boolean;
  narrow: boolean;
  remove: (widget: DashboardWidget) => void;
  update: (widget: DashboardWidget, patch: Partial<DashboardWidget>) => void;
  fit: (widget: DashboardWidget) => void;
};
const BoardContext = createContext<Board | null>(null);

function Widget({ id }: Record<string, unknown>) {
  const board = useContext(BoardContext)!;
  const editor = useRef<HTMLDivElement>(null);
  const editorId = useId();
  const widget = board.layout.widgets.find((w) => w.id === id);
  if (!widget) return null;
  const title =
    board.fleet?.title(widget) ?? widget.title ?? catalog[widget.kind].title;
  const selected = selectedSensors(widget);
  return (
    <section
      className={`widget-shell${widget.appearance?.showTitle === false && !board.editing ? " hide-widget-title" : ""}`}
      data-density={widget.appearance?.density ?? "compact"}
      data-value-size={widget.appearance?.valueSize ?? "medium"}
      data-accent={widget.appearance?.accent ?? "teal"}
      data-compact={widget.h === 1}
      id={`widget-${widget.id}`}
      aria-label={`${title} widget`}
      tabIndex={-1}
    >
      <header className="widget-bar">
        <span
          className="widget-grip"
          tabIndex={board.editing && !board.narrow ? 0 : undefined}
          title={
            board.editing
              ? "Drag to move; use arrow keys when focused"
              : undefined
          }
          onDoubleClick={() =>
            board.editing && !board.narrow && board.fit(widget)
          }
          onKeyDown={(event) => {
            if (!board.editing || board.narrow) return;
            const moves: Record<string, Partial<DashboardWidget>> = {
              ArrowLeft: { x: Math.max(0, widget.x - 1) },
              ArrowRight: { x: Math.min(12 - widget.w, widget.x + 1) },
              ArrowUp: { y: Math.max(0, widget.y - 1) },
              ArrowDown: { y: Math.min(200, widget.y + 1) },
            };
            if (moves[event.key]) {
              event.preventDefault();
              board.update(widget, moves[event.key]);
            }
          }}
        >
          {board.editing && <Grip size={15} />}
          {widget.kind === "jetkvm" && (
            <img className="widget-logo" src={jetLogo} alt="JetKVM" />
          )}
          <strong>
            {widget.kind === "jetkvm" && !board.fleet && !widget.title
              ? "Console"
              : title}
          </strong>
        </span>
        {board.editing && !board.fleet && widget.kind === "sensor" && (
          <>
            <button
              className="quiet"
              aria-label="Configure sensor"
              title="Choose sensor readings"
              popoverTarget={editorId}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                if (editor.current) {
                  editor.current.style.left = `${Math.max(8, Math.min(rect.right + 8, innerWidth - 336))}px`;
                  editor.current.style.top = `${Math.max(16, Math.min(rect.top, innerHeight - 400))}px`;
                }
              }}
            >
              <SlidersHorizontal size={16} />
            </button>
            <div
              id={editorId}
              ref={editor}
              popover="auto"
              className="sensor-editor"
              role="dialog"
              aria-label="Sensor settings"
            >
              <header>
                <strong>Sensor settings</strong>
                <button
                  className="quiet"
                  aria-label="Close sensor settings"
                  popoverTarget={editorId}
                  popoverTargetAction="hide"
                >
                  <X size={16} />
                </button>
              </header>

              <label className="sensor-picker">
                Display
                <select
                  aria-label="Sensor widget mode"
                  value={widget.sensorMode ?? "fixed"}
                  onChange={(e) =>
                    board.update(widget, {
                      sensorMode: e.target.value as "fixed" | "selectable",
                      sensorIds: selected,
                      sensorId: selected[0] ?? "",
                    })
                  }
                >
                  <option value="fixed">Fixed readings</option>
                  <option value="selectable">Selectable reading</option>
                </select>
              </label>

              {widget.sensorMode !== "selectable" && (
                <div className="sensor-config">
                  <p>Choose readings · {selected.length} selected</p>
                  <fieldset aria-label="Readings to display">
                    {selected
                      .filter((id) => !board.sensors.some((s) => s.id === id))
                      .map((id) => (
                        <label key={id}>
                          <input
                            type="checkbox"
                            checked
                            onChange={() =>
                              board.update(widget, {
                                sensorIds: selected.filter(
                                  (value) => value !== id,
                                ),
                              })
                            }
                          />
                          Unavailable sensor ({id})
                        </label>
                      ))}
                    {board.sensors.map((sensor) => (
                      <label key={sensor.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(sensor.id)}
                          disabled={
                            !selected.includes(sensor.id) &&
                            selected.length >= 64
                          }
                          onChange={(e) =>
                            board.update(widget, {
                              sensorIds: e.target.checked
                                ? [...selected, sensor.id]
                                : selected.filter((id) => id !== sensor.id),
                            })
                          }
                        />
                        {sensor.name}
                      </label>
                    ))}
                    {!board.sensors.length && (
                      <p>Waiting for sensor readings…</p>
                    )}
                  </fieldset>
                </div>
              )}
            </div>
          </>
        )}
        {board.editing && (
          <AppearanceEditor
            value={widget.appearance}
            chart={[
              "power-hour",
              "power-day",
              "power-week",
              "power-usage",
            ].includes(widget.kind)}
            onChange={(appearance) => board.update(widget, { appearance })}
          />
        )}
        {board.editing && !board.narrow && (
          <div className="widget-adjust" aria-label={`Arrange ${title}`}>
            <button
              className="quiet"
              aria-label={`Fit ${title} content`}
              title="Fit content height (or double-click title)"
              onClick={() => board.fit(widget)}
            >
              <Minimize2 size={15} />
            </button>
            <label title="Width in columns">
              W{" "}
              <input
                aria-label={`${title} width`}
                type="number"
                min={catalog[widget.kind].minW}
                max={12}
                value={widget.w}
                onChange={(e) => {
                  const w = e.currentTarget.valueAsNumber;
                  if (
                    Number.isInteger(w) &&
                    w >= catalog[widget.kind].minW &&
                    w <= 12
                  )
                    board.update(widget, { w, x: Math.min(widget.x, 12 - w) });
                }}
              />
            </label>
            <label title="Height in rows">
              H{" "}
              <input
                aria-label={`${title} height`}
                type="number"
                min={catalog[widget.kind].minH}
                max={24}
                value={widget.h}
                onChange={(e) => {
                  const h = e.currentTarget.valueAsNumber;
                  if (
                    Number.isInteger(h) &&
                    h >= catalog[widget.kind].minH &&
                    h <= 24
                  )
                    board.update(widget, { h });
                }}
              />
            </label>
          </div>
        )}
        {board.editing && !board.fixedLayout && (
          <button
            className="quiet"
            aria-label={`Remove ${title}`}
            onClick={() => board.remove(widget)}
          >
            <X size={16} />
          </button>
        )}
      </header>
      <div
        className={`widget-body widget-${widget.kind}`}
        inert={
          board.previewing &&
          ![
            "sensor",
            "power-now",
            "power-hour",
            "power-day",
            "power-week",
            "power-statistics",
            "power-projections",
            "health",
          ].includes(widget.kind)
        }
      >
        {widget.kind === "sensor" && (
          <>
            {widget.sensorMode === "selectable" && (
              <label className="sensor-picker">
                Sensor
                <select
                  aria-label="Sensor to display"
                  value={widget.sensorId ?? ""}
                  onChange={(e) =>
                    board.update(widget, { sensorId: e.target.value })
                  }
                >
                  <option value="">Choose a sensor</option>
                  {widget.sensorId &&
                    !board.sensors.some((s) => s.id === widget.sensorId) && (
                      <option value={widget.sensorId}>
                        Unavailable sensor
                      </option>
                    )}
                  {board.sensors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <AppearanceContext value={widget.appearance ?? {}}>
          {board.renderWidget(widget, board.editing || board.previewing)}
        </AppearanceContext>
      </div>
    </section>
  );
}
const components = { widget: Widget };
const nodeFor = (widget: DashboardWidget) => ({
  id: widget.id,
  x: widget.x,
  y: widget.y,
  w: widget.w,
  h: widget.h,
  minW: catalog[widget.kind].minW,
  minH: catalog[widget.kind].minH,
  maxH: 24,
  component: "widget",
  props: { id: widget.id },
});

export function DashboardGrid(props: Props) {
  const scope = useContext(DashboardScope);
  const defaults =
    props.fixedLayout ??
    props.initialLayout ??
    (props.fleet
      ? { version: 1 as const, widgets: [] }
      : defaultLayout(
          !props.jetAvailable && props.vncAvailable,
          props.managementAvailable,
          !props.jetAvailable && !props.vncAvailable && props.cometAvailable,
        ));
  const available = (layout: DashboardLayout) =>
    props.fixedLayout
      ? {
          ...layout,
          widgets: defaults.widgets.map(
            (w) =>
              layout.widgets.find(
                (saved) => saved.id === w.id && saved.kind === w.kind,
              ) ?? w,
          ),
        }
      : availableDashboardLayout(layout, props, !!props.fleet);
  const [initial] = useState(() => {
    const saved = readLayout(props.storageKey, defaults);
    return { ...saved, layout: available(saved.layout) };
  });
  const [savedLayout, setLayout] = useState(initial.layout),
    [error, setError] = useState(initial.error);
  const [editing, setEditing] = useState(false),
    [resetting, setResetting] = useState(false),
    [narrow, setNarrow] = useState(false);
  const gridRef = useRef<GridStackHandle>(null),
    container = useRef<HTMLDivElement>(null);
  const { controller, draft } = useDashboardSurface(
    {
      target: props.storageKey,
      title: props.dashboardTitle ?? scope.title ?? "Dashboard",
      mode: props.fleet ? "fleet" : props.fixedLayout ? "fixed" : "device",
      ...(scope.deviceId && !props.fleet ? { deviceId: scope.deviceId } : {}),
      layout: savedLayout,
      catalog: (Object.keys(catalog) as WidgetKind[])
        .filter((kind) =>
          props.fixedLayout
            ? defaults.widgets.some((w) => w.kind === kind)
            : props.fleet
              ? [
                  "sensor",
                  "power-now",
                  "power-hour",
                  "jetkvm",
                  "vnc",
                  "glinet",
                ].includes(kind)
              : widgetAvailable(
                  kind,
                  props.jetAvailable,
                  props.vncAvailable,
                  props.managementAvailable,
                  props.cometAvailable,
                ),
        )
        .map((kind) => ({ kind, ...catalog[kind] })),
      read: () => localStorage.getItem(props.storageKey),
      save: (next) => {
        const error = writeLayout(props.storageKey, next);
        if (error) throw Error(error);
        setLayout(next);
      },
    },
    props.active !== false && scope.active !== false,
  );
  const layout = draft
    ? draft.showCurrent
      ? draft.baseline
      : draft.layout
    : savedLayout;
  const current = useRef(layout);
  const loadingGrid = useRef(false);
  useLayoutEffect(() => {
    if (current.current === layout) return;
    current.current = layout;
    loadingGrid.current = true;
    gridRef.current?.getGrid()?.load(layout.widgets.map(nodeFor));
    loadingGrid.current = false;
  }, [layout]);
  const [options] = useState<GridStackOptions>(() => ({
    column: 12,
    float: true,
    cellHeight: 80,
    margin: 8,
    animate: false,
    disableDrag: true,
    disableResize: true,
    handle: ".widget-grip",
    draggable: { cancel: "button,input,select,video" },
    columnOpts: { breakpoints: [{ w: 767, c: 1 }] },
    children: initial.layout.widgets.map(nodeFor),
  }));
  const { onKindsChange } = props;
  useEffect(() => {
    onKindsChange?.(layout.widgets.map((w) => w.kind));
  }, [onKindsChange, layout]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry.contentRect.width < 768),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const canEdit =
    editing && !narrow && !draft?.showCurrent && !controller?.busy;
  useEffect(() => {
    const grid = gridRef.current?.getGrid();
    grid?.enableMove(canEdit);
    grid?.enableResize(canEdit);
  }, [canEdit]);

  function commit(next: DashboardLayout) {
    if (loadingGrid.current || draft?.showCurrent || controller?.busy) return;
    current.current = next;
    if (draft) {
      controller?.store.edit(props.storageKey, next);
      return;
    }
    setLayout(next);
    props.onKindsChange?.(next.widgets.map((w) => w.kind));
    setError(writeLayout(props.storageKey, next));
  }
  function saveGeometry() {
    if (loadingGrid.current || draft?.showCurrent || controller?.busy) return;
    const grid = gridRef.current?.getGrid();
    if (!grid || grid.getColumn() !== 12) return;
    // GridStack omits dimensions equal to their minimum when serializing.
    const nodes = grid.save(false, false, undefined, 12);
    if (!Array.isArray(nodes)) return;
    commit({
      version: 1,
      widgets: current.current.widgets.map((w) => {
        const node = nodes.find((n) => n.id === w.id);
        return node
          ? {
              ...w,
              x: node.x ?? 0,
              y: node.y ?? 0,
              w: node.w ?? node.minW ?? 1,
              h: node.h ?? node.minH ?? 1,
            }
          : w;
      }),
    });
  }
  function add(
    kind: WidgetKind,
    sensorMode: "fixed" | "selectable" = "fixed",
    scope?: ScopedWidget,
  ) {
    if (draft?.showCurrent || controller?.busy) return;
    if (
      scope &&
      ["jetkvm", "vnc", "glinet"].includes(kind) &&
      current.current.widgets.some(
        (w) => w.kind === kind && w.deviceIds?.[0] === scope.deviceIds?.[0],
      )
    ) {
      setError("This console is already on the dashboard.");
      return;
    }
    if (
      current.current.widgets.length >= 24 ||
      (!scope &&
        kind !== "sensor" &&
        current.current.widgets.some((w) => w.kind === kind))
    )
      return;
    const { w, h } = catalog[kind];
    const widget: DashboardWidget = {
      id: scope || kind === "sensor" ? crypto.randomUUID() : kind,
      kind,
      ...(kind === "sensor" && !scope ? { sensorMode } : {}),
      ...scope,
      x: 0,
      y: Math.max(0, ...current.current.widgets.map((w) => w.y + w.h)),
      w,
      h,
    };
    const grid = gridRef.current?.getGrid();
    if (scope && grid?.getColumn() === 12)
      grid.engine.findEmptyPosition(widget);
    if (widget.y > 200) {
      setError("No room for another widget. Resize or remove a widget first.");
      return;
    }
    commit({ version: 1, widgets: [...current.current.widgets, widget] });
    grid?.addWidget(nodeFor(widget));
    saveGeometry();
  }
  function remove(widget: DashboardWidget) {
    if (draft?.showCurrent || controller?.busy) return;
    if (!draft) props.beforeRemove?.(widget);
    commit({
      version: 1,
      widgets: current.current.widgets.filter((w) => w.id !== widget.id),
    });
    gridRef.current?.getGrid()?.removeWidget(`[gs-id="${widget.id}"]`);
    saveGeometry();
  }
  function update(widget: DashboardWidget, patch: Partial<DashboardWidget>) {
    if (draft?.showCurrent || controller?.busy) return;
    const next = { ...widget, ...patch };
    commit({
      version: 1,
      widgets: current.current.widgets.map((w) =>
        w.id === widget.id ? next : w,
      ),
    });
    if (
      patch.sensorId !== undefined ||
      patch.appearance !== undefined ||
      patch.sensorIds !== undefined ||
      patch.sensorMode !== undefined
    )
      return;
    const grid = gridRef.current?.getGrid();
    grid?.update(`[gs-id="${widget.id}"]`, {
      x: next.x,
      y: next.y,
      w: next.w,
      h: next.h,
    });
    saveGeometry();
  }
  function reset() {
    if (draft?.showCurrent || controller?.busy) return;
    const resetLayout = available(defaults);
    for (const widget of current.current.widgets)
      if (!resetLayout.widgets.some((w) => w.id === widget.id))
        if (!draft) props.beforeRemove?.(widget);
    commit(resetLayout);
    // load refreshes cached desktop geometry even when currently in one column.
    gridRef.current?.getGrid()?.load(resetLayout.widgets.map(nodeFor));
    setResetting(false);
  }
  function fit(widget: DashboardWidget) {
    if (draft?.showCurrent || controller?.busy) return;
    const grid = gridRef.current?.getGrid();
    const item = grid
      ?.getGridItems()
      .find((el) => el.gridstackNode?.id === widget.id);
    if (!grid || !item) return;
    // Measure the reading layout, excluding editor controls and stretched bodies.
    item.classList.add("widget-measuring");
    try {
      grid.resizeToContent(item);
    } finally {
      item.classList.remove("widget-measuring");
    }
    saveGeometry();
  }
  const toolbar = (
    <div className="dashboard-actions">
      <button
        aria-label={editing ? "Done" : "Edit layout"}
        disabled={draft?.showCurrent || controller?.busy}
        title={editing ? "Done editing layout" : "Edit layout"}
        aria-pressed={editing}
        onClick={() => {
          if (!editing) props.onEditStart?.();
          setEditing((v) => !v);
        }}
      >
        <Pencil size={18} />
      </button>
      <button
        className="quiet"
        onClick={() => setResetting(true)}
        aria-label="Reset layout"
        disabled={draft?.showCurrent || controller?.busy}
        title="Reset layout"
      >
        <RotateCcw size={18} />
      </button>
      {editing && !narrow && (
        <button
          className="quiet"
          aria-label="Compact layout"
          title="Close gaps between widgets"
          onClick={() => {
            gridRef.current?.getGrid()?.compact();
            saveGeometry();
          }}
        >
          <Rows3 size={18} />
        </button>
      )}
    </div>
  );
  return (
    <BoardContext.Provider
      value={{
        ...props,
        previewing: !!draft,
        sensors:
          props.sensors?.filter((s) => validDashboardSensorId(s.id)) ?? [],
        layout,
        editing: editing && !draft?.showCurrent && !controller?.busy,
        narrow,
        remove,
        update,
        fit,
      }}
    >
      <div
        className={`widget-dashboard ${editing ? "is-editing" : ""}`}
        ref={container}
      >
        <DashboardPreview target={props.storageKey} />
        {props.fleet?.feeds(layout.widgets, editing)}
        {props.active === false
          ? null
          : props.toolbarTarget
            ? createPortal(toolbar, props.toolbarTarget)
            : toolbar}
        {error && (
          <p role="status" className="notice">
            {error}
          </p>
        )}
        {editing && (
          <p className="small-note">
            {narrow
              ? "Move and resize on a wider screen."
              : "Drag a title bar, resize a corner, or use the title-bar size controls."}{" "}
            {layout.widgets.some((w) =>
              ["jetkvm", "vnc", "glinet", "sol", "diagnostics"].includes(
                w.kind,
              ),
            ) && "Remote input is paused while editing."}
          </p>
        )}
        {editing &&
          props.fleet &&
          props.fleet.catalog(
            (w) => add(w.kind, "fixed", w),
            layout.widgets.length,
          )}
        {editing && !props.fixedLayout && !props.fleet && (
          <WidgetCatalog
            widgets={layout.widgets}
            jetAvailable={props.jetAvailable}
            vncAvailable={props.vncAvailable}
            cometAvailable={props.cometAvailable}
            managementAvailable={props.managementAvailable}
            add={add}
          />
        )}
        {resetting && (
          <div className="notice" role="alert">
            <span>Restore the default panel arrangement?</span>
            <button onClick={reset}>Confirm reset</button>
            <button onClick={() => setResetting(false)}>Cancel reset</button>
          </div>
        )}
        <GridStack
          ref={gridRef}
          options={options}
          components={components}
          onChange={saveGeometry}
          emptyContent={
            <p className="empty-data">
              Your dashboard is empty. Add a widget to get started.
            </p>
          }
        />
      </div>
    </BoardContext.Provider>
  );
}
