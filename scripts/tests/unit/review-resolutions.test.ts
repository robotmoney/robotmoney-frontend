// The review resolution check scripts/checks/review-resolutions.ts (issue 1459)
// accepts a review whose every finding is fixed in the diff, filed as an
// existing issue or recorded on an issue comment, and refuses an open finding,
// a fixed path outside the diff and a filed cell without `#N`. git and gh are
// injected, so the test needs neither; the last case runs the script as a
// process on a malformed file, which exits before either is called.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkResolutions, parseResolution, resolutionCells, type Deps } from "../../checks/review-resolutions.ts";

const SCRIPT = join(import.meta.dir, "..", "..", "checks", "review-resolutions.ts");

const review = (...rows: string[]) =>
  [
    "# A review",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| bun test | open |",
    "",
    "| Id | Severity | Spec | Finding | Evidence | Resolution |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");

const FIXED = "| DOC-1 | medium | analytics-requirements 4.1 | a rule contradicts D74 | `docs/decisions.md` D74 | fixed: docs/technical/analytics-requirements.md |";
const FILED = "| DOC-2 | low | definitions | a term is undefined | `docs/definitions.md` | filed: #1234 |";
const RECORDED = "| DOC-3 | low | definitions | a term is stale | `docs/definitions.md` | recorded: issue 1459 comment |";

const deps = (changed: string[], issues: number[]): Deps & { asked: number[] } => {
  const asked: number[] = [];
  return {
    asked,
    changedFiles: () => changed,
    issueExists: (n) => {
      asked.push(n);
      return issues.includes(n);
    },
  };
};
const ok = deps(["docs/technical/analytics-requirements.md"], [1234]);

describe("review-resolutions", () => {
  test("only tables with both Id and Resolution columns are read", () => {
    expect(resolutionCells(review(FIXED, FILED))).toEqual([
      { id: "DOC-1", cell: "fixed: docs/technical/analytics-requirements.md" },
      { id: "DOC-2", cell: "filed: #1234" },
    ]);
  });

  test("the three resolution forms parse, and nothing else does", () => {
    expect(parseResolution("fixed: docs/a.md")).toEqual({ kind: "fixed", path: "docs/a.md" });
    expect(parseResolution("filed: #12")).toEqual({ kind: "filed", issue: 12 });
    expect(parseResolution("recorded: issue 1459 comment")).toEqual({ kind: "recorded", issue: 1459 });
    for (const bad of ["open", "", "fixed:", "filed: 12", "filed: #", "recorded: issue 1459", "recorded: #1459", "fixed docs/a.md"])
      expect(parseResolution(bad)).toBeNull();
  });

  test("a passing review table passes every mode", () => {
    const md = review(FIXED, FILED, RECORDED);
    expect(checkResolutions(md, "fixed", ok)).toEqual({ failures: [], checked: 1 });
    expect(checkResolutions(md, "filed", ok)).toEqual({ failures: [], checked: 1 });
    expect(checkResolutions(md, "both", ok)).toEqual({ failures: [], checked: 3 });
  });

  test("red control, --fixed: a fixed path outside the diff fails with its Id and cell", () => {
    const r = checkResolutions(review(FIXED), "fixed", deps(["docs/other.md"], []));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("DOC-1");
    expect(r.failures[0]).toContain("fixed: docs/technical/analytics-requirements.md");
  });

  test("red control, --filed: a filed cell with no #N is malformed", () => {
    const r = checkResolutions(review("| DOC-2 | low | d | f | e | filed: 1234 |"), "filed", ok);
    expect(r.failures).toEqual(['DOC-2: malformed resolution "filed: 1234"']);
  });

  test("--filed fails on an issue gh cannot read and asks once per distinct issue", () => {
    const d = deps([], []);
    const r = checkResolutions(review(FILED, FILED.replace("DOC-2", "DOC-4")), "filed", d);
    expect(r.failures).toHaveLength(2);
    expect(d.asked).toEqual([1234]);
  });

  test("an open or empty resolution fails in every mode, before git or gh is asked", () => {
    for (const mode of ["fixed", "filed", "both"] as const) {
      const d = deps([], []);
      const r = checkResolutions(review(FIXED, "| DOC-5 | low | d | f | e | open |", "| DOC-6 | low | d | f | e |  |"), mode, {
        ...d,
        changedFiles: () => {
          throw new Error("git asked");
        },
      });
      expect(r.failures).toEqual(['DOC-5: malformed resolution "open"', 'DOC-6: malformed resolution ""']);
      expect(d.asked).toEqual([]);
    }
  });

  test("a recorded cell is checked for its form only", () => {
    const d = deps([], []);
    expect(checkResolutions(review(RECORDED), "both", d)).toEqual({ failures: [], checked: 1 });
    expect(d.asked).toEqual([]);
  });

  test("the script exits 1 and names the Id on a malformed review", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-resolutions-"));
    try {
      const file = join(dir, "review.md");
      writeFileSync(file, review("| DOC-7 | low | d | f | e | open |"));
      const p = Bun.spawnSync(["bun", SCRIPT, file, "--filed"]);
      expect(p.exitCode).toBe(1);
      expect(p.stderr.toString()).toContain('DOC-7: malformed resolution "open"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
