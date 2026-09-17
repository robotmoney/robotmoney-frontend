import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  testDir: "./frontend/test/browser",
  fullyParallel: false,
  // The default (unset) halves the CI runner's own core count, so a 4-CPU
  // runner (ubuntu-latest) only ever schedules 2 workers while 2 cores sit
  // idle for the whole browser-checks phase. fullyParallel stays false
  // (files, not individual tests, are the parallel unit) so this does not
  // change per-file scheduling or risk splitting a file's beforeAll across
  // workers (see admin-live.spec.ts's one-time admin claim); it only lets
  // more of the 42 spec files run concurrently.
  workers: process.env.CI ? 4 : undefined,
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
