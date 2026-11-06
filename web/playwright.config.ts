import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    viewport: { width: 1440, height: 1050 },
  },
  webServer: {
    command: "npm run dev -- --mode e2e --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
  reporter: "list",
});
