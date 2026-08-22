// Lockstep MULTI-DAY block resolution (resolveDayBlocks). Fully offline against
// the same deterministic fixture chain tests/block-resolver.test.ts uses.
//
// THE CENTRAL ASSERTION IS EQUIVALENCE. A faster resolver that returns a
// different block is not an optimisation, it is a data corruption with better
// latency — the balance would be real, the date would look right, and the two
// would not belong together. So the first test does not check "close enough" or
// even the bracket property in isolation: it runs the ORIGINAL one-day-at-a-time
// resolver and the batched one over the same days and demands identical
// answers. Everything else here is secondary to that.
//
// The second thing worth pinning is the actual win: sequential depth must stay
// flat as the number of days grows, because that is the whole claim. Ten days
// costing ten times one day would mean the lockstep loop is not in lockstep.
import { expect, test } from "bun:test";
import {
  dayEndExclusiveSec,
  nullDayBlockCache,
  RESOLVER_CALL_BUDGET,
  resolveDayBlock,
  resolveDayBlocks,
  type BlockProbe,
  type DayBlockCache,
  type ResolveDayBlockDeps,
  type ResolveDayBlocksDeps,
} from "../src/chain/block-resolver.ts";

const OPTS = { rpcUrl: "https://mainnet.base.org" };
const GENESIS_SEC = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
const HEAD = 2_000_000;
const AFTER = new Date("2026-03-01T00:00:00Z");

const ts = (n: number, blockTimeSec = 2): number => GENESIS_SEC + n * blockTimeSec;

/** The single-day deps, for the equivalence comparison. */
function singleChain(blockTimeSec = 2): ResolveDayBlockDeps {
  return {
    async latestBlockNumber() {
      return HEAD;
    },
    async blockAt(n) {
      if (n < 0 || n > HEAD) throw new Error(`no block ${n}`);
      return { number: n, timestampSec: ts(n, blockTimeSec) };
    },
  };
}

/** The batched deps. `rounds` counts HTTP HITS — the unit the provider meters
 *  and therefore the unit this file's performance claim is denominated in. */
function batchedChain(
  blockTimeSec = 2,
  opts: { missing?: Set<number>; throwOn?: Set<number> } = {},
): { deps: ResolveDayBlocksDeps; rounds: number[]; probes: number[] } {
  const rounds: number[] = [];
  const probes: number[] = [];
  return {
    rounds,
    probes,
    deps: {
      async latestBlockNumber() {
        return HEAD;
      },
      async blocksAt(numbers): Promise<BlockProbe[]> {
        rounds.push(numbers.length);
        probes.push(...numbers);
        return numbers.map((n) => {
          if (opts.throwOn?.has(n)) return { ok: false, error: `probe of ${n} exploded` };
          if (opts.missing?.has(n) || n < 0 || n > HEAD) return { ok: false, error: `no block ${n}` };
          return { ok: true, stamp: { number: n, timestampSec: ts(n, blockTimeSec) } };
        });
      },
    },
  };
}

const DAYS = ["2026-01-02", "2026-01-09", "2026-01-15", "2026-01-22", "2026-02-01", "2026-02-11"];

// ── Equivalence: the batched answer IS the sequential answer ─────────────────

test("EQUIVALENCE: batched resolution returns exactly what one-at-a-time resolution returns", async () => {
  const sequential = [];
  for (const d of DAYS) {
    const r = await resolveDayBlock(d, OPTS, nullDayBlockCache, singleChain(), AFTER);
    sequential.push({ date: r.date, blockNumber: r.blockNumber, blockTimestampSec: r.blockTimestampSec });
  }

  const { deps } = batchedChain();
  const batched = await resolveDayBlocks(DAYS, OPTS, nullDayBlockCache, deps, AFTER);

  expect(batched.map((r) => (r.ok ? { date: r.date, blockNumber: r.blockNumber, blockTimestampSec: r.blockTimestampSec } : r))).toEqual(
    sequential,
  );
});

test("EQUIVALENCE holds on an off-nominal cadence too (the 2s constant is never trusted)", async () => {
  // 3-second blocks. The self-correcting estimate must still land on the exact
  // boundary — this is the case where an arithmetic shortcut from a cached
  // neighbour would silently return the wrong block.
  const sequential = [];
  for (const d of DAYS) {
    const r = await resolveDayBlock(d, OPTS, nullDayBlockCache, singleChain(3), AFTER);
    sequential.push({ date: r.date, blockNumber: r.blockNumber });
  }
  const { deps } = batchedChain(3);
  const batched = await resolveDayBlocks(DAYS, OPTS, nullDayBlockCache, deps, AFTER);
  expect(batched.map((r) => (r.ok ? { date: r.date, blockNumber: r.blockNumber } : r))).toEqual(sequential);
});

test("the bracket property holds exactly for every day in a batch", async () => {
  const { deps } = batchedChain();
  const out = await resolveDayBlocks(DAYS, OPTS, nullDayBlockCache, deps, AFTER);
  for (const r of out) {
    expect(r.ok).toBe(true);
    if (!r.ok) continue;
    const endSec = dayEndExclusiveSec(r.date);
    expect(r.blockTimestampSec).toBe(ts(r.blockNumber));
    expect(r.blockTimestampSec).toBeLessThan(endSec); // inside the day
    expect(ts(r.blockNumber + 1)).toBeGreaterThanOrEqual(endSec); // the next is not
    expect(new Date(r.blockTimestampSec * 1000).toISOString().slice(0, 10)).toBe(r.date);
  }
});

// ── The win: sequential depth is flat in the number of days ──────────────────

test("HTTP hits stay ~flat as days grow — 12 days cost about what 1 day costs", async () => {
  const one = batchedChain();
  await resolveDayBlocks(["2026-01-20"], OPTS, nullDayBlockCache, one.deps, AFTER);

  const many = batchedChain();
  const twelve = Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 2).padStart(2, "0")}`);
  await resolveDayBlocks(twelve, OPTS, nullDayBlockCache, many.deps, AFTER);

  // The claim is about ROUNDS (hits), not probes. Probes still scale with days;
  // that is fine, because they ride together.
  expect(many.rounds.length).toBeLessThanOrEqual(one.rounds.length + 2);
  expect(many.probes.length).toBeGreaterThan(one.probes.length * 5); // same work…
  // …one hit per round, carrying up to one probe per outstanding day.
  expect(Math.max(...many.rounds)).toBeGreaterThan(1);
});

test("every day still respects the per-day probe budget", async () => {
  const { deps } = batchedChain();
  const out = await resolveDayBlocks(DAYS, OPTS, nullDayBlockCache, deps, AFTER);
  for (const r of out) if (r.ok) expect(r.rpcCalls).toBeLessThanOrEqual(RESOLVER_CALL_BUDGET);
});

// ── Per-day failure isolation ────────────────────────────────────────────────

test("a day whose probe fails fails ALONE — its siblings still resolve", async () => {
  // Kill the exact block one day needs to finish bracketing.
  const probe = batchedChain();
  const target = await resolveDayBlock("2026-01-15", OPTS, nullDayBlockCache, singleChain(), AFTER);
  const { deps } = batchedChain(2, { throwOn: new Set([target.blockNumber, target.blockNumber + 1]) });

  const out = await resolveDayBlocks(DAYS, OPTS, nullDayBlockCache, deps, AFTER);
  const failed = out.filter((r) => !r.ok);
  expect(failed.length).toBe(1);
  expect(failed[0]!.ok === false && failed[0]!.date).toBe("2026-01-15");
  expect(out.filter((r) => r.ok).length).toBe(DAYS.length - 1);
  expect(probe.rounds.length).toBe(0); // sanity: the unused fixture stayed unused
});

test("an OPEN day is refused without consuming a probe, and does not spoil the batch", async () => {
  const { deps, rounds } = batchedChain();
  // 2026-02-11 has not closed as of this `now`.
  const now = new Date("2026-02-11T12:00:00Z");
  const out = await resolveDayBlocks(["2026-02-09", "2026-02-11"], OPTS, nullDayBlockCache, deps, now);

  expect(out[0]!.ok).toBe(true);
  expect(out[1]!.ok).toBe(false);
  expect(out[1]!.ok === false && out[1]!.error).toMatch(/has not closed yet/);
  expect(rounds.length).toBeGreaterThan(0); // the closed day still resolved
});

test("a malformed date is reported per-day, never thrown at the batch", async () => {
  const { deps } = batchedChain();
  const out = await resolveDayBlocks(["2026-01-05", "not-a-date"], OPTS, nullDayBlockCache, deps, AFTER);
  expect(out[0]!.ok).toBe(true);
  expect(out[1]!.ok).toBe(false);
});

// ── The permanent cache ──────────────────────────────────────────────────────

test("cached days cost ZERO hits and are returned beside freshly resolved ones", async () => {
  const store = new Map<string, { blockNumber: number; blockTimestampSec: number }>();
  const cache: DayBlockCache = {
    async get(d) {
      return store.get(d) ?? null;
    },
    async set(d, blockNumber, blockTimestampSec) {
      store.set(d, { blockNumber, blockTimestampSec });
    },
  };

  const first = batchedChain();
  const a = await resolveDayBlocks(DAYS, OPTS, cache, first.deps, AFTER);
  expect(first.rounds.length).toBeGreaterThan(0);
  expect(store.size).toBe(DAYS.length);

  // Second pass over the SAME window: every day is a cache hit, so the chain is
  // never touched at all — not even for the head.
  const second = batchedChain();
  const b = await resolveDayBlocks(DAYS, OPTS, cache, second.deps, AFTER);
  expect(second.rounds.length).toBe(0);
  expect(b.every((r) => r.ok && r.cached && r.rpcCalls === 0)).toBe(true);
  expect(b.map((r) => (r.ok ? r.blockNumber : null))).toEqual(a.map((r) => (r.ok ? r.blockNumber : null)));
});

test("a partially cached window resolves only the misses", async () => {
  const store = new Map<string, { blockNumber: number; blockTimestampSec: number }>();
  const cache: DayBlockCache = {
    async get(d) {
      return store.get(d) ?? null;
    },
    async set(d, blockNumber, blockTimestampSec) {
      store.set(d, { blockNumber, blockTimestampSec });
    },
  };
  const warm = batchedChain();
  await resolveDayBlocks(DAYS.slice(0, 3), OPTS, cache, warm.deps, AFTER);

  const cold = batchedChain();
  const out = await resolveDayBlocks(DAYS, OPTS, cache, cold.deps, AFTER);
  expect(out.every((r) => r.ok)).toBe(true);
  expect(out.slice(0, 3).every((r) => r.ok && r.cached)).toBe(true);
  expect(out.slice(3).every((r) => r.ok && !r.cached)).toBe(true);
  // Only the three misses rode the rounds.
  expect(Math.max(...cold.rounds)).toBeLessThanOrEqual(3);
});

test("an empty date list touches nothing", async () => {
  const { deps, rounds } = batchedChain();
  expect(await resolveDayBlocks([], OPTS, nullDayBlockCache, deps, AFTER)).toEqual([]);
  expect(rounds.length).toBe(0);
});
