import { createContext, useId, useRef } from "react";
import { Palette, X } from "lucide-react";
import {
  accents,
  densities,
  valueSizes,
  type WidgetAppearance,
} from "./widget-appearance";

export const AppearanceContext = createContext<WidgetAppearance>({});

export function AppearanceEditor({
  value = {},
  chart,
  onChange,
}: {
  value?: WidgetAppearance;
  chart: boolean;
  onChange: (value: WidgetAppearance) => void;
}) {
  const id = useId(),
    panel = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<WidgetAppearance>) =>
    onChange({ ...value, ...patch });
  return (
    <>
      <button
        className="quiet"
        aria-label="Appearance"
        title="Widget appearance"
        popoverTarget={id}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (panel.current) {
            panel.current.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 308))}px`;
            panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - 460))}px`;
          }
        }}
      >
        <Palette size={16} />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="appearance-editor"
        role="dialog"
        aria-label="Widget appearance"
      >
        <div className="appearance-heading">
          <strong>Appearance</strong>
          <button
            className="quiet"
            aria-label="Close appearance"
            popoverTarget={id}
            popoverTargetAction="hide"
          >
            <X size={16} />
          </button>
        </div>
        <label>
          Density
          <select
            value={value.density ?? "compact"}
            onChange={(e) =>
              set({ density: e.target.value as WidgetAppearance["density"] })
            }
          >
            {densities.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value size
          <select
            value={value.valueSize ?? "medium"}
            onChange={(e) =>
              set({
                valueSize: e.target.value as WidgetAppearance["valueSize"],
              })
            }
          >
            {valueSizes.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Accent
          <select
            value={value.accent ?? "teal"}
            onChange={(e) =>
              set({ accent: e.target.value as WidgetAppearance["accent"] })
            }
          >
            {accents.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="appearance-check">
          <input
            type="checkbox"
            checked={value.showTitle !== false}
            onChange={(e) => set({ showTitle: e.target.checked })}
          />
          Show title
        </label>
        {chart && (
          <>
            <label className="appearance-check">
              <input
                type="checkbox"
                checked={value.showLegend !== false}
                onChange={(e) => set({ showLegend: e.target.checked })}
              />
              Show legend
            </label>
            <label>
              Plot sizing
              <select
                value={value.plotHeight === undefined ? "auto" : "fixed"}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.value === "auto") delete next.plotHeight;
                  else next.plotHeight = 240;
                  onChange(next);
                }}
              >
                <option value="auto">Fill widget</option>
                <option value="fixed">Custom height</option>
              </select>
            </label>
            {value.plotHeight !== undefined && (
              <label>
                Plot height (px)
                <input
                  type="number"
                  min={120}
                  max={800}
                  step={10}
                  value={value.plotHeight}
                  onChange={(e) => {
                    const height = e.currentTarget.valueAsNumber;
                    if (
                      Number.isInteger(height) &&
                      height >= 120 &&
                      height <= 800
                    )
                      set({ plotHeight: height });
                  }}
                />
              </label>
            )}
          </>
        )}
        <button type="button" onClick={() => onChange({})}>
          Reset appearance
        </button>
      </div>
    </>
  );
}
