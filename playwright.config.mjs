import { defineConfig, devices } from "@playwright/test";

const PORT = 5599;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/static-server.mjs",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
