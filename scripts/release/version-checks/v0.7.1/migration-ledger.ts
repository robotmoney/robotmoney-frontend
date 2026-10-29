// Q39-migration-ledger/C27-migration-ledger (migration 0128, PR 1533, review finding API-6): the
// migration ledger ends at the release's last migration with nothing pending, and 0128's capture of
// asset_prices overwrites is in place: the two triggers on asset_prices, enabled ALWAYS, and the
// analytics_overwrite_events table_name check admitting 'asset_prices', validated.
// The release's migrations are the files of backend/migrations in the checkout this runs in (the
// release commit, installed by Q06-checkout/P01-checkout); the ledger is `schema_migrations` and the
// rest is the system catalog, read on the proven read-only session. Reads only.
import { repoMigrations } from "../../ledger.ts";
import type { VersionCheck } from "../../version-check.ts";
import { ledgerEndProblems } from "../v0.7.0/migration-ledger.ts";

export const MIGRATION = "0128_asset_prices_overwrite_events.sql";
export const TRIGGERS = ["asset_prices_capture_overwrite", "asset_prices_capture_delete"] as const;
export const CONSTRAINT = "analytics_overwrite_events_table_name_check";

export interface Catalog {
  /** asset_prices' own triggers: name and pg_trigger.tgenabled ('A' is ENABLE ALWAYS). */
  readonly triggers: readonly { tgname: string; tgenabled: string }[];
  /** The table_name check: its definition and whether it is validated; absent when there is none. */
  readonly constraint?: { def: string; validated: boolean };
}

/** PURE. Why 0128's objects are not in place; empty when they are. */
export function captureProblems(ledger: readonly string[], catalog: Catalog): string[] {
  const out: string[] = [];
  if (!ledger.includes(MIGRATION)) out.push(`${MIGRATION} is not in schema_migrations`);
  for (const name of TRIGGERS) {
    const t = catalog.triggers.find((x) => x.tgname === name);
    if (!t) out.push(`asset_prices has no trigger ${name}`);
    else if (t.tgenabled !== "A") out.push(`trigger ${name} is enabled as ${JSON.stringify(t.tgenabled)}, not ALWAYS ("A"): a replica-mode session would skip the capture`);
  }
  if (!catalog.constraint) out.push(`analytics_overwrite_events has no ${CONSTRAINT}`);
  else {
    if (!catalog.constraint.def.includes("'asset_prices'")) out.push(`${CONSTRAINT} does not admit 'asset_prices': ${catalog.constraint.def}`);
    if (!catalog.constraint.validated) out.push(`${CONSTRAINT} is NOT VALID: 0128 validates it`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name COLLATE "C"')).map((r) => r.name);
  const triggers = await db.query<{ tgname: string; tgenabled: string }>(
    "SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgrelid = 'public.asset_prices'::regclass AND NOT tgisinternal ORDER BY tgname",
  );
  const [c] = await db.query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint WHERE conrelid = 'public.analytics_overwrite_events'::regclass AND conname = '${CONSTRAINT}'`,
  );
  const repo = repoMigrations();
  const catalog: Catalog = { triggers, ...(c ? { constraint: c } : {}) };
  return {
    found: { applied: ledger.length, repo: repo.length, lastApplied: ledger.at(-1) ?? null, lastInRelease: repo.at(-1) ?? null, triggers, constraint: c ?? null },
    problems: [...ledgerEndProblems(ledger, repo), ...captureProblems(ledger, catalog)],
  };
}) satisfies VersionCheck;
