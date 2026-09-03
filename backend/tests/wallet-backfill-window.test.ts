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
const blockHash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const resolvedBlock = (date: string, rpcCalls: number) => {
  const blockNumber = blockFor(date);
  const blockTimestampSec = tsFor(date);
  return {
    date,
    blockNumber,
    blockHash: blockHash(blockNumber),
    blockTimestampSec,
    boundaryNextBlockNumber: blockNumber + 1,
    boundaryNextBlockHash: blockHash(blockNumber + 1),
    boundaryNextBlockTimestampSec: blockTimestampSec + 2,
    rpcCalls,
    cached: false,
  };
};

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
        return resolvedBlock(date, 3);
      },
      async resolveBlocks(dates): Promise<DayBlockOutcome[]> {
        counts.resolveBatches += 1;
        counts.resolvedDays += dates.length;
        return dates.map((date) => ({
          ok: true as const,
          ...resolvedBlock(date, 1),
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
              ...resolvedBlock(date, 1),
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

// ── A shared failure is charged ONCE, not once per day ───────────────────────
//
// The regression these guard: once #739 made the WINDOW the unit, the three
// shared legs (price load, whole-window chain read, the resolver's head probe)
// began failing every day at once — and each of them charged every day an
// attempt against a per-day ceiling of 3. The queue's degraded retry
// (worker/loop.ts, backoff 2^attempts) lands three executions inside about ten
// seconds, and 'exhausted' is terminal: selectBackfillDays() re-plans only
// undefined and 'failed'. So ten seconds of provider trouble permanently
// retired ten days, recoverable only by hand-written SQL. The suite was green
// throughout, because the shared-fate test above asserts the STATUS and says
// nothing about `attempts`.

test("a shared price-load failure charges NO day an attempt", async () => {
  const { deps } = countingDeps({
    async loadPrices() {
      throw new Error("429 Too Many Requests");
    },
  });

  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ attempts: number }[]>`
    SELECT attempts FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.length).toBe(3);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
});

// A POOL-LEVEL PRICE REFUSAL IS A SHARED LEG TOO, and it is the one that does
// not announce itself by throwing. loadHistoricalPrices gives every symbol it
// resolved a map — empty or not — and leaves a symbol whose pool priced the
// OTHER side of the pair out of the table entirely. Absent therefore means "the
// pool refused", which is the same pool for every day in the window and the same
// answer on every retry; charging it per day walks the whole window to the
// terminal 'exhausted' in about ten seconds, and fixing the pin afterwards no
// longer repairs those days. A blank day inside a PRESENT map is the opposite
// fact — a thin candle, that day's own problem — and still costs an attempt.

function pricesExcept(refusedSymbol: string): WalletBackfillDeps["loadPrices"] {
  return async (assets, fromDate, toDate) => {
    const days: string[] = [];
    for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    const out = new Map<string, Map<string, number>>();
    for (const a of assets) {
      if (a.symbol === refusedSymbol) continue; // refused at the pool: no entry at all
      out.set(a.symbol, new Map(days.map((d) => [d, 2])));
    }
    return out;
  };
}

test("a symbol REFUSED at its pool charges no day an attempt, however often the window is retried", async () => {
  const { deps } = countingDeps({ loadPrices: pricesExcept("BNKR") });

  // One more pass than the per-day ceiling (default 3).
  for (let i = 0; i < 4; i++) await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.length).toBe(3);
  expect(rows.every((r) => r.status === "failed")).toBe(true);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);

  // Still a disclosed gap: refusing to charge the day is not the same as
  // writing it at a price nobody stands behind.
  const [written] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(written!.n).toBe(0);
});

test("a THIN DAY is still charged to that day — the symbol is priced, only this date is blank", async () => {
  const { deps } = countingDeps({
    async loadPrices(assets, fromDate, toDate) {
      const days: string[] = [];
      for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return new Map(
        assets.map((a) => [
          a.symbol,
          new Map(days.filter((d) => !(a.symbol === "BNKR" && d === D2)).map((d) => [d, 2])),
        ]),
      );
    },
  });

  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);
  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ sample_date: Date; status: string; attempts: number }[]>`
    SELECT sample_date, status, attempts FROM wallet_backfill_state
    WHERE sample_date = ANY(${[D1, D2, D3]}::date[]) ORDER BY sample_date
  `;
  const byDay = new Map(rows.map((r) => [r.sample_date.toISOString().slice(0, 10), r]));
  expect(byDay.get(D1)!.status).toBe("filled");
  expect(byDay.get(D3)!.status).toBe("filled");
  expect(byDay.get(D2)!.attempts).toBe(2); // its own problem, its own budget
});

test("repeated shared failures never exhaust a day — it stays re-plannable", async () => {
  const { deps } = countingDeps({
    async loadPrices() {
      throw new Error("429 Too Many Requests");
    },
  });

  // One more pass than the per-day ceiling (default 3). Under the old
  // accounting the third pass flipped every day to 'exhausted' for good.
  for (let i = 0; i < 4; i++) await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.every((r) => r.status === "failed")).toBe(true);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
});

test("a day-specific failure DOES charge that day, and only that day", async () => {
  // One day's block is unreadable; the window's shared legs are fine. That is a
  // refusal attributable to the day, so its ceiling must move — and its
  // siblings' must not.
  const { deps } = countingDeps({
    async resolveBlocks(dates): Promise<DayBlockOutcome[]> {
      return dates.map((date) =>
        date === D2
          ? { ok: false as const, date, error: "block-resolver: no bracket found" }
          : {
              ok: true as const,
              ...resolvedBlock(date, 1),
            },
      );
    },
  });

  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ sample_date: string; status: string; attempts: number }[]>`
    SELECT sample_date::text AS sample_date, status, attempts
      FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[]) ORDER BY sample_date
  `;
  const byDate = new Map(rows.map((r) => [r.sample_date, r]));
  expect(byDate.get(D2)!.attempts).toBe(1);
  expect(byDate.get(D2)!.status).toBe("failed");
  expect(byDate.get(D1)!.attempts).toBe(0);
  expect(byDate.get(D3)!.attempts).toBe(0);
});

test("the resolver's SHARED head-block failure charges no day", async () => {
  // block-resolver flags this one `shared: true` precisely so it is not mistaken
  // for each day's own search failing.
  const { deps } = countingDeps({
    async resolveBlocks(dates): Promise<DayBlockOutcome[]> {
      return dates.map((date) => ({
        ok: false as const,
        date,
        error: "block-resolver: could not read head block 999",
        shared: true,
      }));
    },
  });

  await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);

  const rows = await sql<{ attempts: number }[]>`
    SELECT attempts FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.length).toBe(3);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
});

// ── The shared-leg circuit breaker (issue #761) ──────────────────────────────
//
// The tests above pin the TRANSIENT case: a shared leg that fails and is
// retried moments later — by the queue's own backoff, or by a test loop that
// never advances `now` — must never charge a day's attempt, and (per
// "repeated shared failures never exhaust a day" above) must not reach any
// terminal state either. What was missing is the PERMANENT case: a leg that
// fails identically on every genuinely separate, scheduled run must eventually
// stop being re-selected — while a corrected leg must heal its days again with
// no hand-written SQL. `now` is advanced explicitly between calls below
// (rather than left fixed, as the transient tests do) specifically to
// simulate separate scheduled dispatcher runs rather than one queue-retry
// burst — see bumpDeferStreak()'s debounce comment in wallet-backfill.ts.

test("issue #761 — a permanently refusing shared leg reaches BLOCKED after consecutive SEPARATE runs, still charging no attempt", async () => {
  const { deps } = countingDeps({ loadPrices: pricesExcept("BNKR") });

  // Three genuinely separate scheduled runs (well past the debounce window),
  // simulating a mistyped pin that refuses identically every time.
  let now = NOW;
  for (let i = 0; i < 3; i++) {
    await backfillWalletWindow(sql, [D1, D2, D3], deps, now);
    now = new Date(now.getTime() + 6 * 60_000);
  }

  const rows = await sql<
    { sample_date: string; status: string; attempts: number; defer_leg: string | null; defer_streak: number }[]
  >`
    SELECT sample_date::text AS sample_date, status, attempts, defer_leg, defer_streak
      FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.length).toBe(3);
  expect(rows.every((r) => r.status === "blocked")).toBe(true);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
  expect(rows.every((r) => r.defer_leg === "price-pool:BNKR")).toBe(true);
  expect(rows.every((r) => r.defer_streak === 3)).toBe(true);

  // Still a disclosed gap: reaching the terminal state never writes the day.
  const [written] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(written!.n).toBe(0);
});

test("issue #761 — retries inside the debounce window count as ONE incident, never reaching blocked", async () => {
  const { deps } = countingDeps({ loadPrices: pricesExcept("BNKR") });

  // Five calls five seconds apart — the shape of the queue's own backoff burst
  // (worker/loop.ts), not five separate scheduled runs.
  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await backfillWalletWindow(sql, [D1, D2, D3], deps, now);
    now = new Date(now.getTime() + 5_000);
  }

  const rows = await sql<{ status: string; attempts: number; defer_streak: number }[]>`
    SELECT status, attempts, defer_streak FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.every((r) => r.status === "failed")).toBe(true);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
  expect(rows.every((r) => r.defer_streak === 1)).toBe(true);
});

test("issue #761 — a DIFFERENT shared leg resets the streak rather than inheriting it", async () => {
  const { deps: priceBroken } = countingDeps({ loadPrices: pricesExcept("BNKR") });
  let now = NOW;
  await backfillWalletWindow(sql, [D1, D2, D3], priceBroken, now);
  now = new Date(now.getTime() + 6 * 60_000);
  await backfillWalletWindow(sql, [D1, D2, D3], priceBroken, now);

  // Two consecutive price-pool refusals — one short of the threshold.
  let row = (
    await sql<{ defer_leg: string | null; defer_streak: number; status: string }[]>`
      SELECT defer_leg, defer_streak, status FROM wallet_backfill_state WHERE sample_date = ${D1}
    `
  )[0]!;
  expect(row.defer_leg).toBe("price-pool:BNKR");
  expect(row.defer_streak).toBe(2);
  expect(row.status).toBe("failed");

  // A DIFFERENT leg fails next — a different symptom, not a continuation.
  now = new Date(now.getTime() + 6 * 60_000);
  const base = countingDeps();
  const chainBroken: WalletBackfillDeps = {
    ...base.deps,
    async readChainAmountsAtBlocks() {
      throw new Error("simulated transport outage");
    },
  };
  await backfillWalletWindow(sql, [D1, D2, D3], chainBroken, now);

  row = (
    await sql<{ defer_leg: string | null; defer_streak: number; status: string }[]>`
      SELECT defer_leg, defer_streak, status FROM wallet_backfill_state WHERE sample_date = ${D1}
    `
  )[0]!;
  expect(row.defer_leg).toBe("chain-read-window");
  expect(row.defer_streak).toBe(1); // NOT 3 — the old price-pool streak does not carry over
  expect(row.status).toBe("failed");
});

test("issue #761 — a BLOCKED day heals itself the moment the leg is fixed, no hand-written SQL", async () => {
  const { deps: broken } = countingDeps({ loadPrices: pricesExcept("BNKR") });
  let now = NOW;
  for (let i = 0; i < 3; i++) {
    await backfillWalletWindow(sql, [D1, D2, D3], broken, now);
    now = new Date(now.getTime() + 6 * 60_000);
  }
  const [before] = await sql<{ status: string }[]>`SELECT status FROM wallet_backfill_state WHERE sample_date = ${D1}`;
  expect(before!.status).toBe("blocked");

  // The pin is corrected: BNKR prices again. This stands in for the automatic
  // cooldown-elapsed retry planWalletBackfill() issues once
  // WALLET_BACKFILL_LEG_RETRY_COOLDOWN_MINUTES has passed — no operator, no SQL.
  const { deps: fixed } = countingDeps();
  const out = await backfillWalletWindow(sql, [D1, D2, D3], fixed, now);
  expect(out.every((r) => r.status === "filled")).toBe(true);

  const rows = await sql<{ status: string; defer_leg: string | null; defer_streak: number; attempts: number }[]>`
    SELECT status, defer_leg, defer_streak, attempts FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2, D3]}::date[])
  `;
  expect(rows.every((r) => r.status === "filled")).toBe(true);
  expect(rows.every((r) => r.defer_leg === null)).toBe(true);
  expect(rows.every((r) => r.defer_streak === 0)).toBe(true);
  expect(rows.every((r) => r.attempts === 0)).toBe(true);
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

test("re-running a window over already-filled days writes nothing new, spends nothing, and KEEPS the checkpoint", async () => {
  const { deps, counts } = countingDeps();
  await backfillWalletWindow(sql, [D1, D2], deps, NOW);
  const [before] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2]}::date[])
  `;
  const checkpointBefore = await sql<{ sample_date: string; status: string; balance_rows: number }[]>`
    SELECT sample_date::text AS sample_date, status, balance_rows
      FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2]}::date[]) ORDER BY sample_date
  `;
  const spentBefore = counts.resolvedDays;

  const second = await backfillWalletWindow(sql, [D1, D2], deps, NOW);

  // The days come back as the FILLED days they are. They used to be re-executed
  // and come back 'skipped, 0 rows, already populated', which overwrote the
  // record of a real repair with a record of a no-op — and that record is what
  // §7.1's completion observation grades.
  expect(second.every((r) => r.status === "filled")).toBe(true);

  // Nothing new written, and — the part the old behaviour got wrong — nothing
  // UNWRITTEN either: the checkpoint still says what the first pass did.
  const [after] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2]}::date[])
  `;
  expect(after!.n).toBe(before!.n);
  const checkpointAfter = await sql<{ sample_date: string; status: string; balance_rows: number }[]>`
    SELECT sample_date::text AS sample_date, status, balance_rows
      FROM wallet_backfill_state WHERE sample_date = ANY(${[D1, D2]}::date[]) ORDER BY sample_date
  `;
  expect(checkpointAfter).toEqual(checkpointBefore);

  // And the retry costs no provider budget: settled days never reach the
  // resolver, let alone the chain read.
  expect(counts.resolvedDays).toBe(spentBefore);
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

test("a window reads every day's legs in ONE multi-block pass, each at its own block", async () => {
  // The last of the three per-day fan-outs to be collapsed. The assertion that
  // matters is not the call count but that each day still got ITS OWN block:
  // one batched read serving every day the FIRST day's balances would be the
  // silent-wrong-number failure markets §7 warns about.
  const seen: { tags: readonly string[]; calls: number } = { tags: [], calls: 0 };
  const base = countingDeps();
  const deps: WalletBackfillDeps = {
    ...base.deps,
    async readChainAmountsAtBlocks(reads, _label, blockTags) {
      seen.calls += 1;
      seen.tags = blockTags;
      // Amount encodes the block, so a day served the wrong block's map shows up
      // as the wrong value_usd below.
      return new Map(
        blockTags.map((tag) => [
          tag,
          new Map(reads.map((r) => [r.key, { ok: true, amount: parseInt(tag, 16) } as ChainAmount])),
        ]),
      );
    },
    async readChainAmounts() {
      throw new Error("per-day read must not be used when the batched reader is available");
    },
  };

  const out = await backfillWalletWindow(sql, [D1, D2, D3], deps, NOW);
  expect(out.every((r) => r.status === "filled")).toBe(true);
  expect(seen.calls).toBe(1); // ONE pass for three days
  expect([...seen.tags]).toEqual([D1, D2, D3].map((d) => "0x" + blockFor(d).toString(16)));

  // Each day's persisted amount is its OWN block's, not the window's first.
  const rows = await sql<{ sample_date: Date; amount: string }[]>`
    SELECT sample_date, min(amount)::text AS amount FROM wallet_balance_samples
     WHERE sample_date = ANY(${[D1, D2, D3]}::date[]) GROUP BY sample_date ORDER BY sample_date
  `;
  expect(rows.map((r) => Number(r.amount))).toEqual([D1, D2, D3].map((d) => blockFor(d)));
});

test("a window-wide chain-read failure fails every day it covered, and writes none", async () => {
  const base = countingDeps();
  const deps: WalletBackfillDeps = {
    ...base.deps,
    async readChainAmountsAtBlocks() {
      throw new Error("simulated transport outage");
    },
  };

  const out = await backfillWalletWindow(sql, [D1, D2], deps, NOW);
  expect(out.every((r) => r.status === "failed")).toBe(true);
  expect(out.every((r) => (r.detail ?? "").includes("simulated transport outage"))).toBe(true);
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ANY(${[D1, D2]}::date[])
  `;
  expect(row!.n).toBe(0);
});

test("an empty window is a no-op, not a throw", async () => {
  const { deps, counts } = countingDeps();
  expect(await backfillWalletWindow(sql, [], deps, NOW)).toEqual([]);
  expect(counts.resolveBatches).toBe(0);
  expect(counts.priceLoads).toBe(0);
});
