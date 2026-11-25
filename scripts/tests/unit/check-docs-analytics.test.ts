// scripts/check-docs-analytics.sh guards three doc drifts (issue 1765, checks
// 8-10), and this file executes it against planted violations.
//
//   - docs/technical/analytics-requirements.md must not call the factor panel
//     display-only: PANEL_MEMBERSHIP.factor is "included" (D89).
//   - docs/architecture/task-queue-and-workers.md must not state a daily 22:30
//     regime timer: production runs `30 */3 * * *` (D87). The doc is read with
//     line wraps folded.
//   - every `*.ts` path named in the success table of
//     docs/technical/analyst-sdk-requirements.md section 8 must exist, resolved
//     by the section's path rule (csvb, backend, repo-root and SDK paths).
//
// Each red control copies the real docs and the real script into a throwaway
// git repository, plants one violation, and spawns bash. The throwaway tree
// also holds every file checks 1-7 read and an empty placeholder for every file
// section 8 names, so the unplanted tree passes, and a planted tree fails with
// the planted violation as its only finding. The script runs in repo-guards.yml
// (pinned by ci-workflows-structure.test.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SCRIPT = "scripts/check-docs-analytics.sh";
const ANALYTICS_REQ = "docs/technical/analytics-requirements.md";
const TASK_QUEUE = "docs/architecture/task-queue-and-workers.md";
const SDK_REQ = "docs/technical/analyst-sdk-requirements.md";

/** What checks 1-7 read: every docs/architecture/*.md, docs/decisions.md, .env.example, and the retired select.ts when it exists. */
function checks1to7Files(): string[] {
  const arch = readdirSync(join(REPO, "docs/architecture"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/architecture/${f}`);
  const optional = ["backend/src/analytics/access/select.ts"].filter((f) => existsSync(join(REPO, f)));
  return [...arch, "docs/decisions.md", ".env.example", ...optional];
}

/**
 * The files section 8 of the SDK requirements names, resolved by the path rule
 * at the top of the section: csvb `x` from packages/csvb/, backend `x` from
 * backend/, a path under scripts/, backend/, packages/, contract/ or frontend/
 * from the repo root, any other path from packages/analyst-sdk/. Only `*.ts`
 * paths count. Written apart from the script's awk, so a resolution bug in
 * either shows up as a red baseline.
 */
export function section8Paths(doc: string): string[] {
  const start = doc.search(/^## 8\./m);
  if (start < 0) return [];
  const rest = doc.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const out = new Set<string>();
  for (const row of section.split("\n").filter((l) => l.startsWith("|"))) {
    for (const m of row.matchAll(/(csvb |backend )?`([^`]+)`/g)) {
      const p = m[2]!;
      if (!/^[\w./-]+\.ts$/.test(p)) continue;
      const prefix = m[1]?.trim();
      if (prefix === "csvb") out.add(`packages/csvb/${p}`);
      else if (prefix === "backend") out.add(`backend/${p}`);
      else if (/^(scripts|backend|packages|contract|frontend)\//.test(p)) out.add(p);
      else out.add(`packages/analyst-sdk/${p}`);
    }
  }
  return [...out].sort();
}

type Result = { exitCode: number; stdout: string; stderr: string };

function check(root: string): Result {
  const proc = Bun.spawnSync(["bash", join(root, SCRIPT)], { cwd: root });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** The FAIL lines of a run, in order. */
const failLines = (r: Result): string[] => r.stderr.split("\n").filter((l) => l.startsWith("FAIL: "));

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway git repository with the real script, the real docs, the files checks 1-7 read and a placeholder per section 8 file. */
function fixtureRepo(plant: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-analytics-"));
  scratch.push(root);
  for (const rel of [SCRIPT, ANALYTICS_REQ, TASK_QUEUE, SDK_REQ, ...checks1to7Files()]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(root, rel));
  }
  for (const rel of section8Paths(readFileSync(join(REPO, SDK_REQ), "utf8"))) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "");
  }
  plant(root);
  for (const argv of [["git", "init", "-q"], ["git", "add", "-A"]]) {
    const proc = Bun.spawnSync(argv, { cwd: root });
    expect(proc.exitCode, `${argv.join(" ")}: ${proc.stderr.toString()}`).toBe(0);
  }
  return root;
}

function append(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  writeFileSync(path, readFileSync(path, "utf8") + text);
}

/** Adds rows to the top of the section 8 table, right under its header separator. */
function addSection8Rows(root: string, rows: string[]): void {
  const path = join(root, SDK_REQ);
  const doc = readFileSync(path, "utf8");
  const start = doc.search(/^## 8\./m);
  expect(start).toBeGreaterThan(-1);
  const sep = doc.indexOf("\n| --------- | ---- |\n", start);
  expect(sep).toBeGreaterThan(start);
  const at = sep + "\n| --------- | ---- |\n".length;
  writeFileSync(path, doc.slice(0, at) + rows.join("\n") + "\n" + doc.slice(at));
}

describe("check-docs-analytics.sh on the real tree", () => {
  test("exits 0", () => {
    const r = check(REPO);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("check-docs-analytics: OK");
    expect(r.exitCode).toBe(0);
  });

  test("section 8 names real files, and the resolution covers each path rule", () => {
    const paths = section8Paths(readFileSync(join(REPO, SDK_REQ), "utf8"));
    expect(paths.filter((p) => !existsSync(join(REPO, p)))).toEqual([]);
    // Each prefix the rule resolves is in use today, so the baseline exercises each.
    for (const root of ["packages/analyst-sdk/tests/", "packages/analyst-sdk/src/", "packages/csvb/tests/", "backend/tests/", "scripts/tests/unit/"]) {
      expect(paths.some((p) => p.startsWith(root)), root).toBe(true);
    }
    // The three files the table once named, which never existed, are gone.
    for (const gone of ["fill-parity.test.ts", "download-client.test.ts", "rerun-vintage.test.ts"]) {
      expect(readFileSync(join(REPO, SDK_REQ), "utf8")).not.toContain(gone);
    }
  });
});

describe("check-docs-analytics.sh in a throwaway repository", () => {
  test("baseline: the unplanted tree exits 0", () => {
    const r = check(fixtureRepo());
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("check-docs-analytics: OK");
    expect(r.exitCode).toBe(0);
  });

  test("a sentence calling the factor panel display-only fails, naming analytics-requirements.md", () => {
    const r = check(fixtureRepo((root) => append(root, ANALYTICS_REQ, "\nThe factor panel is display-only.\n")));
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toHaveLength(1);
    expect(failLines(r)[0]).toContain(ANALYTICS_REQ);
    expect(failLines(r)[0]).toContain("The factor panel is display-only");
  });

  test("the factor check is case-insensitive, reads across a line wrap, and reads a table cell as a sentence", () => {
    const wrapped = check(fixtureRepo((root) => append(root, ANALYTICS_REQ, "\nThe Factor panel\nis Display-Only in production.\n")));
    expect(wrapped.exitCode).not.toBe(0);
    expect(failLines(wrapped)).toHaveLength(1);
    const cell = check(fixtureRepo((root) => append(root, ANALYTICS_REQ, "\n| Registry | factor (8), display only |\n")));
    expect(cell.exitCode).not.toBe(0);
    expect(failLines(cell)).toHaveLength(1);
  });

  test("display-only in a sentence that does not name the factor panel passes", () => {
    const r = check(fixtureRepo((root) => append(root, ANALYTICS_REQ, "\nForward statistics are display-only. The factor panel is in the composite.\n")));
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("a regime timer stated as daily at 22:30, split over a line wrap, fails", () => {
    const r = check(fixtureRepo((root) => append(root, TASK_QUEUE, "\nThe producer runs regime daily at\n22:30 UTC.\n")));
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toHaveLength(1);
    expect(failLines(r)[0]).toContain(TASK_QUEUE);
    expect(failLines(r)[0]).toContain("regime daily at 22:30");
  });

  test("the old bold form of the daily timer fails too", () => {
    const r = check(fixtureRepo((root) => append(root, TASK_QUEUE, "\n`regime` daily at **22:30 UTC** (after US market close).\n")));
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toHaveLength(1);
    expect(failLines(r)[0]).toContain(TASK_QUEUE);
  });

  test("a section 8 row naming a csvb test that does not exist fails, naming exactly that file", () => {
    const r = check(fixtureRepo((root) => addSection8Rows(root, ["| A planted criterion. | csvb `tests/no-such.test.ts` |"])));
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toHaveLength(1);
    expect(failLines(r)[0]).toContain(SDK_REQ);
    expect(failLines(r)[0]).toContain("packages/csvb/tests/no-such.test.ts");
  });

  test("each path rule resolves a missing file to its own root, and a non-.ts cell is skipped", () => {
    const r = check(
      fixtureRepo((root) =>
        addSection8Rows(root, [
          "| Planted SDK test. | `tests/no-such-sdk.test.ts` |",
          "| Planted SDK source. | `src/no-such.ts` |",
          "| Planted repo-root test. | `scripts/tests/unit/no-such.test.ts` |",
          "| Planted backend test. | backend `tests/no-such.test.ts` |",
          "| Planted fixture, not a .ts file. | `tests/fixtures/no-such.json`, the package `no-such` script |",
        ]),
      ),
    );
    expect(r.exitCode).not.toBe(0);
    const named = failLines(r).map((l) => /\(([^()]+)\)\.$/.exec(l)?.[1]);
    expect(named.sort()).toEqual(
      ["backend/tests/no-such.test.ts", "packages/analyst-sdk/src/no-such.ts", "packages/analyst-sdk/tests/no-such-sdk.test.ts", "scripts/tests/unit/no-such.test.ts"].sort(),
    );
  });

  test("a section 8 that names no .ts file fails rather than checking nothing", () => {
    const r = check(
      fixtureRepo((root) => {
        const path = join(root, SDK_REQ);
        writeFileSync(path, readFileSync(path, "utf8").replace(/^## 8\. /m, "## 8 "));
      }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toHaveLength(1);
    expect(failLines(r)[0]).toContain("names no .ts test file");
  });

  test("a missing guarded doc fails", () => {
    const r = check(fixtureRepo((root) => rmSync(join(root, ANALYTICS_REQ))));
    expect(r.exitCode).not.toBe(0);
    expect(failLines(r)).toEqual([`FAIL: ${ANALYTICS_REQ} missing`]);
  });
});
