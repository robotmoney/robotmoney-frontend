import { defineConfig } from "@playwright/test";

// See playwright-load-fail/playwright.config.ts's comment: a custom testMatch
// keeps this fixture spec from also matching bun's own default *.spec./*.test.
// discovery, which would otherwise double-collect it into the real per-PR
// `bun run test` and fail it under bun:test.
export default defineConfig({ testDir: ".", testMatch: "**/*.harness-fixture.ts" });
