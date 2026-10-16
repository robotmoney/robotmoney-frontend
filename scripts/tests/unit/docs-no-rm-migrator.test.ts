// No current doc names the retired `rm_migrator` role — issue #1026 criterion 3,
// decision D47 (smoke-production-spec §3: "There is no rm_migrator").
//
// The criterion names one command:
//
//   git grep -n rm_migrator -- docs ':!docs/archive'
//
// This file runs exactly that against the real repository. A hit is allowed in
// only two places:
//
//   - docs/decisions.md between the <a id="d46"> and <a id="d48"> anchors. D46
//     proposed the role and D47 retired it; a decision log that no longer names
//     what it reversed stops being a record.
//   - the single §3 line of docs/technical/smoke-production-spec.md that says
//     the role does not exist ("There is no rm_migrator"). One line, not the
//     whole section: a second mention in §3 is a restatement, and restatements
//     are how the old design crept back into backend.md and two runbooks. The
//     line must also still SAY the role is gone: a §3 line rewritten to use the
//     role would otherwise inherit the exemption.
//
// The ranges are found by anchor and heading, never by line number, so an edit
// above them does not silently move what is allowed.
//
// scripts/lint-docs.sh carries the same rule as its check 5, because the
// docs-lint workflow is the only CI job a docs-only PR triggers. The red
// controls below plant disallowed hits in a throwaway git repository and
// require BOTH this file's classifier and lint-docs.sh to refuse them. A guard
// that has only ever run on a clean tree cannot be told apart from one that
// matches nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const DECISIONS = "docs/decisions.md";
const SMOKE_SPEC = "docs/technical/smoke-production-spec.md";
const LINT_DOCS = "scripts/lint-docs.sh";

type Hit = { file: string; line: number; text: string };

/** What the one allowed §3 line has to say. Shared with lint-docs.sh's check 5. */
const SPEC_DENIAL = /There is no `?rm_migrator`?/;

/** The criterion's grep, verbatim, run in `root`. */
function grepHits(root: string): Hit[] {
  const proc = Bun.spawnSync(["git", "grep", "-n", "rm_migrator", "--", "docs", ":!docs/archive"], { cwd: root });
  // git grep exits 1 with no output when nothing matched.
  const out = proc.stdout.toString().trim();
  if (out === "" && proc.exitCode === 1) return [];
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  return out.split("\n").map((row) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(row);
    if (!m) throw new Error(`unparseable git grep row: ${row}`);
    return { file: m[1], line: Number(m[2]), text: m[3] };
  });
}

/** 1-based line number of the first line matching `re`, or undefined. */
function lineOf(root: string, file: string, re: RegExp): number | undefined {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? undefined : i + 1;
}

/** The hits the rule refuses. A missing anchor or heading allows nothing. */
function disallowed(root: string): Hit[] {
  const d46 = lineOf(root, DECISIONS, /<a id="d46"><\/a>/);
  const d48 = lineOf(root, DECISIONS, /<a id="d48"><\/a>/);
  const s3 = lineOf(root, SMOKE_SPEC, /^## 3\. /);
  const s4 = lineOf(root, SMOKE_SPEC, /^## 4\. /);
  let specHitUsed = false;
  return grepHits(root).filter((h) => {
    if (h.file === DECISIONS && d46 !== undefined && d48 !== undefined && h.line > d46 && h.line < d48) {
      return false;
    }
    if (h.file === SMOKE_SPEC && s3 !== undefined && s4 !== undefined && h.line > s3 && h.line < s4 && !specHitUsed &&
      SPEC_DENIAL.test(h.text)) {
      specHitUsed = true;
      return false;
    }
    return true;
  });
}

function lintDocs(root: string): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", join(root, LINT_DOCS)], { cwd: root });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway git repository holding the real decisions log, the real smoke
 * spec and the real lint-docs.sh. git grep only searches tracked files, so every
 * file is `git add`ed; no commit is needed.
 */
function fixtureRepo(plant: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "docs-no-rm-migrator-"));
  scratch.push(root);
  for (const rel of [DECISIONS, SMOKE_SPEC, LINT_DOCS]) {
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

describe("docs name rm_migrator only in D46/D47 history and smoke-production-spec §3", () => {
  test("the real repository has no disallowed hit", () => {
    expect(disallowed(REPO)).toEqual([]);
  });

  test("the grep is live: it still finds the allowed history and the §3 line", () => {
    // If the pattern, pathspec or cwd broke, the check above would pass on an
    // empty scan. The allowed hits are what prove the scan still sees files.
    const files = grepHits(REPO).map((h) => h.file);
    expect(files).toContain(DECISIONS);
    const spec = grepHits(REPO).filter((h) => h.file === SMOKE_SPEC);
    expect(spec).toHaveLength(1);
    expect(spec[0].text).toMatch(SPEC_DENIAL);
  });

  test("scripts/lint-docs.sh exits 0 on the real repository", () => {
    const { exitCode, stderr } = lintDocs(REPO);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("green control: an unplanted copy passes both checks", () => {
    const root = fixtureRepo(() => {});
    expect(disallowed(root)).toEqual([]);
    expect(lintDocs(root).exitCode).toBe(0);
  });

  const plants: Array<[string, (root: string) => void, string]> = [
    [
      "a hit in another current doc",
      (root) => {
        mkdirSync(join(root, "docs", "runbooks"), { recursive: true });
        writeFileSync(join(root, "docs", "runbooks", "planted.md"), "# Planted\n\nLog in as `rm_migrator` first.\n");
      },
      "docs/runbooks/planted.md",
    ],
    [
      "a hit in decisions.md after the D48 anchor",
      (root) => appendFileSync(join(root, DECISIONS), "\nA later decision reintroduces `rm_migrator`.\n"),
      DECISIONS,
    ],
    [
      "a second hit inside smoke-production-spec §3",
      (root) => {
        const path = join(root, SMOKE_SPEC);
        const text = readFileSync(path, "utf8").replace(
          /^## 3\. .*$/m,
          (heading) => `${heading}\n\nMigrations run as \`rm_migrator\`.`,
        );
        writeFileSync(path, text);
      },
      SMOKE_SPEC,
    ],
    [
      "the one §3 line rewritten to use the role",
      (root) => {
        const path = join(root, SMOKE_SPEC);
        const before = readFileSync(path, "utf8");
        const text = before.replace(/There is no `rm_migrator`\./, "Migrations run as `rm_migrator`.");
        // The plant must have changed something, or this control proves nothing.
        expect(text).not.toBe(before);
        writeFileSync(path, text);
      },
      SMOKE_SPEC,
    ],
  ];

  for (const [name, plant, file] of plants) {
    test(`red control: ${name} is refused by both checks`, () => {
      const root = fixtureRepo(plant);
      expect(disallowed(root).map((h) => h.file)).toContain(file);
      const { exitCode, stderr } = lintDocs(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`FAIL: ${file}:`);
      expect(stderr).toContain("rm_migrator");
    });
  }

  test("a hit under docs/archive is history and is not scanned", () => {
    const root = fixtureRepo((r) => {
      mkdirSync(join(r, "docs", "archive"), { recursive: true });
      writeFileSync(join(r, "docs", "archive", "old-plan.md"), "# Old plan\n\nCreate `rm_migrator`.\n");
    });
    expect(disallowed(root)).toEqual([]);
    expect(lintDocs(root).exitCode).toBe(0);
  });
});
