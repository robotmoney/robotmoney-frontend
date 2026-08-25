// Direct PostgreSQL fixture for migration 0037. The suite preload has already
// applied every migration, so this file takes a clean database clone, removes
// only 0037's new objects, seeds the pre-0037 active-table shape, and executes
// the migration SQL verbatim inside the same transaction shape as migrate().
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { QUARANTINED_PROVENANCE } from "../src/chain/wallet-valuation.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "0037_aum_repairable_quarantine.sql",
);
const DAY = "2018-03-04";

test("0037 archives a mixed quarantine day losslessly and frees every active natural key on PostgreSQL 18", async () => {
  const [server] = await sql<{ major: number }[]>`
    SELECT current_setting('server_version_num')::int / 10000 AS major
  `;
  expect(server!.major).toBe(18);

  await sql.unsafe(`
    DROP TABLE wallet_balance_sample_evidence;
    DROP TABLE wallet_sleeve_sample_evidence;
    DROP FUNCTION rm_aum_evidence_guard();
  `);

  const balanceRows = await sql<{ id: string }[]>`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance,
       sampled_at, strategy_nav_idle_only)
    VALUES
      (${DAY}, 'WETH', ${"15.437800000000000001"}::numeric,
       ${"59988.420000000000000001"}::numeric,
       ${"926089.412676000000015438"}::numeric, ${QUARANTINED_PROVENANCE},
       '2018-03-04T23:58:57.123456Z', false),
      (${DAY}, 'USDC', NULL, NULL, ${"1000.000000000000000001"}::numeric,
       'live', '2018-03-04T23:59:58.654321Z', true)
    RETURNING id
  `;
  const sleeveRows = await sql<{ id: string }[]>`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd,
       provenance, sampled_at)
    VALUES
      (${DAY}, '0xaaa', 'WETH', ${"2.000000000000000003"}::numeric,
       ${"59988.420000000000000001"}::numeric,
       ${"119976.840000000000180002"}::numeric, ${QUARANTINED_PROVENANCE},
       '2018-03-04T23:58:57.123456Z'),
      (${DAY}, '0xbbb', 'USDC', ${"7.000000000000000007"}::numeric,
       ${"1.000000000000000001"}::numeric, NULL, 'seed',
       '2018-03-04T23:59:58.654321Z')
    RETURNING id
  `;

  const ddl = await readFile(migrationPath, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(ddl);
  });

  const [activeBalances] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${DAY}
  `;
  const [activeSleeves] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${DAY}
  `;
  expect(activeBalances!.n).toBe(0);
  expect(activeSleeves!.n).toBe(0);

  const archivedBalances = await sql<{
    original_id: string;
    symbol: string;
    amount: string | null;
    price_usd: string | null;
    value_usd: string;
    provenance: string;
    sampled_at: string;
    strategy_nav_idle_only: boolean | null;
    evidence_reason: string;
  }[]>`
    SELECT original_id, symbol, amount::text, price_usd::text, value_usd::text,
           provenance, sampled_at::text, strategy_nav_idle_only, evidence_reason
      FROM wallet_balance_sample_evidence
     WHERE sample_date = ${DAY}
     ORDER BY symbol
  `;
  expect([...archivedBalances]).toEqual([
    {
      original_id: balanceRows[1]!.id,
      symbol: "USDC",
      amount: null,
      price_usd: null,
      value_usd: "1000.000000000000000001",
      provenance: "live",
      sampled_at: "2018-03-04 23:59:58.654321+00",
      strategy_nav_idle_only: true,
      evidence_reason: "quarantine-cohort-partial",
    },
    {
      original_id: balanceRows[0]!.id,
      symbol: "WETH",
      amount: "15.437800000000000001",
      price_usd: "59988.420000000000000001",
      value_usd: "926089.412676000000015438",
      provenance: QUARANTINED_PROVENANCE,
      sampled_at: "2018-03-04 23:58:57.123456+00",
      strategy_nav_idle_only: false,
      evidence_reason: "quarantined-by-0036",
    },
  ]);

  const archivedSleeves = await sql<{
    original_id: string;
    wallet_address: string;
    symbol: string;
    amount: string | null;
    price_usd: string | null;
    value_usd: string | null;
    provenance: string;
    sampled_at: string;
    evidence_reason: string;
  }[]>`
    SELECT original_id, wallet_address, symbol, amount::text, price_usd::text,
           value_usd::text, provenance, sampled_at::text, evidence_reason
      FROM wallet_sleeve_sample_evidence
     WHERE sample_date = ${DAY}
     ORDER BY wallet_address
  `;
  expect([...archivedSleeves]).toEqual([
    {
      original_id: sleeveRows[0]!.id,
      wallet_address: "0xaaa",
      symbol: "WETH",
      amount: "2.000000000000000003",
      price_usd: "59988.420000000000000001",
      value_usd: "119976.840000000000180002",
      provenance: QUARANTINED_PROVENANCE,
      sampled_at: "2018-03-04 23:58:57.123456+00",
      evidence_reason: "quarantined-by-0036",
    },
    {
      original_id: sleeveRows[1]!.id,
      wallet_address: "0xbbb",
      symbol: "USDC",
      amount: "7.000000000000000007",
      price_usd: "1.000000000000000001",
      value_usd: null,
      provenance: "seed",
      sampled_at: "2018-03-04 23:59:58.654321+00",
      evidence_reason: "quarantine-cohort-partial",
    },
  ]);

  await sql`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${DAY}, 'WETH', 1, 2, 2, 'backfilled', now()),
      (${DAY}, 'USDC', 3, 1, 3, 'backfilled', now())
  `;
  await sql`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${DAY}, '0xaaa', 'WETH', 1, 2, 2, 'backfilled', now()),
      (${DAY}, '0xbbb', 'USDC', 3, 1, 3, 'backfilled', now())
  `;
  const [reusedBalanceKeys] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${DAY}
  `;
  const [reusedSleeveKeys] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${DAY}
  `;
  expect(reusedBalanceKeys!.n).toBe(2);
  expect(reusedSleeveKeys!.n).toBe(2);
});
