#!/usr/bin/env bun
// scripts/release/db-stats-check.ts — query statistics are installed and
// rm_readonly can read all of them (issue 1581), run ON THE TARGET HOST by the
// template steps Q37a-db-stats (stage) and C25a-db-stats (production).
//
//   bun scripts/release/db-stats-check.ts [--receipt-dir <dir>]
//
// WHY. Production's slow queries were found by hand from pg_stat_user_tables;
// pg_stat_statements was available but not installed, and rm_readonly could
// see only its own rows in pg_stat_activity. `bun scripts/prod-init.ts
// role-passwords --doadmin-stdin` (backend/scripts/role-passwords.ts) now
// creates the extension and grants rm_readonly pg_read_all_stats, idempotently,
// as doadmin before the release (D61). This check proves the result after the
// deploy, as rm_readonly on the proven read-only session (./db-read.ts).
//
// It exits 0 only when:
//   * pg_extension lists pg_stat_statements;
//   * rm_readonly holds pg_read_all_stats's privileges;
//   * pg_stat_statements answers, holds rows of other roles, and hides none
//     of their query text;
//   * pg_stat_activity holds client sessions of other roles, and hides none
//     of their query text.
// It writes db-stats-check.json to --receipt-dir. Reads only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the check reads. `statements` is null when pg_stat_statements could not be read. */
export interface DbStatsFound {
  readonly extension: boolean;
  readonly readAllStats: boolean;
  readonly statements: { readonly otherRoles: number; readonly hidden: number } | null;
  readonly statementsError: string | null;
  readonly activity: { readonly otherRoles: number; readonly hidden: number };
}

/** What Postgres prints in place of a query a role may not see. */
const HIDDEN = "<insufficient privilege>";

/** PURE. Why the statistics are not in place; empty when they are. */
export function dbStatsProblems(found: DbStatsFound): string[] {
  const out: string[] = [];
  if (!found.extension) out.push("pg_extension does not list pg_stat_statements (run role-passwords as doadmin, D61)");
  if (!found.readAllStats) out.push("rm_readonly does not hold pg_read_all_stats (run role-passwords as doadmin, D61)");
  if (found.statements === null) {
    if (found.extension) out.push(`pg_stat_statements could not be read: ${found.statementsError ?? "unknown error"}`);
  } else {
    if (found.statements.otherRoles === 0) out.push("pg_stat_statements holds no row of another role");
    if (found.statements.hidden > 0) out.push(`pg_stat_statements hides ${found.statements.hidden} other-role row(s) from rm_readonly`);
  }
  if (found.activity.otherRoles === 0) out.push("pg_stat_activity holds no client session of another role");
  if (found.activity.hidden > 0) out.push(`pg_stat_activity hides ${found.activity.hidden} other-role session(s) from rm_readonly`);
  return out;
}

/** A read-only query runner: the release's db-read session, or a test's connection. */
export type Query = <T>(text: string) => Promise<T[]>;

/** Read what {@link dbStatsProblems} judges. */
export async function readDbStats(query: Query): Promise<DbStatsFound> {
  const [state] = await query<{ extension: boolean; read_all_stats: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS extension, " +
      "pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS read_all_stats",
  );
  let statements: DbStatsFound["statements"] = null;
  let statementsError: string | null = null;
  if (state?.extension) {
    try {
      const [row] = await query<{ other: number | string; hidden: number | string }>(
        `SELECT count(*) FILTER (WHERE userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS other,
                count(*) FILTER (WHERE userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user) AND (query IS NULL OR query = '${HIDDEN}')) AS hidden
           FROM pg_stat_statements`,
      );
      statements = { otherRoles: Number(row?.other ?? 0), hidden: Number(row?.hidden ?? 0) };
    } catch (error) {
      statementsError = error instanceof Error ? error.message : String(error);
    }
  }
  const [activity] = await query<{ other: number | string; hidden: number | string }>(
    `SELECT count(*) AS other, count(*) FILTER (WHERE query IS NULL OR query = '${HIDDEN}') AS hidden
       FROM pg_stat_activity
      WHERE usename IS NOT NULL AND usename <> current_user
        -- A session the reader may not see shows a NULL backend_type, so it counts too.
        AND (backend_type = 'client backend' OR backend_type IS NULL)`,
  );
  return {
    extension: state?.extension === true,
    readAllStats: state?.read_all_stats === true,
    statements,
    statementsError,
    activity: { otherRoles: Number(activity?.other ?? 0), hidden: Number(activity?.hidden ?? 0) },
  };
}

async function main(): Promise<number> {
  const at = process.argv.indexOf("--receipt-dir");
  const receiptDir = at >= 0 ? process.argv[at + 1] : undefined;
  const { openReadOnly } = await import("./db-read.ts");
  const db = await openReadOnly();
  let found: DbStatsFound;
  try {
    found = await readDbStats((text) => db.query(text));
  } finally {
    await db.close();
  }
  const problems = dbStatsProblems(found);
  console.log(`[db-stats-check] ${db.target}: ${JSON.stringify(found)}`);
  for (const p of problems) console.error(`[db-stats-check] REFUSE: ${p}`);
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(receiptDir, "db-stats-check.json"),
      `${JSON.stringify({ step: "db-stats-check", target: db.target, at: new Date().toISOString(), found, problems }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(`[db-stats-check] ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
