// V12-bankr-token-rows (PR 1383, issue 1382, migration 0124): the two Bankr
// "lp-fees" roster rows, which are ERC-20 tokens and not vaults, are inactive.
//
// Migration 0124 sets is_active = false on agent_vaults rows whose
// lower(vault_address) is one of the two addresses and whose strategy_type is
// 'lp-fees'. A database that never held the rows matches nothing, so the claim
// is exact: no row at either address is still active under that strategy. The
// addresses are the migration's own; a unit test reads that file and fails if
// they drift apart.
import type { VersionCheck } from "../../version-check.ts";

export const BANKR_TOKEN_ADDRESSES = Object.freeze([
  "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
  "0x7689006f6c3a3473449e42b628544e60d0bccb07",
]);

/** The one read-only query: the rows at the two addresses, and how many are still active. */
export const BANKR_ROWS_SQL = `SELECT
  count(*)::int AS rows,
  count(*) FILTER (WHERE is_active)::int AS active
FROM agent_vaults
WHERE strategy_type = 'lp-fees'
  AND lower(vault_address) IN (${BANKR_TOKEN_ADDRESSES.map((a) => `'${a}'`).join(", ")})`;

/** PURE. Why the Bankr token rows are not deactivated; empty when none is active. */
export function bankrTokenRowsProblems(counts: { rows: number; active: number }): string[] {
  return counts.active > 0
    ? [`${counts.active} of ${counts.rows} Bankr lp-fees token row(s) are still active: fetch_vaults reads them and logs a failed live read on every run`]
    : [];
}

export default (async (ctx) => {
  const db = await ctx.db();
  const [row] = await db.query<{ rows: number; active: number }>(BANKR_ROWS_SQL);
  const counts = { rows: Number(row?.rows ?? 0), active: Number(row?.active ?? 0) };
  return { found: { ...counts, claim: "no active lp-fees row at either Bankr token address (migration 0124 deactivates them; a database without the rows matches none)" }, problems: bankrTokenRowsProblems(counts) };
}) satisfies VersionCheck;
