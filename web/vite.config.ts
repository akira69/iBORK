import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: "novnc-idrac-compatibility",
      enforce: "pre",
      transform(code, id) {
        if (
          !id
            .replaceAll("\\", "/")
            .split("?")[0]
            .endsWith("/@novnc/novnc/core/rfb.js")
        )
          return;
        // iDRAC 7 stalls when TightPNG is advertised; keep every other encoding and decoder.
        const parts = code.split("encs.push(encodings.encodingTightPNG);");
        if (parts.length !== 2)
          throw new Error(
            "noVNC TightPNG patch no longer matches; requalify iDRAC compatibility.",
          );
        return { code: parts.join(""), map: null };
      },
    },
  ],
  optimizeDeps: { exclude: ["@novnc/novnc"] },
  server: {
    proxy:
      mode === "e2e"
        ? {}
        : { "/api": { target: "http://127.0.0.1:8080", ws: true } },
  },
}));
