export const densities = ["compact", "comfortable"] as const;
export const valueSizes = ["small", "medium", "large"] as const;
export const accents = ["teal", "blue", "violet", "amber", "slate"] as const;
export type WidgetAppearance = {
  density?: (typeof densities)[number];
  valueSize?: (typeof valueSizes)[number];
  accent?: (typeof accents)[number];
  showTitle?: boolean;
  showLegend?: boolean;
  plotHeight?: number;
};

export function validAppearance(value: unknown): value is WidgetAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, v]) => {
    switch (key) {
      case "density":
        return densities.some((item) => item === v);
      case "valueSize":
        return valueSizes.some((item) => item === v);
      case "accent":
        return accents.some((item) => item === v);
      case "showTitle":
      case "showLegend":
        return typeof v === "boolean";
      case "plotHeight":
        return (
          typeof v === "number" && Number.isInteger(v) && v >= 120 && v <= 800
        );
      default:
        return false;
    }
  });
}
