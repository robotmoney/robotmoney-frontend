// D41 phase 3 — the read path switches to a join against `asset_prices` for a
// CLOSED day, across the three sites §5.6/decisions.md D41 names: chain/
// wallet-balances.ts (loadHistory), chain/wallet-sleeves.ts (computeWalletSleeves),
// and recentPersistedPrice in chain/wallet-valuation.ts (issue #850;
// docs/decisions.md D41; docs/technical/markets-asset-pricing-ingest.md §5.6).
//
// Every fixture here is deliberately built so `wallet_balance_samples`/
// `wallet_sleeve_samples`.price_usd and `asset_prices.price_usd` are the EXACT
// same JS double (never merely "close") — that is what the dual-write/seed
// step guarantees in real operation (ops/asset-prices.ts::writeAssetPrice,
// migration 0046's seed step), and it is the premise the "byte-identical
// across the switch" acceptance criterion depends on: this suite would not
// catch a read path that used SQL-side `numeric` arithmetic instead of JS-side
// `Number(...) * Number(...)`, because that only surfaces on values with more
// decimal digits than IEEE-754 can round-trip through `numeric` unchanged.
//
// RED CONTROL: before this issue, none of the three sites below joined
// `asset_prices` at all — every test that plants a DISAGREEING asset_prices
// row and expects it to win (or to be ignored for "today") fails against the
// pre-cutover tree, which reads `price_usd` off the sample row unconditionally.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { resolvePropWallets, resolveTrackedAssets } from "../src/config.ts";
import {
  fetchPersistedWalletBalances,
  _resetWalletBalancesCacheForTests,
} from "../src/chain/wallet-balances.ts";
import {
  getWalletSleeves,
  _resetWalletSleevesCacheForTests,
} from "../src/chain/wallet-sleeves.ts";
import { persistedFallbackWalletPriceReader } from "../src/chain/wallet-valuation.ts";
import { ASSET_PRICE_TIME_BASIS } from "../src/ops/asset-prices.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// This file's last test permanently attaches a wallet_balance_samples row to a
// published wallet_aum_snapshot_runs header — migration 0038's finalize guard
// makes that row (and, worse, ANY blanket `DELETE FROM wallet_balance_samples`
// that happens to sweep over it) permanently un-deletable. Sharing the
// suite-wide database the way most test files do would leave that row behind
// for every OTHER file's unfiltered cleanup DELETE to trip over — exactly the
// failure this suite's tests/support/clean-db.ts was built to design out
// (see its header comment). A clean per-file database is the correct fix, not
// a narrower DELETE in cleanup(): the row is deliberately immutable.
useCleanDatabase(import.meta.file);

const realFetch = globalThis.fetch;

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

async function cleanup(): Promise<void> {
  // wallet_balance_samples rows carrying a snapshot_run_id are immutable
  // (migration 0038's finalize guard blocks DELETE too, not just UPDATE), so
  // the 0038 fixture test below cleans up its own row by nulling the FK
  // before this runs. wallet_aum_snapshot_runs itself is append-only and is
  // deliberately never cleaned up — each test that inserts one reserves a
  // fresh run_id, so fixture rows never collide across tests.
  await sql`DELETE FROM wallet_balance_samples WHERE symbol IN ('WETH', 'ROBOTMONEY') AND snapshot_run_id IS NULL`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE symbol IN ('WETH', 'ROBOTMONEY')`;
  await sql`DELETE FROM asset_prices WHERE symbol IN ('WETH', 'ROBOTMONEY')`;
}

beforeEach(async () => {
  await cleanup();
  _resetWalletBalancesCacheForTests();
  _resetWalletSleevesCacheForTests();
  _resetTokenPriceCacheForTests();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
  _resetWalletBalancesCacheForTests();
  _resetWalletSleevesCacheForTests();
  _resetTokenPriceCacheForTests();
  delete process.env.BASE_RPC_SOURCE;
  delete process.env.PRICE_SOURCE;
});

async function insertAssetPrice(priceDate: string, symbol: string, priceUsd: number): Promise<void> {
  await sql`
    INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source, pool_key, token_address,
       observed_at, fetched_at, config_identity)
    VALUES
      (${priceDate}, ${symbol}, ${ASSET_PRICE_TIME_BASIS}, ${priceUsd}, 'USD', 'geckoterminal', 'fixture-pool', 'fixture-token',
       now(), now(), 'fixture-config')
  `;
}

// ── site 1: chain/wallet-balances.ts::loadHistory ───────────────────────────

test("wallet-balances history: a CLOSED day with an agreeing asset_prices row joins to it, reproducing the ORIGINAL value_usd bit-for-bit", async () => {
  // amount * priceUsd deliberately has more binary digits than a short
  // decimal literal would — this is the case a SQL-side `numeric` recompute
  // would round differently than the JS double that originally produced
  // value_usd.
  const amount = 1.1;
  const priceUsd = 1500.37;
  const valueUsd = amount * priceUsd; // the exact double sampleWalletBalances would have stored
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, 'WETH', ${amount}, ${priceUsd}, ${valueUsd}, 'live', ${`${YESTERDAY}T23:59:58Z`})
  `;
  await insertAssetPrice(YESTERDAY, "WETH", priceUsd);

  const r = await fetchPersistedWalletBalances();
  const point = r.history.find((h) => h.date === YESTERDAY)!;
  expect(point).toBeDefined();
  expect(point.byAsset.WETH).toBe(valueUsd); // toBe, not toBeCloseTo: byte-identical
});

test("wallet-balances history: a CLOSED day with NO asset_prices row (the #849 known cleanly-sampled-day gap) still serves the sample's own value_usd unchanged", async () => {
  const valueUsd = 1650.129999; // an odd literal, so a silent fallback-to-zero or NaN would be obvious
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, 'WETH', 1, 1650.129999, ${valueUsd}, 'live', ${`${YESTERDAY}T23:59:58Z`})
  `;
  // Deliberately no asset_prices row for (YESTERDAY, WETH) — reproduces #849's
  // dev-notes gap: a cleanly-sampled closed day never dual-writes.
  const r = await fetchPersistedWalletBalances();
  const point = r.history.find((h) => h.date === YESTERDAY)!;
  expect(point.byAsset.WETH).toBe(valueUsd);
});

test("wallet-balances history: TODAY's row stays on its fused value_usd even when asset_prices holds a DIFFERENT price for today", async () => {
  const amount = 2;
  const priceUsd = 3000;
  const valueUsd = amount * priceUsd;
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${TODAY}, 'WETH', ${amount}, ${priceUsd}, ${valueUsd}, 'live', now())
  `;
  // A DISAGREEING asset_prices row for today — this should never happen in
  // real operation (the live sampler never dual-writes, D41's second trap),
  // but the read path must ignore it defensively rather than restate today.
  await insertAssetPrice(TODAY, "WETH", 9_999_999);

  const r = await fetchPersistedWalletBalances();
  const point = r.history.find((h) => h.date === TODAY)!;
  expect(point.byAsset.WETH).toBe(valueUsd);
});

// ── site 2: chain/wallet-sleeves.ts::computeWalletSleeves ───────────────────

test("wallet-sleeves: a CLOSED day with an agreeing asset_prices row joins to it, reproducing priceUsd/valueUsd bit-for-bit", async () => {
  const amount = 0.734;
  const priceUsd = 2650.111;
  const valueUsd = amount * priceUsd;
  const wallet = resolvePropWallets()[0]!.toLowerCase();
  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, ${wallet}, 'WETH', ${amount}, ${priceUsd}, ${valueUsd}, 'live', ${`${YESTERDAY}T23:59:58Z`})
  `;
  await insertAssetPrice(YESTERDAY, "WETH", priceUsd);

  const r = await getWalletSleeves();
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  const weth = bankr.holdings.find((h) => h.symbol === "WETH")!;
  expect(weth.priceUsd).toBe(priceUsd);
  expect(weth.valueUsd).toBe(valueUsd);
});

test("wallet-sleeves: a CLOSED day with NO asset_prices row still serves the sample's own price/value unchanged", async () => {
  const wallet = resolvePropWallets()[0]!.toLowerCase();
  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, ${wallet}, 'WETH', 1, 2222.333, 2222.333, 'live', ${`${YESTERDAY}T23:59:58Z`})
  `;
  const r = await getWalletSleeves();
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  const weth = bankr.holdings.find((h) => h.symbol === "WETH")!;
  expect(weth.priceUsd).toBe(2222.333);
  expect(weth.valueUsd).toBe(2222.333);
});

test("wallet-sleeves: TODAY's holding stays fused even when asset_prices holds a DIFFERENT price for today", async () => {
  const wallet = resolvePropWallets()[0]!.toLowerCase();
  const amount = 1;
  const priceUsd = 2500;
  const valueUsd = amount * priceUsd;
  await sql`
    INSERT INTO wallet_sleeve_samples (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${TODAY}, ${wallet}, 'WETH', ${amount}, ${priceUsd}, ${valueUsd}, 'live', now())
  `;
  await insertAssetPrice(TODAY, "WETH", 1);

  const r = await getWalletSleeves();
  const bankr = r.wallets.find((w) => w.type === "primary")!;
  const weth = bankr.holdings.find((h) => h.symbol === "WETH")!;
  expect(weth.priceUsd).toBe(priceUsd);
  expect(weth.valueUsd).toBe(valueUsd);
});

// ── site 3: recentPersistedPrice / persistedFallbackWalletPriceReader ───────

function mockPriceHostFailure() {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("geckoterminal.com") || u.includes("finance.yahoo.com")) {
      throw new Error("mockChain: forced price failure");
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

test("recentPersistedPrice: a CLOSED day's row still within the freshness window sources its price from an agreeing asset_prices row", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  mockPriceHostFailure();
  const asset = resolveTrackedAssets().find((a) => a.symbol === "WETH")!;

  // A row whose sample_date is YESTERDAY (closed) but whose sampled_at is
  // recent enough to still qualify — the narrow window this reader's
  // migration note describes (a repair/backfill commit landing minutes after
  // UTC midnight for the day it just closed).
  const closedDayPrice = 1800.5;
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, 'WETH', 1, ${closedDayPrice}, ${closedDayPrice}, 'backfilled', now())
  `;
  await insertAssetPrice(YESTERDAY, "WETH", 1795.25); // the repaired/reconciled price — DIFFERENT from the sample row

  const quote = await persistedFallbackWalletPriceReader.read(asset, "live", "live");
  expect(quote.kind).toBe("persisted");
  expect(quote.priceUsd).toBe(1795.25); // the join's price wins for a closed day
});

test("recentPersistedPrice: a CLOSED day's row within the freshness window falls back to its own price_usd when asset_prices has no row (the #849 known gap)", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  mockPriceHostFailure();
  const asset = resolveTrackedAssets().find((a) => a.symbol === "WETH")!;

  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${YESTERDAY}, 'WETH', 1, 1701.4, 1701.4, 'backfilled', now())
  `;
  const quote = await persistedFallbackWalletPriceReader.read(asset, "live", "live");
  expect(quote.kind).toBe("persisted");
  expect(quote.priceUsd).toBe(1701.4);
});

test("recentPersistedPrice: TODAY's fresh sample keeps reading its own price_usd even when asset_prices disagrees for today", async () => {
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  mockPriceHostFailure();
  const asset = resolveTrackedAssets().find((a) => a.symbol === "WETH")!;

  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${TODAY}, 'WETH', 1, 2600.75, 2600.75, 'live', now())
  `;
  await insertAssetPrice(TODAY, "WETH", 1);

  const quote = await persistedFallbackWalletPriceReader.read(asset, "live", "live");
  expect(quote.kind).toBe("persisted");
  expect(quote.priceUsd).toBe(2600.75);
});

// ── the 0038 freeze point composes with the read-time join ──────────────────
//
// markets §5.6 point 3 / D41: "the join is the CANDIDATE; 0038 is the freeze
// point" — a generic history read restates a closed day whenever asset_prices
// changes underneath it (that is the whole point of a read-time join), while a
// PUBLISHED wallet_aum_snapshot_runs header's own constituent row is immutable
// (migration 0038's guard triggers) and therefore stays reproducible from its
// own recorded evidence no matter what asset_prices says later. This test
// exercises both halves in one fixture so neither can be "fixed" by breaking
// the other.
test("0038: a published snapshot's constituent row reproduces its original value_usd after asset_prices is repaired underneath it, while the general history read restates", async () => {
  // wallet_balance_samples rows carrying a snapshot_run_id are immutable
  // forever (migration 0038's finalize guard blocks both UPDATE and DELETE),
  // so a fixed symbol would collide with a prior run's row on the same
  // persistent test-container boot. A synthetic per-run symbol keeps the
  // natural key (sample_date, symbol) unique across repeated runs without
  // ever needing to clean the immutable row up.
  const symbol = `WETH-0038-FIXTURE-${crypto.randomUUID().slice(0, 8)}`;
  const originalPrice = 1500;
  const originalValue = 1 * originalPrice;
  await insertAssetPrice(YESTERDAY, symbol, originalPrice); // agrees with the row at publish time

  const [reserved] = await sql<{ run_id: string }[]>`
    SELECT nextval(pg_get_serial_sequence('wallet_aum_snapshot_runs', 'run_id')) AS run_id
  `;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at,
         snapshot_run_id, amount_observed_at, price_observed_at, recorded_at)
      VALUES
        (${YESTERDAY}, ${symbol}, 1, ${originalPrice}, ${originalValue}, 'backfilled', ${`${YESTERDAY}T23:59:58Z`},
         ${reserved!.run_id}, ${`${YESTERDAY}T23:59:58Z`}, ${`${YESTERDAY}T23:59:59Z`}, now())
    `;
    await tx`
      INSERT INTO wallet_aum_snapshot_runs
        (run_id, sample_date, time_basis, state, manifest_version, manifest_json,
         manifest_hash, config_identity, snapshot_id,
         expected_balance_keys, present_balance_keys,
         observed_at, published_at, chain_id, block_number, block_hash,
         block_timestamp, boundary_next_block_number, boundary_next_block_hash,
         boundary_next_block_timestamp, producer_revision_status, producer_revision)
      VALUES
        (${reserved!.run_id}, ${YESTERDAY}, 'utc-daily-close', 'complete', 'v1', ${tx.json({ version: "v1" })},
         ${"a".repeat(64)}, 'fixture-config', ${"b".repeat(64)},
         ARRAY[${symbol}], ARRAY[${symbol}],
         ${`${YESTERDAY}T23:59:58Z`}, now(), 8453, 200, ${"0x" + "2".repeat(64)},
         ${`${YESTERDAY}T23:59:58Z`}, 201, ${"0x" + "3".repeat(64)}, ${`${TODAY}T00:00:00Z`},
         'available', 'git-fixture-850')
    `;
  });

  // Before any repair: the general read agrees with the frozen row (the join
  // is in agreement, so nothing restates yet).
  const before = await fetchPersistedWalletBalances();
  expect(before.history.find((h) => h.date === YESTERDAY)!.byAsset[symbol]).toBe(originalValue);

  // Simulate a repair reconciling asset_prices to a NEW price for the same
  // (date, symbol) — "the price series is repaired underneath it".
  const repairedPrice = 1620;
  await sql`
    UPDATE asset_prices SET price_usd = ${repairedPrice}
     WHERE price_date = ${YESTERDAY} AND symbol = ${symbol} AND time_basis = ${ASSET_PRICE_TIME_BASIS}
  `;

  // The frozen constituent row is UNCHANGED — reproducible from its own
  // recorded evidence regardless of what asset_prices now says.
  const [frozen] = await sql<{ price_usd: string; value_usd: string }[]>`
    SELECT price_usd, value_usd FROM wallet_balance_samples WHERE snapshot_run_id = ${reserved!.run_id}
  `;
  expect(Number(frozen!.price_usd)).toBe(originalPrice);
  expect(Number(frozen!.value_usd)).toBe(originalValue);

  // The general/live history read is the CANDIDATE and restates using the
  // repaired price — proving the join, not a cached/frozen number, drives it.
  const after = await fetchPersistedWalletBalances();
  expect(after.history.find((h) => h.date === YESTERDAY)!.byAsset[symbol]).toBe(1 * repairedPrice);

  await sql`DELETE FROM asset_prices WHERE symbol = ${symbol}`;
});
