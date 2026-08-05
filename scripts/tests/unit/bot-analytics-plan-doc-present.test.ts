// Discoverability guard for the Analytics Surface phase's canonical spec
// (issue #448). docs/bot-analytics-ui-port-plan.md and its two companion
// inventories existed ONLY on the unmerged branch
// docs/session-7bc86c64-analysis-and-plans, cited by ~20 merged issues
// (#379-#402 and siblings) that every dev worker had to `git show` off a
// stray branch to read. This test pins the fix: the three files are readable
// directly on main, and a canonical doc (architecture.md or decisions.md)
// links to the plan so a reviewer on main can discover it exists at all.
//
// Runs in the required unit.yml job via `bun run test:unit`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const PLAN_DOC = "docs/bot-analytics-ui-port-plan.md";
const COMPANION_DOCS = [
  "docs/bot-analytics-ui-port/inventory-original.md",
  "docs/bot-analytics-ui-port/inventory-current.md",
] as const;

describe("bot-analytics UI port plan doc is present and discoverable on main", () => {
  test(`${PLAN_DOC} exists and is non-empty`, () => {
    expect(read(PLAN_DOC).length).toBeGreaterThan(0);
  });

  for (const rel of COMPANION_DOCS) {
    test(`${rel} exists and is non-empty`, () => {
      expect(read(rel).length).toBeGreaterThan(0);
    });
  }

  test("architecture.md or decisions.md references the merged doc's filename", () => {
    const architecture = read("docs/architecture.md");
    const decisions = read("docs/decisions.md");
    const referenced =
      architecture.includes("bot-analytics-ui-port-plan.md") ||
      decisions.includes("bot-analytics-ui-port-plan.md");
    expect(referenced).toBe(true);
  });
});
