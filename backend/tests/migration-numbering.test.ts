// The numbering rule for NEW migration files (smoke-production-spec.md §8.1,
// D66): a new file takes the 4-digit prefix one above the highest prefix
// present, so prefixes are unique and strictly increasing from here on.
//
// The ledger keys on the full filename (`schema_migrations.name` is the primary
// key), which is the only reason the fourteen prefixes used twice do no harm,
// and nothing stopped two authors picking the same number. The existing
// duplicates and the 0064 to 0079 gap (the owner renumbered the never-shipped
// files above production's last recorded row, D55 (8)) are grandfathered by
// the explicit allowlist below. This test fails when a prefix outside the
// allowlist appears twice, or when a prefix outside the allowlisted gap is
// missing below the highest present. No database: it reads directory names.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/** The fourteen prefixes more than one file carries today, with how many
 *  (eleven are used twice, 0023, 0028 and 0059 three times). Never extended. */
export const GRANDFATHERED_DUPLICATE_PREFIXES: Readonly<Record<string, number>> = Object.freeze({
  "0014": 2, "0021": 2, "0022": 2, "0023": 3, "0028": 3, "0029": 2, "0032": 2, "0033": 2, "0056": 2, "0057": 2, "0058": 2, "0059": 3, "0061": 2, "0062": 2,
});

/** The one gap: 0064 to 0079, sixteen numbers, never filled. */
export const GRANDFATHERED_GAP: readonly string[] = Object.freeze(
  Array.from({ length: 16 }, (_, i) => String(64 + i).padStart(4, "0")),
);

/** Every rule violation in a directory's filenames, empty when it conforms. */
export function numberingProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  const byPrefix = new Map<string, string[]>();
  for (const file of files.filter((f) => f.endsWith(".sql")).sort()) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!m) {
      problems.push(`${file} is not <4 digits>_<snake_case>.sql`);
      continue;
    }
    byPrefix.set(m[1]!, [...(byPrefix.get(m[1]!) ?? []), file]);
  }
  for (const [prefix, names] of byPrefix) {
    const allowed = GRANDFATHERED_DUPLICATE_PREFIXES[prefix] ?? 1;
    if (names.length > allowed) {
      problems.push(`prefix ${prefix} is used ${names.length} times (${names.join(", ")}), the allowlist grandfathers ${allowed}; a new file takes the prefix one above the highest present`);
    }
  }
  const highest = Math.max(0, ...[...byPrefix.keys()].map(Number));
  for (let n = 1; n <= highest; n++) {
    const prefix = String(n).padStart(4, "0");
    if (!byPrefix.has(prefix) && !GRANDFATHERED_GAP.includes(prefix)) {
      problems.push(`prefix ${prefix} is missing below the highest present (${String(highest).padStart(4, "0")}); prefixes are contiguous`);
    }
  }
  return problems;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory holding empty files of the given names. */
function fixture(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-numbering-"));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "", "utf8");
  return dir;
}

const real = (): string[] => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

describe("§8.1 numbering rule: unique, strictly increasing 4-digit prefixes for new files", () => {
  test("backend/migrations conforms today: the duplicates and the gap are exactly the allowlist", () => {
    const files = real();
    expect(files.length).toBeGreaterThanOrEqual(122);
    expect(numberingProblems(files)).toEqual([]);
    // The allowlist is not wider than the directory: every grandfathered
    // prefix is really used twice, and every gap number is really absent.
    const prefixes = files.map((f) => f.slice(0, 4));
    for (const [p, count] of Object.entries(GRANDFATHERED_DUPLICATE_PREFIXES)) expect(prefixes.filter((x) => x === p)).toHaveLength(count);
    for (const p of GRANDFATHERED_GAP) expect(prefixes).not.toContain(p);
    expect(Object.keys(GRANDFATHERED_DUPLICATE_PREFIXES)).toEqual(["0014", "0021", "0022", "0023", "0028", "0029", "0032", "0033", "0056", "0057", "0058", "0059", "0061", "0062"]);
    expect(GRANDFATHERED_GAP).toEqual(["0064", "0065", "0066", "0067", "0068", "0069", "0070", "0071", "0072", "0073", "0074", "0075", "0076", "0077", "0078", "0079"]);
  });

  test("red: a new file reusing a prefix outside the allowlist fails, naming both files", () => {
    const files = real();
    const highest = files.at(-1)!.slice(0, 4);
    const dir = fixture([...files, `${highest}_another_file_with_the_same_number.sql`]);
    const problems = numberingProblems(readdirSync(dir));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`prefix ${highest} is used 2 times`);
    expect(problems[0]).toContain(files.at(-1)!);
  });

  test("red: one more file on a grandfathered prefix fails too", () => {
    const dir = fixture([...real(), "0014_a_third_fourteen.sql", "0023_a_fourth_twenty_three.sql"]);
    const problems = numberingProblems(readdirSync(dir));
    expect(problems.join("\n")).toContain("prefix 0014 is used 3 times");
    expect(problems.join("\n")).toContain("prefix 0023 is used 4 times");
    expect(problems).toHaveLength(2);
  });

  test("red: a new prefix that skips a number after the highest existing one fails, naming the skipped prefix", () => {
    const files = real();
    const next = Number(files.at(-1)!.slice(0, 4)) + 2;
    const dir = fixture([...files, `${String(next).padStart(4, "0")}_skipped_one.sql`]);
    const problems = numberingProblems(readdirSync(dir));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`prefix ${String(next - 1).padStart(4, "0")} is missing`);
  });

  test("green control: the next number passes", () => {
    const files = real();
    const next = Number(files.at(-1)!.slice(0, 4)) + 1;
    const dir = fixture([...files, `${String(next).padStart(4, "0")}_the_next_one.sql`]);
    expect(numberingProblems(readdirSync(dir))).toEqual([]);
  });

  test("red: a file outside the <4 digits>_<snake_case>.sql shape fails", () => {
    expect(numberingProblems(["0001_a.sql", "02_b.sql"]).join()).toContain("02_b.sql is not");
  });
});
