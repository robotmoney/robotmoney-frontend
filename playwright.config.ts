import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BACKEND_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  testDir: "./frontend/test/browser",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
});
