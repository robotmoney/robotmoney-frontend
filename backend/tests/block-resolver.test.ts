// date → block resolution (issue #709, markets §5.2). Fully offline: the chain is a
// deterministic fixture (2-second blocks from a fixed genesis) injected through
// ResolveDayBlockDeps, so every assertion is about the ALGORITHM — the bracket
// property, the probe budget, the permanent cache, and the refusal to resolve a
// day that has not closed.
//
// THE BRACKET PROPERTY IS THE WHOLE TEST. A resolver that returns a block
// "near" the right day produces a balance that is plausible and wrong, filed
// under a date that looks right. So the assertion is not "close enough": it is
// block.timestamp < next UTC midnight ≤ (block+1).timestamp, exactly.
import { expect, test } from "bun:test";
import {
  dayEndExclusiveSec,
  nullDayBlockCache,
  RESOLVER_CALL_BUDGET,
  resolveDayBlock,
  type DayBlockCache,
  type CachedDayBlockProof,
  type ResolveDayBlockDeps,
} from "../src/chain/block-resolver.ts";

const OPTS = { rpcUrl: "https://mainnet.base.org" };

// A fixture chain: block 0 at 2026-01-01T00:00:00Z, one block every 2 seconds.
const GENESIS_SEC = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
const HEAD = 2_000_000; // 2026-01-01 + ~46 days
const blockHash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

function fixtureChain(blockTimeSec = 2): { deps: ResolveDayBlockDeps; probes: number[] } {
  const probes: number[] = [];
  return {
    probes,
    deps: {
      async latestBlockNumber() {
        return HEAD;
      },
      async blockAt(n) {
        probes.push(n);
        if (n < 0 || n > HEAD) throw new Error(`no block ${n}`);
        return { number: n, hash: blockHash(n), timestampSec: GENESIS_SEC + n * blockTimeSec };
      },
    },
  };
}

const AFTER = new Date("2026-03-01T00:00:00Z"); // well past every day tested below

test("resolves the LAST block of the day — the bracket property holds exactly", async () => {
  for (const date of ["2026-01-02", "2026-01-15", "2026-02-01"]) {
    const { deps } = fixtureChain();
    const resolved = await resolveDayBlock(date, OPTS, nullDayBlockCache, deps, AFTER);
    const endSec = dayEndExclusiveSec(date);
    const ts = (n: number): number => GENESIS_SEC + n * 2;

    expect(resolved.blockTimestampSec).toBe(ts(resolved.blockNumber));
    expect(resolved.blockTimestampSec).toBeLessThan(endSec); // inside the day
    expect(resolved.blockHash).toBe(blockHash(resolved.blockNumber));
    expect(resolved.boundaryNextBlockNumber).toBe(resolved.blockNumber + 1);
    expect(resolved.boundaryNextBlockHash).toBe(blockHash(resolved.blockNumber + 1));
    expect(resolved.boundaryNextBlockTimestampSec).toBeGreaterThanOrEqual(endSec); // the next one is not
  }
});

test("the closing block belongs to the day it names, not the next one", async () => {
  const { deps } = fixtureChain();
  const resolved = await resolveDayBlock("2026-01-10", OPTS, nullDayBlockCache, deps, AFTER);
  expect(new Date(resolved.blockTimestampSec * 1000).toISOString().slice(0, 10)).toBe("2026-01-10");
});

test("stays within the probe budget on an exact-cadence chain", async () => {
  const { deps, probes } = fixtureChain();
  const resolved = await resolveDayBlock("2026-01-20", OPTS, nullDayBlockCache, deps, AFTER);
  expect(resolved.rpcCalls).toBeLessThanOrEqual(RESOLVER_CALL_BUDGET);
  expect(probes.length).toBeLessThanOrEqual(RESOLVER_CALL_BUDGET);
});

test("an off-nominal cadence still brackets correctly (the estimate is only an estimate)", async () => {
  // 3-second blocks: the 2s assumption undershoots, so the walk has to finish
  // the job. A resolver that trusted the constant would land on the wrong day.
  const blockTime = 3;
  const { deps } = fixtureChain(blockTime);
  const resolved = await resolveDayBlock("2026-01-03", OPTS, nullDayBlockCache, deps, AFTER);
  const endSec = dayEndExclusiveSec("2026-01-03");
  const ts = (n: number): number => GENESIS_SEC + n * blockTime;
  expect(resolved.blockTimestampSec).toBeLessThan(endSec);
  expect(ts(resolved.blockNumber + 1)).toBeGreaterThanOrEqual(endSec);
});

test("refuses a day that has not closed — an open day has no closing block", async () => {
  const { deps, probes } = fixtureChain();
  const duringTheDay = new Date("2026-01-10T13:00:00Z");
  await expect(resolveDayBlock("2026-01-10", OPTS, nullDayBlockCache, deps, duringTheDay)).rejects.toThrow(
    /has not closed yet/,
  );
  expect(probes).toHaveLength(0); // and it costs nothing to refuse
});

test("refuses a day the chain has not reached", async () => {
  const { deps } = fixtureChain();
  // HEAD is at 2026-02-16-ish; ask for a day past it while pretending 'now' is later.
  await expect(
    resolveDayBlock("2026-02-28", OPTS, nullDayBlockCache, deps, new Date("2026-03-05T00:00:00Z")),
  ).rejects.toThrow(/not in the chain's past/);
});

test("refuses an RPC response whose block number does not equal the requested number", async () => {
  const deps: ResolveDayBlockDeps = {
    async latestBlockNumber() {
      return HEAD;
    },
    async blockAt(n) {
      return { number: n + 1, hash: blockHash(n + 1), timestampSec: GENESIS_SEC + n * 2 };
    },
  };
  await expect(resolveDayBlock("2026-01-07", OPTS, nullDayBlockCache, deps, AFTER)).rejects.toThrow(
    new RegExp(`requested block ${HEAD} but RPC returned block ${HEAD + 1}`),
  );
});

test("the cache is PERMANENT: a second resolution of the same day costs zero RPC", async () => {
  const store = new Map<string, CachedDayBlockProof>();
  const cache: DayBlockCache = {
    async get(date) {
      return store.get(date) ?? null;
    },
    async set(date, proof) {
      store.set(date, proof);
    },
  };

  const first = fixtureChain();
  const a = await resolveDayBlock("2026-01-07", OPTS, cache, first.deps, AFTER);
  expect(a.cached).toBe(false);
  expect(first.probes.length).toBeGreaterThan(0);

  const second = fixtureChain();
  const b = await resolveDayBlock("2026-01-07", OPTS, cache, second.deps, AFTER);
  expect(b.cached).toBe(true);
  expect(b.rpcCalls).toBe(0);
  expect(second.probes).toHaveLength(0);
  expect(b.blockNumber).toBe(a.blockNumber);
  expect(b.boundaryNextBlockHash).toBe(a.boundaryNextBlockHash);
});

test("an incomplete legacy cache row is re-resolved and replaced with boundary proof", async () => {
  let stored: CachedDayBlockProof = {
    blockNumber: 1,
    blockHash: null,
    blockTimestampSec: GENESIS_SEC + 2,
    boundaryNextBlockNumber: null,
    boundaryNextBlockHash: null,
    boundaryNextBlockTimestampSec: null,
  };
  let writes = 0;
  const cache: DayBlockCache = {
    async get() {
      return stored;
    },
    async set(_date, proof) {
      writes += 1;
      stored = proof;
    },
  };
  const chain = fixtureChain();
  const resolved = await resolveDayBlock("2026-01-07", OPTS, cache, chain.deps, AFTER);
  expect(resolved.cached).toBe(false);
  expect(chain.probes.length).toBeGreaterThan(0);
  expect(writes).toBe(1);
  expect(stored.blockHash).toBe(blockHash(stored.blockNumber));
  expect(stored.boundaryNextBlockNumber).toBe(stored.blockNumber + 1);
});

test("a structurally populated but invalid cache proof is rejected and overwritten", async () => {
  let stored: CachedDayBlockProof = {
    blockNumber: 1,
    blockHash: blockHash(1),
    blockTimestampSec: GENESIS_SEC + 2,
    boundaryNextBlockNumber: 3,
    boundaryNextBlockHash: blockHash(3),
    boundaryNextBlockTimestampSec: GENESIS_SEC + 6,
  };
  let writes = 0;
  const cache: DayBlockCache = {
    async get() {
      return stored;
    },
    async set(_date, proof) {
      stored = proof;
      writes += 1;
    },
  };
  const chain = fixtureChain();
  const resolved = await resolveDayBlock("2026-01-07", OPTS, cache, chain.deps, AFTER);
  expect(resolved.cached).toBe(false);
  expect(writes).toBe(1);
  expect(stored.boundaryNextBlockNumber).toBe(stored.blockNumber + 1);
});

test("a malformed date is refused before any RPC", async () => {
  const { deps, probes } = fixtureChain();
  await expect(resolveDayBlock("07/01/2026", OPTS, nullDayBlockCache, deps, AFTER)).rejects.toThrow(
    /not an ISO calendar day/,
  );
  expect(probes).toHaveLength(0);
});
