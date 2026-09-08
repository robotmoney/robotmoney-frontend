// Direct PostgreSQL fixture for migration 0046 (issue #849; docs/decisions.md
// D41 phase 1). The suite preload has already applied every migration
// (against empty sample tables, so the seed step ran over zero rows). This
// file takes a clean database clone, removes only 0046's new objects, seeds
// the PRE-migration sample-table shape a real deployment would have
// accumulated, and executes the migration SQL verbatim inside the same
// transaction shape as migrate() — the same pattern
// aum-repairable-quarantine-migration.test.ts uses for 0037.
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
  "0046_asset_prices.sql",
);

// Deliberately far outside the real series window so these fixtures cannot
// collide with any other suite's date-keyed assertions on the shared template.
const D_MAJORITY = "2018-01-01"; // balance + one agreeing sleeve outvote a lone dissenter
const D_TIE = "2018-01-02"; // balance vs. one dissenting sleeve, equal votes — balance wins
const D_QUARANTINE = "2018-01-03"; // only a quarantined row exists — seeded nowhere
const D_SP500 = "2018-01-04"; // SP500 is never part of the price series

async function runMigration(): Promise<void> {
  await sql.unsafe(`
    DROP TABLE asset_prices;
    DROP TABLE asset_price_floors;
  `);
  const ddl = await readFile(migrationPath, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(ddl);
  });
}

test("0046 seeds asset_prices from live/seed provenance with an explicit, deterministic conflict rule", async () => {
  // Majority rule: balance (100) + one agreeing sleeve (100) outvote a lone
  // dissenting sleeve (200).
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D_MAJORITY}, 'WETH', 1, 100, 100, 'live', '2018-01-01T23:59:00Z')
  `;
  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${D_MAJORITY}, '0xaaa', 'WETH', 1, 100, 100, 'live', '2018-01-01T23:59:01Z'),
      (${D_MAJORITY}, '0xbbb', 'WETH', 1, 200, 200, 'live', '2018-01-01T23:59:02Z')
  `;

  // Tie-break rule: one balance row, one dissenting sleeve row — equal votes,
  // resolved toward the aggregate balance value.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D_TIE}, 'ROBOTMONEY', 1, 5, 5, 'seed', '2018-01-02T23:59:00Z')
  `;
  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D_TIE}, '0xaaa', 'ROBOTMONEY', 1, 6, 6, 'seed', '2018-01-02T23:59:01Z')
  `;

  // Quarantined rows are precisely the ones whose price describes a different
  // asset (migration 0036) — never seeded, even alone.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D_QUARANTINE}, 'WETH', 1, 999, 999, ${QUARANTINED_PROVENANCE}, '2018-01-03T23:59:00Z')
  `;

  // SP500 is never part of the price series (config-valued, no vendor read),
  // regardless of provenance.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, value_usd, price_usd, provenance, sampled_at)
    VALUES (${D_SP500}, 'SP500', NULL, 3000, 3000, 'live', '2018-01-04T23:59:00Z')
  `;

  // USDC is priced $1, tagged 'pinned' rather than 'geckoterminal'.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D_MAJORITY}, 'USDC', 10, 1, 10, 'live', '2018-01-01T23:59:00Z')
  `;

  await runMigration();

  const rows = await sql<{ price_date: string; symbol: string; price_usd: string; source: string; currency: string; time_basis: string }[]>`
    SELECT price_date::text, symbol, price_usd::text, source, currency, time_basis
      FROM asset_prices
     WHERE price_date IN (${D_MAJORITY}, ${D_TIE}, ${D_QUARANTINE}, ${D_SP500})
     ORDER BY price_date, symbol
  `;

  expect([...rows]).toEqual([
    { price_date: D_MAJORITY, symbol: "USDC", price_usd: "1", source: "pinned", currency: "USD", time_basis: "utc-daily-close" },
    { price_date: D_MAJORITY, symbol: "WETH", price_usd: "100", source: "geckoterminal", currency: "USD", time_basis: "utc-daily-close" },
    { price_date: D_TIE, symbol: "ROBOTMONEY", price_usd: "5", source: "geckoterminal", currency: "USD", time_basis: "utc-daily-close" },
  ]);

  // Neither the quarantined day nor SP500 (any day) ever appears.
  const [quarantineCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${D_QUARANTINE}
  `;
  expect(quarantineCount!.n).toBe(0);
  const [sp500Count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM asset_prices WHERE symbol = 'SP500'
  `;
  expect(sp500Count!.n).toBe(0);
});

test("0046 excludes the still-open UTC day's live row from the seed, but seeds a prior day's", async () => {
  // Real dates (not the 2018 fixtures above) are required here: the migration
  // filters on `sample_date < (now() AT TIME ZONE 'UTC')::date`, so the whole
  // point of this test is to exercise "today" as Postgres sees it right now.
  // Safe from collision with any other suite because useCleanDatabase() gives
  // this file its own cloned database (tests/support/clean-db.ts).
  const [{ today, yesterday }] = await sql<{ today: string; yesterday: string }[]>`
    SELECT (now() AT TIME ZONE 'UTC')::date::text AS today,
           ((now() AT TIME ZONE 'UTC')::date - 1)::text AS yesterday
  `;

  // The wallet balance sampler runs hourly and continuously upserts a `live`
  // row for the still-open day — this is that row, and it must NOT be
  // seeded as a fabricated 'utc-daily-close'.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${today}, 'WETH', 1, 111, 111, 'live', now())
  `;
  // A prior day that has actually closed IS seeded, same as the 2018 fixtures.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${yesterday}, 'WETH', 1, 222, 222, 'live', ${yesterday + "T23:59:00Z"})
  `;

  await runMigration();

  const rows = await sql<{ price_date: string }[]>`
    SELECT price_date::text FROM asset_prices WHERE symbol = 'WETH' AND price_date IN (${today}, ${yesterday})
  `;
  expect([...rows]).toEqual([{ price_date: yesterday }]);
});

test("0046 seeds a proven floor for the three usdc-pinned assets, not for gecko-priced ones", async () => {
  await runMigration();
  const floors = await sql<{ symbol: string; first_priceable_date: string; proven: boolean }[]>`
    SELECT symbol, first_priceable_date::text, proven FROM asset_price_floors ORDER BY symbol
  `;
  expect([...floors]).toEqual([
    { symbol: "GIZA-SS1", first_priceable_date: "2026-03-18", proven: true },
    { symbol: "USDC", first_priceable_date: "2026-03-18", proven: true },
    { symbol: "ZYFAI-SS1", first_priceable_date: "2026-03-18", proven: true },
  ]);
});
