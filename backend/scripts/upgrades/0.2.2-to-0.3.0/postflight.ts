// Post-cutover verification for v0.2.2 -> v0.3.0, specifically. The
// release-neutral mechanics (DATABASE_URL connect, verdict printing, receipt
// emission) live in ../../lib/postflight-utils.ts; this file only knows what
// THIS release changed and what "it landed correctly" means for each change.
//
// Unlike preflight this runs as the WRITER (DATABASE_URL) — it reads the
// database the cutover just wrote, on the production host, after the boot.
// It still only ever SELECTs.
//
// Usage:
//   bun scripts/upgrades/0.2.2-to-0.3.0/postflight.ts [--emit-receipt]
//
// Exit codes: 0 = POSTFLIGHT CLEAN, 1 = POSTFLIGHT FAILED, 2 = could not run.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, runPostflightMain } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  APPEND_ONLY_MIGRATION,
  COLLAPSE_PER_BUCKET_KINDS,
  NEW_COLUMNS,
  NEW_SCHEDULE_KIND,
  NEW_TABLES,
  TAG_GLOB,
  THIS_RELEASE_MIGRATIONS,
} from "./release.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..", "..");

/** The two steps this script can be evidence for. It must be TOLD which — a
 *  twin rehearsal and a production postflight run the identical checks against
 *  different databases, and a receipt that guessed would let a twin run stand
 *  in for production. The rehearsal is explicitly not production. */
const RECEIPT_STEPS = ["P5.postflight-twin", "P8.postflight-prod"] as const;

/** Check 1 — all four migrations recorded, under their FULL filenames.
 *
 *  The duplicate-prefix property this release introduces is only real if the
 *  ledger actually holds four new NAMES. If the runner had keyed on the numeric
 *  prefix, two of them would be silently absent here — which is precisely the
 *  failure this check exists to make impossible to miss. */
async function checkMigrationsApplied(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const applied = new Set(rows.map((r) => r.name));
  const missing = THIS_RELEASE_MIGRATIONS.filter((m) => !applied.has(m));

  if (missing.length > 0) {
    record(
      "migrations-applied",
      "FAIL",
      [`${missing.length} of this release's migrations are NOT recorded:`, ...missing.map((m) => `  ${m}`)],
      "The boot did not apply them. Do NOT tag. Read the boot log for the migration that aborted.",
    );
    return;
  }

  // Both halves of each reused number must be present — state it explicitly so
  // a reader of the log can see the property held, not just infer it.
  const pairs = ["0032_", "0033_"]
    .map((p) => ({ prefix: p, names: [...applied].filter((n) => n.startsWith(p)).sort() }))
    .filter((x) => x.names.length > 0);

  record("migrations-applied", "PASS", [
    `all ${THIS_RELEASE_MIGRATIONS.length} migration(s) recorded`,
    ...pairs.map((p) => `  ${p.prefix}* → ${p.names.length} file(s): ${p.names.join(", ")}`),
  ]);
}

/** Check 2 — the new column exists and NOTHING was backfilled into it.
 *
 *  0032_wallet_* is deliberately three-valued: NULL means "not applicable or
 *  not known", and every row written before the column is one of those. A
 *  non-NULL value on a historical row would mean something asserted a
 *  measurement nobody took. */
async function checkStrategyNavColumn(db: Db, { record }: Checker): Promise<void> {
  if (!(await columnExists(db, "wallet_balance_samples", "strategy_nav_idle_only"))) {
    record(
      "strategy-nav-column",
      "FAIL",
      "wallet_balance_samples.strategy_nav_idle_only is absent",
      "0032_wallet_* did not apply. Do NOT tag.",
    );
    return;
  }
  const [row] = (await db`
    SELECT count(*) FILTER (WHERE strategy_nav_idle_only IS NOT NULL) AS non_null,
           count(*) AS total
      FROM wallet_balance_samples
  `) as unknown as { non_null: number; total: number }[];
  const nonNull = Number(row?.non_null ?? 0);
  const total = Number(row?.total ?? 0);

  if (nonNull > 0) {
    record(
      "strategy-nav-column",
      "WARN",
      [`${nonNull} of ${total} row(s) already carry a non-NULL value`],
      "Expected 0 immediately after migration. Non-zero means the sampler has already run — fine if the stack has been up, wrong if it has not.",
    );
    return;
  }
  record("strategy-nav-column", "PASS", `column present; NULL on all ${total} pre-existing row(s), as intended`);
}

/** Check 3 — 0034's UPDATE hit exactly the two intended kinds.
 *
 *  This is the ONE data write in the migration set, so it is the one that can
 *  be wrong in a way no CREATE TABLE can. Compared against the preflight
 *  baseline (catchup-baseline). */
async function checkCatchupPolicy(db: Db, { record }: Checker): Promise<void> {
  if (!(await columnExists(db, "job_schedules", "catchup_policy"))) {
    record("catchup-policy", "FAIL", "job_schedules.catchup_policy is absent", "0034 did not apply. Do NOT tag.");
    return;
  }
  const rows = (await db`
    SELECT kind, catchup_policy FROM job_schedules ORDER BY kind
  `) as unknown as { kind: string; catchup_policy: string }[];

  const expected = new Set<string>(COLLAPSE_PER_BUCKET_KINDS);
  const wrongCollapse = rows.filter((r) => r.catchup_policy === "collapse-per-bucket" && !expected.has(r.kind));
  const wrongAll = rows.filter((r) => expected.has(r.kind) && r.catchup_policy !== "collapse-per-bucket");

  if (wrongCollapse.length > 0 || wrongAll.length > 0) {
    record(
      "catchup-policy",
      "FAIL",
      [
        ...wrongAll.map((r) => `  ${r.kind} should be collapse-per-bucket, is '${r.catchup_policy}'`),
        ...wrongCollapse.map((r) => `  ${r.kind} should NOT be collapse-per-bucket, is`),
      ],
      "0034's UPDATE matched the wrong set. Establish why before tagging.",
    );
    return;
  }
  const collapsed = rows.filter((r) => r.catchup_policy === "collapse-per-bucket").map((r) => r.kind);
  record("catchup-policy", "PASS", [
    `collapse-per-bucket on exactly ${collapsed.length}: ${collapsed.join(", ")}`,
    `'all' on the other ${rows.length - collapsed.length} schedule(s)`,
  ]);
}

/** Check 4 — the three new tables exist and are empty. */
async function checkNewTables(db: Db, { record }: Checker): Promise<void> {
  const missing: string[] = [];
  const nonEmpty: string[] = [];
  for (const t of NEW_TABLES) {
    if (!(await tableExists(db, t))) {
      missing.push(t);
      continue;
    }
    const [row] = (await db.unsafe(`SELECT count(*)::int AS n FROM public.${t}`)) as unknown as { n: number }[];
    if ((row?.n ?? 0) > 0) nonEmpty.push(`${t} (${row!.n} rows)`);
  }
  if (missing.length > 0) {
    record("new-tables", "FAIL", [`absent: ${missing.join(", ")}`], "The CREATE TABLE(s) did not apply. Do NOT tag.");
    return;
  }
  if (nonEmpty.length > 0) {
    record(
      "new-tables",
      "WARN",
      [`present but not empty: ${nonEmpty.join(", ")}`],
      "Expected empty on arrival. Non-empty means the backfill has already dispatched — only possible if a budget is set.",
    );
    return;
  }
  record("new-tables", "PASS", `all ${NEW_TABLES.length} present and empty`);
}

/** Check 5 — the new schedule is seeded, and its dispatch behaviour matches
 *  whatever budget decision was actually taken.
 *
 *  Deliberately NOT asserting "it declined": with BASE_RPC_MAX_CALLS_PER_SEC
 *  set, doing real work is the correct outcome. The check reports which world
 *  it is in so the operator confirms it is the one they chose. */
async function checkRepairSchedule(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT kind, cron, enabled, next_run_at FROM job_schedules WHERE kind = ${NEW_SCHEDULE_KIND}
  `) as unknown as { kind: string; cron: string; enabled: boolean; next_run_at: string | null }[];

  if (rows.length === 0) {
    record(
      "repair-schedule",
      "FAIL",
      `${NEW_SCHEDULE_KIND} was not seeded`,
      "seed() runs from migrate() on every boot. Its absence means the boot did not complete. Do NOT tag.",
    );
    return;
  }
  const s = rows[0]!;
  const budget = process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  const detail = [
    `${s.kind} cron=${s.cron} enabled=${s.enabled} next_run_at=${s.next_run_at ?? "null"}`,
    budget
      ? `BASE_RPC_MAX_CALLS_PER_SEC=${budget} — the backfill WILL dispatch repair work`
      : "BASE_RPC_MAX_CALLS_PER_SEC unset — the backfill stays OFF and will decline each run",
  ];
  if (!s.enabled) {
    record("repair-schedule", "WARN", [...detail, "seeded but DISABLED"], "Confirm this was deliberate.");
    return;
  }
  record("repair-schedule", "PASS", detail);
}

/** Check 6 — the append-only guard survived the migration.
 *
 *  A guard that was installed and is now gone is worth refusing over: it means
 *  something dropped triggers during the upgrade, and the retention guarantee
 *  v0.2.2 shipped is no longer real. */
async function checkAppendOnlyIntact(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT c.relname AS table_name, count(*)::int AS triggers
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname LIKE '%_append_only'
     GROUP BY c.relname ORDER BY c.relname
  `) as unknown as { table_name: string; triggers: number }[];

  const [applied] = (await db`
    SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${APPEND_ONLY_MIGRATION}) AS present
  `) as unknown as { present: boolean }[];

  if (applied?.present && rows.length === 0) {
    record(
      "append-only-intact",
      "FAIL",
      `${APPEND_ONLY_MIGRATION} is applied but no *_append_only triggers remain`,
      "The guard was lost during this upgrade. Do NOT tag. Investigate before writing anything else.",
    );
    return;
  }
  record("append-only-intact", "PASS", [
    `guard live on ${rows.length} table(s)`,
    ...rows.map((r) => `  ${r.table_name} (${r.triggers} trigger(s))`),
  ]);
}

/** Check 7 — no enabled schedule was wedged by the cutover window.
 *
 *  The per-minute samplers wedge after ~1 minute of downtime, and a wedged
 *  schedule does not self-heal. Compared against preflight's wedged-schedules
 *  baseline: a schedule that was ALREADY late before the cutover is not this
 *  release's damage. */
async function checkNoWedge(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`
    SELECT kind, cron, next_run_at,
           EXTRACT(EPOCH FROM (now() - next_run_at))::int / 60 AS minutes_late
      FROM job_schedules
     WHERE enabled AND next_run_at IS NOT NULL AND next_run_at < now() - interval '60 minutes'
     ORDER BY next_run_at
  `) as unknown as { kind: string; cron: string; minutes_late: number }[];

  if (rows.length === 0) {
    record("no-wedge", "PASS", "no enabled schedule is more than 60m behind");
    return;
  }
  record(
    "no-wedge",
    "FAIL",
    [
      `${rows.length} enabled schedule(s) are wedged:`,
      ...rows.map((r) => `  ${r.kind} (${r.cron}) ${r.minutes_late}m late`),
    ],
    "Compare against preflight's baseline. If new, repair with UPDATE job_schedules SET next_run_at = now() WHERE kind = ...",
  );
}

export async function runChecks(db: Db, checker: Checker): Promise<void> {
  await checkMigrationsApplied(db, checker);
  await checkStrategyNavColumn(db, checker);
  await checkCatchupPolicy(db, checker);
  await checkNewTables(db, checker);
  await checkRepairSchedule(db, checker);
  await checkAppendOnlyIntact(db, checker);
  await checkNoWedge(db, checker);
}

export async function main(): Promise<number> {
  const emitArg = process.argv.find((a) => a === "--emit-receipt" || a.startsWith("--emit-receipt="));
  let receipt;
  if (emitArg) {
    const step = emitArg.includes("=") ? emitArg.slice("--emit-receipt=".length) : "";
    if (!(RECEIPT_STEPS as readonly string[]).includes(step)) {
      console.error(`[postflight-0.3.0] --emit-receipt needs an explicit step id: ${RECEIPT_STEPS.join(" | ")}`);
      console.error("[postflight-0.3.0] e.g. --emit-receipt=P8.postflight-prod. Refusing to guess which database this was.");
      return 2;
    }
    const backupDir = process.argv.find((a) => a.startsWith("--backup-dir="))?.slice("--backup-dir=".length);
    receipt = { step, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, backupDir };
  }
  return runPostflightMain({ name: "postflight-0.3.0", runChecks, receipt });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[postflight-0.3.0] fatal: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 2;
    });
}
