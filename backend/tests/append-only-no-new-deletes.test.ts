// Static repo guard: nothing new may write a DELETE / TRUNCATE / DROP TABLE
// against an append-only table (issue #684).
//
// WHY A GREP AND NOT JUST THE TRIGGER. Migration 0032 makes the database refuse
// these at runtime, which is the real invariant. But the refusal is only ever
// SEEN by whoever runs the statement — a fixture, a repair script, a 3am psql
// session — and the first time it is seen is the first time something breaks.
// The whole reason 188 test fixtures had to be rewritten for #684 is that the
// erase-and-reset habit had spread for years with nothing objecting. This test
// objects at review time instead, on the diff, before the statement is written
// into a code path someone later has to unpick.
//
// It is deliberately a PINNED SET, not a blanket ban: the occurrences below are
// each legitimate, each for a stated reason, and the test fails on any file not
// in this list. Adding a file here is allowed — it just has to be a decision
// somebody wrote down, which is the point.
//
// The table list is imported from append-only-enforcement.test.ts rather than
// copied: that file and migrations/0032_append_only_history.sql are the spec,
// and a third copy would be a third thing to forget.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { APPEND_ONLY_TABLES } from "./append-only-enforcement.test.ts";

const root = join(import.meta.dir, "..");

// path → why a destructive statement against a protected table is correct there.
const ALLOWED: Record<string, string> = {
  // Migration-replay suites. Each provisions its OWN throwaway database and
  // applies migrations only up to the one under test — all of them BELOW 0032 —
  // so the guard does not exist in that database and the fixture is operating on
  // the schema shape the migration was actually written for.
  "tests/swarm-briefs-session-key-migration.test.ts": "throwaway DB migrated to 0028 only",
  "tests/swarm-member-handle-migration.test.ts": "throwaway DB migrated to 0030 only",
  "tests/swarm-member-handle-namespace-migration.test.ts": "throwaway DB migrated to 0031 only",

  // Statements written to be REFUSED — the assertion is the refusal itself.
  "tests/append-only-enforcement.test.ts": "asserts the guard raises",
  "tests/append-only-no-new-deletes.test.ts": "this file (the table names are the subject)",
  "tests/swarm-admin-regime.test.ts": "asserts a session delete is refused 0A000",
  "tests/analytics-worker-role.test.ts": "asserts the restricted role is denied 42501",

  // The migration that installs the guard names every table it protects.
  "migrations/0032_append_only_history.sql": "installs the guard",
};

const TABLES = APPEND_ONLY_TABLES.join("|");
// `TRUNCATE a, b, c` is one statement over several tables, so look past the
// keyword for the table — but only across characters a TABLE LIST can contain.
// Anything else (a backtick, a semicolon, a paren, an operator) ends the search,
// or `DELETE FROM admin_passkey`; …; `INSERT INTO audit_log` would read as one
// destructive statement against audit_log.
const DESTRUCTIVE = new RegExp(
  String.raw`(DELETE\s+FROM|TRUNCATE(\s+TABLE)?|DROP\s+TABLE(\s+IF\s+EXISTS)?)[\w\s,."']{0,120}?\b(${TABLES})\b`,
  "gi",
);

// Scan CODE, not prose: every one of these tables is named in comments that
// explain why it must NOT be deleted, and a guard that fired on its own
// rationale would be untenable. SQL's `--` line comments are stripped too.
function codeOnly(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".sql")) out.push(full);
  }
  return out;
}

test("no new DELETE/TRUNCATE/DROP TABLE against an append-only table", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "tests", "scripts", "migrations"]) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file);
      if (rel in ALLOWED) continue;
      const hits = [...codeOnly(file).matchAll(DESTRUCTIVE)].map((m) => m[0].replace(/\s+/g, " ").trim());
      for (const hit of hits) offenders.push(`${rel}: ${hit}`);
    }
  }
  expect(
    offenders,
    "History is append-only (migration 0032). If a test needs clean state, take a clean " +
      "DATABASE (tests/support/clean-db.ts) instead of erasing rows; if the statement is " +
      "genuinely correct, add the file to ALLOWED above with the reason.",
  ).toEqual([]);
});

// A guard that matches nothing is a guard that has silently stopped working —
// the exact failure mode this file exists to prevent elsewhere.
test("the guard's pattern actually matches the statements it forbids", () => {
  for (const table of APPEND_ONLY_TABLES) {
    for (const stmt of [`DELETE FROM ${table} WHERE x`, `TRUNCATE ${table}`, `DROP TABLE IF EXISTS ${table}`]) {
      expect([...stmt.matchAll(DESTRUCTIVE)].length, `pattern must match: ${stmt}`).toBeGreaterThan(0);
    }
  }
  expect([...`TRUNCATE jobs, job_runs, ${APPEND_ONLY_TABLES[0]}`.matchAll(DESTRUCTIVE)].length).toBeGreaterThan(0);
  // …and does not fire on an unprotected table or on a plain SELECT.
  expect([...`DELETE FROM jobs WHERE id = 1`.matchAll(DESTRUCTIVE)].length).toBe(0);
  expect([...`SELECT * FROM audit_log`.matchAll(DESTRUCTIVE)].length).toBe(0);
});
