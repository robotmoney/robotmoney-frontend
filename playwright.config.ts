import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  testDir: "./frontend/test/browser",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  // Visual-parity snapshots (regime-visual.spec.ts): small tolerance for
  // cross-run AA jitter; the animated hero is masked in the spec.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" },
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
});
