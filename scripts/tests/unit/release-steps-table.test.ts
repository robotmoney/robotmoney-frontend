// scripts/tests/unit/release-steps-table.test.ts — the runbook's step table is
// generated from scripts/release/steps.ts, and no runbook row names a step the
// list lacks (scripts/release/steps-table.ts). scripts/lint-docs.sh holds the
// same rule for docs-only PRs; this suite holds it for code PRs that change
// the step list.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BEGIN, END, replaceRegion, stepsTable, unknownStepIds } from "../../release/steps-table.ts";
import { RELEASE_STEPS } from "../../release/steps.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const runbooks = join(repoRoot, "docs", "runbooks");

describe("the step table", () => {
  test("docs/runbooks/release-run.md carries the generated table, current", () => {
    const doc = readFileSync(join(runbooks, "release-run.md"), "utf8");
    expect(doc).toContain(BEGIN);
    expect(replaceRegion(doc, stepsTable())).toBe(doc);
  });

  test("red: a stale region differs; missing markers are refused", () => {
    const doc = `x\n${BEGIN}\nold\n${END}\ny\n`;
    expect(replaceRegion(doc, stepsTable())).not.toBe(doc);
    expect(replaceRegion(doc, stepsTable())).toContain("| R1.1 |");
    expect(replaceRegion("no markers", stepsTable())).toBeUndefined();
  });

  test("every runbook step row names a step of the list", () => {
    for (const f of ["release-run.md"]) {
      expect(unknownStepIds(readFileSync(join(runbooks, f), "utf8"))).toEqual([]);
    }
    expect(unknownStepIds("| R7.2 | gone |\n| R1.1 | here |\n")).toEqual(["R7.2"]);
  });

  test("the table names every step once, with its bound and irreversibility", () => {
    const table = stepsTable();
    for (const s of RELEASE_STEPS) expect(table.split("\n").filter((l) => l.startsWith(`| ${s.id} |`))).toHaveLength(1);
    expect(table).toContain("| R6.3 | target | The first migrate");
    expect(table).toMatch(/\| R6\.3 \|.*\| \*\*yes\*\* \| 10 min \|/);
    expect(table).toMatch(/\| R2\.1 \|.*\| 30 min \|/);
    expect(table).not.toContain("| R7.2 |");
  });
});
