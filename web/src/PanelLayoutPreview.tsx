import { useEffect, useRef, useState } from "react";
import { Maximize2, Monitor } from "lucide-react";
import type { PanelLayout, PanelServer } from "./PanelLayout";
import type { Workspace } from "./DeviceWorkspace";
import type { RemoteDisplayStatus } from "./remote-display";
import ibork from "./assets/panel/ibork.jpg";
import finch from "./assets/panel/finch.jpg";
import gear from "./assets/panel/settings.jpg";
import transmission from "./assets/panel/transmission.png";
import switchOff from "./assets/panel/knife0.png";
import switchOn from "./assets/panel/knife4.png";

type Snapshot = NonNullable<RemoteDisplayStatus["snapshot"]>;
const watts = (value?: number | null) =>
  value == null ? "No reading" : `${value.toFixed(0)} W`;

function Chart({
  kind,
  snapshot,
  paired,
}: {
  kind: "day" | "month";
  snapshot?: Snapshot;
  paired: boolean;
}) {
  const day = kind === "day";
  const width = paired ? 344 : 736;
  const count = day ? 24 : 30;
  const values = snapshot?.[kind] ?? [];
  const peak = Math.max(1, ...values.map((v) => v ?? 0));
  const kwh = day ? snapshot?.dayKwh : snapshot?.monthKwh;
  const hours = day ? snapshot?.dayHours : snapshot?.monthHours;
  const rate = snapshot?.usdPerKwh;
  const points = values.map((v, i) =>
    v == null
      ? null
      : [
          Math.floor((width * i) / (count - 1)),
          44 - Math.round((42 * v) / peak),
        ],
  );
  return (
    <section
      className={`cl-chart cl-${kind}`}
      aria-label={day ? "24-hour chart preview" : "30-day chart preview"}
    >
      <h4>{day ? "24 hours" : "30 days"}</h4>
      <strong>
        {kwh == null || rate == null ? "--" : `$${(kwh * rate).toFixed(2)}`}
      </strong>
      <small>Avg W</small>
      <svg
        viewBox={`-2 0 ${width + 4} 48`}
        role="img"
        aria-label="Average power history"
      >
        {[2, 23, 44].map((y) => (
          <path key={y} d={`M0 ${y}h${width}`} stroke="#344959" />
        ))}
        {points.map((p, i) => {
          if (!p) return null;
          const previous = points[i - 1];
          return previous ? (
            <line
              key={i}
              x1={previous[0]}
              y1={previous[1]}
              x2={p[0]}
              y2={p[1]}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          ) : (
            <circle key={i} cx={p[0]} cy={p[1]} r="2" fill="currentColor" />
          );
        })}
      </svg>
      <small>
        {hours == null
          ? "Waiting for readings"
          : `${hours.toFixed(1)}/${day ? 24 : 720} hours covered`}
      </small>
    </section>
  );
}

function PanelIcon({
  name,
  image,
  large,
}: {
  name: string;
  image?: string;
  large?: boolean;
}) {
  return image ? (
    <img
      className={`cl-icon${large ? " cl-large" : ""}`}
      src={`data:image/jpeg;base64,${image}`}
      alt=""
    />
  ) : (
    <span className="cl-initials" aria-hidden="true">
      {[...name].slice(0, 2).join("").toUpperCase()}
    </span>
  );
}

export function PanelLayoutPreview({
  layout,
  workspace,
  detail,
  status,
  onHome,
  onServer,
}: {
  layout: PanelLayout;
  workspace?: Workspace;
  detail?: PanelServer;
  status?: RemoteDisplayStatus;
  onHome: () => void;
  onServer: (id: string) => void;
}) {
  const [nativeSize, setNativeSize] = useState(false);
  const [palette, setPalette] = useState("Teal");
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState<"home" | "servers" | "settings">("home");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setScale(entry.contentRect.width / 800),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const detailId = detail?.id;
  useEffect(() => {
    if (detailId) setPage("home");
  }, [detailId]);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [detail?.id, page]);

  const snapshot = status?.snapshot ?? undefined;
  const devices = layout.servers.filter((s) => s.included);
  const readings = new Map(snapshot?.devices.map((d) => [d.id, d]));
  const measured = devices.flatMap((s) => readings.get(s.id)?.watts ?? []);
  const metered = devices.filter((s) => readings.get(s.id)?.metered).length;
  // The panel sends fleet-wide chart buckets. Changing the draft fleet invalidates those aggregates.
  const sameFleet =
    readings.size === devices.length &&
    devices.every((s) => readings.has(s.id));
  const nameOf = (id: string) =>
    readings.get(id)?.name ||
    workspace?.devices.find((d) => d.id === id)?.name ||
    id;
  const online = !!status?.connected;
  const health = online
    ? ""
    : snapshot
      ? "Offline - last readings"
      : "Waiting for iBORK";
  const showSelector = !layout.home.includes("servers");
  const inSettings = page === "settings";
  const inSelector = !detail && page === "servers" && showSelector;
  const nav =
    !inSettings && !inSelector && !detail && showSelector
      ? "Servers"
      : "< Back";
  function navigate() {
    if (nav === "Servers") setPage("servers");
    else {
      setPage(detail && !inSettings && showSelector ? "servers" : "home");
      onHome();
    }
  }

  function tiles() {
    return (
      <div className="cl-tiles" aria-label="Server tiles preview">
        {devices.map((s) => {
          const d = readings.get(s.id),
            name = nameOf(s.id);
          return (
            <button
              key={s.id}
              className={d?.metered ? "cl-metered" : undefined}
              aria-label={`Preview ${name}`}
              onClick={() => onServer(s.id)}
            >
              <PanelIcon name={name} image={d?.sidebar?.image} />
              <span>
                {d?.sidebar?.label || name}
                <b className={d?.watts == null ? "cl-no-reading" : undefined}>
                  {watts(d?.watts)}
                </b>
              </span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="m4 2 6 6-6 6" fill="none" stroke="currentColor" />
              </svg>
            </button>
          );
        })}
        {!devices.length && (
          <p>{snapshot ? "No servers on this panel" : "Waiting for iBORK"}</p>
        )}
      </div>
    );
  }

  function homeRows() {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < layout.home.length; i++) {
      const key = layout.home[i];
      if (key === "power")
        rows.push(
          <div key={key} className="cl-power">
            <small>
              {measured.length < metered
                ? "Partial fleet power"
                : "Fleet power"}
            </small>
            <strong>
              {measured.length
                ? watts(measured.reduce((a, b) => a + b, 0))
                : "-- W"}
            </strong>
            <img src={transmission} alt="" />
            <span>Electricity rate</span>
            <b>
              {snapshot?.usdPerKwh == null
                ? "--"
                : `$${snapshot.usdPerKwh.toFixed(4)}`}{" "}
              / kWh
            </b>
            {snapshot && <em>{metered} metered</em>}
          </div>,
        );
      else if (key === "servers") rows.push(<div key={key}>{tiles()}</div>);
      else if (key === "day" || key === "month") {
        const next = layout.home[i + 1];
        const paired = next === "day" || next === "month";
        const history = sameFleet ? snapshot : undefined;
        rows.push(
          <div className="cl-chart-row" key={key}>
            <Chart kind={key} paired={paired} snapshot={history} />
            {paired && <Chart kind={next} paired snapshot={history} />}
          </div>,
        );
        if (paired) i++;
      }
    }
    return rows.length ? rows : <p>No home sections enabled</p>;
  }

  function serverPage(server: PanelServer) {
    const name = nameOf(server.id),
      d = readings.get(server.id),
      data = snapshot?.details?.[server.id];
    const controls =
      server.widgets.includes("controls") &&
      server.available.includes("controls");
    const state = data?.powerState;
    const pending = data?.pending && online ? "Loading" : "No reading";
    const rpm = (v?: number | null) =>
      v == null ? pending : `${v.toFixed(0)} RPM`;
    return (
      <div className={`cl-detail${controls ? " cl-has-switch" : ""}`}>
        <div className="cl-device-icon">
          <PanelIcon
            name={name}
            image={data?.image || d?.sidebar?.image}
            large={!!data?.image}
          />
        </div>
        <div className="cl-device">
          <h3>{name}</h3>
          <small>
            {d?.model ||
              workspace?.devices.find((v) => v.id === server.id)?.model}
          </small>
        </div>
        <div className="cl-widgets">
          {server.widgets
            .filter((k) => k !== "controls")
            .map((k) => (
              <div
                key={k}
                className={`cl-stat${k === "fan" ? " cl-fans" : ""}`}
              >
                <span>
                  {
                    {
                      power: "Power draw",
                      temperature: "Hottest temperature",
                      fan: "Fan Speeds",
                    }[k]
                  }
                </span>
                <b>
                  {k === "fan" ? (
                    <>
                      <span>Lowest: {rpm(data?.fan)}</span>
                      <span>Highest: {rpm(data?.fanMax)}</span>
                    </>
                  ) : k === "power" ? (
                    watts(d?.watts)
                  ) : data?.temperature == null ? (
                    pending
                  ) : (
                    `${data.temperature.toFixed(1)} °C`
                  )}
                </b>
              </div>
            ))}
          {!server.widgets.length && <p>No widgets enabled for this server</p>}
        </div>
        {controls && (
          <>
            <div className="cl-switch" aria-label="Power control preview">
              <h4>Power control</h4>
              {!online && (state === "on" || state === "off") && (
                <small>Last known</small>
              )}
              <span>Power on</span>
              {state === "on" || state === "off" ? (
                <img
                  src={state === "on" ? switchOn : switchOff}
                  alt={`Chassis power ${state}`}
                />
              ) : (
                <small className="cl-unknown-pose">
                  {online ? "Reading chassis state" : "Offline"}
                </small>
              )}
              <span>Graceful shutdown</span>
            </div>
            <small className="cl-pin-note">
              Enter the panel PIN to confirm an action
            </small>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="panel cl-preview" aria-label="Display preview">
      <header className="cl-preview-title">
        <h3>
          Display preview <span>(800 × 480)</span>
        </h3>
        <div>
          {(
            [
              [false, Monitor, "Fit preview"],
              [true, Maximize2, "Actual-size preview"],
            ] as const
          ).map(([native, Icon, label]) => (
            <button
              key={label}
              title={label}
              aria-label={label}
              aria-pressed={nativeSize === native}
              onClick={() => setNativeSize(native)}
            >
              <Icon size={18} />
            </button>
          ))}
        </div>
      </header>
      <div className="cl-pan">
        <div className={`cl-bezel${nativeSize ? " cl-native" : ""}`}>
          <div className="cl-glass" ref={frame}>
            <div
              className="cl-screen"
              data-palette={palette}
              style={{ transform: `scale(${scale})` }}
            >
              <header className="cl-screenbar">
                <img className="cl-logo" src={ibork} alt="" />
                <b>iBORK</b>
                {(inSettings || detail || showSelector) && (
                  <button
                    className="cl-nav"
                    aria-label={
                      nav === "Servers"
                        ? "Preview server selector"
                        : inSettings
                          ? "Back from preview settings"
                          : "Back in display preview"
                    }
                    onClick={navigate}
                  >
                    {nav}
                  </button>
                )}
                <small className="cl-health">{health}</small>
                <svg
                  className="cl-link"
                  viewBox="520 10 110 49"
                  role="img"
                  aria-label={
                    online
                      ? "Panel recently connected"
                      : "Panel connection unconfirmed"
                  }
                >
                  <g
                    fill="none"
                    stroke={online ? "#61e796" : "#aac1cc"}
                    strokeWidth="3"
                  >
                    {[24, 16, 8].map((r) => (
                      <path
                        key={r}
                        d={`M${548 - r * 0.67} ${46 - r * 0.74}a${r} ${r} 0 0 1 ${r * 1.34} 0`}
                      />
                    ))}
                    <circle cx="548" cy="46" r="1.5" />
                  </g>
                  <g stroke={online ? "#61e796" : "#ff6c73"} fill="none">
                    {[19, 36].map((y) => (
                      <g key={y}>
                        <rect x="590" y={y} width="32" height="14" rx="3" />
                        <circle cx="597" cy={y + 7} r="1.5" />
                        <path d={`M605 ${y + 7}h10`} />
                      </g>
                    ))}
                  </g>
                </svg>
                <button
                  className="cl-gear"
                  aria-label="Preview panel settings"
                  onClick={() => setPage("settings")}
                >
                  <img src={gear} alt="" />
                </button>
                <img className="cl-finch" src={finch} alt="Finch13" />
              </header>
              <div className="cl-screen-body" ref={body}>
                {inSettings ? (
                  <div className="cl-settings-page">
                    <h3>Settings</h3>
                    {[
                      "Wi-Fi setup",
                      "Change power PIN",
                      "Display schedule",
                      `Color: ${palette}`,
                    ].map((v) => (
                      <div key={v}>
                        {v}
                        <span>&gt;</span>
                      </div>
                    ))}
                  </div>
                ) : detail ? (
                  serverPage(detail)
                ) : inSelector ? (
                  tiles()
                ) : (
                  homeRows()
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="cl-caption">
        Elecrow CrowPanel V3 · Read-only preview.{" "}
        {snapshot
          ? "Readings from the last panel poll."
          : "Waiting for the first panel snapshot."}
        <label>
          Preview palette{" "}
          <select value={palette} onChange={(e) => setPalette(e.target.value)}>
            {["Teal", "Amber", "Ice", "Crimson"].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </p>
    </section>
  );
}
