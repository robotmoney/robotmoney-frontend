// THE REPAIR DRIVER (issue #709, §6.5.4) — the thing that makes "self-healing"
// true for the wallet/AUM series.
//
// Every assertion here is about a REFUSAL as much as about a write, because the
// refusals are what make a backfilled row trustworthy:
//
//   * a day whose chain read was incomplete is not written AT ALL (day-atomic),
//   * a `success:true` + `returnData:"0x"` sub-call is a FAILURE, never a zero,
//   * a day with no price for a symbol is not written at a price of zero,
//   * a day the live sampler already wrote is never overwritten,
//   * a day that keeps failing stops costing RPC but stays a disclosed gap.
//
// RED CONTROL: none of this module existed before #709, and `remediationClass`
// had zero behavioural consumers — the whole file fails to import against the
// pre-change tree.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { resolvePropWallets, resolveTrackedAssets } from "../src/config.ts";
import {
  backfillWalletDay,
  lastClosedDay,
  missingDaysFromReport,
  selectBackfillDays,
  type WalletBackfillDeps,
} from "../src/ops/wallet-backfill.ts";
import type { ChainAmount, KeyedAssetRead } from "../src/chain/wallet-valuation.ts";

// Deliberately far outside the real series window (seriesStart 2026-03-18) so
// these fixtures cannot perturb any other suite's gap assertions on the shared
// ephemeral database.
const D1 = "2019-06-05";
const D2 = "2019-06-06";
const D3 = "2019-06-07";
const NOW = new Date("2019-06-10T09:00:00Z");
const ALL_DAYS = [D1, D2, D3, "2019-06-09"];
const BLOCK = 1_234_567;
const BLOCK_TS = Math.floor(Date.parse(`${D1}T23:59:58Z`) / 1000);

async function cleanup(): Promise<void> {
  await sql`DELETE FROM wallet_balance_samples WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM wallet_backfill_state WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM chain_day_blocks WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
}

beforeEach(async () => {
  // A rate high enough that pacing never shows up in these tests' wall clock —
  // the transport's default (0.25/s) would pace them for real.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "10";
  await cleanup();
});
afterEach(async () => {
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  delete process.env.WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY;
  await cleanup();
});

/** Deps that read a fixed amount for every leg and price everything at $2. */
function happyDeps(overrides: Partial<WalletBackfillDeps> = {}): WalletBackfillDeps {
  return {
    async resolveBlock(date) {
      return { date, blockNumber: BLOCK, blockTimestampSec: BLOCK_TS, rpcCalls: 3, cached: false };
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

// ── The happy path, and what it must record ──────────────────────────────────

test("a repaired day lands in BOTH series, tagged 'backfilled', at the block's own timestamp", async () => {
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(result.ok).toBe(true);
  expect(result.status).toBe("filled");
  expect(result.blockNumber).toBe(BLOCK);
  expect(result.balanceRows).toBeGreaterThan(0);
  expect(result.sleeveRows).toBeGreaterThan(0);

  const balances = await sql<{ symbol: string; amount: string; price_usd: string; value_usd: string; provenance: string; sampled_at: Date }[]>`
    SELECT symbol, amount, price_usd, value_usd, provenance, sampled_at
      FROM wallet_balance_samples WHERE sample_date = ${D1} ORDER BY symbol
  `;
  expect(balances.length).toBeGreaterThan(0);
  for (const row of balances) {
    // NEVER 'live'. A backfilled row is a genuine read of a past block, and it
    // must stay distinguishable from a sample taken on the day, forever.
    expect(row.provenance).toBe("backfilled");
    expect(Number(row.amount)).toBe(5);
    expect(Number(row.price_usd)).toBe(2);
    expect(Number(row.value_usd)).toBe(10);
    // sampled_at is the BLOCK's timestamp — the real observation time — not now.
    expect(Math.floor(new Date(row.sampled_at).getTime() / 1000)).toBe(BLOCK_TS);
  }

  const sleeves = await sql<{ provenance: string }[]>`
    SELECT provenance FROM wallet_sleeve_samples WHERE sample_date = ${D1}
  `;
  expect(sleeves.length).toBeGreaterThan(0);
  for (const row of sleeves) expect(row.provenance).toBe("backfilled");
});

test("SP500 is deliberately absent from a repaired day (PD7 / #648) — not zeroed", async () => {
  await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1} AND symbol = 'SP500'
  `;
  expect(row!.n).toBe(0);
  // and the chain-priced symbols ARE there, so this is a scoping decision rather
  // than a failed day.
  const [chainRows] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1} AND symbol = 'USDC'
  `;
  expect(chainRows!.n).toBe(1);
});

test("the checkpoint commits WITH the day's rows", async () => {
  await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const [state] = await sql<{ status: string; block_number: string; balance_rows: number; sleeve_rows: number }[]>`
    SELECT status, block_number, balance_rows, sleeve_rows FROM wallet_backfill_state WHERE sample_date = ${D1}
  `;
  expect(state!.status).toBe("filled");
  expect(Number(state!.block_number)).toBe(BLOCK);
  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}
  `;
  expect(state!.balance_rows).toBe(count!.n);
});

test("the date→block resolution is cached permanently for that day", async () => {
  let resolutions = 0;
  const deps = happyDeps({
    async resolveBlock(date, opts, cache, now) {
      const hit = await cache.get(date);
      if (hit) return { date, blockNumber: hit.blockNumber, blockTimestampSec: hit.blockTimestampSec, rpcCalls: 0, cached: true };
      resolutions += 1;
      await cache.set(date, BLOCK, BLOCK_TS);
      return { date, blockNumber: BLOCK, blockTimestampSec: BLOCK_TS, rpcCalls: 3, cached: false };
    },
  });
  await backfillWalletDay(sql, D1, deps, NOW);
  await sql`DELETE FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE sample_date = ${D1}`;
  await backfillWalletDay(sql, D1, deps, NOW);
  expect(resolutions).toBe(1); // the second pass paid nothing for the block
});

// ── The refusals ─────────────────────────────────────────────────────────────

test("DAY-ATOMIC: one unreadable leg writes NOTHING for the whole day", async () => {
  const deps = happyDeps({
    async readChainAmounts(reads: KeyedAssetRead[]) {
      // One leg fails — exactly what a strictEmptyReturn `0x` sub-call produces.
      return new Map<string, ChainAmount>(
        reads.map((r, i) => [r.key, (i === 2 ? { ok: false } : { ok: true, amount: 5 }) as ChainAmount]),
      );
    },
  });
  const result = await backfillWalletDay(sql, D1, deps, NOW);
  expect(result.ok).toBe(false);
  expect(result.status).toBe("failed");

  // Not "most of the day". None of it. Round 2's NAV depends on round 1, so a
  // half-read day is a plausible, wrong total.
  const [balances] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  const [sleeves] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${D1}`;
  expect(balances!.n).toBe(0);
  expect(sleeves!.n).toBe(0);
});

test("a missing price fails the day rather than valuing a real holding at zero", async () => {
  const deps = happyDeps({
    async loadPrices(assets, fromDate) {
      // Every symbol priced EXCEPT one — the shape of a thin OHLCV day.
      const out = new Map<string, Map<string, number>>();
      for (const a of assets) {
        out.set(a.symbol, a.symbol === "BNKR" ? new Map() : new Map([[fromDate, 2]]));
      }
      return out;
    },
  });
  const result = await backfillWalletDay(sql, D1, deps, NOW);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("BNKR");
  const [balances] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  expect(balances!.n).toBe(0);
});

test("a day the sampler already wrote is NEVER overwritten", async () => {
  await sql`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D1}, 'USDC', 111, 1, 111, 'live', now())
  `;
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);

  const [row] = await sql<{ amount: string; provenance: string }[]>`
    SELECT amount, provenance FROM wallet_balance_samples WHERE sample_date = ${D1} AND symbol = 'USDC'
  `;
  // Repair fills holes. It does not restate history.
  expect(Number(row!.amount)).toBe(111);
  expect(row!.provenance).toBe("live");
  expect(result.detail).toContain("wallet_balance_samples");
  // The sleeve half of the day WAS empty, so it is still repaired — the two
  // series are checked independently inside one transaction.
  const [sleeves] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${D1}`;
  expect(sleeves!.n).toBeGreaterThan(0);
});

test("a day that has not closed is skipped without touching the chain", async () => {
  let reads = 0;
  const deps = happyDeps({
    async resolveBlock(date) {
      reads += 1;
      return { date, blockNumber: BLOCK, blockTimestampSec: BLOCK_TS, rpcCalls: 1, cached: false };
    },
  });
  const today = "2019-06-10";
  const result = await backfillWalletDay(sql, today, deps, NOW);
  expect(result.status).toBe("skipped");
  expect(reads).toBe(0);
});

test("running the same day twice is idempotent — no duplicate rows", async () => {
  await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const [first] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  const second = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  expect(after!.n).toBe(first!.n);
  expect(second.status).toBe("skipped");
});

test("a day that keeps failing becomes 'exhausted' — still a gap, no longer a cost", async () => {
  process.env.WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY = "2";
  const deps = happyDeps({
    async resolveBlock() {
      throw new Error("simulated RPC outage");
    },
  });

  const a = await backfillWalletDay(sql, D2, deps, NOW);
  expect(a.status).toBe("failed");
  expect(a.ok).toBe(false); // retried by the queue's degrade path

  const b = await backfillWalletDay(sql, D2, deps, NOW);
  expect(b.status).toBe("exhausted");
  expect(b.ok).toBe(true); // the queue stops retrying; the gap stays reported

  const [state] = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM wallet_backfill_state WHERE sample_date = ${D2}
  `;
  expect(state!.status).toBe("exhausted");
  expect(state!.attempts).toBe(2);
  // Nothing was interpolated to make the hole go away.
  const [rows] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D2}`;
  expect(rows!.n).toBe(0);
});

test("a LIVE run refuses outright when pacing is explicitly disabled (PD6)", async () => {
  // Unsetting is no longer a refusal — the transport carries a conservative
  // default, so an ordinary deployment heals. Only BASE_RPC_MAX_CALLS_PER_SEC=0,
  // which turns the limiter off entirely, still stops the sweep.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  const prior = process.env.BASE_RPC_SOURCE;
  process.env.BASE_RPC_SOURCE = "live";
  try {
    await expect(backfillWalletDay(sql, D3, happyDeps(), NOW)).rejects.toThrow(/BASE_RPC_MAX_CALLS_PER_SEC/);
  } finally {
    if (prior === undefined) delete process.env.BASE_RPC_SOURCE;
    else process.env.BASE_RPC_SOURCE = prior;
  }
});

// ── Planning ─────────────────────────────────────────────────────────────────

test("lastClosedDay never returns today", () => {
  expect(lastClosedDay(new Date("2026-08-20T00:00:01Z"))).toBe("2026-08-19");
  expect(lastClosedDay(new Date("2026-08-20T23:59:59Z"))).toBe("2026-08-19");
});

test("missing days include the STALE-HEAD TAIL, not just interior holes", () => {
  // A series that simply stopped has no interior gap at all — every day after
  // its head is 'stale head' territory. A planner that only read interiorGaps
  // would report that series forever and never repair a single day of it.
  const days = missingDaysFromReport(
    { interiorGaps: ["2026-06-02T00:00:00.000Z"], headDate: "2026-06-04T00:00:00.000Z" },
    "2026-06-07",
  );
  expect(days).toEqual(["2026-06-02", "2026-06-05", "2026-06-06", "2026-06-07"]);
});

test("missing days never include a day that has not closed", () => {
  const days = missingDaysFromReport(
    { interiorGaps: ["2026-06-06T00:00:00.000Z", "2026-06-07T00:00:00.000Z"], headDate: null },
    "2026-06-06",
  );
  expect(days).toEqual(["2026-06-06"]);
});

test("the per-run cap DEFERS rather than drops, and reports what it deferred", () => {
  const plan = selectBackfillDays(["d1", "d2", "d3", "d4", "d5"], new Map(), 2);
  expect(plan.days).toEqual(["d1", "d2"]);
  expect(plan.totalMissing).toBe(5);
  expect(plan.deferred).toBe(3); // a silent cap reads as "covered everything"
});

test("settled days are skipped, failed days are retried, exhausted days are reported not retried", () => {
  const plan = selectBackfillDays(
    ["d1", "d2", "d3", "d4"],
    new Map([
      ["d1", "filled"],
      ["d2", "failed"],
      ["d3", "exhausted"],
    ]),
    10,
  );
  expect(plan.days).toEqual(["d2", "d4"]);
  expect(plan.retrying).toBe(1);
  expect(plan.exhausted).toEqual(["d3"]);
});

// ── Sanity: the fixture actually exercises the real asset/sleeve layout ──────

test("a repaired day covers every chain-read asset and every configured sleeve leg", async () => {
  await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const chainAssets = resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
  const [balances] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  expect(balances!.n).toBe(chainAssets.length);

  const wallets = resolvePropWallets();
  const [distinct] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT wallet_address)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${D1}
  `;
  expect(distinct!.n).toBeGreaterThan(0);
  expect(distinct!.n).toBeLessThanOrEqual(wallets.length);
});
