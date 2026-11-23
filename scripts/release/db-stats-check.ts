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
//     of their query text, apart from sessions of a managed-provider role.
//
// MANAGED-PROVIDER ROLES (issue 1720). DigitalOcean's managed Postgres keeps a
// `postgres` superuser session (application_name management-agent) whose query
// text no customer role may read, pg_read_all_stats included. Sessions of a role
// on the allowlist are excluded from the hidden count and listed in the receipt.
// The default is PROVIDER_ROLES; DB_STATS_PROVIDER_ROLES (comma-separated)
// replaces it.
//
// It writes db-stats-check.json to --receipt-dir. Reads only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the check reads. `statements` is null when pg_stat_statements could not be read. */
export interface DbStatsFound {
  readonly extension: boolean;
  readonly readAllStats: boolean;
  readonly statements: { readonly otherRoles: number; readonly hidden: number } | null;
  readonly statementsError: string | null;
  /** `hiddenRoles` holds the role of each other-role session whose query text is hidden. */
  readonly activity: { readonly otherRoles: number; readonly hiddenRoles: readonly string[] };
}

/** Managed-provider roles whose sessions no customer role may see (issue 1720). */
export const PROVIDER_ROLES: readonly string[] = Object.freeze(["postgres"]);

/** The allowlist: DB_STATS_PROVIDER_ROLES (comma-separated) when set, else {@link PROVIDER_ROLES}. */
export function providerRoles(env: Record<string, string | undefined> = process.env): readonly string[] {
  const raw = env.DB_STATS_PROVIDER_ROLES;
  if (raw === undefined) return PROVIDER_ROLES;
  return raw.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
}

/** PURE. Split hidden sessions into allowlisted (excluded) and counted ones. */
export function splitHidden(hiddenRoles: readonly string[], allow: readonly string[]): { excluded: string[]; counted: string[] } {
  const excluded = hiddenRoles.filter((r) => allow.includes(r));
  const counted = hiddenRoles.filter((r) => !allow.includes(r));
  return { excluded, counted };
}

/** What Postgres prints in place of a query a role may not see. */
const HIDDEN = "<insufficient privilege>";

/** PURE. Why the statistics are not in place; empty when they are. */
export function dbStatsProblems(found: DbStatsFound, allow: readonly string[] = PROVIDER_ROLES): string[] {
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
  const { counted } = splitHidden(found.activity.hiddenRoles, allow);
  if (counted.length > 0) {
    out.push(`pg_stat_activity hides ${counted.length} other-role session(s) from rm_readonly: ${[...new Set(counted)].sort().join(", ")}`);
  }
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
  const [activity] = await query<{ other: number | string; hidden_roles: string[] | null }>(
    `SELECT count(*) AS other,
            coalesce(array_agg(usename::text ORDER BY usename) FILTER (WHERE query IS NULL OR query = '${HIDDEN}'), '{}') AS hidden_roles
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
    activity: { otherRoles: Number(activity?.other ?? 0), hiddenRoles: activity?.hidden_roles ?? [] },
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
  const allow = providerRoles();
  const problems = dbStatsProblems(found, allow);
  const { excluded } = splitHidden(found.activity.hiddenRoles, allow);
  for (const role of excluded) console.log(`[db-stats-check] excluded hidden session of managed-provider role ${role}`);
  console.log(`[db-stats-check] ${db.target}: ${JSON.stringify(found)}`);
  for (const p of problems) console.error(`[db-stats-check] REFUSE: ${p}`);
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(receiptDir, "db-stats-check.json"),
      `${JSON.stringify({ step: "db-stats-check", target: db.target, at: new Date().toISOString(), found, providerRoles: allow, excluded: excluded.map((role) => ({ role })), problems }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(`[db-stats-check] ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
