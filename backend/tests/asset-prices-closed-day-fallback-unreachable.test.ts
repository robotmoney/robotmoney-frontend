// AC3 (issue #927): "The three read sites' fallback-to-sample-row branches
// (wallet-balances.ts, wallet-sleeves.ts, wallet-valuation.ts) are removed
// once no longer needed, OR A TEST PROVES THEY ARE PROVABLY UNREACHABLE if
// left as defense-in-depth."
//
// Removing the branches outright is NOT safe: the retroactive backfill
// (ops.backfill_asset_prices) converges EXISTING history over successive
// scheduled runs, not instantly on deploy, so a huge share of pre-#927
// history still lacks an asset_prices row the moment this ships — removing
// the fallback would turn that into missing/null values across the UI until
// the backfill catches up, which is a worse regression than the coverage gap
// this issue exists to close. So this file proves the narrower, ACTUALLY TRUE
// claim instead: for any day EITHER sampler cleanly writes GOING FORWARD, the
// fallback's firing condition (a wallet_balance_samples/wallet_sleeve_samples
// row for a priced symbol with NO matching asset_prices row) can never occur,
// because writeAssetPrice runs in the SAME transaction as the sample-row
// insert, for every symbol that priced fresh this tick (see wallet.ts's
// isFreshThisTick gate) — atomically, not eventually.
//
// PR #946 review fix (RELIABILITY_CROSS_JOB_ATOMICITY_FALSE_INVARIANT): the
// original version of this file "proved" the sleeve-row claim only by calling
// sampleWalletBalances and sampleWalletSleeves back-to-back, synchronously, in
// one test body — a sequencing production never guarantees, since the two are
// separate, independently-scheduled jobs (wallet.sample_balances vs
// wallet.sample_sleeves in db/seed.ts, each its own transaction, no
// ordering/joint-success guarantee). That made the invariant true only in the
// test, not in production, where a tick could run the sleeve job without the
// balance job (or with the balance job's read for that symbol degraded) and
// leave a sleeve row with no covering asset_prices row. sampleWalletSleeves
// now performs its OWN dual-write (mirroring sampleWalletBalances' pattern),
// so each job is independently correct. The second test below proves exactly
// that: it calls sampleWalletSleeves ALONE, never sampleWalletBalances, for
// this tick.
//
// This is a WRITE-SIDE invariant, not a data-completeness assumption: it
// holds the instant this code ships, for every day it samples from then on.
// The fallback stays in the read sites as permanent defense-in-depth for two
// cases this test does NOT claim are unreachable: (1) pre-#927 history, which
// the scheduled backfill closes over time, and (2) a leg that degrades
// (price fetch fails) on a given tick — which correctly falls back to its
// last-known value, exactly as it always has; that is not the D41 coverage
// gap, it is the ordinary #173/#294 degrade path.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { sampleWalletBalances, sampleWalletSleeves } from "../src/worker/handlers/wallet.ts";
import { resolveTrackedAssets } from "../src/config.ts";
import { ASSET_PRICE_TIME_BASIS } from "../src/ops/asset-prices.ts";
import { _resetWalletBalancesCacheForTests } from "../src/chain/wallet-balances.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const ENV_KEYS = ["BASE_RPC_SOURCE", "PRICE_SOURCE"] as const;

beforeEach(async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  _resetWalletBalancesCacheForTests();
  await sql`DELETE FROM wallet_balance_samples`;
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`DELETE FROM asset_prices`;
});
afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await sql`DELETE FROM wallet_balance_samples`;
  await sql`DELETE FROM wallet_sleeve_samples`;
  await sql`DELETE FROM asset_prices`;
});

test("AC3: a cleanly-sampled day's balance rows can never trigger the closed-day fallback — every priced symbol gets a same-transaction asset_prices row", async () => {
  const { sampleDate } = (await sampleWalletBalances({})) as { sampleDate: string };

  // Sanity: the sampler really did write rows for priced symbols today —
  // otherwise every assertion below would be vacuously true.
  const pricedSymbols = resolveTrackedAssets()
    .filter((a) => a.priceKind !== "yahoo")
    .map((a) => a.symbol);
  const [sampleCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples
     WHERE sample_date = ${sampleDate} AND symbol = ANY(${pricedSymbols})
  `;
  expect(sampleCount!.n).toBeGreaterThan(0);

  // THE PROOF: no priced symbol's row for this date lacks a matching
  // asset_prices row. This is exactly loadHistory's/recentPersistedPrice's
  // fallback-firing condition (`is_closed && asset_price_usd == null`) —
  // proving it empty proves the fallback branch is unreachable for this day,
  // regardless of when in the future it is read as "closed".
  const uncovered = await sql<{ symbol: string }[]>`
    SELECT wbs.symbol
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
     WHERE wbs.sample_date = ${sampleDate}
       AND wbs.symbol = ANY(${pricedSymbols})
       AND ap.price_date IS NULL
  `;
  expect(uncovered.map((r) => r.symbol), "symbol(s) missing an asset_prices row for this clean sample: proves the fallback IS reachable").toEqual([]);
});

test("AC3: a cleanly-sampled day's sleeve rows can never trigger the closed-day fallback — sampleWalletSleeves dual-writes asset_prices ON ITS OWN, with no help from sampleWalletBalances that tick", async () => {
  // THE POINT OF THIS TEST: call ONLY sampleWalletSleeves. sampleWalletBalances
  // — a separate, independently-scheduled job in production — never runs in
  // this tick, so any asset_prices coverage found below can only have come
  // from sampleWalletSleeves' own dual-write, not from the balance leg's.
  const { sampleDate } = (await sampleWalletSleeves({})) as { sampleDate: string };

  // Sanity: sampleWalletBalances genuinely never ran this tick — otherwise
  // the proof below would be vacuous (covering rows could have come from it).
  const [balanceCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${sampleDate}
  `;
  expect(balanceCount!.n, "sampleWalletBalances must not have run for this test to prove anything").toBe(0);

  const [sleeveCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${sampleDate}
  `;
  expect(sleeveCount!.n).toBeGreaterThan(0);

  // THE PROOF: no sleeve row for this date lacks a matching asset_prices row
  // — computeWalletSleeves's fallback-firing condition is empty — even though
  // sampleWalletBalances never ran this tick. This is only true because
  // sampleWalletSleeves now performs its own writeAssetPrice dual-write in the
  // same transaction as its sample-row insert (PR #946's review fix for
  // RELIABILITY_CROSS_JOB_ATOMICITY_FALSE_INVARIANT), not because it is
  // riding on a sibling job's success.
  const uncovered = await sql<{ symbol: string }[]>`
    SELECT wss.symbol
      FROM wallet_sleeve_samples wss
      LEFT JOIN asset_prices ap
        ON ap.symbol = wss.symbol
       AND ap.price_date = wss.sample_date
       AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
     WHERE wss.sample_date = ${sampleDate}
       AND ap.price_date IS NULL
  `;
  expect(uncovered.map((r) => r.symbol), "symbol(s) missing an asset_prices row for this clean sample: proves the fallback IS reachable").toEqual([]);
});
