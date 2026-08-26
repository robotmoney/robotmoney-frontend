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
import parser from "cron-parser";
import { columnExists, tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { type Db, runPostflightMain } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  AUM_GUARD_TRIGGERS,
  APPEND_ONLY_MIGRATION,
  APPEND_ONLY_TABLES,
  BACKFILL_PROVENANCE,
  COLLAPSE_PER_BUCKET_KINDS,
  NEW_COLUMN_MIGRATION,
  NEW_COLUMNS,
  NEW_SCHEDULE_CRON,
  NEW_SCHEDULE_KIND,
  NEW_TABLES,
  TAG_GLOB,
  THIS_RELEASE_MIGRATIONS,
} from "./release.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..", "..");

/** The two steps this script can be evidence for. It must be TOLD which — a
 *  smoke-twin rehearsal and a production postflight run the identical checks against
 *  different databases, and a receipt that guessed would let a smoke-twin run stand
 *  in for production. The rehearsal is explicitly not production. */
const RECEIPT_STEPS = ["P5.postflight-smoke-twin", "P8.postflight-prod"] as const;

/** Check 1 — all seven migrations recorded, under their FULL filenames.
 *
 *  The duplicate-prefix property this release introduces is only real if the
 *  ledger actually holds seven new NAMES. If the runner had keyed on the numeric
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
    await migrationWallClock(db),
  ]);
}

/** §7's "time the migration set" requirement, answered from data instead of
 *  transcription.
 *
 *  `schema_migrations.applied_at` has been written since the ledger existed
 *  (src/db/migrate.ts) and read by NOTHING in this repo. The runner commits each
 *  file in its own transaction, so the spread across this release's rows is the
 *  migration set's wall-clock — the number §2.2 predicts as "well under a
 *  second" and §12's report asks for.
 *
 *  It is a LOWER bound: Postgres `now()` is transaction-start time, so the
 *  spread runs from the first migration's start to the last migration's start
 *  and omits the last one's own duration. Stated rather than rounded away. */
async function migrationWallClock(db: Db): Promise<string> {
  const [r] = (await db`
    SELECT EXTRACT(EPOCH FROM (max(applied_at) - min(applied_at)))::float8 AS spread_s,
           min(applied_at) AS first_at
      FROM schema_migrations
     WHERE name = ANY(${[...THIS_RELEASE_MIGRATIONS]})
  `) as unknown as { spread_s: number | null; first_at: string | null }[];

  if (!r || r.spread_s === null) return "  migration wall-clock: unavailable";
  return `  migration wall-clock: ${(r.spread_s * 1000).toFixed(0)}ms across ${THIS_RELEASE_MIGRATIONS.length} file(s), from ${r.first_at} (lower bound — excludes the last file's own duration)`;
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
  // Count only rows that PREDATE the migration.
  //
  // This check used to compare against absolute zero, and so could never pass
  // in the place it runs. postflight runs after readiness — G8 requires it, and
  // on production the stack is up by definition — so the per-minute sampler has
  // necessarily written at least one fresh row with the column populated, which
  // is correct behaviour. Every smoke-twin rehearsal therefore produced the same
  // WARN, and a warning that always fires is one an operator learns to skim.
  //
  // What the check actually cares about is that THE MIGRATION POPULATED
  // NOTHING: 0032_wallet_* is `ADD COLUMN` nullable with no default, so every
  // row untouched since it applied must still be NULL. Rows written or
  // re-upserted afterwards are the sampler (or a backfill) doing their job.
  // `wallet_balance_samples.sampled_at` vs `schema_migrations.applied_at` is the
  // boundary for LIVE-SAMPLED rows: sampled_at moves on upsert, so it asks
  // "untouched since the migration", not "old".
  //
  // ⚠ IT IS NOT A WRITE TIME FOR BACKFILLED ROWS, and this release is what makes
  // that reachable. ops/wallet-backfill.ts sets sampled_at to the repaired day's
  // BLOCK TIMESTAMP — a historical instant — so every row the gap repair writes
  // lands on the "untouched since the migration" side of this boundary no matter
  // when it was written. Today the check survives only because that INSERT does
  // not list strategy_nav_idle_only, leaving it NULL; the moment anything
  // backfills that column, a correct system would be told "something asserted a
  // measurement nobody took. Do NOT tag."
  //
  // So backfilled rows are excluded by provenance and reported separately. What
  // this check is actually about is rows the migration itself may have touched,
  // and the repair is not the migration.
  const [mig] = (await db`
    SELECT applied_at FROM schema_migrations WHERE name = ${NEW_COLUMN_MIGRATION}
  `) as unknown as { applied_at: string }[];

  if (!mig) {
    record(
      "strategy-nav-column",
      "FAIL",
      `the column exists but ${NEW_COLUMN_MIGRATION} is not in schema_migrations`,
      "The column arrived by some route other than this release's migration. Establish why before tagging.",
    );
    return;
  }

  const [row] = (await db`
    SELECT count(*) FILTER (WHERE strategy_nav_idle_only IS NOT NULL AND sampled_at < ${mig.applied_at}
                              AND provenance <> ${BACKFILL_PROVENANCE}) AS historical_non_null,
           count(*) FILTER (WHERE sampled_at < ${mig.applied_at}
                              AND provenance <> ${BACKFILL_PROVENANCE}) AS historical,
           count(*) FILTER (WHERE strategy_nav_idle_only IS NOT NULL) AS non_null,
           count(*) FILTER (WHERE provenance = ${BACKFILL_PROVENANCE}) AS backfilled,
           count(*) AS total
      FROM wallet_balance_samples
  `) as unknown as { historical_non_null: number; historical: number; non_null: number; backfilled: number; total: number }[];

  const historicalNonNull = Number(row?.historical_non_null ?? 0);
  const historical = Number(row?.historical ?? 0);
  const nonNull = Number(row?.non_null ?? 0);
  const backfilled = Number(row?.backfilled ?? 0);
  const total = Number(row?.total ?? 0);

  if (historicalNonNull > 0) {
    record(
      "strategy-nav-column",
      "FAIL",
      [
        `${historicalNonNull} of ${historical} row(s) untouched since ${NEW_COLUMN_MIGRATION} applied carry a non-NULL value`,
        "The column is three-valued: NULL means 'not applicable or not known', and every historical row is one of those.",
      ],
      "Something asserted a measurement nobody took. Do NOT tag until you know what wrote them.",
    );
    return;
  }
  record("strategy-nav-column", "PASS", [
    `column present; NULL on all ${historical} live-sampled row(s) untouched since the migration, as intended`,
    `${nonNull} of ${total} row(s) carry a value, all written after it — the sampler doing its job`,
    `${backfilled} row(s) carry provenance='${BACKFILL_PROVENANCE}' and are graded separately: the repair writes the`,
    "  repaired day's block timestamp into sampled_at, so they are not datable by that column",
  ]);
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

/** Check 4 — every new table/column exists; report whether migration/repair populated tables. */
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
  for (const { table, column } of NEW_COLUMNS) {
    if (!(await columnExists(db, table, column))) missing.push(`${table}.${column}`);
  }
  if (missing.length > 0) {
    record("new-tables", "FAIL", [`absent: ${missing.join(", ")}`], "The release schema did not apply completely. Do NOT tag.");
    return;
  }
  if (nonEmpty.length > 0) {
    record(
      "new-tables",
      "WARN",
      [`present but not empty: ${nonEmpty.join(", ")}`],
      "Non-empty operational tables mean repair already dispatched; non-empty evidence tables mean 0037 archived an rc-era quarantined cohort. Reconcile the reported counts before tagging.",
    );
    return;
  }
  record(
    "new-tables",
    "PASS",
    `all ${NEW_TABLES.length} table(s) present and empty; all ${NEW_COLUMNS.length} column(s) present`,
  );
}

/** Check 5 — the new schedule is seeded, and its dispatch behaviour matches
 *  whatever budget decision was actually taken.
 *
 *  Deliberately NOT asserting either outcome: dispatching real work is the
 *  DEFAULT and is correct, and a deployment that set BASE_RPC_MAX_CALLS_PER_SEC=0
 *  has chosen the other world on purpose. The check reports which one it is in
 *  so the operator confirms it is the one they chose. */
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
  // EXACTLY one row, because seed()'s ON CONFLICT key is (kind, cron): changing
  // this schedule's cron string INSERTS a second row rather than updating the
  // first, and both would be enabled. This check used to read rows[0]! and
  // grade one of them arbitrarily, so a duplicated schedule — dispatching the
  // same repair work twice against a metered RPC budget — looked identical to a
  // correct one.
  if (rows.length > 1) {
    record(
      "repair-schedule",
      "FAIL",
      [
        `${NEW_SCHEDULE_KIND} has ${rows.length} rows, not 1:`,
        ...rows.map((r) => `  cron=${r.cron} enabled=${r.enabled} next_run_at=${r.next_run_at ?? "null"}`),
      ],
      "seed()'s ON CONFLICT key is (kind, cron), so a cadence change leaves the old row behind. Disable or delete the superseded row before tagging — two enabled rows dispatch the same backfill twice.",
    );
    return;
  }
  const s = rows[0]!;

  // ASK THE DEPLOYMENT, DO NOT ASK THIS PROCESS.
  //
  // This used to read process.env.BASE_RPC_MAX_CALLS_PER_SEC and narrate what
  // the backfill "will" do. postflight runs in the operator's shell (or, on the
  // smoke-twin, spawned from the rehearsal host); the app reads that variable inside
  // the container, from the repo-root .env that docker-compose.yml interpolates.
  // Those are different environments. An operator taking §5.2's documented
  // opt-out by putting BASE_RPC_MAX_CALLS_PER_SEC=0 in .env — not exporting it —
  // got "PASS … the backfill WILL dispatch repair work" while production had the
  // headline feature switched off. It also disagreed with the app on the empty
  // string, which resolveRpcRateBudget() treats as unset (→ ON) and Number("")
  // makes 0 (→ reported OFF), and it could not see BASE_RPC_SOURCE at all.
  //
  // The deployment already reports this about itself: every ops.repair_gaps run
  // records whether it dispatched or declined, and why. That is an observation
  // rather than an inference, and it is what §9 check 5 claims to be making.
  const [lastRun] = (await db`
    SELECT status, output, finished_at
      FROM job_runs
     WHERE kind = ${NEW_SCHEDULE_KIND} AND finished_at IS NOT NULL
     ORDER BY id DESC LIMIT 1
  `) as unknown as { status: string; output: Record<string, unknown> | null; finished_at: string }[];

  const detail = [`${s.kind} cron=${s.cron} enabled=${s.enabled} next_run_at=${s.next_run_at ?? "null"}`];

  if (s.cron !== NEW_SCHEDULE_CRON) {
    record(
      "repair-schedule",
      "FAIL",
      [...detail, `cron is '${s.cron}', expected '${NEW_SCHEDULE_CRON}' (release.ts)`],
      "seed()'s ON CONFLICT key is (kind, cron), so a changed cadence INSERTs a second row rather than updating this one. Do NOT tag.",
    );
    return;
  }

  if (!lastRun) {
    detail.push("no ops.repair_gaps run has finished yet — cannot say whether it dispatches or declines");
  } else {
    const out = (lastRun.output ?? {}) as Record<string, unknown>;
    const dispatched = (out.dispatched ?? {}) as { enqueued?: number; classC?: string[] };
    if (out.status === "skipped") {
      detail.push(`last run DECLINED to dispatch: ${String(out.reason ?? "no reason given")}`);
      detail.push("That is the BASE_RPC_MAX_CALLS_PER_SEC=0 opt-out (§5.2). Confirm it is the world you chose.");
    } else if (lastRun.status !== "succeeded") {
      detail.push(`last run finished status='${lastRun.status}' — see job_runs.error`);
    } else {
      detail.push(
        `last run dispatched ${String(dispatched.enqueued ?? 0)} window job(s) covering ${String((dispatched.classC ?? []).length)} day(s), ` +
          `${String(out.totalMissingDays ?? "?")} day(s) missing in total`,
      );
    }
  }
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
export async function checkAppendOnlyIntact(db: Db, { record }: Checker): Promise<void> {
  // `LIKE '%_append_only%'`, not `LIKE '%_append_only'`: append-only-guard.ts
  // installs TWO triggers per table — `<table>_append_only` (statement) and
  // `<table>_append_only_row`. The old anchored pattern matched only the
  // statement trigger, so this check reported "1 trigger(s)" for every table
  // and could not see a row-level trigger that had been dropped on its own.
  const rows = (await db`
    SELECT c.relname AS table_name,
           count(*)::int AS triggers,
           count(*) FILTER (WHERE t.tgenabled = 'D')::int AS disabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname LIKE '%\_append\_only%'
     GROUP BY c.relname ORDER BY c.relname
  `) as unknown as { table_name: string; triggers: number; disabled: number }[];

  const [applied] = (await db`
    SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${APPEND_ONLY_MIGRATION}) AS present
  `) as unknown as { present: boolean }[];

  // Compare against the roster the guard itself declares, not against zero.
  // Before this, ANY non-empty result PASSed: losing thirteen of the fourteen
  // tables reported "guard live on 1 table(s)" and read as green. The whole
  // point of the check is that a guard silently lost is the §11.1 failure mode,
  // and "silently lost" is exactly what a partial loss is.
  const present = new Map(rows.map((r) => [r.table_name, r]));
  const missing = APPEND_ONLY_TABLES.filter((t) => !present.has(t));

  // TWO triggers per table, both ENABLED — not "at least one, in any state".
  //
  // The roster comparison above fixed a check that passed on ANY non-empty
  // result; it left two holes of exactly the same shape. The guard installs a
  // statement-level and a row-level trigger per table
  // (src/db/append-only-guard.ts, and append-only-guard-check.test.ts:102 asserts
  // TABLES * 2), so dropping every row-level trigger left "guard live on 1
  // trigger(s)" reading green. And `ALTER TABLE ... DISABLE TRIGGER` leaves the
  // pg_trigger row in place with tgenabled='D', so an inert guard was
  // indistinguishable from a live one. A guard silently lost is the §11.1
  // failure mode whether it was dropped or merely switched off.
  const EXPECTED_TRIGGERS = 2;
  const partial = APPEND_ONLY_TABLES.filter((t) => {
    const r = present.get(t);
    return r !== undefined && r.triggers !== EXPECTED_TRIGGERS;
  });
  const disabled = APPEND_ONLY_TABLES.filter((t) => (present.get(t)?.disabled ?? 0) > 0);

  const aumTables = [...new Set(AUM_GUARD_TRIGGERS.map((guard) => guard.table))];
  const aumRows = (await db`
    SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND c.relname = ANY(${aumTables})
  `) as unknown as { table_name: string; trigger_name: string; tgenabled: string }[];
  const aumPresent = new Map(aumRows.map((row) => [`${row.table_name}.${row.trigger_name}`, row.tgenabled]));
  const missingAum = AUM_GUARD_TRIGGERS.filter(
    (guard) => !aumPresent.has(`${guard.table}.${guard.trigger}`),
  );
  const bypassableAum = AUM_GUARD_TRIGGERS.filter((guard) => {
    const mode = aumPresent.get(`${guard.table}.${guard.trigger}`);
    return mode !== undefined && mode !== "A";
  });

  if (!applied?.present || missing.length > 0 || partial.length > 0 || disabled.length > 0
    || missingAum.length > 0 || bypassableAum.length > 0) {
    record(
      "append-only-intact",
      "FAIL",
      [
        `${APPEND_ONLY_MIGRATION} applied: ${applied?.present === true}`,
        `shared guard inventory (${APPEND_ONLY_TABLES.length} protected table(s)):`,
        ...missing.map((t) => `  ${t} — NO append-only trigger at all`),
        ...partial.map((t) => `  ${t} — ${present.get(t)!.triggers} trigger(s), expected ${EXPECTED_TRIGGERS}`),
        ...disabled.map((t) => `  ${t} — ${present.get(t)!.disabled} trigger(s) DISABLED (tgenabled='D'), so the guard is inert`),
        `AUM guard inventory (${AUM_GUARD_TRIGGERS.length} exact trigger(s)):`,
        ...missingAum.map((guard) => `  ${guard.table}.${guard.trigger} — MISSING`),
        ...bypassableAum.map((guard) =>
          `  ${guard.table}.${guard.trigger} — tgenabled='${aumPresent.get(`${guard.table}.${guard.trigger}`)}', expected 'A' (ENABLE ALWAYS)`,
        ),
      ],
      "A shared or AUM-specific guard was lost, disabled, or left replication-bypassable. Do NOT tag.",
    );
    return;
  }

  record("append-only-intact", "PASS", [
    `guard live on all ${APPEND_ONLY_TABLES.length} protected table(s), ${EXPECTED_TRIGGERS} enabled trigger(s) each`,
    `all ${AUM_GUARD_TRIGGERS.length} P0/P1 AUM trigger(s) present and ENABLE ALWAYS`,
    ...rows.map((r) => `  ${r.table_name} (${r.triggers} trigger(s))`),
  ]);
}

/** Check 7 — no enabled schedule was wedged by the cutover window.
 *
 *  The per-minute samplers wedge after ~1 minute of downtime, and a wedged
 *  schedule does not self-heal. Compared against preflight's wedged-schedules
 *  baseline: a schedule that was ALREADY late before the cutover is not this
 *  release's damage.
 *
 *  THE THRESHOLD IS PER-CADENCE, and that is the whole point. This check used a
 *  flat `interval '60 minutes'` for every row, while its own premise — and §8's
 *  cutover budget — is that `wallet.sample_balances` and `wallet.sample_sleeves`
 *  wedge after about ONE minute. A forty-minute cutover therefore wedged both
 *  per-minute samplers and this check still returned PASS: sixty times wider
 *  than the failure it exists to catch. A schedule is late here when it has
 *  missed more than one of its OWN slots, plus a small grace for the scheduler's
 *  30s tick (worker/runtime.ts). */
export const WEDGE_GRACE_MS = 90_000;

/** How long one cadence of `cron` is, in ms, from two consecutive occurrences.
 *  Returns null for an expression cron-parser rejects — an unparseable cron is
 *  reported rather than silently given an arbitrary threshold. */
export function cadenceMs(cron: string, timezone: string): number | null {
  try {
    const it = parser.parseExpression(cron, { tz: timezone, currentDate: new Date() });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b > a ? b - a : null;
  } catch {
    return null;
  }
}

async function checkNoWedge(db: Db, { record }: Checker): Promise<void> {
  // A NULL next_run_at on an ENABLED schedule is a wedge, not a healthy row.
  // worker/scheduler.ts seeds next_run_at on its FIRST tick, so NULL means the
  // scheduler has never ticked for that row since it was created. The late-row
  // query below cannot see that — `next_run_at < now()` excludes NULL — and
  // check 5 only printed the value without grading it, so a completely dead
  // scheduler loop passed both. That is the one condition this check exists to
  // catch, arriving by the one route it could not observe.
  const never = (await db`
    SELECT kind, cron FROM job_schedules WHERE enabled AND next_run_at IS NULL ORDER BY kind
  `) as unknown as { kind: string; cron: string }[];

  if (never.length > 0) {
    record(
      "no-wedge",
      "FAIL",
      [
        `${never.length} enabled schedule(s) have never been picked up by the scheduler (next_run_at IS NULL):`,
        ...never.map((r) => `  ${r.kind} (${r.cron})`),
      ],
      "worker/scheduler.ts seeds next_run_at on its first tick, so NULL means it has not ticked. Check the worker is running before tagging.",
    );
    return;
  }

  const rows = (await db`
    SELECT kind, cron, timezone, next_run_at,
           EXTRACT(EPOCH FROM (now() - next_run_at))::int AS seconds_late
      FROM job_schedules
     WHERE enabled AND next_run_at IS NOT NULL AND next_run_at < now()
     ORDER BY next_run_at
  `) as unknown as { kind: string; cron: string; timezone: string; seconds_late: number }[];

  const wedged: string[] = [];
  const unparseable: string[] = [];
  for (const r of rows) {
    const cadence = cadenceMs(r.cron, r.timezone);
    if (cadence === null) {
      unparseable.push(`  ${r.kind} (${r.cron}) — cron not parseable, ${r.seconds_late}s late`);
      continue;
    }
    const budgetMs = cadence + WEDGE_GRACE_MS;
    if (r.seconds_late * 1000 > budgetMs) {
      wedged.push(
        `  ${r.kind} (${r.cron}) ${r.seconds_late}s late — more than one ${Math.round(cadence / 1000)}s cadence behind`,
      );
    }
  }

  if (wedged.length === 0 && unparseable.length === 0) {
    record("no-wedge", "PASS", `no enabled schedule is more than one of its own cadences behind (${rows.length} due)`);
    return;
  }
  if (wedged.length === 0) {
    record("no-wedge", "WARN", ["every due schedule is within cadence, but:", ...unparseable], "Check the cron syntax.");
    return;
  }
  record(
    "no-wedge",
    "FAIL",
    [`${wedged.length} enabled schedule(s) are wedged:`, ...wedged, ...unparseable],
    // NOT `next_run_at = now()`: scheduler.ts anchors its cron iterator at
    // next_run_at - 1s and breaks on the first FUTURE slot, so setting it to
    // now() enqueues nothing at all and the schedule simply resumes at its next
    // slot — up to a full cadence away, with the missed backlog dropped. To
    // fire immediately, set it back past a slot that has already passed.
    "Compare against preflight's baseline. If new, repair with UPDATE job_schedules SET next_run_at = now() - <one cadence> WHERE kind = ... — which resumes AND replays the missed slots. Setting it to now() only resumes at the next slot and discards the backlog.",
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
