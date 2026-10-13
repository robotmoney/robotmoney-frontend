// scripts/tests/unit/release-delta-runbooks.test.ts — the runbook split (issue 1261):
// docs/runbooks/release-standing-runbook.md holds what every release repeats and
// names no 0.5.x fact; a delta runbook (v0-6-1-rollout.md as the frozen record,
// v0-6-2-rollout.md as the live one) holds only its release's delta, 100 to 150
// lines, with no one-time v0.6.0 step; both state the owner's rule that every
// production data change ships as a migration; and no runbook row names a step
// the list lacks (scripts/release/steps-table.ts, the hash check's id half).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unknownStepIds } from "../../release/steps-table.ts";

const runbooks = join(import.meta.dir, "..", "..", "..", "docs", "runbooks");
const read = (f: string) => readFileSync(join(runbooks, f), "utf8");
const lines = (s: string) => s.replace(/\n$/, "").split("\n").length;

const STANDING = "release-standing-runbook.md";
const DELTAS = ["v0-6-1-rollout.md", "v0-6-2-rollout.md"];
const MIGRATION_RULE = /every production data change ships as a migration/i;
const ONE_TIME = /rebind|first[ -]boot|credential[ -]migration/i;
const STANDING_IDS = ["SP.1", "SP.2", "SP.3", "SP.4", "SP.5", "SP.6", "SP.7", "SP.8", "SR.0", "SR.1", "SR.2", "SR.3", "SR.4", "SR.5", "SR.6", "SR.7", "SR.8", "SR.9", "SR.10", "SC.1", "SC.2", "SC.3", "SV.1", "SV.2", "SV.3", "SV.4", "SV.5", "SV.6", "SW.1", "SW.2", "SW.3"];

const assertDelta = (doc: string) => {
  expect(lines(doc)).toBeGreaterThanOrEqual(100);
  expect(lines(doc)).toBeLessThanOrEqual(150);
  expect(doc).not.toMatch(ONE_TIME);
  expect(doc).toMatch(MIGRATION_RULE);
  expect(doc).toContain("## Inherits the standing runbook");
  expect(unknownStepIds(doc)).toEqual([]);
};

describe("the standing runbook", () => {
  const doc = read(STANDING);
  test("names no 0.5.x fact", () => {
    expect(doc).not.toMatch(/0\.5\.x/);
  });
  test("still defines every SP, SR, SC, SV and SW check id as a table row", () => {
    for (const id of STANDING_IDS) expect(doc.split("\n").filter((l) => l.startsWith(`| ${id} |`))).toHaveLength(1);
    for (const prefix of ["SP", "SR", "SC", "SV", "SW"]) {
      const rows = [...doc.matchAll(/^\| (S[PRCVW]\.\d+) \|/gm)].map((m) => m[1]!).filter((id) => id.startsWith(prefix));
      expect(rows.sort()).toEqual(STANDING_IDS.filter((id) => id.startsWith(prefix)).sort());
    }
  });
  test("states that every production data change ships as a migration", () => {
    expect(doc).toMatch(MIGRATION_RULE);
  });
});

describe("the delta runbooks", () => {
  for (const f of DELTAS) {
    test(`${f}: 100 to 150 lines, no one-time step, the migration rule, known step ids`, () => assertDelta(read(f)));
  }
  test("the v0.6.0 record is short history and names the full revision", () => {
    const doc = read("v0-6-0-rollout.md");
    expect(lines(doc)).toBeLessThan(100);
    expect(doc).toContain("git show v0.6.0:docs/runbooks/v0-6-0-rollout.md");
    expect(doc).toMatch(/^> \*\*History/m);
  });
});

describe("red controls", () => {
  const good = read("v0-6-2-rollout.md");
  test("a one-time step, a missing rule, a stale step id or a wrong length fails", () => {
    expect(() => assertDelta(`${good}\nR6.7c: rebind the members\n`)).toThrow();
    expect(() => assertDelta(good.replace(MIGRATION_RULE, "data changes by hand"))).toThrow();
    expect(() => assertDelta(`${good}| R6.7c | gone |\n`)).toThrow();
    expect(() => assertDelta(good.split("\n").slice(0, 60).join("\n"))).toThrow();
    expect(() => assertDelta(`${good}${"\n".repeat(60)}`)).toThrow();
  });
  test("a 0.5.x fact in the standing runbook fails", () => {
    expect(`${read(STANDING)}\nported from 0.5.x\n`).toMatch(/0\.5\.x/);
  });
});
