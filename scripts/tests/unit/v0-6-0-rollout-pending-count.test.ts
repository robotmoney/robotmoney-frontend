// scripts/tests/unit/v0-6-0-rollout-pending-count.test.ts — issue 1252.
//
// docs/runbooks/v0-6-0-rollout.md states how many migrations the first
// production migrate (R6.3) applies, how they split by `compat:` header, and how
// many rows the ledger holds after it. Those numbers drifted once already: PR
// 1247 added 0115_token_market_samples.sql and the runbook kept saying 39 files
// (a 115-row ledger). This test recomputes the numbers from the repository and
// fails when the runbook disagrees, so the next migration fails CI until the
// runbook is updated with it.
//
//   pending  = .sql files in backend/migrations minus SUPPORTED_RELEASES[0].migrations
//   compat   = each pending file's own header, read by the runner's parser
//              (parsePendingHeader: null = no header, else additive | breaking)
//   ledger   = baseline length + pending count
//
// Nothing is hard-coded: the baseline comes from backend/src/db/supported-releases.ts.
// Red control: the runbook text as it stood before the fix (39 files, 25
// additive, no 0115, no ledger total) fails the same assertion function.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_RELEASES } from "../../../backend/src/db/supported-releases.ts";
import { parsePendingHeader } from "../../../backend/src/db/schema-compat.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MIGRATIONS_DIR = join(ROOT, "backend", "migrations");
const RUNBOOK_PATH = join(ROOT, "docs", "runbooks", "v0-6-0-rollout.md");

type Category = "none" | "breaking" | "additive";

interface Expected {
  readonly baseline: number;
  readonly pending: readonly string[];
  readonly byCategory: Readonly<Record<Category, readonly string[]>>;
}

/** The pending set and its classification, derived from the repository. */
function derivePending(): Expected {
  const baseline = SUPPORTED_RELEASES[0]!.migrations;
  const recorded = new Set(baseline);
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => !recorded.has(file))
    .sort();
  const byCategory: Record<Category, string[]> = { none: [], breaking: [], additive: [] };
  for (const file of pending) {
    const header = parsePendingHeader(file, readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    byCategory[header === null ? "none" : header.compat].push(file);
  }
  return { baseline: baseline.length, pending, byCategory };
}

/** Section 1.1: from its heading to the next heading of level 2 or 3. */
function section11(text: string): string | null {
  const start = text.search(/^### 1\.1 /m);
  if (start < 0) return null;
  const bodyStart = text.indexOf("\n", start) + 1;
  const end = text.slice(bodyStart).search(/^#{2,3} /m);
  return end < 0 ? text.slice(start) : text.slice(start, bodyStart + end);
}

const BULLETS: ReadonlyArray<{ category: Category; pattern: RegExp }> = [
  { category: "none", pattern: /^- \*\*No `compat:` header \((\d+)[^)]*\):\*\*(.*)$/m },
  { category: "breaking", pattern: /^- \*\*Breaking \((\d+)\):\*\*(.*)$/m },
  { category: "additive", pattern: /^- \*\*Additive \((\d+)\):\*\*(.*)$/m },
];

/** Every migration number a bullet names: `0084`, `0111_name`, or a range `0085`–`0088`. */
function namedNumbers(bullet: string): { numbers: Set<number>; names: string[] } {
  const numbers = new Set<number>();
  const names: string[] = [];
  const item = /`(\d{4})(_[a-z0-9_]+)?`(?:–`(\d{4})`)?/g;
  for (const match of bullet.matchAll(item)) {
    const from = Number(match[1]);
    const to = match[3] === undefined ? from : Number(match[3]);
    for (let n = from; n <= to; n++) numbers.add(n);
    if (match[2] !== undefined) names.push(`${match[1]}${match[2]}.sql`);
  }
  return { numbers, names };
}

const numberOf = (file: string): number => Number(file.slice(0, 4));

/** Every way the runbook text disagrees with the derived numbers. Empty means it agrees. */
function runbookProblems(text: string, expected: Expected): string[] {
  const problems: string[] = [];
  const pending = expected.pending.length;
  const ledger = expected.baseline + pending;

  const section = section11(text);
  if (section === null) return ["section 1.1 is missing"];

  const heading = /^### 1\.1 Pending migrations \((\d+) files, from the (\d+)-name ledger\)/m.exec(section);
  if (heading === null) {
    problems.push("section 1.1 heading does not read '(<n> files, from the <m>-name ledger)'");
  } else {
    if (Number(heading[1]) !== pending) problems.push(`heading says ${heading[1]} files, repo has ${pending} pending`);
    if (Number(heading[2]) !== expected.baseline) {
      problems.push(`heading says a ${heading[2]}-name ledger, baseline has ${expected.baseline}`);
    }
  }

  let sum = 0;
  for (const { category, pattern } of BULLETS) {
    const files = expected.byCategory[category];
    const match = pattern.exec(section);
    if (match === null) {
      problems.push(`section 1.1 has no ${category} bullet`);
      continue;
    }
    const stated = Number(match[1]);
    sum += stated;
    if (stated !== files.length) problems.push(`${category} bullet says ${stated}, repo has ${files.length}`);
    const { numbers, names } = namedNumbers(match[2]!);
    const want = new Set(files.map(numberOf));
    for (const file of files) {
      if (!numbers.has(numberOf(file))) problems.push(`${category} bullet does not name ${file}`);
    }
    for (const n of numbers) {
      if (!want.has(n)) problems.push(`${category} bullet names ${String(n).padStart(4, "0")}, not a pending ${category} file`);
    }
    for (const name of names) {
      if (!files.includes(name)) problems.push(`${category} bullet names ${name}, not a pending ${category} file`);
    }
  }
  if (sum !== pending) problems.push(`section 1.1 bullets sum to ${sum}, repo has ${pending} pending`);

  const ledgerLine = /ledger holds (\d+) rows: the (\d+) recorded names plus these (\d+) files/.exec(section);
  if (ledgerLine === null) {
    problems.push("section 1.1 does not state the ledger total after R6.3");
  } else if (
    Number(ledgerLine[1]) !== ledger ||
    Number(ledgerLine[2]) !== expected.baseline ||
    Number(ledgerLine[3]) !== pending
  ) {
    problems.push(`section 1.1 ledger line says ${ledgerLine[0]}, repo gives ${ledger} (${expected.baseline} + ${pending})`);
  }

  const r63 = text.split("\n").find((line) => line.startsWith("| R6.3 | `bun run migrate`"));
  if (r63 === undefined) {
    problems.push("the R6.3 step-table row is missing");
  } else {
    if (!r63.includes(`**${pending} applied files**`)) problems.push(`R6.3 row does not say ${pending} applied files`);
    if (!r63.includes(`ledger at ${ledger} rows (${expected.baseline} + ${pending})`)) {
      problems.push(`R6.3 row does not say ledger at ${ledger} rows (${expected.baseline} + ${pending})`);
    }
  }

  for (const stale of ["39 files", "39 applied files"]) {
    if (text.includes(stale)) problems.push(`runbook still contains '${stale}'`);
  }
  return problems;
}

/** The runbook as it stood before the fix: 39 files, 25 additive, no 0115, no ledger total. */
function preFixRunbook(current: string): string {
  return current
    .replace(/\(\d+ files, from the/, "(39 files, from the")
    .replace(/\*\*Additive \(\d+\):\*\*/, "**Additive (25):**")
    .replace(", `0115_token_market_samples`", "")
    .replace(/\n\nAfter R6\.3 the ledger holds [^\n]*/, "")
    .replace(/\*\*\d+ applied files\*\*, ledger at \d+ rows \(\d+ \+ \d+\)/, "**39 applied files**");
}

describe("v0.6.0 rollout runbook pending-migration counts (issue 1252)", () => {
  const expected = derivePending();
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");

  test("the pending set is derived from the baseline, and includes 0115_token_market_samples", () => {
    expect(expected.baseline).toBe(SUPPORTED_RELEASES[0]!.migrations.length);
    expect(expected.pending).toContain("0115_token_market_samples.sql");
    expect(expected.byCategory.additive).toContain("0115_token_market_samples.sql");
    const classified = expected.byCategory.none.length + expected.byCategory.breaking.length + expected.byCategory.additive.length;
    expect(classified).toBe(expected.pending.length);
  });

  test("the runbook states the pending count, the compat breakdown, the files, and the ledger total", () => {
    expect(runbookProblems(runbook, expected)).toEqual([]);
  });

  test("red control: the pre-fix runbook text (39 files, 25 additive) fails the same check", () => {
    const old = preFixRunbook(runbook);
    expect(old).toContain("(39 files, from the");
    expect(old).toContain("**39 applied files**");
    const problems = runbookProblems(old, expected);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toContain(`heading says 39 files, repo has ${expected.pending.length} pending`);
    expect(problems).toContain(`additive bullet says 25, repo has ${expected.byCategory.additive.length}`);
    expect(problems).toContain("additive bullet does not name 0115_token_market_samples.sql");
    expect(problems).toContain("section 1.1 does not state the ledger total after R6.3");
    expect(problems).toContain(`R6.3 row does not say ${expected.pending.length} applied files`);
  });

  test("red control: one more migration on disk fails the check until the runbook names it", () => {
    const next = `${String(numberOf(expected.pending.at(-1)!) + 1).padStart(4, "0")}_next.sql`;
    const grown: Expected = {
      ...expected,
      pending: [...expected.pending, next],
      byCategory: { ...expected.byCategory, additive: [...expected.byCategory.additive, next] },
    };
    expect(runbookProblems(runbook, grown).length).toBeGreaterThan(0);
  });
});
