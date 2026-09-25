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
import { RUNTIME_DELETE_REVOKED_TABLES } from "../src/db/preflight.ts";

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
  "backend/tests/consensus-receipt-publish.test.ts": "asserts DELETE and TRUNCATE of a published receipt are refused",
  "backend/tests/analytics-overwrite-events.test.ts":
    "asserts regime deletion is refused while allowed current-view deletes are captured",
  "backend/tests/database-role-taxonomy.test.ts":
    "asserts rm_app direct evidence DELETE and TRUNCATE are denied 42501",
  // The offending statements are `GRANT TRUNCATE ON swarm_members TO rm_app`:
  // the file GRANTS a destructive privilege precisely so preflight check 2's
  // denylist can be proved to catch it, then revokes it in a `finally`. No row
  // is ever deleted or truncated — the privilege is the subject, not the data
  // (spec §7 check 2, issue #1026 W2). Once W2.2's grant-transition migration
  // lands, this same grant is what production must NOT have.
  "backend/tests/db-preflight-checks.test.ts":
    "GRANTs TRUNCATE so the preflight denylist can be proved to refuse it; deletes nothing",
  // The statements here are DATA, not code: fixture migration bodies handed to
  // preflight's scanner as strings so it can be proved to turn red on them. The
  // file opens no writeable connection to a protected table at all — its only
  // database work is SELECTs against the trigger catalog and a throwaway
  // database of its own. Written out longhand rather than assembled from
  // fragments on purpose: a fixture this guard cannot see is a fixture nobody
  // reviews.
  "backend/tests/preflight-0-3-0-append-only-safety.test.ts":
    "fixture SQL asserted to FAIL preflight's destructive-statement scan; never executed",

  // DDL, not the DML this guard's triggers intercept (0032's own header says
  // so): drops the table outright, in this file's own useCleanDatabase()
  // clone, to exercise checkSchemaCurrent()'s "never migrated at all" branch.
  "backend/tests/schema-current.test.ts": "DROP TABLE in an isolated clone, to test the never-migrated branch",

  // The migration that installs the guard names every table it protects.
  "backend/migrations/0032_append_only_history.sql": "installs the guard",

  // Same statements as 0032, for the same reason: the snapshot declaration
  // (spec §8.1, issue #1026 W2) is the canonical description of the schema, so
  // it carries every `CREATE TRIGGER ... BEFORE DELETE OR TRUNCATE ON <table>`
  // the guard installs. Those are the protection, not a use of it — the file
  // creates objects on a blank database and deletes no row anywhere.
  "backend/schema/snapshot.sql": "the snapshot declaration installs the guard's triggers",

  // Same statements again, for the same reason, in the fixture snapshot the
  // snapshot tests build on disk: its declaration carries
  // `CREATE TRIGGER ... BEFORE DELETE OR TRUNCATE ON schema_migrations` so the
  // fixture is honest about embodying 0032 and preflight check 3a can be run
  // against it. Installing the guard is not using it — the file deletes no row.
  "backend/tests/schema-snapshot.test.ts": "its fixture declaration installs the guard's triggers",

  // Migration 0059 cleans up fabricated snapshots on framework subjects (issue #960).
  "backend/migrations/0059_swarm_framework_subject_snapshot_cleanup.sql":
    "cleans up fabricated snapshots on framework subjects (issue #960)",

  // The runtime check. Its probe statement is built by interpolation, so it
  // carries no literal table name — but the list of protected tables lives here
  // and a future edit that spells one out next to a DELETE should not have to
  // fight the guard about it.
  "backend/src/db/append-only-guard.ts": "declares the protected set; the probe interpolates the table name",
};

/**
 * THE GRANT-ONLY TABLES (D53 (2)) and the files allowed to prune them.
 *
 * `swarm_stream_events` left APPEND_ONLY_TABLES when migration 0080 dropped its
 * triggers so rm_owner can prune below the oldest servable cursor (scheduler
 * spec §6.3 Retention, D52). Leaving the append-only set must not also take it
 * out of this guard: a DELETE against it is still a decision, and the only
 * correct one is rm_owner's prune below the floor. So it is scanned as well,
 * against its OWN pinned list — never the append-only ALLOWED map above, which
 * would excuse a file for every protected table at once. Each entry must carry
 * a statement against the table (no stale entry) and must act as `rm_owner`,
 * the only role that may prune.
 */
const GRANT_ONLY_TABLES: readonly string[] = RUNTIME_DELETE_REVOKED_TABLES.filter(
  (t) => !(APPEND_ONLY_TABLES as readonly string[]).includes(t),
);
const PRUNE_SITES: Record<string, string> = {
  "backend/tests/stream-events-retention.test.ts":
    "proves rm_owner may prune below the floor while rm_app and rm_worker get 42501",
  "backend/tests/api-event-stream.test.ts": "prunes as rm_owner to prove a cursor below the floor is a resync",
};

// `TRUNCATE a, b, c` is one statement over several tables, so look past the
// keyword for the table — but only across characters a TABLE LIST can contain.
// Anything else (a backtick, a semicolon, a paren, an operator) ends the search,
// or `DELETE FROM admin_passkey`; …; `INSERT INTO audit_log` would read as one
// destructive statement against audit_log.
const destructiveAgainst = (tables: readonly string[]) =>
  new RegExp(
    String.raw`(DELETE\s+FROM|TRUNCATE(\s+TABLE)?|DROP\s+TABLE(\s+IF\s+EXISTS)?)[\w\s,."']{0,120}?\b(${tables.join("|")})\b`,
    "gi",
  );
const DESTRUCTIVE = destructiveAgainst(APPEND_ONLY_TABLES);
const DESTRUCTIVE_GRANT_ONLY = destructiveAgainst(GRANT_ONLY_TABLES);

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
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "brand-assets"]);
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

test("no DELETE/TRUNCATE/DROP TABLE against a grant-only table outside its pinned prune sites (D53 (2))", () => {
  expect(GRANT_ONLY_TABLES, "swarm_stream_events is grant-only, and must still be scanned").toContain(
    "swarm_stream_events",
  );
  const offenders: string[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (rel in ALLOWED || rel in PRUNE_SITES) continue;
    // A GRANT or REVOKE names the privilege, not a removal: migration 0080's
    // `REVOKE DELETE, TRUNCATE ON swarm_stream_events FROM rm_app, rm_worker` is
    // the protection itself. Privilege statements are dropped before matching,
    // so what is left to match is a statement that removes rows.
    const code = codeOnly(file).replace(/\b(?:GRANT|REVOKE)\b[^;`"]*?\b(?:TO|FROM)\s+[\w, ]+/gi, "");
    for (const m of code.matchAll(DESTRUCTIVE_GRANT_ONLY)) {
      offenders.push(`${rel}: ${m[0].replace(/\s+/g, " ").trim()}`);
    }
  }
  expect(
    offenders,
    "Only rm_owner prunes swarm_stream_events, and only below the oldest servable cursor (D52, D53 (2)). " +
      "A new prune site is a decision: add it to PRUNE_SITES with the reason.",
  ).toEqual([]);
  for (const [rel, why] of Object.entries(PRUNE_SITES)) {
    const code = codeOnly(join(root, rel));
    expect({ rel, why, prunes: [...code.matchAll(DESTRUCTIVE_GRANT_ONLY)].length > 0 }).toEqual({ rel, why, prunes: true });
    expect({ rel, actsAsOwner: code.includes("SET LOCAL ROLE rm_owner") }).toEqual({ rel, actsAsOwner: true });
  }
});

// A guard that matches nothing is a guard that has silently stopped working —
// the exact failure mode this file exists to prevent elsewhere.
test("the guard's pattern actually matches the statements it forbids", () => {
  for (const table of GRANT_ONLY_TABLES) {
    expect([...`DELETE FROM ${table} WHERE seq < 10`.matchAll(DESTRUCTIVE_GRANT_ONLY)].length).toBeGreaterThan(0);
    expect([...`TRUNCATE ${table}`.matchAll(DESTRUCTIVE_GRANT_ONLY)].length).toBeGreaterThan(0);
  }
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
