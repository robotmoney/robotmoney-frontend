// scripts/release/db-read.ts — the read-only database session the release
// baseline (Q12-state-baseline/P07-state-baseline) and the comparison (Q30-compare-baseline/C18-compare-baseline) share.
//
// It connects as `rm_readonly` from `$HOME/.env` (scripts/lib/env-role.ts),
// sets the session read-only and PROVES it with `SHOW transaction_read_only`
// before the first query. D61 rule 3: every database read a runbook needs is a
// committed script, never a hand-typed psql line.
//
// It imports only node built-ins and env-role, because the Q07-host-identity/P02-host-identity precondition
// (./host-identity.ts) runs it before `bun install`.
import { homeEnvFilePath, loadEnvFile, redactedTarget, urlForRole } from "../lib/env-role.ts";

/** The R2.4 tables whose row counts are the postflight comparison baseline. */
export const BASELINE_TABLES: readonly string[] = Object.freeze([
  "swarm_sessions",
  "swarm_recommendations",
  "swarm_consensus_receipts",
  "swarm_session_judgements",
  "source_value_versions",
]);

export interface ReadOnlySession {
  readonly target: string;
  query<T = Record<string, unknown>>(text: string): Promise<T[]>;
  close(): Promise<void>;
}

/** The one statement runner {@link proveReadOnly} needs: SQL text in, rows out. */
export type ReadOnlyProbeQuery = (text: string) => Promise<readonly Record<string, unknown>[]>;

/**
 * Make the session read-only and PROVE it before anything else runs on it.
 * It sets the session default to READ ONLY, then asks `SHOW
 * transaction_read_only`. On any answer but `on` it closes the session and
 * throws, so the caller never gets a handle to query with. Exported so a test
 * can drive the refusal with a fake runner (issue 1765 storage S0).
 *
 * The session default is the first wall. The real wall is the role: rm_readonly
 * holds SELECT-only grants, so a write fails even if this default were lifted.
 */
export async function proveReadOnly(query: ReadOnlyProbeQuery, close: () => Promise<void>, target = "the session"): Promise<void> {
  await query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const ro = await query("SHOW transaction_read_only");
  if (ro[0]?.transaction_read_only !== "on") {
    await close();
    throw new Error(`the session to ${target} is not read-only; refusing to read`);
  }
}

/** Open the proven read-only session, or throw naming what is missing. */
export async function openReadOnly(env: Record<string, string | undefined> = process.env): Promise<ReadOnlySession> {
  const envPath = homeEnvFilePath(env.HOME);
  const file = loadEnvFile(envPath);
  const url = file ? urlForRole(file, "rm_readonly") : undefined;
  if (!url) throw new Error(`${envPath} lacks the connection (host, port, database, sslmode) or the rm_readonly line`);
  const sql = new Bun.SQL(url, { max: 1 });
  const target = redactedTarget(url, "rm_readonly");
  const query = async <T>(text: string): Promise<T[]> => (await sql.unsafe(text)) as T[];
  const close = () => sql.close();
  await proveReadOnly(query, close, target);
  return { target, query, close };
}

/** Row counts of the baseline tables; a table that does not exist reads null. */
export async function readCounts(db: ReadOnlySession): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const table of BASELINE_TABLES) {
    const exists = await db.query<{ t: string | null }>(`SELECT to_regclass('public.${table}')::text AS t`);
    if (!exists[0]?.t) { out[table] = null; continue; }
    const rows = await db.query<{ n: string | number }>(`SELECT count(*)::bigint AS n FROM public.${table}`);
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

export async function readDatabaseSize(db: ReadOnlySession): Promise<number> {
  const rows = await db.query<{ n: string | number }>("SELECT pg_database_size(current_database())::bigint AS n");
  return Number(rows[0]?.n ?? 0);
}
