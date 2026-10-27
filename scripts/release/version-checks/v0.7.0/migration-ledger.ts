// V04-migration-ledger (D75, migrations 0126 and 0127): the migration ledger
// ends at the release's last migration and nothing is pending. The release's
// migrations are the files of backend/migrations in the checkout this runs in
// (the release commit, installed by P01-checkout); the ledger is
// `schema_migrations` read on the proven read-only session.
// Reads only.
import { repoMigrations } from "../../ledger.ts";
import type { VersionCheck } from "../../version-check.ts";

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** PURE. Why the ledger does not end at the repository's last migration; empty when it does. */
export function ledgerEndProblems(ledger: readonly string[], repo: readonly string[]): string[] {
  const out: string[] = [];
  if (repo.length === 0) return ["backend/migrations holds no migration file: the checkout was not read"];
  const applied = new Set(ledger);
  const repoSet = new Set(repo);
  const pending = repo.filter((f) => !applied.has(f));
  if (pending.length > 0) out.push(`${pending.length} migration(s) pending: ${pending.join(", ")}`);
  const foreign = [...applied].filter((f) => !repoSet.has(f));
  if (foreign.length > 0) out.push(`the ledger records ${foreign.length} migration(s) this release does not have: ${foreign.join(", ")}`);
  const last = [...applied].sort(byteOrder).at(-1);
  const want = [...repo].sort(byteOrder).at(-1)!;
  if (last !== want) out.push(`the ledger ends at ${last ?? "(empty)"}, the release's last migration is ${want}`);
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name COLLATE "C"')).map((r) => r.name);
  const repo = repoMigrations();
  return { found: { applied: ledger.length, repo: repo.length, lastApplied: ledger.at(-1) ?? null, lastInRelease: repo.at(-1) ?? null }, problems: ledgerEndProblems(ledger, repo) };
}) satisfies VersionCheck;
