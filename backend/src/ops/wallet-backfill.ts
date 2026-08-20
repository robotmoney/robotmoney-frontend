// THE CLASS C REPAIR DRIVER — the thing that makes "self-healing" true for the
// wallet/AUM series (issue #709; docs/technical/data-self-healing.md §6.5.4).
//
// WHAT WAS MISSING. #615 shipped detection: a series registry
// (ops/series-registry.ts), a generic gap detector (ops/gap-detector.ts), a
// `remediationClass` label, and a read-only operator surface at
// GET /api/admin/gaps. What it did NOT ship is any consumer of that label —
// `remediationClass` had zero behavioural consumers, so the pipeline could see
// its own holes and do nothing about them. #646 records the identical shape for
// the Class A half. This module is the missing half for Class C.
//
// HOW IT HEALS. Nothing here is a migration, a script, or a one-shot import: the
// repair runs inside the ordinary analytics/worker engine, on a schedule, the
// same way every other producer does.
//
//   ops.repair_gaps      (scheduled) → asks the gap detector what is missing and
//                                      enqueues one job per missing day
//   wallet.backfill_day  (per day)   → resolves that day to a block, reads and
//                                      prices at that block, writes the day
//
// So a hole that appears for ANY reason — a wedged scheduler, an RPC outage, a
// fresh database whose bootstrap date is later than the series start — is found
// and closed by the running system, without an operator. A run that is capped,
// interrupted or partially failed simply converges on the next run: the plan is
// re-derived from the DATA every time, never from a cursor that could drift.
//
// WHAT IT WILL NOT DO, and why each refusal is the point:
//
//   * It never writes a day it could not read honestly. A failed day stays in
//     the gap report — an unrepaired day must keep LOOKING unrepaired.
//   * It never overwrites a day that already has rows. Repair fills holes; it
//     does not restate history (§7.1's append-only reading).
//   * It never treats `success:true` + `returnData:"0x"` as a zero. That is a
//     contract with no code at that block, and decoding it to 0 does not read a
//     balance — it invents one.
//   * It never runs on its own RPC limiter. The provider meters per-IP, so a
//     second limiter beside the live sampler's sums to 2x and 429s them both,
//     CAUSING new gaps while repairing old ones (#651's 2026-08-10 storm). Every
//     read here goes through chain/base-rpc-client.ts's single shared token
//     bucket.
import type postgresTypes from "postgres";
import {
  config,
  isPlaceholderAddress,
  resolveBaseRpcSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../config.ts";
import { resolveRpcRateBudget, toBlockTag, type RpcCallOptions } from "../chain/base-rpc-client.ts";
import {
  resolveDayBlock,
  type DayBlockCache,
  type ResolvedDayBlock,
} from "../chain/block-resolver.ts";
import { loadHistoricalPrices, type HistoricalPriceTable } from "../chain/historical-prices.ts";
import {
  readChainAmountsBatched,
  SLEEVE_DEFS,
  type ChainAmount,
  type ChainReadOptions,
  type KeyedAssetRead,
} from "../chain/wallet-valuation.ts";
import { detectGaps } from "./gap-detector.ts";
import { getSeriesDef } from "./series-registry.ts";

type Db = postgresTypes.Sql<{}>;

/** The two Class C series one backfilled day writes. Both are filled by the
 *  same job because both are read from the SAME multicall batch — splitting
 *  them would double the RPC cost of every repaired day for no benefit. */
export const BACKFILLED_SERIES = ["wallet_balance_samples", "wallet_sleeve_samples"] as const;

/** Default blast-radius cap on how many days ONE dispatcher run enqueues.
 *  Deliberately small: the run is scheduled, so a wide gap closes over several
 *  runs rather than in one burst against a metered RPC budget. What gets left
 *  for the next run is REPORTED, never silently dropped. */
export const DEFAULT_MAX_DAYS_PER_RUN = 10;

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function maxDaysPerRun(): number {
  return intEnv("WALLET_BACKFILL_MAX_DAYS_PER_RUN", DEFAULT_MAX_DAYS_PER_RUN, 1);
}

/** How many times a day may fail before it stops being retried.
 *
 *  A day can be unrepairable for a permanent reason — most obviously one that
 *  precedes a tracked target's deployment, where the honest read is "no contract
 *  here" and there is no value to write. Retrying such a day on every scheduled
 *  run would spend a metered RPC budget forever to re-learn the same fact. After
 *  the ceiling the day is marked 'exhausted': still an unrepaired gap, still
 *  reported by GET /api/admin/gaps, just no longer retried. Nothing is
 *  interpolated and nothing is marked handled. */
export function maxAttemptsPerDay(): number {
  return intEnv("WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY", 3, 1);
}

// ── The RPC budget precondition (PD6) ────────────────────────────────────────

/**
 * Refuse to run a LIVE backfill until the shared RPC rate budget is configured.
 *
 * This is not defensive boilerplate; it is the one mechanism that stops this
 * feature from re-creating the incident it exists to repair. The measured
 * figures (~5-token bucket, ~0.55 calls/s) were taken from a developer IP, and
 * PD6 requires them re-measured from the production droplet before any
 * production run. Unset means the transport paces nothing, and an unpaced
 * multi-day sweep against a per-IP-metered provider is exactly what killed
 * `vault.sample_share_price` on 2026-08-10.
 *
 * Only LIVE reads are gated: under BASE_RPC_SOURCE=stub there is no provider
 * bucket to exhaust.
 */
export function assertRpcBudgetConfigured(): void {
  if (resolveBaseRpcSource() !== "live") return;
  if (resolveRpcRateBudget()) return;
  throw new Error(
    "wallet-backfill: refusing to run without BASE_RPC_MAX_CALLS_PER_SEC set — " +
      "the backfill shares the live sampler's per-IP RPC budget and must never run unpaced (PD6, issue #651)",
  );
}

// ── Planning: which days are missing ─────────────────────────────────────────

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnightMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** The newest day that is fully CLOSED as of `now`. A day still in progress has
 *  no closing block and is the live sampler's job, not this one's. */
export function lastClosedDay(now: Date): string {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return isoDay(t - 86_400_000);
}

export interface WalletBackfillPlan {
  /** Missing CLOSED days, oldest first, after the cap. */
  days: string[];
  /** How many closed days are missing in total, before the cap. */
  totalMissing: number;
  /** Days the cap deferred to a later run — reported, never silently dropped. */
  deferred: number;
  /** Days already recorded as attempted-and-failed, included for retry. */
  retrying: number;
  /** Days that hit the attempt ceiling: still gaps, no longer retried. */
  exhausted: string[];
}

/**
 * Derive the work list FROM THE DATA, via the same gap detector the operator
 * surface reads.
 *
 * Deliberately not from a cursor and not from job rows: §6.5.4's unification
 * point is that there must be exactly ONE notion of "which days are missing",
 * or the repair and the report drift apart and the dashboard starts disagreeing
 * with the thing that is supposed to be fixing it.
 */
export async function planWalletBackfill(db: Db, now: Date = new Date()): Promise<WalletBackfillPlan> {
  const cutoff = lastClosedDay(now);
  const missing = new Set<string>();
  for (const key of BACKFILLED_SERIES) {
    const def = getSeriesDef(key);
    if (!def) continue;
    for (const day of missingDaysFromReport(await detectGaps(def, db, now), cutoff)) missing.add(day);
  }
  const ordered = [...missing].sort();
  if (ordered.length === 0) return { days: [], totalMissing: 0, deferred: 0, retrying: 0, exhausted: [] };

  const rows = await db<{ sample_date: Date; status: string }[]>`
    SELECT sample_date, status FROM wallet_backfill_state
  `;
  const byStatus = new Map(rows.map((r) => [isoDay(new Date(r.sample_date).getTime()), r.status]));
  return selectBackfillDays(ordered, byStatus, maxDaysPerRun());
}

/** The days one gap report says are missing and CLOSED. Pure, so the date
 *  arithmetic is testable without a database. */
export function missingDaysFromReport(
  report: { interiorGaps: string[]; headDate: string | null },
  cutoff: string,
): string[] {
  const out = new Set<string>();
  for (const iso of report.interiorGaps) {
    const day = iso.slice(0, 10);
    if (day <= cutoff) out.add(day);
  }
  // interiorGaps stops at the observed head by construction (it reports a hole
  // the series jumped OVER). Days after the head are stale-head territory and
  // are just as missing, so the tail is added explicitly — otherwise a series
  // that simply STOPPED would be reported forever and never repaired, which is
  // exactly the failure mode that produced the production AUM gap.
  if (report.headDate) {
    for (let t = utcMidnightMs(report.headDate.slice(0, 10)) + 86_400_000; t <= utcMidnightMs(cutoff); t += 86_400_000) {
      out.add(isoDay(t));
    }
  }
  return [...out].sort();
}

/**
 * Choose this run's days from the missing set and what earlier runs recorded.
 *
 * 'filled' and 'skipped' are settled. 'exhausted' is settled too — still a
 * disclosed gap, just no longer worth RPC. 'failed' is RETRIED: the usual cause
 * is a transient RPC or price failure, and a day that is quietly abandoned after
 * one bad minute is not self-healing.
 */
export function selectBackfillDays(
  orderedMissing: string[],
  byStatus: Map<string, string>,
  cap: number,
): WalletBackfillPlan {
  const candidates = orderedMissing.filter((d) => {
    const status = byStatus.get(d);
    return status === undefined || status === "failed";
  });
  return {
    days: candidates.slice(0, cap),
    totalMissing: candidates.length,
    deferred: Math.max(0, candidates.length - cap),
    retrying: candidates.filter((d) => byStatus.get(d) === "failed").length,
    exhausted: orderedMissing.filter((d) => byStatus.get(d) === "exhausted"),
  };
}

// ── The permanent date→block cache, backed by Postgres ───────────────────────

export function dayBlockCache(db: Db): DayBlockCache {
  return {
    async get(date) {
      const rows = await db<{ block_number: string; block_timestamp: Date }[]>`
        SELECT block_number, block_timestamp FROM chain_day_blocks WHERE sample_date = ${date}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        blockNumber: Number(row.block_number),
        blockTimestampSec: Math.floor(new Date(row.block_timestamp).getTime() / 1000),
      };
    },
    async set(date, blockNumber, blockTimestampSec) {
      await db`
        INSERT INTO chain_day_blocks (sample_date, block_number, block_timestamp)
        VALUES (${date}, ${blockNumber}, ${new Date(blockTimestampSec * 1000)})
        ON CONFLICT (sample_date) DO NOTHING
      `;
    },
  };
}

// ── The per-day executor ─────────────────────────────────────────────────────

export type BackfillDayStatus = "filled" | "skipped" | "failed" | "exhausted";

export interface BackfillDayResult {
  ok: boolean;
  sampleDate: string;
  status: BackfillDayStatus;
  blockNumber: number | null;
  balanceRows: number;
  sleeveRows: number;
  detail: string | null;
  /** Present only on a failed day. worker/loop.ts's degrade path reads this
   *  field for the job_runs error text, so the reason a day was refused ends up
   *  durable and greppable rather than only in a console line. */
  error?: string;
}

export interface WalletBackfillDeps {
  resolveBlock(date: string, opts: RpcCallOptions, cache: DayBlockCache, now: Date): Promise<ResolvedDayBlock>;
  readChainAmounts(reads: KeyedAssetRead[], logLabel: string, readOpts: ChainReadOptions): Promise<Map<string, ChainAmount>>;
  loadPrices(assets: TrackedAsset[], fromDate: string, toDate: string): Promise<HistoricalPriceTable>;
}

export const defaultWalletBackfillDeps: WalletBackfillDeps = {
  resolveBlock: (date, opts, cache, now) => resolveDayBlock(date, opts, cache, undefined, now),
  readChainAmounts: readChainAmountsBatched,
  loadPrices: loadHistoricalPrices,
};

const AGG = (symbol: string): string => `agg:${symbol}`;
const SLV = (walletIndex: number, symbol: string): string => `slv:${walletIndex}:${symbol}`;

/**
 * Build EVERY keyed read a day needs in ONE batch.
 *
 * The aggregate feed keys by symbol (raw balances summed across every prop
 * wallet); the sleeve feed keys per (wallet, symbol). They overlap, and the
 * overlap is deliberately not deduplicated: Multicall3 charges per eth_call and
 * not per inner read (27 inner reads cost ONE token — §6.5.3), so an extra
 * balanceOf inside the same batch is free while a second batch is not. One
 * batch per day means ≤2 eth_calls per day for both series, instead of ≤4.
 *
 * SP500 is absent. It is not a chain read at all (valuationKind 'config'), #648
 * records that the column splices two different measurements, and PD7's
 * recommendation is to SKIP it rather than approximate it. A backfilled day
 * therefore carries no SP500 row — honest sparseness, which WalletHistoryPoint
 * already documents, rather than an invented one.
 */
export function buildDayReads(
  assets: TrackedAsset[],
  wallets: string[],
): { reads: KeyedAssetRead[]; sleeveTargets: { key: string; walletAddress: string; asset: TrackedAsset }[] } {
  const chainAssets = assets.filter((a) => a.valuationKind !== "config");
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
  const reads: KeyedAssetRead[] = chainAssets.map((a) => ({ key: AGG(a.symbol), asset: a, wallets }));

  const sleeveTargets: { key: string; walletAddress: string; asset: TrackedAsset }[] = [];
  for (let i = 0; i < SLEEVE_DEFS.length && i < wallets.length; i++) {
    const address = wallets[i]!;
    const walletAssets = SLEEVE_DEFS[i]!.symbols
      .map((s) => bySymbol.get(s))
      .filter((a): a is TrackedAsset => a != null && (a.valuationKind === "native" || !isPlaceholderAddress(a.address)));
    for (const a of walletAssets) {
      const key = SLV(i, a.symbol);
      reads.push({ key, asset: a, wallets: [address] });
      sleeveTargets.push({ key, walletAddress: address.toLowerCase(), asset: a });
    }
  }
  return { reads, sleeveTargets };
}

/**
 * Repair ONE day.
 *
 * DAY-ATOMIC, and that is a correctness requirement rather than tidiness: round
 * 2 of the chain read (`convertToAssets` NAV, chain/wallet-valuation.ts) depends
 * on round 1's output, so a half-read day produces a total that is plausible and
 * wrong. If any leg of the day fails, NOTHING is written for it and the day
 * stays in the gap report.
 */
export async function backfillWalletDay(
  db: Db,
  date: string,
  deps: WalletBackfillDeps = defaultWalletBackfillDeps,
  now: Date = new Date(),
): Promise<BackfillDayResult> {
  const fail = async (detail: string, blockNumber: number | null = null): Promise<BackfillDayResult> => {
    const attempts = await bumpAttempts(db, date);
    const exhausted = attempts >= maxAttemptsPerDay();
    const status: BackfillDayStatus = exhausted ? "exhausted" : "failed";
    await recordState(db, date, status, blockNumber, 0, 0, detail, attempts);
    console.warn(`wallet-backfill: ${date} refused (attempt ${attempts}${exhausted ? ", exhausted" : ""}) — ${detail}`);
    // An exhausted day returns ok:true so the QUEUE stops retrying it — the day
    // itself is still an unrepaired, still-reported gap; what has stopped is the
    // spending, not the disclosure.
    return exhausted
      ? { ok: true, sampleDate: date, status, blockNumber, balanceRows: 0, sleeveRows: 0, detail }
      : { ok: false, sampleDate: date, status, blockNumber, balanceRows: 0, sleeveRows: 0, detail, error: detail };
  };
  const skip = async (detail: string, blockNumber: number | null = null): Promise<BackfillDayResult> => {
    await recordState(db, date, "skipped", blockNumber, 0, 0, detail, null);
    return { ok: true, sampleDate: date, status: "skipped", blockNumber, balanceRows: 0, sleeveRows: 0, detail };
  };

  if (date > lastClosedDay(now)) {
    return skip(`${date} has not closed yet — the live sampler owns the current day`);
  }
  assertRpcBudgetConfigured();

  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();

  // 1. asof → block. Permanent cache, so a re-run over the same window is free.
  let resolved: ResolvedDayBlock;
  try {
    resolved = await deps.resolveBlock(date, { rpcUrl: config.baseRpcUrl }, dayBlockCache(db), now);
  } catch (err) {
    return fail(`block resolution failed: ${String(err)}`);
  }
  const blockTag = toBlockTag(resolved.blockNumber);

  // 2. Read every leg AT THAT BLOCK, with the silent-zero rail armed.
  const { reads, sleeveTargets } = buildDayReads(assets, wallets);
  let amounts: Map<string, ChainAmount>;
  try {
    amounts = await deps.readChainAmounts(reads, `wallet-backfill ${date}`, { blockTag, strictEmptyReturn: true });
  } catch (err) {
    return fail(`chain read failed at block ${resolved.blockNumber}: ${String(err)}`, resolved.blockNumber);
  }
  const unreadable = reads.filter((r) => !amounts.get(r.key)?.ok).map((r) => r.key);
  if (unreadable.length > 0) {
    // Day-atomic: one unreadable leg fails the DAY. An empty return here is a
    // contract with no code at this block, never a zero.
    return fail(
      `${unreadable.length} leg(s) unreadable at block ${resolved.blockNumber} (${unreadable.slice(0, 6).join(", ")})`,
      resolved.blockNumber,
    );
  }

  // 3. Price at that DATE (not at spot). A missing price fails the day rather
  //    than valuing a real holding at zero, which would read as a drawdown.
  let prices: HistoricalPriceTable;
  try {
    prices = await deps.loadPrices(
      assets.filter((a) => a.valuationKind !== "config"),
      date,
      date,
    );
  } catch (err) {
    return fail(`historical price load failed: ${String(err)}`, resolved.blockNumber);
  }
  const priceFor = (symbol: string): number | undefined => prices.get(symbol)?.get(date);
  const unpriced = reads
    .map((r) => r.asset.symbol)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .filter((s) => !Number.isFinite(priceFor(s) ?? NaN));
  if (unpriced.length > 0) {
    return fail(`no ${date} price for ${unpriced.join(", ")}`, resolved.blockNumber);
  }

  // 4. Write the day in ONE transaction, and only into a day that is still
  //    empty. Repair fills holes; it never restates a day the sampler wrote.
  const sampledAt = new Date(resolved.blockTimestampSec * 1000);
  let balanceRows = 0;
  let sleeveRows = 0;
  const skippedTables: string[] = [];

  await db.begin(async (tx) => {
    // Reset the counters inside the closure: if the transaction body ever runs
    // twice, the recorded row counts must describe THIS attempt, not the sum.
    balanceRows = 0;
    sleeveRows = 0;
    skippedTables.length = 0;
    const [existingBalance] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wallet_balance_samples WHERE sample_date = ${date}
    `;
    const [existingSleeve] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wallet_sleeve_samples WHERE sample_date = ${date}
    `;

    if ((existingBalance?.n ?? 0) === 0) {
      for (const r of reads) {
        if (!r.key.startsWith("agg:")) continue;
        const amount = amounts.get(r.key)!;
        if (!amount.ok) continue; // unreachable: checked above
        const priceUsd = priceFor(r.asset.symbol)!;
        await tx`
          INSERT INTO wallet_balance_samples
            (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
          VALUES
            (${date}, ${r.asset.symbol}, ${amount.amount}, ${priceUsd}, ${amount.amount * priceUsd}, 'backfilled', ${sampledAt})
          ON CONFLICT (sample_date, symbol) DO NOTHING
        `;
        balanceRows += 1;
      }
    } else {
      skippedTables.push("wallet_balance_samples");
    }

    if ((existingSleeve?.n ?? 0) === 0) {
      for (const t of sleeveTargets) {
        const amount = amounts.get(t.key)!;
        if (!amount.ok) continue; // unreachable: checked above
        const priceUsd = priceFor(t.asset.symbol)!;
        await tx`
          INSERT INTO wallet_sleeve_samples
            (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
          VALUES
            (${date}, ${t.walletAddress}, ${t.asset.symbol}, ${amount.amount}, ${priceUsd}, ${amount.amount * priceUsd}, 'backfilled', ${sampledAt})
          ON CONFLICT (sample_date, wallet_address, symbol) DO NOTHING
        `;
        sleeveRows += 1;
      }
    } else {
      skippedTables.push("wallet_sleeve_samples");
    }

    // The checkpoint commits WITH the day's rows, so it can never claim a day
    // that was not actually written.
    const status: BackfillDayStatus = balanceRows + sleeveRows > 0 ? "filled" : "skipped";
    const detail = skippedTables.length > 0 ? `already populated: ${skippedTables.join(", ")}` : null;
    await tx`
      INSERT INTO wallet_backfill_state
        (sample_date, status, block_number, balance_rows, sleeve_rows, detail, attempted_at)
      VALUES
        (${date}, ${status}, ${resolved.blockNumber}, ${balanceRows}, ${sleeveRows}, ${detail}, now())
      ON CONFLICT (sample_date) DO UPDATE SET
        status       = EXCLUDED.status,
        block_number = EXCLUDED.block_number,
        balance_rows = EXCLUDED.balance_rows,
        sleeve_rows  = EXCLUDED.sleeve_rows,
        detail       = EXCLUDED.detail,
        attempted_at = EXCLUDED.attempted_at
    `;
  });

  const status: BackfillDayStatus = balanceRows + sleeveRows > 0 ? "filled" : "skipped";
  return {
    ok: true,
    sampleDate: date,
    status,
    blockNumber: resolved.blockNumber,
    balanceRows,
    sleeveRows,
    detail: skippedTables.length > 0 ? `already populated: ${skippedTables.join(", ")}` : null,
  };
}

/** Read-and-increment this day's attempt counter, returning the NEW count. */
async function bumpAttempts(db: Db, date: string): Promise<number> {
  const rows = await db<{ attempts: number }[]>`
    SELECT attempts FROM wallet_backfill_state WHERE sample_date = ${date}
  `;
  return (rows[0]?.attempts ?? 0) + 1;
}

// The checkpoint write for a day that produced NO rows. Kept out of the
// transaction above because there is no transaction in those paths — the day
// failed or was skipped before any write was attempted. `attempts` of null
// leaves the existing counter alone (a skip is not a failed attempt).
async function recordState(
  db: Db,
  date: string,
  status: BackfillDayStatus,
  blockNumber: number | null,
  balanceRows: number,
  sleeveRows: number,
  detail: string | null,
  attempts: number | null,
): Promise<void> {
  await db`
    INSERT INTO wallet_backfill_state
      (sample_date, status, block_number, balance_rows, sleeve_rows, attempts, detail, attempted_at)
    VALUES
      (${date}, ${status}, ${blockNumber}, ${balanceRows}, ${sleeveRows}, ${attempts ?? 0}, ${detail}, now())
    ON CONFLICT (sample_date) DO UPDATE SET
      status       = EXCLUDED.status,
      block_number = EXCLUDED.block_number,
      balance_rows = EXCLUDED.balance_rows,
      sleeve_rows  = EXCLUDED.sleeve_rows,
      attempts     = COALESCE(${attempts}, wallet_backfill_state.attempts),
      detail       = EXCLUDED.detail,
      attempted_at = EXCLUDED.attempted_at
  `;
}
