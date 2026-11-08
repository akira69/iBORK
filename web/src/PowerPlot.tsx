import { useContext, useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppearanceContext } from "./WidgetAppearance";
import "./PowerPlot.css";

export type PowerSeries = {
  name: string;
  points: { at: number; watts: number | null }[];
  partial?: boolean;
  color?: string;
};

export function PowerPlot({
  series,
  start,
  end,
  label,
}: {
  series: PowerSeries[];
  start: number;
  end: number;
  label: string;
}) {
  const appearance = useContext(AppearanceContext);
  const data = useMemo(() => {
    const rows = new Map<number, Record<string, number | null>>();
    series.forEach((line, i) =>
      line.points.forEach(({ at, watts }) => {
        const row = rows.get(at) ?? { at };
        row[`s${i}`] = watts;
        rows.set(at, row);
      }),
    );
    return [...rows.values()].sort((a, b) => a.at! - b.at!);
  }, [series]);
  const tick = (at: number) =>
    new Date(at * 1000).toLocaleString(
      undefined,
      end - start > 86400
        ? { weekday: "short", hour: "numeric" }
        : { hour: "2-digit", minute: "2-digit" },
    );
  const legend = [...new Map(series.map((line) => [line.name, line])).values()];
  return (
    <div
      className="power-plot"
      role="img"
      aria-label={label}
      data-sizing={appearance.plotHeight === undefined ? "auto" : "fixed"}
      style={
        appearance.plotHeight === undefined
          ? undefined
          : { height: appearance.plotHeight, flex: "0 0 auto" }
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={1}
        initialDimension={{ width: 320, height: 180 }}
      >
        <LineChart
          data={data}
          margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid
            vertical={false}
            stroke="var(--line)"
            strokeDasharray="3 5"
          />
          <XAxis
            type="number"
            dataKey="at"
            domain={[start, end]}
            tickFormatter={tick}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            minTickGap={36}
          />
          <YAxis
            width={52}
            domain={[
              0,
              (max: number) => Math.max(10, Math.ceil(max / 10) * 10),
            ]}
            tickFormatter={(v: number) => `${v} W`}
            tick={{ fontSize: 10, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            labelFormatter={(at) =>
              new Date(Number(at) * 1000).toLocaleString()
            }
            formatter={(v, name) => [
              `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} W`,
              name,
            ]}
            contentStyle={{
              background: "#19272e",
              border: "1px solid #344850",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          {appearance.showLegend !== false && (
            <Legend
              content={() => (
                <div className="power-plot-legend">
                  {legend.map((line) => (
                    <span key={line.name}>
                      <i
                        style={{
                          borderColor:
                            line.color ?? "var(--widget-accent, #75ddc6)",
                          borderStyle: line.partial ? "dashed" : "solid",
                        }}
                      />
                      {line.name}
                    </span>
                  ))}
                </div>
              )}
            />
          )}
          {series.map((line, i) => (
            <Line
              key={i}
              dataKey={`s${i}`}
              name={line.name}
              type="linear"
              stroke={line.color ?? "var(--widget-accent, #75ddc6)"}
              strokeWidth={2}
              strokeDasharray={line.partial ? "4 3" : undefined}
              dot={line.points.length <= 12 ? { r: 2 } : false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
