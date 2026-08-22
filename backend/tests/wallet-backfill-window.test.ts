// THE WINDOW EXECUTOR — batching a repair run's days without loosening any of
// the per-day guarantees that make a backfilled row trustworthy.
//
// WHY THIS FILE EXISTS SEPARATELY FROM wallet-backfill.test.ts. That file pins
// what one day must do; this one pins what batching must NOT change about it.
// The tempting failure here is not a wrong number, it is a wrong BLAST RADIUS:
// a window that loses all ten days because one day's block would not resolve,
// or that writes ten days in one transaction so an interruption loses nine, is
// faster and worse. So the assertions below are mostly about isolation.
//
// The other half is the actual saving, stated as a behaviour rather than a
// comment: N days must cost ONE price load and ONE resolver pass, because the
// provider meters HTTP hits and a per-day fan-out is what lost 2026-03-18 to a
// price-feed 429 on 2026-08-22.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  backfillWalletDay,
  backfillWalletWindow,
  type WalletBackfillDeps,
} from "../src/ops/wallet-backfill.ts";
import type { ChainAmount, KeyedAssetRead } from "../src/chain/wallet-valuation.ts";
import type { DayBlockOutcome } from "../src/chain/block-resolver.ts";

const D1 = "2019-07-01";
const D2 = "2019-07-02";
const D3 = "2019-07-03";
const NOW = new Date("2019-07-10T09:00:00Z");
const ALL_DAYS = [D1, D2, D3, "2019-07-04", "2019-07-09", "2019-07-10"];
const BLOCK = 7_000_000;
const blockFor = (d: string): number => BLOCK + ALL_DAYS.indexOf(d);
const tsFor = (d: string): number => Math.floor(Date.parse(`${d}T23:59:58Z`) / 1000);

async function cleanup(): Promise<void> {
  await sql`DELETE FROM wallet_balance_samples WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM wallet_sleeve_samples WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM wallet_backfill_state WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
  await sql`DELETE FROM chain_day_blocks WHERE sample_date = ANY(${ALL_DAYS}::date[])`;
}

beforeEach(async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "10";
  await cleanup();
});
afterEach(async () => {
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  await cleanup();
});

/** Counting deps: every call the executor makes to the metered world is tallied
 *  so the tests can assert the SHAPE of the spend, not just the outcome. */
function countingDeps(overrides: Partial<WalletBackfillDeps> = {}): {
  deps: WalletBackfillDeps;
  counts: { resolveBatches: number; resolvedDays: number; priceLoads: number; reads: number };
  priceRanges: [string, string][];
} {
  const counts = { resolveBatches: 0, resolvedDays: 0, priceLoads: 0, reads: 0 };
  const priceRanges: [string, string][] = [];
  return {
    counts,
    priceRanges,
    deps: {
      async resolveBlock(date) {
        return { date, blockNumber: blockFor(date), blockTimestampSec: tsFor(date), rpcCalls: 3, cached: false };
      },
      async resolveBlocks(dates): Promise<DayBlockOutcome[]> {
        counts.resolveBatches += 1;
        counts.resolvedDays += dates.length;
        return dates.map((date) => ({
          ok: true as const,
          date,
          blockNumber: blockFor(date),
          blockTimestampSec: tsFor(date),
          rpcCalls: 1,
          cached: false,
        }));
      },
      async readChainAmounts(reads: KeyedAssetRead[]) {
        counts.reads += 1;
        return new Map<string, ChainAmount>(reads.map((r) => [r.key, { ok: true, amount: 5 } as ChainAmount]));
      },
      async loadPrices(assets, fromDate, toDate) {
        counts.priceLoads += 1;
        priceRanges.push([fromDate, toDate]);
        const days: string[] = [];
        for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
          days.push(new Date(t).toISOString().slice(0, 10));
        }
        return new Map(assets.map((a) => [a.symbol, new Map(days.map((d) => [d, 2]))]));
      },
      ...overrides,
    },
  };
}

// ── The saving, as a behaviour ───────────────────────────────────────────────

test("a window of N days costs ONE resolver pass and ONE price load", async () => {
  const { deps, counts, priceRanges } = countingDeps();
  const out = await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  expect(out.length).toBe(3);
  expect(out.every((r) => r.status === "filled")).toBe(true);
  expect(counts.resolveBatches).toBe(1);
  expect(counts.resolvedDays).toBe(3);
  expect(counts.priceLoads).toBe(1);
  // ONE range spanning the window, not three single-day loads. This is the exact
  // fan-out that 429'd on 2026-08-22.
  expect(priceRanges).toEqual([[D1, D3]]);
});

test("results come back positionally aligned with the requested dates", async () => {
  const { deps } = countingDeps();
  const out = await backfillWalletWindow(sql, [D3, D1, D2], deps, NOW);
  expect(out.map((r) => r.sampleDate)).toEqual([D3, D1, D2]);
});

// ── Isolation: a window is a batching unit, never a blast radius ─────────────

test("one day whose block will not resolve fails ALONE — the rest are repaired", async () => {
  const { deps, counts } = countingDeps({
    async resolveBlocks(dates): Promise<DayBlockOutcome[]> {
      counts.resolveBatches += 1;
      return dates.map((date) =>
        date === D2
          ? { ok: false as const, date, error: "simulated resolver outage" }
          : {
              ok: true as const,
              date,
              blockNumber: blockFor(date),
              blockTimestampSec: tsFor(date),
              rpcCalls: 1,
              cached: false,
            },
      );
    },
  });

  const out = await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const byDate = new Map(out.map((r) => [r.sampleDate, r]));
  expect(byDate.get(D1)!.status).toBe("filled");
  expect(byDate.get(D3)!.status).toBe("filled");
  expect(byDate.get(D2)!.status).toBe("failed");
  expect(byDate.get(D2)!.detail).toContain("simulated resolver outage");

  // The failed day wrote NOTHING and stays a disclosed gap.
  const [rows] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D2}
  `;
  expect(rows!.n).toBe(0);
  // Its siblings really did land.
  const [kept] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D3]}::date[])
  `;
  expect(kept!.n).toBeGreaterThan(0);
});

test("a day with an unreadable leg fails alone and is still day-atomic", async () => {
  let call = 0;
  const { deps } = countingDeps({
    async readChainAmounts(reads: KeyedAssetRead[]) {
      call += 1;
      // Break exactly one leg of the SECOND day read.
      return new Map<string, ChainAmount>(
        reads.map((r, i) => [r.key, (call === 2 && i === 0 ? { ok: false } : { ok: true, amount: 5 }) as ChainAmount]),
      );
    },
  });

  const out = await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);
  expect(out.filter((r) => r.status === "filled").length).toBe(2);
  const failed = out.find((r) => r.status === "failed")!;
  expect(failed.sampleDate).toBe(D2);
  expect(failed.detail).toContain("unreadable");

  const [rows] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${D2}
  `;
  expect(rows!.n).toBe(0); // nothing partial survives
});

test("a price-load failure fails every day it covers — and writes none of them", async () => {
  // Shared work means shared failure, and that is the honest outcome: no day in
  // the window had a price, so no day may be written at one.
  const { deps } = countingDeps({
    async loadPrices() {
      throw new Error("429 Too Many Requests");
    },
  });

  const out = await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);
  expect(out.every((r) => r.status === "failed")).toBe(true);
  expect(out.every((r) => (r.detail ?? "").includes("429"))).toBe(true);
  // Block numbers are still recorded: resolution succeeded, pricing did not.
  expect(out.every((r) => r.blockNumber !== null)).toBe(true);

  const [rows] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows!.n).toBe(0);
});

// ── Per-day durability survives the batching ─────────────────────────────────

test("each day commits its OWN checkpoint row, so an interruption loses at most one day", async () => {
  const { deps } = countingDeps();
  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ sample_date: Date; status: string; block_number: string }[]>`
    SELECT sample_date, status, block_number FROM wallet_backfill_state
     WHERE sample_date = ANY(${[D1, D2, D3]}::date[]) ORDER BY sample_date
  `;
  expect(rows.length).toBe(3);
  // Each day's checkpoint names ITS OWN block, not the window's first.
  expect(rows.map((r) => Number(r.block_number))).toEqual([blockFor(D1), blockFor(D2), blockFor(D3)]);
  expect(rows.every((r) => r.status === "filled")).toBe(true);
});

test("an OPEN day is skipped without spending anything, and never blocks the closed ones", async () => {
  const { deps, counts } = countingDeps();
  const today = "2019-07-10";
  const out = await backfillWalletWindow(sql, [D1, today], deps, NOW);

  const byDate = new Map(out.map((r) => [r.sampleDate, r]));
  expect(byDate.get(today)!.status).toBe("skipped");
  expect(byDate.get(today)!.detail).toContain("has not closed yet");
  expect(byDate.get(D1)!.status).toBe("filled");
  // The open day never reached the resolver.
  expect(counts.resolvedDays).toBe(1);
});

test("re-running a window over already-filled days writes nothing new", async () => {
  const { deps } = countingDeps();
  await backfillWalletWindow(sql, [D1, D2], deps, NOW);
  const [before] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2]}::date[])
  `;

  const second = await backfillWalletWindow(sql, [D1, D2], deps, NOW);
  expect(second.every((r) => r.status === "skipped")).toBe(true);
  expect(second.every((r) => (r.detail ?? "").includes("already populated"))).toBe(true);

  const [after] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2]}::date[])
  `;
  expect(after!.n).toBe(before!.n);
});

// ── One executor, not two ────────────────────────────────────────────────────

test("backfillWalletDay IS the N=1 window — same result, same rows", async () => {
  // If these two ever diverge, one of them is writing money numbers the other
  // would refuse. The single-day entry point is a delegation, and this is what
  // keeps it one.
  const a = countingDeps();
  const viaDay = await backfillWalletDay(sql, D1, a.deps, NOW);
  const dayRows = await sql<{ symbol: string; value_usd: string; provenance: string }[]>`
    SELECT symbol, value_usd, provenance FROM wallet_balance_samples WHERE sample_date = ${D1} ORDER BY symbol
  `;
  await cleanup();

  const b = countingDeps();
  const viaWindow = (await backfillWalletWindow(sql, [D1], b.deps, NOW))[0]!;
  const windowRows = await sql<{ symbol: string; value_usd: string; provenance: string }[]>`
    SELECT symbol, value_usd, provenance FROM wallet_balance_samples WHERE sample_date = ${D1} ORDER BY symbol
  `;

  expect(viaWindow).toEqual(viaDay);
  expect(windowRows).toEqual(dayRows);
  expect(windowRows.length).toBeGreaterThan(0); // the comparison is not of two empties
});

test("a caller that injects only the per-day resolver still drives the executor", async () => {
  // The fallback exists so every pre-existing test keeps testing the real thing
  // rather than a path nothing uses. Pin it, or it rots.
  const { deps } = countingDeps();
  const perDayOnly: WalletBackfillDeps = {
    resolveBlock: deps.resolveBlock,
    readChainAmounts: deps.readChainAmounts,
    loadPrices: deps.loadPrices,
  };
  const out = await backfillWalletWindow(sql, [D1, D2], perDayOnly, NOW);
  expect(out.every((r) => r.status === "filled")).toBe(true);
});

test("an empty window is a no-op, not a throw", async () => {
  const { deps, counts } = countingDeps();
  expect(await backfillWalletWindow(sql, [], deps, NOW)).toEqual([]);
  expect(counts.resolveBatches).toBe(0);
  expect(counts.priceLoads).toBe(0);
});
