// The 2026-10-09 rule "production data changes only through a migration" is a
// recorded decision, and the scheduler docs agree with it — issue 1312, D66.
//
// Before this test the rule lived only in the v0.6.0 post-mortem (decision 2)
// while system-scheduler-spec.md §2.3 and investment-swarm.md still said a
// subject's scheduling columns change "only through the admin API". Migrations
// 0117 and 0121 changed those columns on production, so the text was wrong.
//
// Two assertions, each mirrored by scripts/lint-docs.sh check 7 (the docs-lint
// workflow is the only CI job a docs-only PR triggers):
//
//   - docs/decisions.md has the D66 heading, with its date.
//   - no current doc under docs/ says the columns change "only through the
//     admin API". docs/archive/ and docs/post-mortems/ are history.
//
// The red controls plant a missing entry and a stale sentence in a throwaway
// git repository and require BOTH this file's checks and lint-docs.sh to
// refuse them.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const DECISIONS = "docs/decisions.md";
const SCHEDULER_SPEC = "docs/technical/system-scheduler-spec.md";
const SWARM_DOC = "docs/architecture/investment-swarm.md";
const LINT_DOCS = "scripts/lint-docs.sh";

/** The heading check 7 of lint-docs.sh greps for, verbatim. */
const D66_HEADING = /^## D66 — Production data changes only through a migration \(owner, 2026-10-09\)$/m;

/** The stale phrasing, as check 7 greps for it. */
const STALE = /only (through|via|by) the \*{0,2}admin API/i;

function hasDecision(root: string): boolean {
  return D66_HEADING.test(readFileSync(join(root, DECISIONS), "utf8"));
}

/** `file:line` of every current doc line with the stale phrasing. */
function staleHits(root: string): string[] {
  const proc = Bun.spawnSync(
    ["git", "grep", "-n", "-i", "-E", STALE.source, "--", "docs", ":!docs/archive", ":!docs/post-mortems"],
    { cwd: root },
  );
  const out = proc.stdout.toString().trim();
  if (out === "" && proc.exitCode === 1) return [];
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  return out.split("\n").map((row) => row.replace(/^([^:]+:\d+):.*$/, "$1"));
}

function lintDocs(root: string): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", join(root, LINT_DOCS)], { cwd: root });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repository holding the real docs this rule reads and the real lint-docs.sh. */
function fixtureRepo(plant: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "docs-migration-rule-"));
  scratch.push(root);
  for (const rel of [DECISIONS, SCHEDULER_SPEC, SWARM_DOC, "docs/technical/smoke-production-spec.md", LINT_DOCS]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(root, rel));
  }
  plant(root);
  for (const argv of [["git", "init", "-q"], ["git", "add", "-A"]]) {
    const proc = Bun.spawnSync(argv, { cwd: root });
    expect(proc.exitCode, `${argv.join(" ")}: ${proc.stderr.toString()}`).toBe(0);
  }
  return root;
}

describe("D66 records the 2026-10-09 migration rule and the scheduler docs agree with it", () => {
  test("docs/decisions.md has the dated D66 entry with its anchor", () => {
    expect(hasDecision(REPO)).toBe(true);
    expect(readFileSync(join(REPO, DECISIONS), "utf8")).toContain('<a id="d66"></a>');
  });

  test("no current doc says the scheduling columns change only through the admin API", () => {
    expect(staleHits(REPO)).toEqual([]);
  });

  test("the scheduler spec and the swarm doc say a deployed stack changes the columns by migration", () => {
    const spec = readFileSync(join(REPO, SCHEDULER_SPEC), "utf8");
    expect(spec).toMatch(/changed afterwards only by a \*\*migration\*\*/);
    expect(spec).toContain("[D66](../decisions.md#d66)");
    const swarm = readFileSync(join(REPO, SWARM_DOC), "utf8");
    expect(swarm).toMatch(/changed afterwards by migration on a deployed stack/);
    expect(swarm).toContain("[D66](../decisions.md#d66)");
  });

  test("scripts/lint-docs.sh exits 0 on the real repository", () => {
    const { exitCode, stderr } = lintDocs(REPO);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("green control: an unplanted copy passes both checks", () => {
    const root = fixtureRepo(() => {});
    expect(hasDecision(root)).toBe(true);
    expect(staleHits(root)).toEqual([]);
    expect(lintDocs(root).exitCode).toBe(0);
  });

  test("red control: a decisions log without D66 is refused by both checks", () => {
    const root = fixtureRepo((r) => {
      const path = join(r, DECISIONS);
      const before = readFileSync(path, "utf8");
      const text = before.replace(D66_HEADING, "## D66 — Something else (owner, 2026-10-09)");
      expect(text).not.toBe(before);
      writeFileSync(path, text);
    });
    expect(hasDecision(root)).toBe(false);
    const { exitCode, stderr } = lintDocs(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL: docs/decisions.md lacks the D66 entry");
  });

  test("red control: a current doc with the stale sentence is refused by both checks", () => {
    const root = fixtureRepo((r) => {
      mkdirSync(join(r, "docs", "runbooks"), { recursive: true });
      writeFileSync(
        join(r, "docs", "runbooks", "planted.md"),
        "# Planted\n\nThe scheduling columns are changed only through the admin API.\n",
      );
    });
    expect(staleHits(root)).toEqual(["docs/runbooks/planted.md:3"]);
    const { exitCode, stderr } = lintDocs(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL: docs/runbooks/planted.md:3 says scheduling columns change only through the admin API");
  });

  test("a hit under docs/post-mortems or docs/archive is history and is not scanned", () => {
    const root = fixtureRepo((r) => {
      for (const dir of ["post-mortems", "archive"]) {
        mkdirSync(join(r, "docs", dir), { recursive: true });
        writeFileSync(join(r, "docs", dir, "old.md"), "# Old\n\nChanged only through the admin API.\n");
      }
    });
    expect(staleHits(root)).toEqual([]);
    expect(lintDocs(root).exitCode).toBe(0);
  });
});
