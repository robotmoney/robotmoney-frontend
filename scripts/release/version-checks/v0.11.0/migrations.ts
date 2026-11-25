// Q39-migrations/C27-migrations (tracking issue 1754): the three migrations this release ships are applied and did what
// they declare. Read-only: the ledger and the catalog as rm_readonly.
//
//   0134_read_path_indexes (PR 1736, compat: additive): its six read-path indexes exist.
//   0135_drop_vintage_members_vintage_idx (PR 1740, compat: additive): analytics_vintage_members_vintage_idx is gone.
//   0136_regime_beside_snapshots (PR 1755, issue 1753, compat: additive): analytics_output_snapshots' artifact_kind
//     CHECK accepts `regime_beside_snapshots`, and the constraint is validated.
//
// WHAT IT REQUIRES: schema_migrations records each file, and the catalog shows each effect above.
import type { VersionCheck } from "../../version-check.ts";

export const MIGRATIONS = ["0134_read_path_indexes.sql", "0135_drop_vintage_members_vintage_idx.sql", "0136_regime_beside_snapshots.sql"] as const;
export const INDEXES_0134 = [
  "jobs_kind_id_idx",
  "job_runs_kind_started_idx",
  "source_value_versions_heads_idx",
  "source_value_versions_id_time_idx",
  "analytics_overwrite_events_id_time_idx",
  "analytics_vintage_members_vintage_id_idx",
] as const;
export const DROPPED_0135 = "analytics_vintage_members_vintage_idx";
export const CONSTRAINT_0136 = "analytics_output_snapshots_artifact_kind_check";

export interface MigrationsRead {
  readonly ledger: readonly string[];
  readonly indexes: readonly string[];
  /** pg_get_constraintdef of the artifact_kind CHECK, or null when it is absent. */
  readonly kindCheck: string | null;
  readonly kindCheckValidated: boolean;
}

/** PURE. Why the release's migrations are not in place; empty when they are. */
export function migrationsProblems(r: MigrationsRead): string[] {
  const out: string[] = [];
  for (const m of MIGRATIONS) if (!r.ledger.includes(m) && !r.ledger.includes(m.replace(/\.sql$/, ""))) out.push(`the ledger does not record ${m}`);
  for (const i of INDEXES_0134) if (!r.indexes.includes(i)) out.push(`index ${i} (0134_read_path_indexes) does not exist`);
  if (r.indexes.includes(DROPPED_0135)) out.push(`index ${DROPPED_0135} still exists (0135 drops it)`);
  if (r.kindCheck === null) out.push(`constraint ${CONSTRAINT_0136} does not exist`);
  else {
    if (!r.kindCheck.includes("regime_beside_snapshots")) out.push(`${CONSTRAINT_0136} does not accept regime_beside_snapshots: ${r.kindCheck}`);
    for (const k of ["regime_snapshots", "research_signals", "warnings", "logs", "exceptions"]) if (!r.kindCheck.includes(`'${k}'`)) out.push(`${CONSTRAINT_0136} no longer accepts ${k}`);
    if (!r.kindCheckValidated) out.push(`${CONSTRAINT_0136} is NOT VALID: 0136 validates it`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((x) => x.name);
  const indexes = (await db.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes WHERE indexname IN (${[...INDEXES_0134, DROPPED_0135].map((i) => `'${i}'`).join(", ")})`,
  )).map((x) => x.name);
  const [c] = await db.query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint WHERE conname = '${CONSTRAINT_0136}' AND conrelid = 'analytics_output_snapshots'::regclass`,
  );
  const read: MigrationsRead = { ledger, indexes, kindCheck: c?.def ?? null, kindCheckValidated: c?.validated === true };
  return {
    found: { recorded: MIGRATIONS.filter((m) => ledger.includes(m) || ledger.includes(m.replace(/\.sql$/, ""))), indexes, kindCheck: read.kindCheck, kindCheckValidated: read.kindCheckValidated },
    problems: migrationsProblems(read),
  };
}) satisfies VersionCheck;
