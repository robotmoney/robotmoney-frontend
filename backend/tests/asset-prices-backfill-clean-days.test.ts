// Backfill asset_prices for cleanly-sampled closed days (issue #927).
//
// This test verifies that the backfill function correctly populates asset_prices
// for days that have complete wallet_balance_samples/wallet_sleeve_samples but
// are missing asset_prices rows — the coverage gap described in
// docs/technical/markets-asset-pricing-ingest.md §8.1.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { backfillAssetPricesForCleanDays, lastClosedPriceDay } from "../src/ops/asset-prices.ts";
import { loadHistoricalPrices } from "../src/chain/historical-prices.ts";
import type { HistoricalPriceTable } from "../src/chain/historical-prices.ts";
import { resolveTrackedAssets, resolvePropWallets } from "../src/config.ts";
import type { ChainAmount, KeyedAssetRead } from "../src/chain/wallet-valuation.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const D1 = "2026-04-05";
const D2 = "2026-04-06";
const NOW = new Date("2026-04-07T09:00:00Z"); // D1 and D2 are closed
const BLOCK_TS = Math.floor(Date.parse(`${D1}T23:59:58Z`) / 1000);
const blockHash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const resolvedBlock = (date: string) => ({
  date,
  blockNumber: BLOCK,
  blockHash: blockHash(BLOCK),
  blockTimestampSec: BLOCK_TS,
  boundaryNextBlockNumber: BLOCK + 1,
  boundaryNextBlockHash: blockHash(BLOCK + 1),
  boundaryNextBlockTimestampSec: BLOCK_TS + 2,
  rpcCalls: 1,
  cached: false,
});

async function cleanup(): Promise<void> {
  await sql`DELETE FROM wallet_balance_samples`;
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`DELETE FROM wallet_backfill_state`;
  await sql`DELETE FROM chain_day_blocks`;
  await sql`DELETE FROM asset_prices`;
}

beforeEach(async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "10";
  await cleanup();
});
afterEach(async () => {
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  delete process.env.BASE_RPC_SOURCE;
  delete process.env.PRICE_SOURCE;
  await cleanup();
});

/** Deps that read a fixed amount for every leg and price everything at $2. */
function happyHistoricalDeps(): { loadPrices: (assets: any[], fromDate: string, toDate: string) => Promise<HistoricalPriceTable> } {
  return {
    async loadPrices(assets, fromDate, toDate) {
      const days: string[] = [];
      for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return new Map(assets.map((a) => [a.symbol, new Map(days.map((d) => [d, 2]))]));
    },
  };
}

test("backfillAssetPricesForCleanDays writes asset_prices for a complete clean day", async () => {
  // Insert a complete clean day in wallet_balance_samples and wallet_sleeve_samples
  const assets = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  const wallets = resolvePropWallets();

  // Write complete balance samples for D1
  for (const asset of assets) {
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${D1}, ${asset.symbol}, 5, 2, 10, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
    `;
  }

  // Write complete sleeve samples for D1
  for (let i = 0; i < 3; i++) {
    const wallet = wallets[i];
    const sleeveSymbols = i === 0
      ? ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"]
      : i === 1
      ? ["ZYFAI-SS1"]
      : ["GIZA-SS1"];
    for (const symbol of sleeveSymbols) {
      await sql`
        INSERT INTO wallet_sleeve_samples
          (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
        VALUES
          (${D1}, ${wallet}, ${symbol}, 5, 2, 10, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
      `;
    }
  }

  // Ensure asset_prices is empty for D1
  const before = await sql`SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${D1}`;
  expect(before[0]!.n).toBe(0);

  // Run the backfill with mock deps
  const result = await backfillAssetPricesForCleanDays(sql, NOW, happyHistoricalDeps());

  expect(result.daysProcessed).toBe(1);
  expect(result.rowsWritten).toBeGreaterThan(0);
  expect(result.errors.length).toBe(0);

  // Verify asset_prices rows were written
  const after = await sql<{ symbol: string; price_usd: string; currency: string; time_basis: string; source: string }[]>`
    SELECT symbol, price_usd::text, currency, time_basis, source
      FROM asset_prices WHERE price_date = ${D1} ORDER BY symbol
  `;
  expect(after.length).toBe(assets.length);

  const usdcPinned = new Set(["USDC", "ZYFAI-SS1", "GIZA-SS1"]);
  for (const row of after) {
    expect(row.currency).toBe("USD");
    expect(row.time_basis).toBe("utc-daily-close");
    expect(Number(row.price_usd)).toBe(2);
    expect(row.source).toBe(usdcPinned.has(row.symbol) ? "pinned" : "geckoterminal");
  }
});

test("backfillAssetPricesForCleanDays skips incomplete days", async () => {
  // Insert an INCOMPLETE day (missing some symbols)
  await sql`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${D1}, 'USDC', 5, 1, 5, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
  `;
  await sql`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${D1}, ${resolvePropWallets()[0]}, 'USDC', 5, 1, 5, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
  `;
  // Only one symbol — incomplete

  const result = await backfillAssetPricesForCleanDays(sql, NOW, happyHistoricalDeps());

  expect(result.daysProcessed).toBe(1);
  expect(result.rowsWritten).toBe(0);
  expect(result.rowsSkipped).toBeGreaterThan(0);

  // Verify asset_prices is still empty for D1
  const after = await sql`SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${D1}`;
  expect(after[0]!.n).toBe(0);
});

test("backfillAssetPricesForCleanDays skips quarantined days", async () => {
  // Insert a complete day but with quarantined provenance
  const assets = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  const wallets = resolvePropWallets();
  for (const asset of assets) {
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${D1}, ${asset.symbol}, 5, 2, 10, 'backfilled-quarantined', ${new Date(BLOCK_TS * 1000).toISOString()})
    `;
  }
  for (let i = 0; i < 3; i++) {
    const wallet = wallets[i];
    const sleeveSymbols = i === 0
      ? ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"]
      : i === 1
      ? ["ZYFAI-SS1"]
      : ["GIZA-SS1"];
    for (const symbol of sleeveSymbols) {
      await sql`
        INSERT INTO wallet_sleeve_samples
          (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
        VALUES
          (${D1}, ${wallet}, ${symbol}, 5, 2, 10, 'backfilled-quarantined', ${new Date(BLOCK_TS * 1000).toISOString()})
      `;
    }
  }

  const result = await backfillAssetPricesForCleanDays(sql, NOW, happyHistoricalDeps());

  // Quarantined days are excluded from candidateDays query entirely, so daysProcessed = 0
  expect(result.daysProcessed).toBe(0);
  expect(result.rowsWritten).toBe(0);
  expect(result.rowsSkipped).toBe(0);
});

test("backfillAssetPricesForCleanDays does not process today or future days", async () => {
  const today = NOW.toISOString().slice(0, 10); // Use NOW's date
  const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString().slice(0, 10);

  // Insert complete samples for today and tomorrow
  const assets = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  for (const date of [today, tomorrow]) {
    for (const asset of assets) {
      await sql`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
        VALUES
          (${date}, ${asset.symbol}, 5, 2, 10, 'live', now())
      `;
    }
  }

  const result = await backfillAssetPricesForCleanDays(sql, NOW, happyHistoricalDeps());

  // Should not process today or tomorrow (they're not closed)
  expect(result.daysProcessed).toBe(0);
});

test("backfillAssetPricesForCleanDays handles multiple days", async () => {
  // Insert complete clean days for D1 and D2
  const assets = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  const wallets = resolvePropWallets();

  for (const date of [D1, D2]) {
    for (const asset of assets) {
      await sql`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
        VALUES
          (${date}, ${asset.symbol}, 5, 2, 10, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
      `;
    }
    for (let i = 0; i < 3; i++) {
      const wallet = wallets[i];
      const sleeveSymbols = i === 0
        ? ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"]
        : i === 1
        ? ["ZYFAI-SS1"]
        : ["GIZA-SS1"];
      for (const symbol of sleeveSymbols) {
        await sql`
          INSERT INTO wallet_sleeve_samples
            (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
          VALUES
            (${date}, ${wallet}, ${symbol}, 5, 2, 10, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
        `;
      }
    }
  }

  // NOW is 2026-04-07, so cutoff is 2026-04-06. Only D1 (2026-04-05) is < cutoff.
  // D2 (2026-04-06) equals cutoff, so it's not processed.
  const result = await backfillAssetPricesForCleanDays(sql, NOW, happyHistoricalDeps());

  expect(result.daysProcessed).toBe(1);
  expect(result.rowsWritten).toBe(assets.length);
  expect(result.errors.length).toBe(0);

  // Verify D1 has asset_prices rows
  const rows = await sql`SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${D1}`;
  expect(rows[0]!.n).toBe(assets.length);
  // D2 should not have rows (not closed yet relative to cutoff)
  const rowsD2 = await sql`SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${D2}`;
  expect(rowsD2[0]!.n).toBe(0);
});