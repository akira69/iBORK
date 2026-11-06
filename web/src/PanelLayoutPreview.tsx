import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Circle,
  Home,
  Maximize2,
  Monitor,
  Settings,
} from "lucide-react";
import type { PanelLayout, PanelServer } from "./PanelLayout";
import type { Workspace } from "./DeviceWorkspace";
import { resolveServerIcon } from "./ServerIcon";
import { useElectricityRate } from "./ElectricityRate";

const display = { model: "Elecrow CrowPanel V3", width: 800, height: 480 };

const day = [
  70, 73, 72, 76, 78, 77, 80, 84, 81, 86, 89, 91, 90, 94, 96, 95, 98, 97, 94,
  96, 93, 94, 92, 92,
];
const month = [
  61, 65, 63, 70, 69, 74, 66, 68, 73, 75, 78, 74, 81, 84, 80, 74, 73, 79, 82,
  81, 85, 87, 90, 85, 82, 88, 91, 94, 90, 92,
];
function Chart({
  kind,
  watts,
  rate,
}: {
  kind: string;
  watts: number | null;
  rate: number | null;
}) {
  const values = kind === "day" ? day : month;
  const hours = kind === "day" ? 24 : 720;
  const cost =
    watts === null || rate === null
      ? "—"
      : "$" +
        (
          (((hours * watts) / 1000) *
            rate *
            values.reduce((sum, v) => sum + v, 0)) /
          values.length /
          100
        ).toFixed(2);
  return (
    <section
      className={`cl-chart cl-${kind}`}
      aria-label={
        kind === "day" ? "24-hour chart preview" : "30-day chart preview"
      }
    >
      <header>
        <h4>{kind === "day" ? "24 hours" : "30 days"}</h4>
        <strong>{cost}</strong>
      </header>
      <small>Avg W</small>
      <svg
        viewBox="0 0 700 48"
        preserveAspectRatio="none"
        role="img"
        aria-label="Example power history"
      >
        {[5, 26, 47].map((y) => (
          <line key={y} x1="0" y1={y} x2="700" y2={y} stroke="#41515c" />
        ))}
        {watts !== null && (
          <polyline
            points={values
              .map(
                (v, i) =>
                  `${(700 * i) / (values.length - 1)},${47 - (v - 50) * 0.8}`,
              )
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <small>
        {watts === null
          ? "Waiting for readings"
          : `${hours} / ${hours} hours covered`}
      </small>
    </section>
  );
}

export function PanelLayoutPreview({
  layout,
  workspace,
  detail,
  onHome,
  onServer,
}: {
  layout: PanelLayout;
  workspace?: Workspace;
  detail?: PanelServer;
  onHome: () => void;
  onServer: (id: string) => void;
}) {
  const { rate } = useElectricityRate();
  const [nativeSize, setNativeSize] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [settings, setSettings] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setScale(entry.contentRect.width / display.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setSettings(false);
    body.current?.scrollTo(0, 0);
  }, [detail?.id]);
  const included = layout.servers.filter((s) => s.included);
  const devices = workspace?.devices ?? [];
  function info(s: PanelServer) {
    const index = devices.findIndex((d) => d.id === s.id);
    const device = devices[index],
      display = workspace?.displays[s.id];
    const name = display?.name || device?.name || s.id;
    const icon = device
      ? resolveServerIcon(device, display)
      : {
          shortLabel: [...name].slice(0, 6).join(""),
          initials: [...name].slice(0, 2).join("").toUpperCase(),
          source: undefined,
          kind: "initials",
        };
    const watts = s.available.includes("power")
      ? ([50, 75, 100][index] ?? 50)
      : null;
    return { name, model: display?.model || device?.model || "", icon, watts };
  }
  const measured = included.flatMap((s) => info(s).watts ?? []);
  const total = measured.length ? measured.reduce((a, b) => a + b, 0) : null;
  function icon(s: PanelServer) {
    const { icon } = info(s);
    return (
      <span className={`cl-icon cl-icon-${icon.kind}`} aria-hidden="true">
        {icon.source ? <img src={icon.source} alt="" /> : icon.initials}
      </span>
    );
  }
  function tiles() {
    return (
      <div className="cl-tiles" aria-label="Server tiles preview">
        {included.length ? (
          included.map((s) => {
            const { name, icon: identity, watts } = info(s);
            return (
              <button
                key={s.id}
                aria-label={`Preview ${name}`}
                onClick={() => onServer(s.id)}
              >
                {icon(s)}
                <span>
                  {identity.shortLabel}
                  <b>{watts === null ? "No reading" : `${watts} W`}</b>
                </span>
                <ChevronRight size={20} />
              </button>
            );
          })
        ) : (
          <p>No servers on panel</p>
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
            <div>
              Fleet power
              <strong>{total === null ? "— W" : `${total} W`}</strong>
            </div>
            <div>
              <strong>
                {included.length} {included.length === 1 ? "server" : "servers"}
              </strong>
              <small>{measured.length} metered</small>
            </div>
            <small>
              {rate === null ? "Rate" : `$${rate.toFixed(4)}`}
              <br />
              {rate === null ? "unavailable" : "/ kWh"}
            </small>
          </div>,
        );
      else if (key === "servers") rows.push(<div key={key}>{tiles()}</div>);
      else {
        const pair = [key];
        if (["day", "month"].includes(layout.home[i + 1]))
          pair.push(layout.home[++i]);
        rows.push(
          <div className="cl-chart-row" key={key}>
            {pair.map((kind) => (
              <Chart key={kind} kind={kind} watts={total} rate={rate} />
            ))}
          </div>,
        );
      }
    }
    return rows.length ? rows : <p>Select a Home section.</p>;
  }
  const identity = detail ? info(detail) : null;
  return (
    <section className="panel cl-preview" aria-label="Display preview">
      <header className="cl-preview-title">
        <h3>
          Display preview{" "}
          <span>
            ({display.width} × {display.height})
          </span>
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
        <div
          className={`cl-bezel${nativeSize ? " cl-native" : ""}`}
          style={{ width: nativeSize ? display.width : undefined }}
        >
          <div
            className="cl-glass"
            ref={frame}
            style={{ aspectRatio: `${display.width} / ${display.height}` }}
          >
            <div
              className="cl-screen"
              style={{
                width: display.width,
                height: display.height,
                transform: `scale(${scale})`,
              }}
            >
              <header className="cl-screenbar">
                <button
                  onClick={() => {
                    if (settings) setSettings(false);
                    else onHome();
                  }}
                  aria-label={
                    settings ? "Back from preview settings" : "Preview Home"
                  }
                >
                  <Home /> {settings ? "Back" : "Home"}
                </button>
                <select
                  aria-label="Preview server selector"
                  value={detail?.id ?? ""}
                  onChange={(e) => {
                    setSettings(false);
                    if (e.target.value) onServer(e.target.value);
                    else onHome();
                  }}
                >
                  <option value="">All servers</option>
                  {layout.servers
                    .filter((s) => s.included || s.id === detail?.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {info(s).name}
                      </option>
                    ))}
                </select>
                <span className="cl-linked">
                  <Circle size={14} fill="currentColor" />
                  Connected
                </span>
                <button
                  aria-label="Preview panel settings"
                  onClick={() => setSettings(!settings)}
                >
                  <Settings />
                  Settings
                </button>
              </header>
              <div className="cl-screen-body" ref={body}>
                {settings ? (
                  <div className="cl-settings-page">
                    <h3>Settings</h3>
                    {[
                      "Wi-Fi setup",
                      "Change power PIN",
                      "Display schedule",
                    ].map((v) => (
                      <div key={v}>
                        {v}
                        <ChevronRight />
                      </div>
                    ))}
                  </div>
                ) : detail && identity ? (
                  <>
                    <div className="cl-device">
                      {icon(detail)}
                      <div>
                        <h3>{identity.name}</h3>
                        <span>{identity.model}</span>
                      </div>
                    </div>
                    <div className="cl-widgets">
                      {detail.widgets.map((k) =>
                        k === "controls" ? (
                          <div className="cl-controls" key={k}>
                            <span>Power on</span>
                            <span>Graceful shutdown</span>
                          </div>
                        ) : (
                          <div className="cl-stat" key={k}>
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
                              {k === "temperature" ? (
                                "42.0 °C"
                              ) : k === "fan" ? (
                                <>
                                  Lowest: 1800 RPM
                                  <br />
                                  Highest: 2400 RPM
                                </>
                              ) : (
                                `${identity.watts} W`
                              )}
                            </b>
                          </div>
                        ),
                      )}
                      {!detail.widgets.length && (
                        <p>No widgets enabled for this server.</p>
                      )}
                    </div>
                  </>
                ) : (
                  homeRows()
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="cl-caption">
        {display.model} · Example readings. Icons and labels reflect this
        browser’s sidebar choices.
      </p>
    </section>
  );
}
