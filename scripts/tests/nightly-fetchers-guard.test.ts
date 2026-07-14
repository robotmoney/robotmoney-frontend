// Execution-evidence guard for the nightly live-fetchers workflow (review
// finding 017; test-coverage policy invariant 2: exit 0 must never mean
// "0 tests ran"). The enforcement itself lives in TEST CODE: each live suite
// throws at module load when EXPECT_LIVE=1 but its RUN_LIVE_FETCHERS gate
// resolves off, so a gate-name drift between the workflow and the test files
// fails the nightly loudly instead of turning every live test into a silent
// all-skips green. This file is the CI-executed CONFIG check for that pairing:
// it parses .github/workflows/nightly-fetchers.yml and asserts every live-suite
// step sets BOTH the gate (RUN_LIVE_FETCHERS=1) and the guard (EXPECT_LIVE=1),
// and that each live test file still carries the module-load guard — so
// neither half of the handshake can be dropped unnoticed.
//
// Runs in the required integration.yml root job via `bun test scripts/tests`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const workflow = readFileSync(
  join(repoRoot, ".github/workflows/nightly-fetchers.yml"),
  "utf8",
);

// The four live suites the nightly sweeps (backend/tests/<suite>.test.ts).
const LIVE_SUITES = [
  "fetchers-live",
  "projects-fetchers-live",
  "vault-rpc-live",
  "token-price-live",
] as const;

// Split the workflow into per-step blocks (each starts at "- name:"), so the
// env assertions are scoped to the step that runs the suite — a stray
// EXPECT_LIVE elsewhere in the file can't satisfy the check.
const stepBlocks = workflow.split(/\n\s*- name:/).slice(1);
function stepFor(suite: string): string {
  const block = stepBlocks.find((b) => b.includes(`bun test tests/${suite}.test.ts`));
  if (!block) throw new Error(`nightly-fetchers.yml has no step running tests/${suite}.test.ts`);
  return block;
}

describe("nightly-fetchers.yml pairs the live gate with the execution-evidence guard", () => {
  for (const suite of LIVE_SUITES) {
    test(`the ${suite} step sets RUN_LIVE_FETCHERS=1 AND EXPECT_LIVE=1`, () => {
      const step = stepFor(suite);
      expect(step).toContain('RUN_LIVE_FETCHERS: "1"');
      expect(step).toContain('EXPECT_LIVE: "1"');
    });
  }
});

describe("each live suite carries the module-load EXPECT_LIVE guard", () => {
  for (const suite of LIVE_SUITES) {
    test(`backend/tests/${suite}.test.ts throws when EXPECT_LIVE=1 but the gate is off`, () => {
      const src = readFileSync(join(repoRoot, `backend/tests/${suite}.test.ts`), "utf8");
      // The guard condition + the loud refusal message (the throw is what makes
      // `bun test` exit non-zero on an all-skip run).
      expect(src).toContain('process.env.EXPECT_LIVE === "1" && !LIVE');
      expect(src).toContain("refusing an all-skip false-green run");
    });
  }
});
