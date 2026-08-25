// Pre-upgrade dry run for v0.2.2 -> v0.3.0, specifically. The release-neutral
// mechanics (env loading, read-only connect + gate, verdict printing, receipt
// emission) live in ../../lib/preflight-utils.ts; this file only knows about
// the seven migrations THIS release ships and the checks specific to them.
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

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, runPreflightMain } from "../../lib/preflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  APPEND_ONLY_MIGRATION,
  COLLAPSE_PER_BUCKET_KINDS,
  MIGRATION_WRITTEN_TABLES,
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

/**
 * The reason the out-of-order warning above is tolerable.
 *
 * On a FRESH database the runner would apply `0032_append_only_history.sql`
 * before `0032_wallet_...` (`_append` sorts before `_wallet`), so the guard is
 * installed first. On THIS upgrade the guard is already installed, which is the
 * same relative order. Either way the new migrations run with the guard live —
 * so the only question that matters is whether any of them writes to a
 * protected table. None does, and this asserts it against the database's own
 * trigger catalog rather than against a list in a doc.
 */
async function checkAppendOnlySafety(db: Db, { record }: Checker, applied: Set<string>): Promise<void> {
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
  const protectedTables = new Set(rows.map((r) => r.table_name));

  if (protectedTables.size === 0) {
    record(
      "append-only-safety",
      "FAIL",
      `${APPEND_ONLY_MIGRATION} is recorded as applied but NO *_append_only triggers exist`,
      "The guard was installed and is now gone. Stop and establish why before writing anything.",
    );
    return;
  }

  // Every table a migration in this release actually WRITES, against the ones
  // the guard protects. This includes 0036/0037's active sleeve archive path,
  // not only DDL targets. Tables this release merely locks — `swarm_members`,
  // via 0035's foreign key — are excluded on purpose: the guard aborts a boot
  // on a write, and holding a lock is not a write. See MIGRATION_WRITTEN_TABLES.
  const written = [...MIGRATION_WRITTEN_TABLES];
  const collisions = written.filter((t) => protectedTables.has(t));
  if (collisions.length > 0) {
    record(
      "append-only-safety",
      "FAIL",
      [
        `${collisions.length} table(s) this release's migrations touch ARE append-only protected:`,
        ...collisions.map((t) => `  ${t}`),
      ],
      "A migration writing to a protected table will abort the whole boot. Re-read the migration set before proceeding.",
    );
    return;
  }

  record("append-only-safety", "PASS", [
    `guard live on ${protectedTables.size} table(s); none is written by this release`,
    `written: ${written.join(", ")}`,
  ]);
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
  // restore-check.ts (a DIFFERENT step, Gate C) and against the twin during a
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
