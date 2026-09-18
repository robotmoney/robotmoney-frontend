// D41 phase 2 — the window executor dual-writes asset_prices alongside the
// sample row (issue #849; docs/decisions.md D41;
// docs/technical/markets-asset-pricing-ingest.md §5.6).
//
// RED CONTROL: none of ops/asset-prices.ts existed before #849, and
// repairResolvedDay wrote only wallet_balance_samples/wallet_sleeve_samples —
// this whole file fails to import/pass against the pre-change tree.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { backfillWalletDay, type WalletBackfillDeps } from "../src/ops/wallet-backfill.ts";
import type { ChainAmount, KeyedAssetRead } from "../src/chain/wallet-valuation.ts";
import { resolveTrackedAssets } from "../src/config.ts";
import { sampleWalletBalances } from "../src/worker/handlers/wallet.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const D1 = "2019-07-05";
const NOW = new Date("2019-07-06T09:00:00Z");
const BLOCK = 7_654_321;
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
  await sql`DELETE FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE sample_date = ${D1}`;
  await sql`DELETE FROM wallet_backfill_state WHERE sample_date = ${D1}`;
  await sql`DELETE FROM chain_day_blocks WHERE sample_date = ${D1}`;
  await sql`DELETE FROM asset_prices WHERE price_date = ${D1}`;
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

/** Every leg reads amount 5, priced $2 — mirrors wallet-backfill.test.ts's
 *  happyDeps, minus resolveAddressFloors/resolvePoolKey (both optional; the
 *  dual-write must work with pool_key left NULL, exactly as a caller that
 *  does not inject that dep gets today). */
function happyDeps(overrides: Partial<WalletBackfillDeps> = {}): WalletBackfillDeps {
  return {
    async resolveBlock(date) {
      return resolvedBlock(date);
    },
    async readChainAmounts(reads: KeyedAssetRead[]) {
      return new Map<string, ChainAmount>(reads.map((r) => [r.key, { ok: true, amount: 5 } as ChainAmount]));
    },
    async loadPrices(assets, fromDate, toDate) {
      const days: string[] = [];
      for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return new Map(assets.map((a) => [a.symbol, new Map(days.map((d) => [d, 2]))]));
    },
    ...overrides,
  };
}

test("a repaired day dual-writes asset_prices for every priced symbol, source correct, SP500 absent", async () => {
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(result.ok).toBe(true);

  const rows = await sql<{ symbol: string; price_usd: string; currency: string; time_basis: string; source: string }[]>`
    SELECT symbol, price_usd::text, currency, time_basis, source
      FROM asset_prices WHERE price_date = ${D1} ORDER BY symbol
  `;
  const manifest = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  expect(rows.length).toBe(manifest.length);
  expect(rows.some((r) => r.symbol === "SP500")).toBe(false);

  const usdcPinned = new Set(["USDC", "ZYFAI-SS1", "GIZA-SS1"]);
  for (const row of rows) {
    expect(row.currency).toBe("USD");
    expect(row.time_basis).toBe("utc-daily-close");
    expect(Number(row.price_usd)).toBe(2);
    expect(row.source).toBe(usdcPinned.has(row.symbol) ? "pinned" : "geckoterminal");
  }
});

test("a disagreement against an already-persisted asset_prices row is reported, not silently swallowed, offline", async () => {
  await sql`
    INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    VALUES
      (${D1}, 'WETH', 'utc-daily-close', 999, 'USD', 'geckoterminal', now(), now(), 'fixture-prior-repair')
  `;
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("asset_prices disagreement");
  expect(result.detail).toContain("WETH");
  expect(result.detail).toContain("999");

  // The freshly verified repair value wins — this is the EXPAND half of the
  // cutover and nothing reads this table yet, so overwriting can never
  // regress a live path.
  const [row] = await sql<{ price_usd: string }[]>`
    SELECT price_usd::text FROM asset_prices WHERE price_date = ${D1} AND symbol = 'WETH'
  `;
  expect(Number(row!.price_usd)).toBe(2);
});

test("a disagreement against the PRIOR wallet_balance_samples row is reported — the literal sample-row-vs-price-row check", async () => {
  // An incomplete prior snapshot: one symbol present at a stale price, every
  // other manifest symbol missing — `before.complete` is false, so the
  // rebuild branch runs and the pre-delete comparison fires.
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D1}, 'WETH', 1, 999, 999, 'live', ${new Date(BLOCK_TS * 1000).toISOString()})
  `;
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("asset_prices disagreement");
  expect(result.detail).toContain("sample_row");
  expect(result.detail).toContain("WETH");
  expect(result.detail).toContain("999");
});

test("no disagreement is reported when the freshly repaired price matches what asset_prices already held", async () => {
  await sql`
    INSERT INTO asset_prices
      (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    VALUES
      (${D1}, 'WETH', 'utc-daily-close', 2, 'USD', 'geckoterminal', now(), now(), 'fixture-prior-repair')
  `;
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(result.detail ?? "").not.toContain("disagreement");
});

// UPDATE (issue #927): before this issue the live sampler never touched
// asset_prices at all — the coverage gap it closes is exactly that omission.
// It now dual-writes on every ordinary sample, which is NOT the live/close
// substitution D41's second trap refuses: the row it writes for TODAY's date
// is never consumed via the read sites' join while today stays "open"
// (`is_closed = false` — all three sites keep reading the fused sample row
// for today regardless of what asset_prices holds, unchanged by #927). Only
// once tomorrow arrives does today's row become a CLOSED day, and by then
// asset_prices holds whatever spot price the LAST successful per-minute tick
// before midnight observed — the same "last trade of the day" approximation
// of a close the repair path's own OHLCV-derived close exists to true up
// later if it ever disagrees (see the disagreement-check tests above).
test("the live sampler dual-writes asset_prices under today's date (issue #927) — the row exists, but today's OWN reads never consume it via the join", async () => {
  process.env.BASE_RPC_SOURCE = "stub";
  process.env.PRICE_SOURCE = "stub";
  // issue #827: read the day the sampler actually wrote off its own return
  // value, rather than recomputing "today" independently — sampleWalletBalances
  // picks its own `sampleDate` from `new Date()` internally, and a
  // separately-computed `today` here would race that read across a UTC
  // midnight straddle.
  const { sampleDate: today } = (await sampleWalletBalances({})) as { sampleDate: string };
  const [balanceCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${today}
  `;
  // Sanity: the sampler really did write today's fused sample rows...
  expect(balanceCount!.n).toBeGreaterThan(0);
  // ...and every priced symbol among them also got an asset_prices row under
  // TODAY's date (issue #927's forward dual-write — the SP500/`config`-kind
  // legs have no price to dual-write, so this is bounded below by balances
  // minus those, not required to equal balanceCount exactly).
  const [priceCount] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_prices WHERE price_date = ${today}`;
  expect(priceCount!.n).toBeGreaterThan(0);
  const timeBases = await sql<{ time_basis: string }[]>`SELECT DISTINCT time_basis FROM asset_prices WHERE price_date = ${today}`;
  expect(timeBases.map((r) => r.time_basis)).toEqual(["utc-daily-close"]);
  // D41 phase 4 (issue #927): the live sampler no longer writes price_usd —
  // asset_prices is the sole record of that price now.
  const [priceUsdNull] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${today} AND price_usd IS NOT NULL
  `;
  expect(priceUsdNull!.n).toBe(0);
});
