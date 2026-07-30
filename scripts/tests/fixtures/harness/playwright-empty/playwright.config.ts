import { defineConfig } from "@playwright/test";

// No spec files live in this directory at all — the empty-selection fixture.
// Kept on the same custom testMatch as its siblings (playwright-load-fail/,
// playwright-pass/) purely for consistency; it has no effect here since there
// is nothing to match either way.
export default defineConfig({ testDir: ".", testMatch: "**/*.harness-fixture.ts" });
