// Q44-fixture-guard/C30-fixture-guard (PR 1297, issue 1208): the projects fixture dataset never
// reaches a deployed database.
//
// The guard has three parts. The selector refuses the fixture on any deployed
// stack (#1244, then #1325: the fixture is reachable only through the armed
// test seam), PR 1297's import guard keeps fixture-source.ts out of every
// backend/src module, and migration 0118 purged the rows production had
// persisted. The deployed claim is therefore exact: the database holds no row
// with the fixture's synthetic identity. The check counts, read-only, the
// tracked wallets and vaults at a fixture address and the projects with a
// fixture slug and logo pair, whatever their status (a purge leaves none,
// active or not). The identities are migration 0118's own; a unit test reads
// that file and fails if they drift apart.
import type { VersionCheck } from "../../version-check.ts";

export const FIXTURE_WALLETS = Object.freeze([
  "0xwallet0000000000000000000000000000000aaa", "0xwallet0000000000000000000000000000000bbb",
  "0xwallet0000000000000000000000000000000ccc", "0xwallet0000000000000000000000000000000ddd",
]);
export const FIXTURE_VAULTS = Object.freeze(["0xvault0000000000000000000000000000000aaa", "0xvault0000000000000000000000000000000bbb"]);
export const FIXTURE_PROJECTS: ReadonlyArray<readonly [slug: string, logoUrl: string]> = Object.freeze([
  ["virtuals-protocol", "https://cdn.example/virtuals.png"],
  ["aixbt", "https://cdn.example/aixbt.png"],
  ["coinbase-x402-facilitator", "https://cdn.example/x402.png"],
  ["tokenless-no-activity", "https://cdn.example/noactivity.png"],
] as const);

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The one read-only query: the fixture rows still present, by kind. */
export const FIXTURE_COUNTS_SQL = `SELECT
  (SELECT count(*) FROM tracked_wallets WHERE lower(address) IN (${FIXTURE_WALLETS.map(lit).join(", ")}))::int AS wallets,
  (SELECT count(*) FROM agent_vaults WHERE lower(vault_address) IN (${FIXTURE_VAULTS.map(lit).join(", ")}))::int AS vaults,
  (SELECT count(*) FROM projects WHERE (slug, logo_url) IN (${FIXTURE_PROJECTS.map(([s, l]) => `(${lit(s)}, ${lit(l)})`).join(", ")}))::int AS projects`;

/** PURE. Every kind of fixture row a deployed database still holds. */
export function fixtureProblems(counts: { wallets: number; vaults: number; projects: number }): string[] {
  const out: string[] = [];
  if (counts.projects > 0) out.push(`${counts.projects} fixture project(s) (a fixture slug and logo pair) are in the database`);
  if (counts.wallets > 0) out.push(`${counts.wallets} tracked wallet(s) carry a fixture address`);
  if (counts.vaults > 0) out.push(`${counts.vaults} vault(s) carry a fixture address`);
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const [row] = await db.query<{ wallets: number; vaults: number; projects: number }>(FIXTURE_COUNTS_SQL);
  const counts = { wallets: Number(row?.wallets ?? 0), vaults: Number(row?.vaults ?? 0), projects: Number(row?.projects ?? 0) };
  return { found: { ...counts, claim: "no row with the fixture's synthetic identity, any status (selector guard, import guard, migration 0118's purge)" }, problems: fixtureProblems(counts) };
}) satisfies VersionCheck;
