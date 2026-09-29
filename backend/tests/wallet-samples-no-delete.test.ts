// The wallet repair pass removes nothing — issue #1026, decision D55 (6),
// smoke-production-spec.md §3 ("Only rm_owner may DELETE or TRUNCATE") and §10
// W2 ("No runtime path deletes").
//
// WHAT CHANGED. ops/wallet-backfill.ts used to rewrite an incomplete day by
// deleting every wallet_balance_samples and wallet_sleeve_samples row on the
// date and inserting the rows it computed, as rm_worker — the one runtime
// DELETE the pipeline worker issued. It now upserts each row it writes on the
// table's natural key and sets `superseded_at` (migration 0086) on each live
// row of the date it no longer writes, and every read of either table filters
// `superseded_at IS NULL`.
//
// WHAT THIS FILE PROVES, each against the real code path on a real database:
//
//   1. The pass runs as a real rm_worker LOGIN with DELETE and TRUNCATE revoked
//      on both tables (the revocation w5-no-runtime-delete's migration makes),
//      and succeeds.
//   2. A re-run over the same date is idempotent: same row count, same values,
//      same ids, same tombstones.
//   3. A key dropped between passes (an asset no longer tracked, a sleeve
//      wallet no longer configured) is superseded, not deleted: its row is
//      still in the table, its id and content unchanged, and it has left every
//      read. The rows the pass does write are replaced on their key, and the
//      table never grows past one row per key however often the configuration
//      flips.
//   4. Each rewrite archives every live version it replaces or supersedes to
//      evidence exactly once (the evidence tables are UNIQUE (original_id), so
//      an upsert that kept the old id would collide on a key's second rewrite).
//   5. Every reader returns exactly what the old delete-and-insert produced for
//      the same inputs — a golden comparison per reader, under both the
//      configuration that dropped the keys and the one that still expects them
//      (the second is where an unfiltered read would differ).
//   6. The published-snapshot guard (rm_wallet_aum_snapshot_constituent_guard,
//      0038) refuses a repair that would touch a row of a complete run with
//      0A000 and the rows stay as they were: a live constituent at the evidence
//      copy (where the old code was refused too), a superseded one at the
//      upsert.
//
// RED CONTROLS, each run against f59bbac7's files. The old writer fails (1)
// outright: 42501 on its DELETE. Each reader file reverted alone
// (wallet-balances, wallet-sleeves, wallet-valuation, asset-prices,
// gap-detector) fails (5) on its own reader's key. Within wallet-backfill.ts:
// its completeness read without the filter fails (3) (a superseded key counts
// as present), its evidence copy without the filter fails (4) (a superseded
// row is archived a second time), and an upsert that keeps the old id fails
// (3) and (4) (the key's second rewrite collides on the evidence tables'
// UNIQUE (original_id)). (5) also asserts its discrimination directly: the gap
// reports computed WITHOUT the tombstone filter disagree with the old world.
//
//   7. The live sampler (worker/handlers/wallet.ts) revives a key the repair
//      superseded as a fresh row: a new id, price_usd and snapshot identity
//      reset, as the old delete-and-insert let its INSERT create one. A live
//      row keeps its id and every column the sampler never writes.
//
// THE EVIDENCE GRANT. The pass copies a day's live rows into
// wallet_{balance,sleeve}_sample_evidence before it rewrites them, as
// rm_worker. The shipped grant set must give rm_worker INSERT on both tables.
// 0054's allowlist omitted them (the same omission 0061 fixed for
// wallet_backfill_state), so the grant belongs in w5-no-runtime-delete's
// migration and backend/schema/grants.sql. The first test below reads the
// privilege as the template shipped it, BEFORE this file grants anything, and
// fails until that migration lands: the production privilege set is asserted,
// never assumed. The GRANT in beforeAll then only keeps the rest of the path
// provable on a tree without that migration; once the migration ships it is a
// no-op.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sql, type DbHandle } from "../src/db/client.ts";
import { decodeAggregate3Calls, encodeAggregate3Result } from "../src/chain/base-rpc-client.ts";
import type { TrackedAsset } from "../src/config.ts";
import { resolveTrackedAssets } from "../src/config.ts";
import {
  fetchPersistedWalletBalances,
  fetchWalletBalances,
  _resetWalletBalancesCacheForTests,
} from "../src/chain/wallet-balances.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";
import { getWalletSleeves, _resetWalletSleevesCacheForTests } from "../src/chain/wallet-sleeves.ts";
import {
  MAX_PERSISTED_PRICE_AGE_MS,
  persistedFallbackWalletPriceReader,
  type ChainAmount,
  type KeyedAssetRead,
} from "../src/chain/wallet-valuation.ts";
import { backfillAssetPricesForCleanDays } from "../src/ops/asset-prices.ts";
import { detectGaps } from "../src/ops/gap-detector.ts";
import { getSeriesDef, type SeriesDef } from "../src/ops/series-registry.ts";
import { backfillWalletDay, planWalletBackfill, type WalletBackfillDeps } from "../src/ops/wallet-backfill.ts";
import { resolveWalletSnapshotManifest } from "../src/ops/wallet-snapshot-manifest.ts";
import { sampleWalletBalances, sampleWalletSleeves } from "../src/worker/handlers/wallet.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { adminExec, adminUrl } from "./support/cluster.ts";

useCleanDatabase(import.meta.file);

// Inside the registered series window (seriesStart 2026-03-18), so the gap
// detector's answer about this day is part of what is compared.
const D = "2026-08-01";
const PASS_NOW = new Date("2026-08-02T09:00:00Z");
const READ_NOW = new Date("2026-08-03T09:00:00Z");

// Two configurations. A tracks the optional aUSDC leg and the three default
// prop wallets; B drops aUSDC and replaces the third wallet. So a pass under B
// over a day A wrote must stop writing aUSDC's balance row and the third
// wallet's sleeve rows — and the new third wallet's sleeves make the day
// incomplete under B, which is what sends the pass down its rewrite path.
const W1 = "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6";
const W2 = "0x422c906083ca40b7e055b811d517f03bbbef8eee";
const W3 = "0x8d0c331e45beca4184b758f3049f8897aabb9442";
const W3B = "0x1234567890abcdef1234567890abcdef12345678";
const AUSDC = "0x4e65fe4dba92790696d040ac24aa414708f5c0ab";
type Config = "A" | "B";
const CONFIG_ENV: Record<Config, Record<string, string | undefined>> = {
  A: { AAVE_AUSDC_ADDRESS: AUSDC, PROP_WALLET_ADDRESSES: [W1, W2, W3].join(",") },
  B: { AAVE_AUSDC_ADDRESS: undefined, PROP_WALLET_ADDRESSES: [W1, W2, W3B].join(",") },
};
const ENV_KEYS = ["AAVE_AUSDC_ADDRESS", "PROP_WALLET_ADDRESSES"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function useConfig(config: Config): void {
  for (const key of ENV_KEYS) {
    const value = CONFIG_ENV[config][key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const blockHash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

/** Deps for one pass: every leg reads `amount`, every symbol is priced at $2,
 *  and the day's block is stamped `blockTimestampMs`. Recent stamps keep the
 *  persisted-price fallback (5-minute window) able to see these rows. */
function passDeps(amount: number, blockTimestampMs: number): WalletBackfillDeps {
  const blockNumber = 30_000_000;
  const tsSec = Math.floor(blockTimestampMs / 1000);
  return {
    async resolveBlock(date) {
      return {
        date,
        blockNumber,
        blockHash: blockHash(blockNumber),
        blockTimestampSec: tsSec,
        boundaryNextBlockNumber: blockNumber + 1,
        boundaryNextBlockHash: blockHash(blockNumber + 1),
        boundaryNextBlockTimestampSec: tsSec + 2,
        rpcCalls: 0,
        cached: false,
      };
    },
    async readChainAmounts(reads: KeyedAssetRead[]) {
      return new Map<string, ChainAmount>(reads.map((r) => [r.key, { ok: true, amount } as ChainAmount]));
    },
    async loadPrices(assets, fromDate, toDate) {
      const days: string[] = [];
      for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      return new Map(assets.map((a) => [a.symbol, new Map(days.map((d) => [d, 2]))]));
    },
  };
}

interface BalanceRow {
  id: string;
  symbol: string;
  amount: string | null;
  price_usd: string | null;
  value_usd: string;
  provenance: string;
  sampled_at: string;
  strategy_nav_idle_only: boolean | null;
  snapshot_run_id: string | null;
  superseded: boolean;
}
interface SleeveRow {
  id: string;
  wallet_address: string;
  symbol: string;
  amount: string | null;
  price_usd: string | null;
  value_usd: string | null;
  provenance: string;
  sampled_at: string;
  snapshot_run_id: string | null;
  superseded: boolean;
}

/** Every row on the date, live or superseded, read as the harness owner. */
async function tableState(date: string): Promise<{ balances: BalanceRow[]; sleeves: SleeveRow[] }> {
  const balances = await sql<BalanceRow[]>`
    SELECT id::text, symbol, amount::text, price_usd::text, value_usd::text, provenance,
           sampled_at::text, strategy_nav_idle_only, snapshot_run_id::text,
           superseded_at IS NOT NULL AS superseded
      FROM wallet_balance_samples WHERE sample_date = ${date}
     ORDER BY symbol COLLATE "C"
  `;
  const sleeves = await sql<SleeveRow[]>`
    SELECT id::text, wallet_address, symbol, amount::text, price_usd::text, value_usd::text,
           provenance, sampled_at::text, snapshot_run_id::text,
           superseded_at IS NOT NULL AS superseded
      FROM wallet_sleeve_samples WHERE sample_date = ${date}
     ORDER BY wallet_address COLLATE "C", symbol COLLATE "C"
  `;
  return { balances: [...balances], sleeves: [...sleeves] };
}

const balanceKey = (r: BalanceRow): string => r.symbol;
const sleeveKey = (r: SleeveRow): string => `${r.wallet_address}|${r.symbol}`;
/** A row as a reader could ever see it: everything but the version id. */
function withoutIds<T extends { id: string }>(row: T): Omit<T, "id"> {
  const { id: _id, ...rest } = row;
  return rest;
}

/** The original ids the date's evidence rows archive, per table, sorted. */
async function archivedIds(date: string): Promise<{ balances: string[]; sleeves: string[] }> {
  const balances = await sql<{ id: string }[]>`
    SELECT original_id::text AS id FROM wallet_balance_sample_evidence WHERE sample_date = ${date}
  `;
  const sleeves = await sql<{ id: string }[]>`
    SELECT original_id::text AS id FROM wallet_sleeve_sample_evidence WHERE sample_date = ${date}
  `;
  return { balances: balances.map((r) => r.id).sort(), sleeves: sleeves.map((r) => r.id).sort() };
}

/** Every tombstone on the date, as (table, id, superseded_at). */
async function tombstones(date: string): Promise<string[]> {
  const rows = await sql<{ t: string }[]>`
    SELECT 'balance:' || id || ':' || superseded_at::text AS t
      FROM wallet_balance_samples WHERE sample_date = ${date} AND superseded_at IS NOT NULL
    UNION ALL
    SELECT 'sleeve:' || id || ':' || superseded_at::text
      FROM wallet_sleeve_samples WHERE sample_date = ${date} AND superseded_at IS NOT NULL
  `;
  return rows.map((r) => r.t).sort();
}

const ROLLBACK = Symbol("rollback");
/** Run a reader that writes (the asset-price backfill) and throw its writes away. */
async function rolledBack<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  let result!: T;
  try {
    await sql.begin(async (tx) => {
      result = await fn(tx as unknown as DbHandle);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return result;
}

/** A reader outcome that may be a refusal; the refusal's message is the value. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: T } | { error: string }> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const seriesDef = (key: string): SeriesDef => {
  const def = getSeriesDef(key);
  if (!def) throw new Error(`series ${key} is not registered`);
  return def;
};

/**
 * Every reader of the two tables, under the configuration currently set:
 *   - chain/wallet-balances.ts: the persisted balances payload (latest per
 *     symbol) and its history (the quarantine-aware day series), and the live
 *     payload's stale degrade (lastPersistedHolding), forced by failing every
 *     chain and price read so each tracked symbol falls back to its last
 *     persisted row;
 *   - chain/wallet-sleeves.ts: the per-wallet sleeves payload;
 *   - chain/wallet-valuation.ts: the persisted-price fallback, forced by a
 *     provider refusal (a gecko read under the stub price source with no
 *     fixture price) for every symbol configuration A tracks;
 *   - ops/series-registry.ts via ops/gap-detector.ts: both series' gap reports;
 *   - ops/wallet-backfill.ts: the repair planner built on those reports;
 *   - ops/asset-prices.ts: the clean-day price backfill (rolled back).
 * wallet-backfill.ts's own completeness read is exercised by the passes
 * themselves (a complete day is replayed, an incomplete one rewritten).
 */
async function readAll(): Promise<Record<string, unknown>> {
  _resetWalletSleevesCacheForTests();
  const assetsA = (() => {
    const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      useConfig("A");
      return resolveTrackedAssets().filter((a) => a.valuationKind !== "config");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
  const fallback: Record<string, unknown> = {};
  for (const asset of assetsA) {
    const forced: TrackedAsset = { ...asset, priceKind: "gecko" };
    fallback[asset.symbol] = await outcome(() => persistedFallbackWalletPriceReader.read(forced, "live", "stub"));
  }
  return {
    persistedBalances: await fetchPersistedWalletBalances(),
    staleDegrade: await staleDegradedHoldings(),
    sleeves: await getWalletSleeves(),
    fallback,
    balanceGaps: await detectGaps(seriesDef("wallet_balance_samples"), sql, READ_NOW),
    sleeveGaps: await detectGaps(seriesDef("wallet_sleeve_samples"), sql, READ_NOW),
    repairPlan: await planWalletBackfill(sql, READ_NOW),
    // The passes dual-wrote D's asset_prices rows, which takes D out of this
    // reader's candidate set before it ever reads the samples, and the seeded
    // history's unpriced days fill its 30-day window first. Its input here is
    // the gap it exists to close with D alone in it — D sampled, D unpriced,
    // no other sampled day — made inside the same rolled-back transaction as
    // the harness owner, so the reader's completeness read over D's samples is
    // what gets compared.
    assetPriceBackfill: await rolledBack(async (tx) => {
      const owner = tx as unknown as postgres.TransactionSql<{}>;
      await owner`DELETE FROM asset_prices WHERE price_date = ${D}`;
      await owner`DELETE FROM wallet_balance_samples WHERE sample_date <> ${D}`;
      await owner`DELETE FROM wallet_sleeve_samples WHERE sample_date <> ${D}`;
      return backfillAssetPricesForCleanDays(tx, READ_NOW, {
        async loadPrices(assets, fromDate) {
          return new Map(assets.map((a) => [a.symbol, new Map([[fromDate, 2]])]));
        },
      });
    }),
  };
}

/**
 * fetchWalletBalances with every outbound read failing: the RPC batch throws
 * (every chain leg fails) and every price host throws (the config leg fails
 * too), so valueAsset degrades each tracked symbol to lastPersistedHolding —
 * the live path's only read of wallet_balance_samples. Only what that read
 * decides is kept: the history in the same payload is loadHistory, compared
 * through fetchPersistedWalletBalances already.
 */
async function staleDegradedHoldings(): Promise<Record<string, unknown>> {
  const saved = {
    fetch: globalThis.fetch,
    consoleError: console.error,
    rpc: process.env.BASE_RPC_SOURCE,
    price: process.env.PRICE_SOURCE,
  };
  globalThis.fetch = (async () => {
    throw new Error("wallet-samples-no-delete: every outbound read fails");
  }) as unknown as typeof fetch;
  console.error = () => {};
  process.env.BASE_RPC_SOURCE = "live";
  process.env.PRICE_SOURCE = "live";
  _resetWalletBalancesCacheForTests();
  _resetTokenPriceCacheForTests();
  try {
    const { holdings } = await fetchWalletBalances();
    const out: Record<string, unknown> = {};
    for (const h of holdings) {
      out[h.symbol] = { amount: h.amount, priceUsd: h.priceUsd, valueUsd: h.valueUsd, provenance: h.provenance };
    }
    return out;
  } finally {
    globalThis.fetch = saved.fetch;
    console.error = saved.consoleError;
    if (saved.rpc === undefined) delete process.env.BASE_RPC_SOURCE;
    else process.env.BASE_RPC_SOURCE = saved.rpc;
    if (saved.price === undefined) delete process.env.PRICE_SOURCE;
    else process.env.PRICE_SOURCE = saved.price;
    _resetWalletBalancesCacheForTests();
    _resetTokenPriceCacheForTests();
  }
}

const WORKER_PASSWORD = "rm_worker_ci_password";
const EVIDENCE_TABLES = ["wallet_balance_sample_evidence", "wallet_sleeve_sample_evidence"] as const;
/** rm_worker's INSERT on each evidence table as the template shipped it, read
 *  before this file grants anything. */
const shippedEvidenceInsert: Record<string, boolean> = {};
let worker: postgres.Sql<{}>;

beforeAll(async () => {
  // The same credential analytics-worker-role.test.ts provisions: roles are
  // cluster-wide, so two files must not fight over the password.
  await adminExec(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${WORKER_PASSWORD}'`);
  // D55 (6)'s end state on this file's own copy: rm_worker holds no DELETE or
  // TRUNCATE on either sample table.
  await sql`REVOKE DELETE, TRUNCATE ON wallet_balance_samples, wallet_sleeve_samples FROM rm_worker`;
  // See THE EVIDENCE GRANT in the header: read the shipped privilege first.
  for (const table of EVIDENCE_TABLES) {
    const [row] = await sql<{ ins: boolean }[]>`SELECT has_table_privilege('rm_worker', ${table}, 'INSERT') AS ins`;
    shippedEvidenceInsert[table] = row!.ins;
  }
  await sql`GRANT INSERT ON wallet_balance_sample_evidence, wallet_sleeve_sample_evidence TO rm_worker`;
  const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  const url = new URL(adminUrl());
  url.username = "rm_worker";
  url.password = WORKER_PASSWORD;
  url.pathname = `/${db}`;
  worker = postgres(url.toString(), { max: 2, onnotice: () => {} });
});

beforeEach(() => {
  // The executor refuses to run without an RPC budget (assertRpcBudgetConfigured);
  // preload.ts zeroes it before every test.
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "10";
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetWalletSleevesCacheForTests();
  await worker?.end({ timeout: 5 });
});

describe("the shipped grant set", () => {
  test("gives rm_worker INSERT on both evidence tables, which every rewrite of an incomplete day copies into first", () => {
    // Red until w5-no-runtime-delete's migration and grants.sql grant it: the
    // repair pass then fails 42501 at its evidence copy for every incomplete
    // day in production (backend/src/ops/wallet-backfill.ts, the evidence
    // INSERT ... SELECT in repairResolvedDay).
    expect(shippedEvidenceInsert).toEqual({
      wallet_balance_sample_evidence: true,
      wallet_sleeve_sample_evidence: true,
    });
  });
});

describe("the wallet repair pass as rm_worker with DELETE revoked", () => {
  // Block stamps for the two configurations, fixed when the first pass runs
  // (not at collection) so the rows stay well inside the persisted-price
  // fallback's MAX_PERSISTED_PRICE_AGE_MS window when the golden reads them.
  // The golden asserts that as a positive control.
  let T1 = 0;
  let T2 = 0;
  let afterPass1: Awaited<ReturnType<typeof tableState>>;
  let afterPass2: Awaited<ReturnType<typeof tableState>>;

  test("the login really is rm_worker, and it can neither DELETE nor TRUNCATE either table", async () => {
    const [who] = await worker<{ u: string }[]>`SELECT current_user AS u`;
    expect(who!.u).toBe("rm_worker");
    for (const table of ["wallet_balance_samples", "wallet_sleeve_samples"]) {
      const [privs] = await worker<{ del: boolean; trunc: boolean; upd: boolean; ins: boolean }[]>`
        SELECT has_table_privilege(${table}, 'DELETE') AS del,
               has_table_privilege(${table}, 'TRUNCATE') AS trunc,
               has_table_privilege(${table}, 'UPDATE') AS upd,
               has_table_privilege(${table}, 'INSERT') AS ins
      `;
      expect(privs).toEqual({ del: false, trunc: false, upd: true, ins: true });
      let refused: unknown;
      try {
        await worker.unsafe(`DELETE FROM ${table} WHERE false`);
      } catch (err) {
        refused = err;
      }
      expect((refused as { code?: string } | undefined)?.code).toBe("42501");
    }
  });

  test("pass 1 fills an empty day under configuration A", async () => {
    const before = await tableState(D);
    expect(before.balances.length + before.sleeves.length).toBe(0);

    T1 = Date.now() - 60_000;
    T2 = Date.now() - 30_000;
    useConfig("A");
    const result = await backfillWalletDay(worker, D, passDeps(5, T1), PASS_NOW);
    expect(result).toMatchObject({ ok: true, status: "filled" });

    const manifest = resolveWalletSnapshotManifest();
    afterPass1 = await tableState(D);
    expect(afterPass1.balances.map((r) => r.symbol)).toContain("aUSDC");
    expect(afterPass1.balances).toHaveLength(manifest.balanceAssets.length);
    expect(afterPass1.sleeves).toHaveLength(manifest.sleeveKeys.length);
    expect(afterPass1.sleeves.some((r) => r.wallet_address === W3)).toBe(true);
    for (const row of [...afterPass1.balances, ...afterPass1.sleeves]) {
      expect(row).toMatchObject({ amount: "5", price_usd: null, value_usd: "10", provenance: "backfilled", superseded: false });
    }
  });

  test("re-running pass 1 over the same date is idempotent: same rows, same values, same ids", async () => {
    useConfig("A");
    const rerun = await backfillWalletDay(worker, D, passDeps(5, T1), PASS_NOW);
    expect(rerun).toMatchObject({ ok: true, status: "filled" });
    expect(await tableState(D)).toEqual(afterPass1);
  });

  test("pass 2 under configuration B rewrites the day on its keys and supersedes the keys it dropped — nothing is deleted", async () => {
    useConfig("B");
    const result = await backfillWalletDay(worker, D, passDeps(7, T2), PASS_NOW);
    expect(result).toMatchObject({ ok: true, status: "filled" });

    const manifest = resolveWalletSnapshotManifest();
    afterPass2 = await tableState(D);

    // Nothing left the table: every key pass 1 wrote still has its row, and
    // the only rows added are the new wallet's.
    const keysAfter = new Set([...afterPass2.balances.map(balanceKey), ...afterPass2.sleeves.map(sleeveKey)]);
    for (const key of [...afterPass1.balances.map(balanceKey), ...afterPass1.sleeves.map(sleeveKey)]) {
      expect(keysAfter.has(key)).toBe(true);
    }
    expect(afterPass2.balances).toHaveLength(afterPass1.balances.length);
    const newSleeves = manifest.sleeveKeys.filter((k) => k.walletAddress === W3B).length;
    expect(newSleeves).toBeGreaterThan(0);
    expect(afterPass2.sleeves).toHaveLength(afterPass1.sleeves.length + newSleeves);

    // The dropped keys: superseded, id and content exactly as pass 1 left them.
    const supersededBalances = afterPass2.balances.filter((r) => r.superseded);
    expect(supersededBalances.map((r) => r.symbol)).toEqual(["aUSDC"]);
    expect(supersededBalances[0]).toEqual({ ...afterPass1.balances.find((r) => r.symbol === "aUSDC")!, superseded: true });
    const supersededSleeves = afterPass2.sleeves.filter((r) => r.superseded);
    expect(supersededSleeves.length).toBe(afterPass1.sleeves.filter((r) => r.wallet_address === W3).length);
    for (const row of supersededSleeves) {
      expect(row.wallet_address).toBe(W3);
      expect(row).toEqual({ ...afterPass1.sleeves.find((r) => r.id === row.id)!, superseded: true });
    }

    // The written keys: live, pass 2's values, and a new version's id (the
    // evidence tables' UNIQUE (original_id) needs one per version).
    const live = afterPass2.balances.filter((r) => !r.superseded);
    expect(live.map((r) => r.symbol).sort()).toEqual(manifest.balanceAssets.map((a) => a.symbol).sort());
    for (const row of live) {
      expect(row).toMatchObject({ amount: "7", price_usd: null, value_usd: "14", provenance: "backfilled", snapshot_run_id: null });
      expect(row.id).not.toBe(afterPass1.balances.find((r) => r.symbol === row.symbol)!.id);
    }
    const liveSleeves = afterPass2.sleeves.filter((r) => !r.superseded);
    expect(liveSleeves).toHaveLength(manifest.sleeveKeys.length);
    for (const row of liveSleeves) {
      expect(row).toMatchObject({ amount: "7", price_usd: null, value_usd: "14", provenance: "backfilled" });
    }

    // What the pass replaced or superseded went to evidence first — every row
    // pass 1 wrote, once.
    expect(await archivedIds(D)).toEqual({
      balances: afterPass1.balances.map((r) => r.id).sort(),
      sleeves: afterPass1.sleeves.map((r) => r.id).sort(),
    });
  });

  test("re-running pass 2 over the same date is idempotent: same rows, same values, same ids, same tombstones", async () => {
    useConfig("B");
    const tombstonesBefore = await tombstones(D);
    const rerun = await backfillWalletDay(worker, D, passDeps(7, T2), PASS_NOW);
    expect(rerun).toMatchObject({ ok: true, status: "filled" });
    expect(await tableState(D)).toEqual(afterPass2);
    expect(await tombstones(D)).toEqual(tombstonesBefore);
  });

  test("a key the configuration brings back is live again, flipping back restores pass 2's table, and each live version is archived exactly once", async () => {
    // Pass 3, configuration A again: the day is incomplete under A (aUSDC and
    // the third wallet's sleeves are superseded, so wallet-backfill's own
    // completeness read must not count them), so the pass rewrites it — its
    // upsert revives those keys and supersedes the new wallet's.
    useConfig("A");
    const pass3 = await backfillWalletDay(worker, D, passDeps(5, T1), PASS_NOW);
    expect(pass3).toMatchObject({ ok: true, status: "filled" });
    const afterPass3 = await tableState(D);
    expect(afterPass3.balances).toHaveLength(afterPass2.balances.length);
    expect(afterPass3.sleeves).toHaveLength(afterPass2.sleeves.length);
    expect(withoutIds(afterPass3.balances.find((r) => r.symbol === "aUSDC")!)).toEqual(
      withoutIds(afterPass1.balances.find((r) => r.symbol === "aUSDC")!),
    );
    for (const row of afterPass3.sleeves) {
      expect(row.superseded).toBe(row.wallet_address === W3B);
    }

    // Pass 4, configuration B again: pass 2's table, key for key and value for
    // value (the live rows are new versions, so their ids are new).
    useConfig("B");
    const pass4 = await backfillWalletDay(worker, D, passDeps(7, T2), PASS_NOW);
    expect(pass4).toMatchObject({ ok: true, status: "filled" });
    const afterPass4 = await tableState(D);
    expect(afterPass4.balances.map(withoutIds)).toEqual(afterPass2.balances.map(withoutIds));
    expect(afterPass4.sleeves.map(withoutIds)).toEqual(afterPass2.sleeves.map(withoutIds));

    // Evidence holds each LIVE version a rewrite replaced or superseded, once:
    // passes 2, 3 and 4 each archived the rows live before them, and a row
    // already superseded was not archived again (it was archived while live).
    const liveIds = (rows: readonly { id: string; superseded: boolean }[]): string[] =>
      rows.filter((r) => !r.superseded).map((r) => r.id);
    expect(await archivedIds(D)).toEqual({
      balances: [afterPass1, afterPass2, afterPass3].flatMap((s) => liveIds(s.balances)).sort(),
      sleeves: [afterPass1, afterPass2, afterPass3].flatMap((s) => liveIds(s.sleeves)).sort(),
    });
    // aUSDC's key: two versions archived (pass 1's before pass 2, pass 3's
    // before pass 4), never the superseded one twice.
    const [ausdc] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wallet_balance_sample_evidence WHERE sample_date = ${D} AND symbol = 'aUSDC'
    `;
    expect(ausdc!.n).toBe(2);
  });

  test("every reader returns what the old delete-and-insert produced for the same inputs, under both configurations", async () => {
    // THE TOMBSTONE WORLD: the table as pass 2 left it.
    const tombstone: Record<Config, Record<string, unknown>> = { A: {}, B: {} };
    for (const config of ["A", "B"] as const) {
      useConfig(config);
      tombstone[config] = await readAll();
    }
    // Positive control for the valuation fallback's half of the golden: the
    // superseded aUSDC row is still young enough, AFTER every tombstone read
    // ran, that an unfiltered recentPersistedPrice would have served it. Without
    // this the fallback could refuse in both worlds only because the row aged
    // out, and the comparison would prove nothing about the filter.
    const [ausdcRow] = await sql<{ sampled_at: Date; superseded: boolean }[]>`
      SELECT sampled_at, superseded_at IS NOT NULL AS superseded
        FROM wallet_balance_samples WHERE sample_date = ${D} AND symbol = 'aUSDC'
    `;
    expect(ausdcRow!.superseded).toBe(true);
    expect(Date.now() - ausdcRow!.sampled_at.getTime()).toBeLessThan(MAX_PERSISTED_PRICE_AGE_MS);
    // And the stale degrade's half: aUSDC's newest row is the superseded one
    // on D, so an unfiltered lastPersistedHolding would serve pass 3's amount.
    const [newestAusdc] = await sql<{ sample_date: string }[]>`
      SELECT sample_date::text FROM wallet_balance_samples
       WHERE symbol = 'aUSDC' ORDER BY sample_date DESC LIMIT 1
    `;
    expect(newestAusdc!.sample_date).toBe(D);
    // The red control's input: the balances gap report as it would read
    // WITHOUT the tombstone filter, under configuration A (which still expects
    // aUSDC and the third wallet's sleeves).
    useConfig("A");
    // The detector's statements are registered per series and always filter
    // `superseded_at`, so the unfiltered read is built from the data instead:
    // temp tables that shadow the two real ones (pg_temp is searched first)
    // with every row's tombstone cleared, which is what a read without the
    // filter sees.
    const unfiltered = await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE wallet_balance_samples ON COMMIT DROP AS
        SELECT sample_date, symbol, provenance, NULL::timestamptz AS superseded_at FROM public.wallet_balance_samples`;
      await tx`CREATE TEMP TABLE wallet_sleeve_samples ON COMMIT DROP AS
        SELECT sample_date, wallet_address, symbol, provenance, NULL::timestamptz AS superseded_at FROM public.wallet_sleeve_samples`;
      return {
        balanceGaps: await detectGaps(seriesDef("wallet_balance_samples"), tx, READ_NOW),
        sleeveGaps: await detectGaps(seriesDef("wallet_sleeve_samples"), tx, READ_NOW),
      };
    });

    // THE OLD WORLD: what the delete-and-insert left for pass 2's inputs —
    // the date emptied, then exactly the statements the old pass issued,
    // one fresh row per key configuration B's manifest names. Done as the
    // harness owner on this file's own copy (rm_owner may delete; no runtime
    // role here does).
    useConfig("B");
    const manifest = resolveWalletSnapshotManifest();
    const sampledAt = new Date(Math.floor(T2 / 1000) * 1000);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM wallet_balance_samples WHERE sample_date = ${D}`;
      await tx`DELETE FROM wallet_sleeve_samples WHERE sample_date = ${D}`;
      for (const asset of manifest.balanceAssets) {
        await tx`
          INSERT INTO wallet_balance_samples
            (sample_date, symbol, amount, value_usd, provenance, sampled_at)
          VALUES (${D}, ${asset.symbol}, ${7}, ${14}, 'backfilled', ${sampledAt})
        `;
      }
      for (const key of manifest.sleeveKeys) {
        await tx`
          INSERT INTO wallet_sleeve_samples
            (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
          VALUES (${D}, ${key.walletAddress}, ${key.asset.symbol}, ${7}, ${14}, 'backfilled', ${sampledAt})
        `;
      }
    });
    const old: Record<Config, Record<string, unknown>> = { A: {}, B: {} };
    for (const config of ["A", "B"] as const) {
      useConfig(config);
      old[config] = await readAll();
    }

    for (const config of ["A", "B"] as const) {
      for (const reader of Object.keys(old[config])) {
        expect({ config, reader, value: tombstone[config][reader] }).toEqual({ config, reader, value: old[config][reader] });
      }
    }

    // The comparison can tell the worlds apart: under A, the old world has a
    // hole at D in both series (aUSDC and the third wallet's sleeves are
    // missing), and an unfiltered read of the tombstone world does not.
    const gapAtD = (report: { interiorGaps: string[]; headDate: string | null }): boolean =>
      report.interiorGaps.includes(`${D}T00:00:00.000Z`) ||
      (report.headDate !== null && report.headDate < `${D}T00:00:00.000Z`);
    expect(gapAtD(old.A.balanceGaps as { interiorGaps: string[]; headDate: string | null })).toBe(true);
    expect(gapAtD(old.A.sleeveGaps as { interiorGaps: string[]; headDate: string | null })).toBe(true);
    expect(gapAtD(unfiltered.balanceGaps)).toBe(false);
    expect(gapAtD(unfiltered.sleeveGaps)).toBe(false);
    // And the persisted-price fallback for aUSDC refuses in both worlds (the
    // positive control above shows an unfiltered read would have served it).
    expect((tombstone.A.fallback as Record<string, unknown>).aUSDC).toHaveProperty("error");
    // The stale degrade never serves the superseded aUSDC version (amount 5).
    const staleAusdc = (tombstone.A.staleDegrade as Record<string, { amount: number | null; provenance: string }>).aUSDC!;
    expect(staleAusdc.provenance).toBe("stale");
    expect(staleAusdc.amount).not.toBe(5);
  });
});


describe("the published-snapshot guard still refuses a repair that would touch a final run's rows", () => {
  const NOW = new Date("2019-05-10T09:00:00Z");

  /** Publish a complete run whose one constituent is `symbol`'s balance row on
   *  `day`, staged under the reserved run id exactly as a publisher would.
   *  `superseded` stages that row already tombstoned. That state exists only
   *  because rm_wallet_aum_snapshot_finalize_guard (0038, reproduced in
   *  backend/schema/snapshot.sql) counts constituents with no superseded_at
   *  filter, a gap no code under backend/src reaches today (nothing publishes
   *  a run). It is the one shape in which the repair's upsert, not its
   *  evidence copy, is the first statement to touch a published row, so the
   *  case pins that the constituent guard still refuses there. When a migration
   *  closes the finalize-guard gap, publishRun(…, true) fails 23514 and the
   *  superseded case must become the proof that the run cannot be published. */
  async function publishRun(day: string, symbol: string, superseded: boolean): Promise<string> {
    const [reserved] = await sql<{ run_id: string }[]>`
      SELECT nextval(pg_get_serial_sequence('wallet_aum_snapshot_runs', 'run_id'))::text AS run_id
    `;
    const blockTs = `${day}T23:59:58Z`;
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    const recorded = new Date(Date.parse(next) + 60_000).toISOString();
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at,
           snapshot_run_id, amount_observed_at, price_observed_at, recorded_at, superseded_at)
        VALUES
          (${day}, ${symbol}, 3, 1, 3, 'backfilled', ${blockTs},
           ${reserved!.run_id}, ${blockTs}, ${blockTs}, ${recorded},
           ${superseded ? recorded : null})
      `;
      await tx`
        INSERT INTO wallet_aum_snapshot_runs
          (run_id, sample_date, time_basis, state, manifest_version, manifest_json,
           manifest_hash, config_identity, snapshot_id,
           expected_balance_keys, present_balance_keys,
           expected_sleeve_keys, present_sleeve_keys,
           observed_at, published_at, chain_id, block_number, block_hash,
           block_timestamp, boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp, producer_revision_status, producer_revision)
        VALUES
          (${reserved!.run_id}, ${day}, 'utc-daily-close', 'complete', 'v1', ${tx.json({ version: "v1" })},
           ${"b".repeat(64)}, 'fixture-config', ${day.replace(/-/g, "").padEnd(64, "c")},
           ARRAY[${symbol}]::text[], ARRAY[${symbol}]::text[], '{}'::text[], '{}'::text[],
           ${blockTs}, ${recorded}, 8453, 200, ${blockHash(200)},
           ${blockTs}, 201, ${blockHash(201)}, ${next},
           'available', 'git-fixture-guard')
      `;
    });
    return reserved!.run_id;
  }

  // A LIVE constituent is refused where the old code refused it too: the
  // evidence copy that precedes any rewrite, an INSERT of a published run's
  // row into the evidence table. A SUPERSEDED constituent is never copied (it
  // was archived when it was live), so the first statement to reach it is the
  // upsert's conflict UPDATE — refused by the same trigger on the sample table.
  for (const [day, superseded, statement] of [
    ["2019-05-01", false, "INSERT on wallet_balance_sample_evidence"],
    ["2019-05-02", true, "UPDATE on wallet_balance_samples"],
  ] as const) {
    test(`a ${superseded ? "superseded" : "live"} constituent: refused (${statement}), and the day is exactly as it was`, async () => {
      useConfig("B");
      const runId = await publishRun(day, "USDC", superseded);
      const before = await tableState(day);
      expect(before.balances).toHaveLength(1);
      expect(before.balances[0]!.superseded).toBe(superseded);

      const result = await backfillWalletDay(worker, day, passDeps(9, Date.parse(`${day}T23:59:58Z`)), NOW);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("transactional snapshot write failed");
      // The message rm_wallet_aum_snapshot_constituent_guard raises with
      // ERRCODE 0A000 (0038), naming the statement it refused.
      expect(result.detail).toContain(`published AUM snapshot run ${runId} is immutable: ${statement} is not permitted`);

      // The whole transaction rolled back: the published row as it was, and
      // nothing else on the day.
      expect(await tableState(day)).toEqual(before);
    });
  }
});


describe("the live sampler revives a superseded key as a fresh row", () => {
  // Hermetic: the stub RPC and price sources, as asset-prices-dual-write runs
  // the sampler, plus an in-process transport (mockTransport below) for the
  // reads the samplers still make under them (pool discovery, the sleeves'
  // batched NAV call). The sampler picks today's date itself; each case reads
  // it off the sampler's own return value.
  const saved = { rpc: process.env.BASE_RPC_SOURCE, price: process.env.PRICE_SOURCE, fetch: globalThis.fetch };
  beforeAll(() => {
    process.env.BASE_RPC_SOURCE = "stub";
    process.env.PRICE_SOURCE = "stub";
    mockTransport();
  });
  afterAll(() => {
    globalThis.fetch = saved.fetch;
    if (saved.rpc === undefined) delete process.env.BASE_RPC_SOURCE;
    else process.env.BASE_RPC_SOURCE = saved.rpc;
    if (saved.price === undefined) delete process.env.PRICE_SOURCE;
    else process.env.PRICE_SOURCE = saved.price;
  });

  test("balances: a superseded row comes back with a new id and price_usd reset; a live row keeps both", async () => {
    useConfig("A");
    const first = (await sampleWalletBalances({})) as { sampleDate: string };
    const today = first.sampleDate;
    // As the repair would leave it: USDC superseded after it was archived
    // under its id (evidence holds UNIQUE (original_id)), and a price_usd from
    // the old version. WETH stays live with a price_usd the sampler never writes.
    const [usdc] = await sql<{ id: string }[]>`
      UPDATE wallet_balance_samples SET superseded_at = now(), price_usd = 1
       WHERE sample_date = ${today} AND symbol = 'USDC' RETURNING id::text
    `;
    await sql`
      INSERT INTO wallet_balance_sample_evidence
        (original_id, sample_date, symbol, amount, price_usd, value_usd, provenance,
         strategy_nav_idle_only, sampled_at, evidence_reason)
      SELECT id, sample_date, symbol, amount, price_usd, value_usd, provenance,
             strategy_nav_idle_only, sampled_at, 'incomplete-snapshot-replacement'
        FROM wallet_balance_samples WHERE id = ${usdc!.id}
    `;
    const [weth] = await sql<{ id: string }[]>`
      UPDATE wallet_balance_samples SET price_usd = 7
       WHERE sample_date = ${today} AND symbol = 'WETH' RETURNING id::text
    `;

    const second = (await sampleWalletBalances({})) as { sampleDate: string };
    expect(second.sampleDate).toBe(today);

    const rows = await sql<{ symbol: string; id: string; price_usd: string | null; superseded: boolean }[]>`
      SELECT symbol, id::text, price_usd::text, superseded_at IS NOT NULL AS superseded
        FROM wallet_balance_samples WHERE sample_date = ${today} AND symbol IN ('USDC', 'WETH')
       ORDER BY symbol
    `;
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get("USDC")).toMatchObject({ price_usd: null, superseded: false });
    expect(bySymbol.get("USDC")!.id).not.toBe(usdc!.id);
    expect(bySymbol.get("WETH")).toEqual({ symbol: "WETH", id: weth!.id, price_usd: "7", superseded: false });
  });

  /** The samplers still reach the network under the stub sources (the
   *  balance sampler's pool discovery, the sleeve sampler's batched round-2
   *  NAV call), so they get a transport that answers every Multicall3
   *  sub-call and every price request, as chain-indexer-samples mocks it, and
   *  refuses anything else. Nothing leaves the process. */
  function mockTransport(): void {
    const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");
    const answers: Record<string, string> = {
      "0x70a08231": word(1_000_000n), // balanceOf
      "0x07a2d13a": word(1_000_000n), // convertToAssets
      "0x4d2301cc": word(50_000_000_000_000_000n), // getEthBalance
    };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("geckoterminal.com") || u.includes("finance.yahoo.com")) {
        const addrs = (u.split("/token_price/")[1] ?? "x").toLowerCase().split(",");
        return new Response(
          JSON.stringify({ data: { attributes: { token_prices: Object.fromEntries(addrs.map((a) => [a, "10.0"])) } } }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params: { data: string }[] };
      if (body.method === "eth_call" && body.params[0]!.data.slice(0, 10) === "0x82ad56cb") {
        const results = decodeAggregate3Calls(body.params[0]!.data).map((c) => {
          const rd = answers[c.callData.slice(0, 10)];
          return rd ? { success: true, returnData: rd } : { success: false, returnData: "0x" };
        });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAggregate3Result(results) }), { status: 200 });
      }
      throw new Error(`wallet-samples-no-delete: unexpected outbound call ${body.method}`);
    }) as unknown as typeof fetch;
  }

  test("sleeves: a superseded row comes back with a new id and price_usd reset; a live row keeps both", async () => {
    useConfig("A");
    const first = (await sampleWalletSleeves({})) as { sampleDate: string };
    const today = first.sampleDate;
    const live = await sql<{ id: string; wallet_address: string; symbol: string }[]>`
      SELECT id::text, wallet_address, symbol FROM wallet_sleeve_samples
       WHERE sample_date = ${today} AND superseded_at IS NULL
       ORDER BY wallet_address COLLATE "C", symbol COLLATE "C" LIMIT 2
    `;
    expect(live).toHaveLength(2);
    const target = live[0]!;
    const kept = live[1]!;
    await sql`UPDATE wallet_sleeve_samples SET superseded_at = now(), price_usd = 1 WHERE id = ${target.id}`;
    await sql`UPDATE wallet_sleeve_samples SET price_usd = 7 WHERE id = ${kept.id}`;

    const second = (await sampleWalletSleeves({})) as { sampleDate: string };
    expect(second.sampleDate).toBe(today);

    const read = async (k: { wallet_address: string; symbol: string }) => {
      const [row] = await sql<{ id: string; price_usd: string | null; superseded: boolean }[]>`
        SELECT id::text, price_usd::text, superseded_at IS NOT NULL AS superseded
          FROM wallet_sleeve_samples
         WHERE sample_date = ${today} AND wallet_address = ${k.wallet_address} AND symbol = ${k.symbol}
      `;
      return row!;
    };
    const revived = await read(target);
    expect(revived).toMatchObject({ price_usd: null, superseded: false });
    expect(revived.id).not.toBe(target.id);
    expect(await read(kept)).toEqual({ id: kept.id, price_usd: "7", superseded: false });
  });
});
