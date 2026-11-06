import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoolingPanel } from "../../src/CoolingPanel";
import { DiagnosticsTerminal } from "../../src/DiagnosticsTerminal";

it("shows fan mode without duplicate sensors or unqualified controls", () => {
  const html = renderToStaticMarkup(
    createElement(CoolingPanel, {
      cooling: {
        modeCode: "0x03",
        modeLabel: "Unknown",
        querySupported: true,
        controlSupported: false,
        reason: "Qualification pending",
      },
    }),
  );
  expect(html).toContain("Unknown (0x03)");
  expect(html).not.toContain("RPM");
  expect(html).not.toContain("°C");
  expect(html).not.toContain("Change fan mode");
  expect(html).not.toContain("Custom fan curve");
});
it("does not render old readings as current when telemetry has failed", () => {
  const html = renderToStaticMarkup(
    createElement(CoolingPanel, {
      error: "Mode query failed",
    }),
  );
  expect(html).not.toContain("2,175 RPM");
  expect(html).not.toContain("29 °C");
  expect(html).toContain("Unavailable");
  expect(html).toContain("Mode query failed");
});
it("keeps the inactive diagnostics console disabled", () => {
  const html = renderToStaticMarkup(
    createElement(DiagnosticsTerminal, {
      apiPrefix: "devices/test/",
      csrf: "csrf",
      active: false,
    }),
  );
  expect(html).toContain("Diagnostics paused");
  expect(html).toContain("Read-only IPMI diagnostics");
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});
