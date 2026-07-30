import { defineConfig } from "@playwright/test";

// testMatch is a custom, NON-".spec."/".test." pattern deliberately: the
// default Playwright discovery pattern (`**/*.@(spec|test).*`) is ALSO bun's
// own default test-file naming convention, so a fixture spec named
// `*.spec.ts` here would get double-collected by the real per-PR
// `bun run test` (`bun test scripts/tests`, which recurses into
// scripts/tests/fixtures/) and executed under bun:test — where Playwright's
// test() throws ("did not expect test() to be called here"), turning this
// fixture into a real CI failure instead of staying an isolated fixture only
// ever invoked explicitly via `playwright test --list --config=...` from
// scripts/tests/unit/harness-selftest.test.ts.
export default defineConfig({ testDir: ".", testMatch: "**/*.harness-fixture.ts" });
