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
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { resolvePropWallets, resolveTrackedAssets } from "../src/config.ts";
import { QUARANTINED_PROVENANCE } from "../src/chain/wallet-valuation.ts";
import {
  backfillWalletDay,
  lastClosedDay,
  missingDaysFromReport,
  selectBackfillDays,
  type WalletBackfillDeps,
} from "../src/ops/wallet-backfill.ts";
import type { ChainAmount, KeyedAssetRead } from "../src/chain/wallet-valuation.ts";
import {
  lockWalletSnapshotDate,
  resolveWalletSnapshotManifest,
} from "../src/ops/wallet-snapshot-manifest.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

// Deliberately far outside the real series window (seriesStart 2026-03-18) so
// these fixtures cannot perturb any other suite's gap assertions on the shared
// ephemeral database.
const D1 = "2019-06-05";
const D2 = "2019-06-06";
const D3 = "2019-06-07";
const D4 = "2019-06-09";
const NOW = new Date("2019-06-10T09:00:00Z");
const ALL_DAYS = [D1, D2, D3, D4];
const BLOCK = 1_234_567;
const BLOCK_TS = Math.floor(Date.parse(`${D1}T23:59:58Z`) / 1000);

async function cleanup(): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS wallet_backfill_test_fail_sleeve ON wallet_sleeve_samples`;
  await sql`DROP FUNCTION IF EXISTS wallet_backfill_test_fail_sleeve()`;
  await sql`DROP TRIGGER IF EXISTS wallet_backfill_test_fail_checkpoint ON wallet_backfill_state`;
  await sql`DROP FUNCTION IF EXISTS wallet_backfill_test_fail_checkpoint()`;
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
  const manifest = resolveWalletSnapshotManifest();
  expect(state!.balance_rows).toBe(manifest.balanceAssets.length);
  expect(state!.sleeve_rows).toBe(manifest.sleeveKeys.length);
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

test("an incomplete populated day is rebuilt completely while preserving its original row as evidence", async () => {
  const [original] = await sql<{ id: string }[]>`
    INSERT INTO wallet_balance_samples (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D1}, 'USDC', 111, 1, 111, 'live', now())
    RETURNING id
  `;
  const result = await backfillWalletDay(sql, D1, happyDeps(), NOW);

  const [row] = await sql<{ amount: string; provenance: string }[]>`
    SELECT amount, provenance FROM wallet_balance_samples WHERE sample_date = ${D1} AND symbol = 'USDC'
  `;
  expect(result.status).toBe("filled");
  expect(Number(row!.amount)).toBe(5);
  expect(row!.provenance).toBe("backfilled");

  const [evidence] = await sql<{ amount: string; provenance: string; evidence_reason: string }[]>`
    SELECT amount, provenance, evidence_reason
      FROM wallet_balance_sample_evidence
     WHERE original_id = ${original!.id}
  `;
  expect(Number(evidence!.amount)).toBe(111);
  expect(evidence!.provenance).toBe("live");
  expect(evidence!.evidence_reason).toBe("incomplete-snapshot-replacement");

  const manifest = resolveWalletSnapshotManifest();
  const [balances] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;
  const [sleeves] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${D1}`;
  expect(balances!.n).toBe(manifest.balanceAssets.length);
  expect(sleeves!.n).toBe(manifest.sleeveKeys.length);
});

test("quarantined rows remain immutable evidence and their logical keys accept verified replacements", async () => {
  const sleeveTarget = resolveWalletSnapshotManifest().sleeveKeys[0]!;
  const [original] = await sql<{ id: string }[]>`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D2}, 'WETH', 5, 50000, 250000, ${QUARANTINED_PROVENANCE}, now())
    RETURNING id
  `;
  const [originalSleeve] = await sql<{ id: string }[]>`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${D2}, ${sleeveTarget.walletAddress}, ${sleeveTarget.asset.symbol}, 5, 50000, 250000,
       ${QUARANTINED_PROVENANCE}, now())
    RETURNING id
  `;

  const result = await backfillWalletDay(sql, D2, happyDeps(), NOW);
  expect(result.status).toBe("filled");

  const [replacement] = await sql<{ amount: string; price_usd: string; provenance: string }[]>`
    SELECT amount, price_usd, provenance
      FROM wallet_balance_samples
     WHERE sample_date = ${D2} AND symbol = 'WETH'
  `;
  expect(Number(replacement!.amount)).toBe(5);
  expect(Number(replacement!.price_usd)).toBe(2);
  expect(replacement!.provenance).toBe("backfilled");

  const [evidence] = await sql<{ price_usd: string; provenance: string; evidence_reason: string }[]>`
    SELECT price_usd, provenance, evidence_reason
      FROM wallet_balance_sample_evidence
     WHERE original_id = ${original!.id}
  `;
  expect(Number(evidence!.price_usd)).toBe(50000);
  expect(evidence!.provenance).toBe(QUARANTINED_PROVENANCE);
  expect(evidence!.evidence_reason).toBe("quarantined-replacement");
  const [sleeveReplacement] = await sql<{ price_usd: string; provenance: string }[]>`
    SELECT price_usd, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = ${D2}
       AND wallet_address = ${sleeveTarget.walletAddress}
       AND symbol = ${sleeveTarget.asset.symbol}
  `;
  expect(Number(sleeveReplacement!.price_usd)).toBe(2);
  expect(sleeveReplacement!.provenance).toBe("backfilled");
  const [sleeveEvidence] = await sql<{ price_usd: string; evidence_reason: string }[]>`
    SELECT price_usd, evidence_reason
      FROM wallet_sleeve_sample_evidence
     WHERE original_id = ${originalSleeve!.id}
  `;
  expect(Number(sleeveEvidence!.price_usd)).toBe(50000);
  expect(sleeveEvidence!.evidence_reason).toBe("quarantined-replacement");
  let guardError: unknown;
  try {
    await sql`UPDATE wallet_balance_sample_evidence SET price_usd = 2 WHERE original_id = ${original!.id}`;
  } catch (err) {
    guardError = err;
  }
  expect(String(guardError)).toContain("immutable AUM evidence");
});

test("a checkpoint failure rolls archive/delete/replacement/checkpoint back over existing rows and remains retryable", async () => {
  const sleeveTarget = resolveWalletSnapshotManifest().sleeveKeys[0]!;
  const [originalBalance] = await sql<{ id: string }[]>`
    INSERT INTO wallet_balance_samples
      (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES (${D3}, 'USDC', 111.125, 1.0001, 111.1361125, 'live', '2019-06-07T23:57:00Z')
    RETURNING id
  `;
  const [originalSleeve] = await sql<{ id: string }[]>`
    INSERT INTO wallet_sleeve_samples
      (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
    VALUES
      (${D3}, ${sleeveTarget.walletAddress}, ${sleeveTarget.asset.symbol},
       222.25, 3.5, 777.875, 'seed', '2019-06-07T23:58:00Z')
    RETURNING id
  `;
  await sql`
    INSERT INTO wallet_backfill_state
      (sample_date, status, attempts, balance_rows, sleeve_rows, detail, attempted_at)
    VALUES (${D3}, 'failed', 3, 1, 1, 'pre-existing retryable checkpoint', now())
  `;
  await sql.unsafe(`
    CREATE FUNCTION wallet_backfill_test_fail_checkpoint() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.sample_date = DATE '2019-06-07' AND NEW.status = 'filled' THEN
        RAISE EXCEPTION 'injected filled-checkpoint failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER wallet_backfill_test_fail_checkpoint
      BEFORE INSERT OR UPDATE ON wallet_backfill_state
      FOR EACH ROW EXECUTE FUNCTION wallet_backfill_test_fail_checkpoint();
  `);

  const failed = await backfillWalletDay(sql, D3, happyDeps(), NOW);
  expect(failed.status).toBe("failed");
  expect(failed.ok).toBe(false);
  expect(failed.detail).toContain("injected filled-checkpoint failure");

  const balances = await sql<{ id: string; symbol: string; amount: string; price_usd: string; value_usd: string; provenance: string }[]>`
    SELECT id, symbol, amount::text, price_usd::text, value_usd::text, provenance
      FROM wallet_balance_samples WHERE sample_date = ${D3}
  `;
  expect([...balances]).toEqual([{
    id: originalBalance!.id,
    symbol: "USDC",
    amount: "111.125",
    price_usd: "1.0001",
    value_usd: "111.1361125",
    provenance: "live",
  }]);
  const sleeves = await sql<{ id: string; wallet_address: string; symbol: string; amount: string; price_usd: string; value_usd: string; provenance: string }[]>`
    SELECT id, wallet_address, symbol, amount::text, price_usd::text, value_usd::text, provenance
      FROM wallet_sleeve_samples WHERE sample_date = ${D3}
  `;
  expect([...sleeves]).toEqual([{
    id: originalSleeve!.id,
    wallet_address: sleeveTarget.walletAddress,
    symbol: sleeveTarget.asset.symbol,
    amount: "222.25",
    price_usd: "3.5",
    value_usd: "777.875",
    provenance: "seed",
  }]);
  const [archived] = await sql<{ n: number }[]>`
    SELECT
      (SELECT count(*) FROM wallet_balance_sample_evidence WHERE original_id = ${originalBalance!.id})::int +
      (SELECT count(*) FROM wallet_sleeve_sample_evidence WHERE original_id = ${originalSleeve!.id})::int AS n
  `;
  expect(archived!.n).toBe(0);
  const [state] = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM wallet_backfill_state WHERE sample_date = ${D3}
  `;
  expect(state).toEqual({ status: "failed", attempts: 3 });
  expect(selectBackfillDays([D3], new Map([[D3, state!.status]]), 1).days).toEqual([D3]);

  await sql`DROP TRIGGER wallet_backfill_test_fail_checkpoint ON wallet_backfill_state`;
  await sql`DROP FUNCTION wallet_backfill_test_fail_checkpoint()`;
  const retried = await backfillWalletDay(sql, D3, happyDeps(), NOW);
  expect(retried.status).toBe("filled");
});

test("concurrent live writer and repair serialize before archival, preserving the writer and committing only a complete filled day", async () => {
  const workerSource = readFileSync(new URL("../src/worker/handlers/wallet.ts", import.meta.url), "utf8");
  expect([...workerSource.matchAll(/lockWalletSnapshotDate\(tx, sampleDate\)/g)]).toHaveLength(2);

  const sleeveTarget = resolveWalletSnapshotManifest().sleeveKeys[0]!;
  const writerDb = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "wallet-live-writer-race" },
  });
  let releaseWriter!: () => void;
  const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerReady!: (ids: { balanceId: string; sleeveId: string }) => void;
  const writerStarted = new Promise<{ balanceId: string; sleeveId: string }>((resolve) => { writerReady = resolve; });

  const writer = writerDb.begin(async (tx) => {
    await lockWalletSnapshotDate(tx, D4);
    const [balance] = await tx<{ id: string }[]>`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES (${D4}, 'USDC', 333.125, 1.0002, 333.191625, 'live', '2019-06-09T23:57:00Z')
      RETURNING id
    `;
    const [sleeve] = await tx<{ id: string }[]>`
      INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${D4}, ${sleeveTarget.walletAddress}, ${sleeveTarget.asset.symbol},
         444.25, 4.5, 1999.125, 'live', '2019-06-09T23:58:00Z')
      RETURNING id
    `;
    writerReady({ balanceId: balance!.id, sleeveId: sleeve!.id });
    await writerRelease;
  });

  const writerIds = await writerStarted;
  const [invisibleWhileUncommitted] = await sql<{ balances: number; sleeves: number }[]>`
    SELECT
      (SELECT count(*) FROM wallet_balance_samples WHERE sample_date = ${D4})::int AS balances,
      (SELECT count(*) FROM wallet_sleeve_samples WHERE sample_date = ${D4})::int AS sleeves
  `;
  expect(invisibleWhileUncommitted).toEqual({ balances: 0, sleeves: 0 });

  const repair = backfillWalletDay(sql, D4, happyDeps(), NOW);
  let observedBlockedRepair = false;
  try {
    for (let i = 0; i < 200; i++) {
      const [waiting] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE '%pg_advisory_xact_lock%'
           AND pid <> pg_backend_pid()
      `;
      if ((waiting?.n ?? 0) > 0) {
        observedBlockedRepair = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedBlockedRepair).toBe(true);
  } finally {
    releaseWriter();
  }

  await writer;
  const result = await repair;
  await writerDb.end({ timeout: 5 });
  expect(result.status).toBe("filled");
  expect(result.ok).toBe(true);

  const [balanceEvidence] = await sql<{ amount: string; price_usd: string; value_usd: string; provenance: string }[]>`
    SELECT amount::text, price_usd::text, value_usd::text, provenance
      FROM wallet_balance_sample_evidence WHERE original_id = ${writerIds.balanceId}
  `;
  expect(balanceEvidence).toEqual({
    amount: "333.125",
    price_usd: "1.0002",
    value_usd: "333.191625",
    provenance: "live",
  });
  const [sleeveEvidence] = await sql<{ amount: string; price_usd: string; value_usd: string; provenance: string }[]>`
    SELECT amount::text, price_usd::text, value_usd::text, provenance
      FROM wallet_sleeve_sample_evidence WHERE original_id = ${writerIds.sleeveId}
  `;
  expect(sleeveEvidence).toEqual({
    amount: "444.25",
    price_usd: "4.5",
    value_usd: "1999.125",
    provenance: "live",
  });

  const manifest = resolveWalletSnapshotManifest();
  const [committed] = await sql<{ balances: number; sleeves: number; non_backfilled: number }[]>`
    SELECT
      (SELECT count(*) FROM wallet_balance_samples WHERE sample_date = ${D4})::int AS balances,
      (SELECT count(*) FROM wallet_sleeve_samples WHERE sample_date = ${D4})::int AS sleeves,
      ((SELECT count(*) FROM wallet_balance_samples WHERE sample_date = ${D4} AND provenance <> 'backfilled') +
       (SELECT count(*) FROM wallet_sleeve_samples WHERE sample_date = ${D4} AND provenance <> 'backfilled'))::int AS non_backfilled
  `;
  expect(committed).toEqual({
    balances: manifest.balanceAssets.length,
    sleeves: manifest.sleeveKeys.length,
    non_backfilled: 0,
  });
  const [state] = await sql<{ status: string; balance_rows: number; sleeve_rows: number }[]>`
    SELECT status, balance_rows, sleeve_rows FROM wallet_backfill_state WHERE sample_date = ${D4}
  `;
  expect(state).toEqual({
    status: "filled",
    balance_rows: manifest.balanceAssets.length,
    sleeve_rows: manifest.sleeveKeys.length,
  });
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

test("running the same day twice is idempotent — no duplicate rows, and the checkpoint is REPLAYED not restated", async () => {
  const firstRun = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  expect(firstRun.status).toBe("filled");
  const [first] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;

  const second = await backfillWalletDay(sql, D1, happyDeps(), NOW);
  const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${D1}`;

  // The idempotence this test is named for: no second copy of the day.
  expect(after!.n).toBe(first!.n);

  // A SETTLED DAY REPLAYS ITS CHECKPOINT — it does not report itself 'skipped'.
  // This used to expect 'skipped', which is what the day-at-a-time executor
  // returned when it re-entered the write path and found both tables populated.
  // The window planner now settles the day BEFORE that, so a re-run reports what
  // the day actually did rather than what the re-run did. That is deliberate:
  // answering 'skipped, 0 rows' overwrites the `filled, N rows` checkpoint, and
  // §7.1's completion observation reads exactly that record to prove a day
  // completed — a re-planned window would erase its own evidence.
  expect(second.status).toBe("filled");
  expect(second.balanceRows).toBe(firstRun.balanceRows);
  expect(second.sleeveRows).toBe(firstRun.sleeveRows);
  expect(second.detail).toMatch(/already filled/);

  // And the durable record still says filled, with the counts the WRITE made.
  const [state] = await sql<{ status: string; balance_rows: number; sleeve_rows: number }[]>`
    SELECT status, balance_rows, sleeve_rows FROM wallet_backfill_state WHERE sample_date = ${D1}
  `;
  expect(state!.status).toBe("filled");
  expect(state!.balance_rows).toBe(firstRun.balanceRows);
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

test("a detected gap retries despite filled/skipped metadata; exhausted days remain disclosed", () => {
  const plan = selectBackfillDays(
    ["d1", "d2", "d3", "d4"],
    new Map([
      ["d1", "filled"],
      ["d2", "failed"],
      ["d3", "exhausted"],
      ["d4", "skipped"],
    ]),
    10,
  );
  expect(plan.days).toEqual(["d1", "d2", "d4"]);
  expect(plan.retrying).toBe(3);
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
