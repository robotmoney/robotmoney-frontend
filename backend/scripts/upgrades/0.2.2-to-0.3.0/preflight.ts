// Pre-upgrade dry run for v0.2.2 -> v0.3.0, specifically. The release-neutral
// mechanics (env loading, read-only connect + gate, verdict printing, receipt
// emission) live in ../../lib/preflight-utils.ts; this file only knows about
// the ten migrations THIS release ships and the checks specific to them.
//
// A future release gets its own backend/scripts/upgrades/<from>-to-<to>/
// directory, not an edit to this one — so what a past release's preflight
// actually checked stays reconstructable from git history.
//
// Usage (from anywhere in the checkout — the .env.readonly path resolves off
// this file's own location, not the cwd):
//   Create <repo root>/.env.readonly with the read-only role's connection
//   details as discrete keys (see .env.readonly.example), then:
//     bun scripts/upgrades/0.2.2-to-0.3.0/preflight.ts
//
// Exit codes: 0 = SAFE TO UPGRADE, 1 = BLOCKED, 2 = could not run the check.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, runPreflightMain } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  APPEND_ONLY_MIGRATION,
  APPEND_ONLY_TABLES,
  AUM_GUARD_TRIGGERS,
  COLLAPSE_PER_BUCKET_KINDS,
  MIGRATION_TOUCHED_TABLES,
  NEW_COLUMNS,
  NEW_SCHEDULE_KIND,
  NEW_TABLES,
  PRIOR_RELEASE_MIGRATIONS,
  TAG_GLOB,
  THIS_RELEASE_MIGRATIONS,
} from "./release.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(scriptDir, "..", "..", "..", "migrations");
const repoRoot = join(scriptDir, "..", "..", "..", "..");
const envPath = join(scriptDir, "..", "..", "..", "..", ".env.readonly");

/**
 * A transaction older than this will queue in front of 0034's ACCESS EXCLUSIVE
 * lock on job_schedules and 0035's ShareRowExclusive on swarm_members — and
 * every reader arriving after the lock request queues behind BOTH.
 *
 * This release's DDL is additive and fast (see checkLockProfile), so the window
 * is small — but "small" only holds if nothing is already holding a conflicting
 * lock when it starts.
 */
const BLOCKING_XACT_SECONDS = 60;

/** A schedule whose next_run_at is this far in the past has missed at least one
 *  expected fire without the stack being down. WARN, not a cut-off. */
const WEDGED_SCHEDULE_WARN_MINUTES = 60;

/**
 * Rows in wallet_balance_samples above which 0032_wallet_*'s ADD COLUMN is
 * worth calling out. It adds a NULLABLE column with NO default, which does not
 * rewrite the table on any supported Postgres — so this is informational, and
 * exists so the operator is not surprised by the table's size during the
 * rehearsal timing (§7 of the runbook asks for a wall-clock measurement).
 */
const WALLET_SAMPLES_NOTE_ROWS = 1_000_000;

async function checkServerVersion(db: Db, { record }: Checker): Promise<void> {
  const [v] = (await db`
    SELECT current_setting('server_version')          AS version,
           current_setting('server_version_num')::int AS num
  `) as unknown as { version: string; num: number }[];
  // 0034 adds `NOT NULL DEFAULT 'all'`. On PG 11+ a constant default is stored
  // in the catalog and the ADD COLUMN is instant; before 11 it rewrites the
  // whole table while holding ACCESS EXCLUSIVE.
  if (v.num < 110000) {
    record(
      "server-version",
      "FAIL",
      `PostgreSQL ${v.version} — 0034's NOT NULL DEFAULT would REWRITE job_schedules`,
      "This upgrade assumes PG 11+ for non-rewriting ADD COLUMN. Do not proceed on an older server.",
    );
    return;
  }
  record("server-version", "PASS", `PostgreSQL ${v.version}`);
}

/**
 * The premise check: is this database actually at v0.2.2?
 *
 * Split from the pending-migration diff below because the two failures mean
 * completely different things. A missing PRIOR migration means .env.readonly is
 * pointed at the wrong database (or one that never got v0.2.2) — the upgrade's
 * premise is false and nothing after this matters.
 */
async function checkPriorRelease(db: Db, { record }: Checker, applied: Set<string>): Promise<void> {
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((m) => !applied.has(m));
  if (missing.length > 0) {
    record(
      "prior-release",
      "FAIL",
      [
        `${missing.length} migration(s) from v0.2.2 are NOT applied on this database:`,
        ...missing.map((m) => `  ${m}`),
        "This database is not at v0.2.2, so 'upgrade v0.2.2 -> v0.3.0' is not what is about to happen.",
      ],
      "Confirm .env.readonly points at production. If it does, stop: the release baseline is wrong.",
    );
    return;
  }
  record("prior-release", "PASS", `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.2.2 migration(s) present`);
}

/**
 * Which migrations the next boot will apply, and whether that set is exactly
 * this release's declared set.
 *
 * The out-of-order WARN this emits is EXPECTED for v0.3.0 and is not a defect:
 * `0032_wallet_...` sorts before the already-applied
 * `0033_swarm_member_uuid_ids.sql`. What makes it safe is checked separately by
 * checkAppendOnlySafety() — the DDL that the out-of-order file would have run
 * "after" on a fresh database is the append-only guard, and this file does not
 * touch a protected table.
 */
async function checkPendingMigrations(db: Db, { record }: Checker): Promise<Set<string>> {
  if (!(await tableExists(db, "schema_migrations"))) {
    record(
      "schema-migrations",
      "FAIL",
      "no public.schema_migrations — this database was never migrated by src/db/migrate.ts",
      "Confirm .env.readonly points at the production database, not an empty/wrong one.",
    );
    return new Set();
  }

  // Same ordering the runner uses: readdir + JS default sort (src/db/migrate.ts:39-41).
  const onDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  // Sorted in JS, not SQL: the runner's ordering is JS default sort, and a
  // database collation can order differently.
  const applied = rows.map((r) => r.name).sort();
  const appliedSet = new Set(applied);
  const diskSet = new Set(onDisk);

  const pending = onDisk.filter((f) => !appliedSet.has(f));
  const orphans = applied.filter((f) => !diskSet.has(f));

  if (orphans.length > 0) {
    record(
      "schema-migrations",
      "FAIL",
      [
        `${orphans.length} migration(s) recorded in schema_migrations but ABSENT from backend/migrations/:`,
        ...orphans.map((o) => `  ${o}`),
        "The database is AHEAD of the checkout — this working tree is not the tag production is upgrading to.",
      ],
      "Check out the exact rc being deployed and re-run; do not migrate a database ahead of the code.",
    );
    return appliedSet;
  }

  const expected = new Set<string>(THIS_RELEASE_MIGRATIONS);
  const unexpected = pending.filter((p) => !expected.has(p));
  const alreadyApplied = THIS_RELEASE_MIGRATIONS.filter((m) => appliedSet.has(m));

  if (alreadyApplied.length > 0) {
    record(
      "schema-migrations",
      "FAIL",
      [
        `${alreadyApplied.length} of THIS release's migrations are already in schema_migrations:`,
        ...alreadyApplied.map((m) => `  ${m}`),
        "A partial application of this release has already happened on this database.",
      ],
      "Stop. Establish how they were applied before migrating further; do not assume the rest will be clean.",
    );
    return appliedSet;
  }

  if (unexpected.length > 0) {
    record(
      "schema-migrations",
      "FAIL",
      [
        `${unexpected.length} pending migration(s) are NOT part of v0.3.0:`,
        ...unexpected.map((p) => `  ${p}`),
        `Expected exactly: ${THIS_RELEASE_MIGRATIONS.join(", ")}`,
      ],
      "The checkout carries migrations this release does not declare. Confirm you are on the rc you intend to ship.",
    );
    return appliedSet;
  }

  const detail = [`${pending.length} migration(s) will be applied on the next boot:`, ...pending.map((p) => `  ${p}`)];

  const newestApplied = applied.length > 0 ? applied[applied.length - 1]! : "";
  const outOfOrder = pending.filter((p) => p < newestApplied);
  if (outOfOrder.length > 0) {
    detail.push(
      `NOTE: ${outOfOrder.length} of these sort BEFORE the newest applied file (${newestApplied}):`,
      ...outOfOrder.map((p) => `  ${p}`),
      "They will still run — the runner keys on the FULL filename, not the numeric prefix.",
      "EXPECTED for v0.3.0: this release adds a second 0032_ and a second 0033_.",
      "What makes it safe is checked separately — see the append-only-safety check below.",
    );
    record("schema-migrations", "WARN", detail, "Expected for this release. Confirm append-only-safety also passed.");
    return appliedSet;
  }

  record("schema-migrations", "PASS", detail);
  return appliedSet;
}

// ───────────────────────────────────────────────────────────────────────────
// DESTRUCTIVE-STATEMENT DETECTION — the half of append-only-safety that has to
// agree with `rm_append_only_guard()`.
//
// WHY IT IS NOT THE TOUCHED-TABLES ROSTER. This check used to ask "does this
// release TOUCH a table the guard protects?" and print the answer as "this
// release may DESTROY protected history". Two different claims, and only the
// first was true. `rm_append_only_guard()` (migration 0032) fires
// `BEFORE DELETE OR TRUNCATE` only, so 0035's `VALIDATE CONSTRAINT` on
// `swarm_members` and 0039's `DROP/ADD CONSTRAINT` on `swarm_sessions` take a
// lock and can never trip it — yet both were reported as blocking collisions,
// which is how v0.3.0 preflight came to exit BLOCKED with nothing actually
// wrong (issue #815). `MIGRATION_TOUCHED_TABLES` stays what it is — the roster
// of everything the release creates, alters, locks or writes, kept honest by
// tests/rollout-steps-0-3-0.test.ts — and risk is now read off the SQL the
// release will actually execute. The check and the trigger agree by
// construction rather than by coincidence.
//
// WHAT THIS DOES NOT CATCH. Stated plainly on purpose: a check whose blind
// spots are written down is honest; one that implies completeness it does not
// have is the exact defect being fixed here.
//   1. DYNAMIC SQL. `EXECUTE format('DELETE FROM %I', t)` is a string literal
//      to this scanner and is stripped before matching. Migration 0040
//      legitimately drops and recreates append-only triggers exactly this way,
//      and nothing here sees it. This is the one blind spot that errs towards a
//      FALSE NEGATIVE, which is why the runbook still asks the operator to read
//      §2.2's migration table rather than treating a PASS as the whole story.
//   2. A removal reached INDIRECTLY — through a view, a rule, an
//      `ON DELETE CASCADE` chain, or a function the migration merely calls.
//      Only text the migration file itself contains is read. (The guard itself
//      still refuses all of these at runtime; they are invisible here, not
//      unprotected.)
//   3. SCHEMA QUALIFICATION. Tables are matched on the BARE name, so
//      `other_schema.swarm_members` is treated as `swarm_members` — a false
//      positive, i.e. the safe direction.
//   4. `standard_conforming_strings = off`, or a backslash-escaped quote inside
//      an `E'…'` literal: literals end on `'` with `''` doubling only, so such a
//      literal can end early and shift what is scanned.
//   5. Statement splitting is on a bare `;`, so a semicolon inside a
//      double-quoted identifier splits one statement into two.
//   6. REMOVAL, not mutation. This check grades what the append-only guard
//      enforces: DELETE and TRUNCATE. A table whose own guard also refuses
//      UPDATE (the per-table `<t>_immutable` pairs 0037/0038 install, and the
//      `<t>_snapshot_final_guard` pair that also refuses INSERT) is protected
//      here against having that guard turned OFF, but an UPDATE or INSERT
//      statement against it is not graded — postflight's guard-catalog checks
//      and the trigger itself are what cover that.
//   7. WHICH MIGRATION INSTALLS A GUARD is read out of the files
//      (guardedTablesInstalledBy), in the two shapes this repo uses. A guard
//      installed in a third shape would not be attributed to its migration, and
//      a removal that runs after it would be graded as running before it. The
//      derived map is pinned against the real migration set by
//      tests/preflight-0-3-0-append-only-safety.test.ts, so a new shape shows up
//      as a failing test rather than as a quiet gap.
// Apart from (1) and (7), every limit above errs towards flagging a release that
// is fine rather than passing one that is not.
// ───────────────────────────────────────────────────────────────────────────

/** One statement in a migration that removes rows, or changes the guard's
 *  ability to refuse a removal. */
export interface DestructiveFinding {
  /** Migration filename the statement was found in. */
  file: string;
  kind: "DELETE" | "TRUNCATE" | "DROP TABLE" | "DISABLE TRIGGER" | "DROP TRIGGER" | "REPLACE TRIGGER" | "GUARD FUNCTION";
  /** The table for a row-removal finding; the trigger or function name for a
   *  guard-tampering one. */
  target: string;
  /** True when this finding must BLOCK the release: it removes rows from an
   *  append-only table, or it changes what the guard can refuse. A row-removing
   *  statement against an UNPROTECTED table is reported (so the check is
   *  visibly non-vacuous) but does not block. */
  blocking: boolean;
}

/** A migration file as the scanner reads it. */
export interface MigrationSql {
  file: string;
  sql: string;
}

const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * Remove everything a `DELETE`/`TRUNCATE` keyword could hide in without being
 * executed: line comments, (nestable) block comments, and single-quoted string
 * literals.
 *
 * Dollar-quoted bodies are the deliberate exception — they are KEPT and
 * recursively stripped, so a `DO $$ … DELETE FROM swarm_members; … $$` block
 * and a function body the migration defines are both scanned. That is the
 * conservative direction: a function body that merely mentions a removal is
 * flagged even though defining it removes nothing.
 */
export function stripSqlNoise(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      out.push(" ");
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out.push(" ");
      continue;
    }
    if (sql[i] === "$") {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) break; // unterminated — nothing after it is parseable
        out.push(" ", stripSqlNoise(sql.slice(i + tag.length, end)), " ");
        i = end + tag.length;
        continue;
      }
    }
    if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push(" '' ");
      continue;
    }
    out.push(sql[i]!);
    i++;
  }
  return out.join("");
}

/** Bare table name out of an optionally schema-qualified, optionally quoted,
 *  optionally `ONLY`-prefixed reference. */
function bareTable(ref: string): string | null {
  const m = /^\s*(?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?/i.exec(ref);
  return m?.[1] ?? null;
}

/**
 * plpgsql keywords that can stand between a `;` boundary and the statement that
 * follows it.
 *
 * WHY THIS EXISTS. `stripSqlNoise()` unwraps a `DO $$ … $$` body so its contents
 * are scanned, but the unwrapped text does not begin with the statement — it
 * begins `BEGIN …`, or `IF … THEN`, or `LOOP`. `DELETE FROM` is matched anywhere
 * in a statement so it survived that; `TRUNCATE`, `DROP TABLE`, `DISABLE
 * TRIGGER` and `DROP TRIGGER` were anchored at the start of the fragment and so
 * were invisible inside every DO block — while the comment above claimed DO
 * blocks were handled, and the suite asserted only the DELETE case. That is
 * one shape in five, and DO blocks are where 0037, 0038 and 0040 do all of
 * their trigger DDL.
 *
 * The anchors stay (they are what keeps `CREATE TRIGGER … BEFORE DELETE OR
 * TRUNCATE ON …` from reading as a TRUNCATE); they are just applied after the
 * openers are peeled off.
 *
 * `DO` leads the list because stripSqlNoise() splices a dollar-quoted body in
 * place of its wrapper, so the first fragment of a DO block reads
 * `DO  BEGIN <statement>` — the `DO` is still there.
 */
const BLOCK_OPENER =
  /^(?:DO|BEGIN|DECLARE\b[^]*?(?=\bBEGIN\b)|THEN|ELSE|LOOP|END\s+LOOP|END\s+IF|END|EXCEPTION|IF\b[^]*?\bTHEN|ELSIF\b[^]*?\bTHEN|WHEN\b[^]*?\bTHEN|WHILE\b[^]*?\bLOOP|FOR\b[^]*?\bLOOP|FOREACH\b[^]*?\bLOOP)\s+/i;

/** Peel plpgsql block openers so a statement inside a DO block is anchored the
 *  same way a top-level one is. */
function atStatementStart(stmt: string): string {
  let s = stmt;
  // Bounded: a fragment cannot nest more openers than this without a `;`.
  for (let i = 0; i < 8; i++) {
    const next = s.replace(BLOCK_OPENER, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/** `TRUNCATE a, public.b RESTART IDENTITY CASCADE` → ["a", "b"]. */
function tableList(clause: string): string[] {
  const head = clause.split(/\b(?:RESTART|CONTINUE|CASCADE|RESTRICT)\b/i)[0] ?? "";
  return head
    .split(",")
    .map(bareTable)
    .filter((t): t is string => t !== null);
}

/**
 * The repo's IMMUTABILITY-GUARD NAMING VOCABULARY.
 *
 * Guards are recognised by name rather than by assuming every one is 0032's,
 * because they are not: 0032/0040 install the shared `<t>_append_only` /
 * `<t>_append_only_row` pair, while 0037/0038 install table-SPECIFIC pairs
 * (`<t>_immutable`, `<t>_immutable_row`) driven by their own guard functions,
 * and a migration adding a new protected table follows that second shape. A
 * check that only knew the first name would watch one of the three and call it
 * coverage.
 *
 * It is a heuristic, and the limit is real: a guard named outside this
 * vocabulary (`wallet_aum_snapshot_runs_finalize`, for one) is not recognised
 * BY NAME. Such a trigger is still caught whenever it sits on an append-only
 * table, because scanMigrationSql() blocks any trigger change on one of those
 * regardless of the trigger's name.
 */
const isGuardTriggerName = (name: string): boolean => /_append_only|_immutable|_guard/i.test(name);

/** Guard FUNCTIONS follow the same two shapes: `rm_append_only_guard()` and the
 *  per-table `rm_<subject>_immutable()` / `rm_<subject>_guard()`. */
const GUARD_FUNCTION = /\brm_[a-z0-9_]*(?:guard|immutable)[a-z0-9_]*\b/i;

/**
 * Read one migration's SQL and report every statement that removes rows, or
 * that changes the append-only guard's capability. See the header block above
 * for what it deliberately does not see.
 */
export function scanMigrationSql(
  file: string,
  sql: string,
  protectedTables: ReadonlySet<string>,
): DestructiveFinding[] {
  const findings: DestructiveFinding[] = [];
  const push = (kind: DestructiveFinding["kind"], target: string, blocking: boolean): void => {
    findings.push({ file, kind, target, blocking });
  };
  // A trigger change counts when EITHER the trigger's name is guard-shaped
  // (isGuardTriggerName, which reaches table-specific guards on tables the
  // append-only roster does not contain) OR it sits on an append-only table
  // (which reaches a guard whose name this file has never heard of). The two
  // rules cover each other's gap.
  const guardChange = (table: string, trigger: string): boolean =>
    isGuardTriggerName(trigger) || protectedTables.has(table);

  for (const raw of stripSqlNoise(sql).split(";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    if (!stmt) continue;
    // The same fragment with plpgsql block openers peeled off, so the anchored
    // rules below reach a statement written inside a DO block. See BLOCK_OPENER.
    const head = atStatementStart(stmt);

    // `DELETE FROM` is unambiguous: a trigger event list says `BEFORE DELETE ON`,
    // never `DELETE FROM`. So this is matched ANYWHERE in the statement, which
    // also covers a `WITH … AS (DELETE FROM …)` data-modifying CTE.
    for (const m of stmt.matchAll(/\bDELETE\s+FROM\s+((?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)/gi)) {
      const t = bareTable(m[1]!);
      if (t) push("DELETE", t, protectedTables.has(t));
    }

    // TRUNCATE and DROP TABLE, by contrast, must LEAD the statement: the same
    // words appear inside `CREATE TRIGGER … BEFORE DELETE OR TRUNCATE ON …`,
    // which removes nothing and must not be reported.
    const truncate = /^TRUNCATE\s+(?:TABLE\s+)?(.+)$/i.exec(head);
    if (truncate) {
      for (const t of tableList(truncate[1]!)) push("TRUNCATE", t, protectedTables.has(t));
    }
    const dropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+)$/i.exec(head);
    if (dropTable) {
      // Dropping the table takes its append-only triggers with it, so this is
      // destructive on a protected table however few rows it holds.
      for (const t of tableList(dropTable[1]!)) push("DROP TABLE", t, protectedTables.has(t));
    }

    // ── Guard tampering. A migration runs as the table's OWNER, so it can turn
    // the guard off — and `rm_append_only_guard()` cannot see that happen to
    // itself. This is the half of the risk the row trigger structurally cannot
    // cover, which is why it is checked here rather than left to the database.
    const disable = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?\s+(?:DISABLE|ENABLE\s+REPLICA)\s+TRIGGER\s+(?:(ALL|USER)\b|"?([A-Za-z_][\w$]*)"?)/i.exec(
      head,
    );
    if (disable) {
      const table = disable[1]!;
      // `ENABLE REPLICA` is here beside `DISABLE` on purpose: the guards are
      // installed ENABLE ALWAYS precisely so a `session_replication_role =
      // replica` apply cannot bypass them, and demoting one to REPLICA re-opens
      // that door without the word DISABLE ever appearing.
      const named = disable[2] ? disable[2].toUpperCase() : disable[3]!;
      if (disable[2] ? protectedTables.has(table) : guardChange(table, named)) {
        push("DISABLE TRIGGER", `${table}.${named}`, true);
      }
    }
    const dropTrigger = /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][\w$]*)"?\s+ON\s+(?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?/i.exec(
      head,
    );
    if (dropTrigger && guardChange(dropTrigger[2]!, dropTrigger[1]!)) {
      push("DROP TRIGGER", `${dropTrigger[2]!}.${dropTrigger[1]!}`, true);
    }
    const replaceTrigger = /^CREATE\s+OR\s+REPLACE\s+TRIGGER\s+"?([A-Za-z_][\w$]*)"?[^]*?\bON\s+(?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?/i.exec(
      head,
    );
    if (replaceTrigger && guardChange(replaceTrigger[2]!, replaceTrigger[1]!)) {
      push("REPLACE TRIGGER", `${replaceTrigger[2]!}.${replaceTrigger[1]!}`, true);
    }
    // Replacing or dropping the FUNCTION is the same capability change one
    // level down: a guard trigger is only as good as the function it executes,
    // and swapping that body silently defangs every trigger pointing at it.
    const guardFn = /^(?:CREATE\s+OR\s+REPLACE|DROP)\s+FUNCTION\b([^]*)$/i.exec(head);
    const fnName = guardFn ? GUARD_FUNCTION.exec(guardFn[1]!) : null;
    if (fnName) push("GUARD FUNCTION", fnName[0], true);
  }
  return findings;
}

/** Every dollar-quoted body in a migration, unwrapped one level. */
function dollarQuotedBodies(sql: string): string[] {
  const bodies: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    if (sql[i] !== "$") {
      i++;
      continue;
    }
    DOLLAR_TAG.lastIndex = i;
    const m = DOLLAR_TAG.exec(sql);
    if (!m) {
      i++;
      continue;
    }
    const end = sql.indexOf(m[0], i + m[0].length);
    if (end === -1) break;
    bodies.push(sql.slice(i + m[0].length, end));
    i = end + m[0].length;
  }
  return bodies;
}

/**
 * The tables a migration installs an immutability guard ON.
 *
 * WHY THIS IS NEEDED AT ALL. Three of the tables this release guards are
 * guarded BY this release — 0037's evidence pair, 0038's snapshot runs and
 * constituent guards, 0040's judgement pair — so "is this table protected?" is
 * not one answer for the whole run. It changes as the migrations apply, and a
 * check that used a single set would either miss a removal (grading a
 * mid-release table as unguarded) or block one that is genuinely safe (0037
 * archives-then-deletes sample rows BEFORE 0038 guards them). Both happened:
 * the first was a detection regression against main's over-broad rule, and the
 * second is the ordering the release actually depends on.
 *
 * Reading it out of the files makes that ordering a COMPUTED fact rather than a
 * coincidence nobody re-checks. Two shapes, because the repo uses both:
 *   - static `CREATE TRIGGER <guard-name> … ON <table>` (0038's snapshot-run pair)
 *   - a `DO $$ … $$` block that builds the trigger with `format()` over an ARRAY
 *     of table names (0037, 0038's constituent guards, 0040). The table names
 *     are plain literals in that array even though the trigger name is not, so
 *     they are readable; the guard-name suffixes (`'_immutable'`) start with an
 *     underscore and are excluded.
 *
 * It reads the RAW sql, not the stripped form — the literals are the point here.
 * Pinned against the real migration set by
 * tests/preflight-0-3-0-append-only-safety.test.ts.
 */
export function guardedTablesInstalledBy(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([A-Za-z_][\w$]*)"?[^;]*?\bON\s+(?:ONLY\s+)?(?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?/gi,
  )) {
    if (isGuardTriggerName(m[1]!)) out.add(m[2]!);
  }
  for (const body of dollarQuotedBodies(sql)) {
    if (!/\bCREATE\s+TRIGGER\b/i.test(body)) continue;
    // Line comments first: 0040's rationale quotes `session_replication_role =
    // 'replica'`, and a word in a comment is not a table.
    const code = body.replace(/--.*$/gm, "");
    for (const lit of code.matchAll(/'([A-Za-z_][A-Za-z0-9_$]*)'/g)) {
      // A leading underscore is a trigger-name SUFFIX being concatenated
      // (`t || '_immutable'`), never a table.
      if (!lit[1]!.startsWith("_")) out.add(lit[1]!);
    }
  }
  return out;
}

/** Reads this release's migration files off disk, in runner order. */
async function loadReleaseMigrations(): Promise<MigrationSql[]> {
  return Promise.all(
    THIS_RELEASE_MIGRATIONS.map(async (file) => ({ file, sql: await readFile(join(migrationsDir, file), "utf8") })),
  );
}

/**
 * The reason the out-of-order warning above is tolerable.
 *
 * On a FRESH database the runner would apply `0032_append_only_history.sql`
 * before `0032_wallet_...` (`_append` sorts before `_wallet`), so the guard is
 * installed first. On THIS upgrade the guard is already installed, which is the
 * same relative order. Either way the new migrations run with the guard live —
 * so the only question that matters is whether any of them REMOVES A ROW from a
 * protected table, or turns the guard off. Both are read out of the migrations'
 * own SQL (scanMigrationSql, above) and graded against the database's own
 * trigger catalog rather than against a list in a doc.
 *
 * `loadMigrations` is injectable so the check itself — not a re-implementation
 * of it — can be graded against fixture migrations in both directions
 * (tests/preflight-0-3-0-append-only-safety.test.ts).
 */
export async function checkAppendOnlySafety(
  db: Db,
  { record }: Checker,
  applied: Set<string>,
  loadMigrations: () => Promise<MigrationSql[]> = loadReleaseMigrations,
): Promise<void> {
  if (!applied.has(APPEND_ONLY_MIGRATION)) {
    record(
      "append-only-safety",
      "FAIL",
      `${APPEND_ONLY_MIGRATION} is not applied — v0.2.2's append-only guard is missing`,
      "Do not upgrade. A database without the guard has not had v0.2.2 applied, or has been restored unchecked.",
    );
    return;
  }

  const rows = (await db`
    SELECT c.relname AS table_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND NOT t.tgisinternal
       AND t.tgname LIKE '%_append_only'
     GROUP BY c.relname
  `) as unknown as { table_name: string }[];
  const live = new Set(rows.map((r) => r.table_name));

  if (live.size === 0) {
    record(
      "append-only-safety",
      "FAIL",
      `${APPEND_ONLY_MIGRATION} is recorded as applied but NO *_append_only triggers exist`,
      "The guard was installed and is now gone. Stop and establish why before writing anything.",
    );
    return;
  }

  let migrations: MigrationSql[];
  try {
    migrations = await loadMigrations();
  } catch (e) {
    record(
      "append-only-safety",
      "FAIL",
      `cannot read this release's migration files: ${e instanceof Error ? e.message : e}`,
      "The checkout is incomplete. Do not upgrade from a tree whose migrations cannot be read.",
    );
    return;
  }

  // ── What counts as protected, and WHEN ──────────────────────────────────
  //
  // The live catalog is not the whole answer and neither is any single list.
  // The catalog reads `%_append_only` triggers only, so it cannot see the
  // table-specific guards 0037/0038 install (`<t>_immutable`,
  // `<t>_snapshot_final_guard`) — and it is read against a v0.2.2 database, so
  // it cannot see any table THIS RELEASE creates and protects.
  //
  // `AUM_GUARD_TRIGGERS` is the declared roster for the first gap and
  // `APPEND_ONLY_TABLES` for the second. Both already exist in release.ts,
  // both are already drift-guarded against the migrations, and postflight
  // already reads them; preflight simply had not.
  //
  // The WHEN matters as much as the what. Three of these tables are guarded BY
  // this release, so protection is not one set for the whole run:
  //   - 0037 archives and then DELETEs rows from `wallet_balance_samples` /
  //     `wallet_sleeve_samples`, which 0038 guards afterwards. That delete is
  //     correct, and grading it against the end-state roster would re-block the
  //     release for a guard that does not exist yet when it runs.
  //   - A delete from the same tables in a LATER migration would abort the boot,
  //     and must be caught.
  // So the release's own guard installations are read out of the migration
  // files (guardedTablesInstalledBy) and a table counts as protected for every
  // migration that sorts AFTER the one installing its guard. The ordering the
  // release depends on becomes a computed, re-checked fact instead of a
  // coincidence — which is the whole point of this check.
  const declared = new Set<string>([...APPEND_ONLY_TABLES, ...AUM_GUARD_TRIGGERS.map((g) => g.table)]);
  const installedAt = new Map<string, number>();
  migrations.forEach((m, i) => {
    for (const t of guardedTablesInstalledBy(m.sql)) if (!installedAt.has(t)) installedAt.set(t, i);
  });

  const protectedFor = (i: number): Set<string> => {
    const set = new Set<string>(live);
    for (const t of declared) {
      const at = installedAt.get(t);
      // Not yet guarded while the migration that installs its guard has not run.
      if (at === undefined || at < i) set.add(t);
    }
    return set;
  };
  // Everything guarded by the time the release finishes — used for WORDING, so
  // the report can never call a table "unguarded" when it ends up guarded.
  const protectedAtEnd = new Set<string>([...live, ...declared]);

  const findings = migrations.flatMap((m, i) => scanMigrationSql(m.file, m.sql, protectedFor(i)));
  const blocking = findings.filter((f) => f.blocking);
  if (blocking.length > 0) {
    record(
      "append-only-safety",
      "FAIL",
      [
        `${blocking.length} statement(s) in this release remove protected history, or the guard that protects it:`,
        ...blocking.map((f) => `  ${f.file}: ${f.kind} ${f.target}`),
      ],
      "rm_append_only_guard() will abort the boot on a removal, and a disabled guard is worse. Do not upgrade until each line above is removed or justified.",
    );
    return;
  }

  // Reported even on the happy path, because it is the evidence that the
  // scanner is looking at real statements rather than passing everything: this
  // release DOES issue row removals (0036 on wallet_backfill_state, 0037 on the
  // two sample tables), and each is placed in the bucket that is TRUE of it.
  //
  // Splitting the buckets is not cosmetic. One line used to read "all against
  // UNPROTECTED tables" and list `wallet_balance_samples` — a table that carries
  // a BEFORE DELETE guard by the end of this same release. That sentence was
  // the operator-facing claim this check exists to make trustworthy, and it was
  // false; the runbook then pointed the operator at it as positive evidence.
  const removals = findings.filter((f) => f.kind === "DELETE" || f.kind === "TRUNCATE" || f.kind === "DROP TABLE");
  const beforeGuard = removals.filter((f) => protectedAtEnd.has(f.target));
  const unguarded = removals.filter((f) => !protectedAtEnd.has(f.target));
  // "…but not written" has to mean it. `wallet_balance_samples` is both touched
  // AND deleted from, so it belongs in the ordering bucket above, not here.
  const written = new Set(removals.map((f) => f.target));
  const lockedOnly = [...MIGRATION_TOUCHED_TABLES].filter((t) => protectedAtEnd.has(t) && !written.has(t));

  const detail = [
    `guard live on ${live.size} table(s); no statement in this release's ${migrations.length} migration(s) removes a row from a table protected AT THE TIME IT RUNS`,
  ];
  detail.push(
    unguarded.length > 0
      ? `${unguarded.length} removal(s) target tables no guard covers, before or after this release: ${[...new Set(unguarded.map((f) => f.target))].join(", ")}`
      : "no removal targets a permanently unguarded table",
  );
  if (beforeGuard.length > 0) {
    detail.push(
      `${beforeGuard.length} removal(s) run BEFORE this release installs the guard for their table — correct ONLY in this migration order:`,
      ...beforeGuard.map((f) => {
        const at = installedAt.get(f.target);
        const by = at === undefined ? "a guard already on the database" : migrations[at]!.file;
        return `  ${f.file}: ${f.kind} ${f.target} (guarded from ${by})`;
      }),
    );
  }
  detail.push(
    lockedOnly.length > 0
      ? `${lockedOnly.length} protected table(s) are LOCKED or ALTERED but not written: ${lockedOnly.join(", ")} — rm_append_only_guard() fires BEFORE DELETE OR TRUNCATE only`
      : "no protected table is touched at all",
  );
  detail.push(
    "not seen by this check: removals built with dynamic SQL, or reached through a view/rule/cascade — see §2.2 for the read-through",
  );
  record("append-only-safety", "PASS", detail);
}

/**
 * Every target this release's DDL will create must not exist yet. A column or
 * table that is already there means either a partial application (caught above
 * by schema-migrations) or an out-of-band change nobody recorded.
 */
async function checkCleanTargets(db: Db, { record }: Checker): Promise<void> {
  const occupied: string[] = [];
  for (const t of NEW_TABLES) {
    if (await tableExists(db, t)) occupied.push(`table ${t}`);
  }
  for (const { table, column } of NEW_COLUMNS) {
    if (!(await tableExists(db, table))) {
      // Some 0038 ALTER targets (chain cache and P0 evidence tables) are
      // themselves created earlier in this release. Their absence is the clean
      // v0.2.2 shape; postflight verifies the final table+column inventory.
      if ((NEW_TABLES as readonly string[]).includes(table)) continue;
      record(
        "clean-targets",
        "FAIL",
        `${table} does not exist — this release's ALTER TABLE has no target`,
        "The database is not the shape v0.2.2 leaves behind. Stop.",
      );
      return;
    }
    if (await columnExists(db, table, column)) occupied.push(`column ${table}.${column}`);
  }

  if (occupied.length > 0) {
    record(
      "clean-targets",
      "FAIL",
      [`${occupied.length} target(s) already exist:`, ...occupied.map((o) => `  ${o}`)],
      "Something applied part of this release out of band. Establish what before migrating.",
    );
    return;
  }
  record("clean-targets", "PASS", `${NEW_TABLES.length} table(s) and ${NEW_COLUMNS.length} column(s) clear`);
}

/**
 * Capture what 0034 will overwrite, so postflight can prove its schedule UPDATE
 * hit exactly the two intended kinds and nothing else. Migrations 0036/0037
 * separately quarantine and archive wallet samples.
 */
async function checkCatchupBaseline(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "job_schedules"))) {
    record("catchup-baseline", "FAIL", "no job_schedules table", "The database is not the shape v0.2.2 leaves behind.");
    return;
  }
  const rows = (await db`
    SELECT kind, enabled, cron FROM job_schedules ORDER BY kind
  `) as unknown as { kind: string; enabled: boolean; cron: string }[];

  const targets = rows.filter((r) => (COLLAPSE_PER_BUCKET_KINDS as readonly string[]).includes(r.kind));
  const missing = COLLAPSE_PER_BUCKET_KINDS.filter((k) => !rows.some((r) => r.kind === k));

  const detail = [
    `${rows.length} schedule(s); 0034 will set catchup_policy='collapse-per-bucket' on ${targets.length}:`,
    ...targets.map((t) => `  ${t.kind} (cron=${t.cron}, enabled=${t.enabled})`),
    `every other schedule keeps the column default 'all' (${rows.length - targets.length} row(s))`,
  ];

  if (missing.length > 0) {
    detail.push(`NOTE: ${missing.length} expected kind(s) absent: ${missing.join(", ")}`);
    record(
      "catchup-baseline",
      "WARN",
      detail,
      "0034's UPDATE will match fewer rows than expected. Confirm those schedules are genuinely absent.",
    );
    return;
  }

  if (rows.some((r) => r.kind === NEW_SCHEDULE_KIND)) {
    record(
      "catchup-baseline",
      "WARN",
      [...detail, `NOTE: ${NEW_SCHEDULE_KIND} already exists — seed() will not be introducing it`],
      "Unexpected but not blocking: confirm it was not created out of band with different settings.",
    );
    return;
  }

  record("catchup-baseline", "PASS", detail);
}

/**
 * Informational sizing for the rehearsal's wall-clock measurement (runbook §7).
 * The ADD COLUMN is nullable with no default, so it does not rewrite — this
 * exists so a large table is not a surprise, not because it is a risk.
 */
async function checkWalletSamplesSize(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "wallet_balance_samples"))) {
    record("wallet-samples-size", "FAIL", "no wallet_balance_samples table", "Not the shape v0.2.2 leaves behind.");
    return;
  }
  const [row] = (await db`
    SELECT reltuples::bigint AS estimate,
           pg_size_pretty(pg_total_relation_size('public.wallet_balance_samples')) AS size
      FROM pg_class WHERE oid = 'public.wallet_balance_samples'::regclass
  `) as unknown as { estimate: number; size: string }[];
  const n = Number(row?.estimate ?? 0);
  const detail = [`~${n.toLocaleString()} row(s), ${row?.size ?? "unknown"} — ADD COLUMN is nullable, no default`];
  if (n > WALLET_SAMPLES_NOTE_ROWS) {
    detail.push("Large, but still non-rewriting: the catalog-only path applies regardless of row count.");
  }
  record("wallet-samples-size", "PASS", detail);
}

/**
 * A long-running transaction will queue in front of this release's ACCESS
 * EXCLUSIVE locks, and every reader that arrives after the lock request queues
 * behind both. Goes stale by the minute — re-run immediately before cutover.
 */
async function checkBlockingActivity(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT pid,
           state,
           EXTRACT(EPOCH FROM (now() - xact_start))::int AS xact_seconds,
           left(coalesce(query, ''), 80) AS query
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND xact_start IS NOT NULL
       AND now() - xact_start > make_interval(secs => ${BLOCKING_XACT_SECONDS})
     ORDER BY xact_start
  `) as unknown as { pid: number; state: string; xact_seconds: number; query: string }[];

  if (rows.length === 0) {
    record("blocking-xacts", "PASS", `no transaction older than ${BLOCKING_XACT_SECONDS}s`);
    return;
  }
  record(
    "blocking-xacts",
    "WARN",
    [
      `${rows.length} transaction(s) older than ${BLOCKING_XACT_SECONDS}s:`,
      ...rows.map((r) => `  pid ${r.pid} (${r.state}, ${r.xact_seconds}s): ${r.query}`),
    ],
    "Each can queue in front of 0034/0035/0037's locks. Clear them or re-check immediately before cutover.",
  );
}

/**
 * A schedule that has already missed its window before the upgrade will still
 * be wedged after it, and the cutover would get the blame. Establish it now.
 */
async function checkWedgedSchedules(db: Db, { record }: Checker): Promise<void> {
  if (!(await tableExists(db, "job_schedules"))) return;
  const rows = (await db`
    SELECT kind, cron, next_run_at,
           EXTRACT(EPOCH FROM (now() - next_run_at))::int / 60 AS minutes_late
      FROM job_schedules
     WHERE enabled
       AND next_run_at IS NOT NULL
       AND next_run_at < now() - make_interval(mins => ${WEDGED_SCHEDULE_WARN_MINUTES})
     ORDER BY next_run_at
  `) as unknown as { kind: string; cron: string; minutes_late: number }[];

  if (rows.length === 0) {
    record("wedged-schedules", "PASS", `no enabled schedule more than ${WEDGED_SCHEDULE_WARN_MINUTES}m late`);
    return;
  }
  record(
    "wedged-schedules",
    "WARN",
    [
      `${rows.length} enabled schedule(s) already late BEFORE the upgrade:`,
      ...rows.map((r) => `  ${r.kind} (${r.cron}) ${r.minutes_late}m late`),
    ],
    "Pre-existing, not caused by the cutover. Record it now so postflight does not misattribute it.",
  );
}

export async function runChecks(db: Db, checker: Checker): Promise<void> {
  await checkServerVersion(db, checker);
  const applied = await checkPendingMigrations(db, checker);
  await checkPriorRelease(db, checker, applied);
  await checkAppendOnlySafety(db, checker, applied);
  await checkCleanTargets(db, checker);
  await checkCatchupBaseline(db, checker);
  await checkWalletSamplesSize(db, checker);
  await checkBlockingActivity(db, checker);
  await checkWedgedSchedules(db, checker);
}

export async function main(overrideEnvPath?: string): Promise<number> {
  // --emit-receipt records this run as step P4.preflight-live for where.ts.
  // Opt-in, because runChecks is also called against a restored dump by
  // restore-check.ts (a DIFFERENT step, Gate C) and against the smoke-twin during a
  // rehearsal — a receipt claiming "live replica" must only be written by a run
  // that actually was one.
  const emit = process.argv.includes("--emit-receipt");
  const backupDir = process.argv.find((a) => a.startsWith("--backup-dir="))?.slice("--backup-dir=".length);
  return runPreflightMain({
    envPath: overrideEnvPath ?? envPath,
    name: "preflight-0.3.0",
    allowPrivilegedEnvVar: "PREFLIGHT_ALLOW_PRIVILEGED",
    runChecks,
    receipt: emit
      ? { step: "P4.preflight-live", repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, backupDir }
      : undefined,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[preflight-0.3.0] fatal: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 2;
    });
}

export { THIS_RELEASE_MIGRATIONS };
