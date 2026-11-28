// The deposit fork spec's own config (issue 1778): `bun run test:deposit-fork`.
// It starts anvil and needs foundry, so it lives outside the default config's
// testDir (frontend/test/browser) and only web-client.yml's deposit-fork job,
// which installs foundry, runs it. One worker: both tests share one fork.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./frontend/test/deposit-fork",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The JSON report is what the CI job reads to assert 2 run and 0 skipped.
  reporter: [["list"], ["json", { outputFile: "playwright-report/deposit-fork.json" }]],
  timeout: 180_000,
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
