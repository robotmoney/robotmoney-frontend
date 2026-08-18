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
// The table list is imported from src/db/append-only-guard.ts rather than
// copied: that module and migrations/0032_append_only_history.sql are the spec
// (and an executed test asserts the two agree), so a third copy would be a
// third thing to forget.
import { expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APPEND_ONLY_TABLES } from "../src/db/append-only-guard.ts";

// Scanned from the REPOSITORY root, not backend/. The statement this guard is
// really aimed at — a hand-run `psql` — is not written in application code; it
// is written in an ops script, a workflow step, or a runbook. `docs/runbooks/`
// in particular already carries copy-paste `DELETE FROM` blocks (they target
// admin_* tables, none of which is protected — but that is a fact about today,
// which is precisely the kind of fact a guard is for). Widening costs nothing
// here: at the time of writing the whole repo produces ZERO offenders outside
// backend/, so this is not a permissive boundary being papered over.
const root = join(import.meta.dir, "..", "..");

// path (relative to the repo root) → why a destructive statement against a
// protected table is correct there.
const ALLOWED: Record<string, string> = {
  // Migration-replay suites. Each provisions its OWN throwaway database and
  // applies migrations only up to the one under test — all of them BELOW 0032 —
  // so the guard does not exist in that database and the fixture is operating on
  // the schema shape the migration was actually written for.
  "backend/tests/swarm-briefs-session-key-migration.test.ts": "throwaway DB migrated to 0028 only",
  "backend/tests/swarm-member-handle-migration.test.ts": "throwaway DB migrated to 0030 only",
  "backend/tests/swarm-member-handle-namespace-migration.test.ts": "throwaway DB migrated to 0031 only",

  // Statements written to be REFUSED — the assertion is the refusal itself.
  "backend/tests/append-only-enforcement.test.ts": "asserts the guard raises",
  "backend/tests/append-only-guard-check.test.ts": "builds a DISARMED database on purpose and deletes from it",
  "backend/tests/append-only-replication.test.ts": "replicates a DELETE to prove the row-level guard catches it",
  "backend/tests/append-only-no-new-deletes.test.ts": "this file (the table names are the subject)",
  "backend/tests/swarm-admin-regime.test.ts": "asserts a session delete is refused 0A000",
  "backend/tests/analytics-worker-role.test.ts": "asserts the restricted role is denied 42501",
  "backend/tests/api-boot-handle-namespace-guard.test.ts": "rolls schema_migrations back to build a pre-0032 database",

  // The migration that installs the guard names every table it protects.
  "backend/migrations/0032_append_only_history.sql": "installs the guard",

  // The runtime check. Its probe statement is built by interpolation, so it
  // carries no literal table name — but the list of protected tables lives here
  // and a future edit that spells one out next to a DELETE should not have to
  // fight the guard about it.
  "backend/src/db/append-only-guard.ts": "declares the protected set; the probe interpolates the table name",
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
//
// MARKDOWN IS ALMOST ALL PROSE, and stripping `/* */`, `//` and `--` removes
// NONE of it — so widening SCANNED to `.md` (which is right: a runbook step is
// exactly where a hand-run psql statement gets written down) handed this guard
// 48 committed files it reads as if they were SQL. This very file advertises
// the verbatim `TRUNCATE swarm_recommendations, swarm_briefs, swarm_sessions
// RESTART IDENTITY CASCADE` as the string to watch for; the next doc, review
// artefact, or postmortem that QUOTES it would turn a required job red with no
// code change, and nothing in the offender list would distinguish a citation
// from a regression.
//
// So for Markdown, keep ONLY what is inside fenced code blocks and discard the
// prose around it. That preserves the entire reason `.md` is scanned — a
// copy-paste runbook step lives in a fence — while a sentence ABOUT a statement
// is no longer a statement. Everything else keeps the previous behaviour.
const FENCE = /^[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*(?:```|~~~)/gm;

function stripToCode(text: string, file: string): string {
  const source = file.endsWith(".md") ? [...text.matchAll(FENCE)].map((m) => m[1]).join("\n") : text;
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*--.*$/gm, "");
}

function codeOnly(file: string): string {
  return stripToCode(readFileSync(file, "utf8"), file);
}

// Vendored, generated, or binary trees: nothing in them is source somebody
// writes a psql statement into, and walking them would only make this slower.
// Everything else in the repo is scanned.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "brand-assets", "recyclebin"]);
// Skipped by repo-relative PATH, not by bare directory name, so the exemption
// cannot silently widen to some other `code-review/` added elsewhere later.
// `docs/code-review/` is where review artefacts are written, and a review of
// THIS guard quotes the statements it forbids by definition — the fenced-block
// rule above is not enough there, because a review quotes SQL in a fence.
const SKIP_PATHS = new Set(["docs/code-review"]);
// `.md` and `.yml` are in the list on purpose: a runbook step and a workflow
// step are both places a destructive statement gets written down. See
// stripToCode() for why `.md` is read fenced-blocks-only.
const SCANNED = [".ts", ".tsx", ".sql", ".sh", ".md", ".yml", ".yaml"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    // Dot-directories are noise (.venv, .cache) with one exception that matters.
    if (entry.startsWith(".") && entry !== ".github") continue;
    const full = join(dir, entry);
    if (SKIP_PATHS.has(relative(root, full))) continue;
    // lstat, never stat: stat() FOLLOWS symlinks, so one dangling link anywhere
    // under the repo root would throw and abort the entire walk — turning this
    // guard off by way of a hard error, in a tree that now spans the whole
    // repository rather than four backend/ subdirectories. Nothing tracked in
    // git here is a symlink, so skipping them costs no coverage and also rules
    // out a symlinked-directory cycle walking forever.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(full, out);
    else if (SCANNED.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

test("no new DELETE/TRUNCATE/DROP TABLE against an append-only table", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (rel in ALLOWED) continue;
    scanned++;
    const hits = [...codeOnly(file).matchAll(DESTRUCTIVE)].map((m) => m[0].replace(/\s+/g, " ").trim());
    for (const hit of hits) offenders.push(`${rel}: ${hit}`);
  }
  // An empty offender list is only meaningful if the walk found anything at
  // all. A mis-resolved root, a rename, or a broken skip rule would otherwise
  // report a clean repo by scanning nothing — the silent-pass failure mode this
  // whole file exists to prevent elsewhere. The floor is deliberately far below
  // the ~650 files present, so it pins "the walk works", not a file count.
  expect(scanned, "the walk must actually have read files").toBeGreaterThan(300);
  expect(
    offenders,
    "History is append-only (migration 0032). If a test needs clean state, take a clean " +
      "DATABASE (backend/tests/support/clean-db.ts) instead of erasing rows; if the statement " +
      "is genuinely correct, add the file to ALLOWED above with the reason.",
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

// The Markdown rule NARROWS what this guard reads, so it has to be shown that it
// narrowed the right half. A weakening that also stopped catching runbook steps
// would look identical from the offender list (still empty) — which is the
// silent-pass shape this whole file exists to prevent.
test("Markdown is read as fenced code only — a runbook STEP still fires, a sentence ABOUT it does not", () => {
  const table = APPEND_ONLY_TABLES[0]!;
  const fired = (doc: string) => [...stripToCode(doc, "docs/x.md").matchAll(DESTRUCTIVE)].length;

  // The reason `.md` is scanned at all: a copy-paste step in a runbook.
  expect(fired(["# Runbook", "", "```sh", `psql -c 'DELETE FROM ${table}'`, "```", ""].join("\n")))
    .toBeGreaterThan(0);
  expect(fired(["```sql", `TRUNCATE ${table} CASCADE;`, "```"].join("\n"))).toBeGreaterThan(0);
  // Indented inside a list item, which is how half the runbooks are written.
  expect(fired(["1. Do this:", "", "   ```sh", `   psql -c 'DELETE FROM ${table}'`, "   ```"].join("\n")))
    .toBeGreaterThan(0);

  // …and the citations that used to be indistinguishable from a regression.
  expect(fired(`The guard refuses \`DELETE FROM ${table}\` and \`TRUNCATE ${table}\`.`)).toBe(0);
  expect(fired(`We removed the old \`TRUNCATE ${table} RESTART IDENTITY CASCADE\` call in #684.`)).toBe(0);
  // Prose around a fence is still discarded; the fence itself is still read.
  expect(fired([`Never run \`DELETE FROM ${table}\`. Instead:`, "", "```sh", "echo safe", "```"].join("\n"))).toBe(0);

  // Non-Markdown is untouched by the fence rule — a bare .sql/.sh step still fires.
  expect([...stripToCode(`DELETE FROM ${table};`, "x.sql").matchAll(DESTRUCTIVE)].length).toBeGreaterThan(0);
});
