// THE CLASS C REPAIR DRIVER — the thing that makes "self-healing" true for the
// wallet/AUM series (issue #709; docs/technical/markets-asset-pricing-ingest.md §5).
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
//   * It never silently overwrites a day that already has rows. A complete day
//     is untouched; an incomplete day is copied to immutable evidence before a
//     complete replacement snapshot is committed (markets §6.5's append-only boundary).
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
  resolveBaseRpcSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../config.ts";
import { resolveRpcRateBudget, toBlockTag, type RpcCallOptions } from "../chain/base-rpc-client.ts";
import {
  resolveDayBlock,
  resolveDayBlocks,
  type DayBlockCache,
  type DayBlockOutcome,
  type ResolvedDayBlock,
} from "../chain/block-resolver.ts";
import {
  resolveAddressFloors,
  type AddressFloor,
  type AddressFloorCache,
} from "../chain/address-floor-resolver.ts";
import { loadHistoricalPrices, type HistoricalPriceTable } from "../chain/historical-prices.ts";
import {
  readChainAmountsAtBlocks,
  readChainAmountsBatched,
  QUARANTINED_PROVENANCE,
  type ChainAmount,
  type ChainReadOptions,
  type KeyedAssetRead,
} from "../chain/wallet-valuation.ts";
import { detectGaps } from "./gap-detector.ts";
import { getSeriesDef } from "./series-registry.ts";
import {
  lockWalletSnapshotDate,
  resolveWalletSnapshotManifest,
  sleeveManifestKey,
  type WalletSnapshotManifest,
} from "./wallet-snapshot-manifest.ts";

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
 *  A day can be unrepairable for a permanent reason. The most common one — a
 *  day preceding a tracked address's on-chain deployment — is now caught
 *  proactively by the earliest-valid-block floor (issue #760, above) and
 *  routed to 'skipped' before it ever reaches this ceiling, at zero attempt
 *  cost. This ceiling remains for reasons the floor cannot see in advance: an
 *  address deployed but permanently unreadable some other way, say. Retrying
 *  such a day on every scheduled run would spend a metered RPC budget forever
 *  to re-learn the same fact. After the ceiling the day is marked 'exhausted':
 *  still an unrepaired gap, still
 *  reported by GET /api/admin/gaps, just no longer retried. Nothing is
 *  interpolated and nothing is marked handled. */
export function maxAttemptsPerDay(): number {
  return intEnv("WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY", 3, 1);
}

// ── The shared-leg circuit breaker (issue #761) ──────────────────────────────
//
// deferDay() is right to never charge a day's attempt counter for a shared-leg
// refusal — that is what stops a ten-second provider blip from retiring ten
// days permanently (see deferDay's doc comment below). It never distinguished
// a TRANSIENT shared-leg refusal from a PERMANENT one, though: a mistyped pin
// or a delisted pool refuses identically on every retry, so with no counter at
// all the same days were re-selected on every scheduled run forever, spending
// the whole per-run budget re-earning the same refusal instead of making room
// for other, repairable gaps.
//
// How many CONSECUTIVE, SEPARATE refusals of the same leg move a day to the
// terminal 'blocked' status (bumpDeferStreak() below).
export function legTerminalThreshold(): number {
  return intEnv("WALLET_BACKFILL_LEG_TERMINAL_THRESHOLD", 3, 1);
}

/** How close together two defers of the SAME leg must land to be treated as
 *  ONE incident rather than two. Sized well above the queue's own retry burst
 *  (worker/loop.ts backs off 2^attempts seconds, capped at 3600s, so a job's
 *  own retries land within tens of seconds) and well below the dispatcher's
 *  five-minute scheduled cadence (#749) — so a single transient provider
 *  blip retried three times by the queue in ten seconds still counts as ONE
 *  refusal, exactly as it does today, while three genuinely separate
 *  SCHEDULED runs that all hit the same wall do not. */
export function legDebounceMs(): number {
  return intEnv("WALLET_BACKFILL_LEG_DEBOUNCE_MS", 60_000, 1);
}

/** How long a 'blocked' day is excluded from replanning before one more
 *  attempt is let through — the mechanism that makes AC4 true: correcting the
 *  underlying cause (the pin, the RPC config) repairs the day automatically on
 *  the next elapsed cooldown, with no hand-written SQL. Deliberately far above
 *  the dispatcher cadence so a permanently broken leg costs roughly one probe
 *  an hour instead of twelve. */
export function legRetryCooldownMs(): number {
  return intEnv("WALLET_BACKFILL_LEG_RETRY_COOLDOWN_MINUTES", 60, 1) * 60_000;
}

// ── The RPC budget precondition (PD6) ────────────────────────────────────────

/**
 * Refuse to run a LIVE backfill while pacing is explicitly turned OFF.
 *
 * This is not defensive boilerplate; it is the one mechanism that stops this
 * feature from re-creating the incident it exists to repair: an unpaced
 * multi-day sweep against a per-IP-metered provider is exactly what killed
 * `vault.sample_share_price` on 2026-08-10.
 *
 * WHAT CHANGED, AND WHAT DID NOT. The budget is no longer something an operator
 * must set before anything happens — chain/base-rpc-client.ts now carries a
 * conservative hardcoded default (half the measured refill), so the ordinary
 * deployment is paced and this check passes. See that file for why a safe
 * constant beats an unset knob. What has NOT changed is the refusal itself:
 * `BASE_RPC_MAX_CALLS_PER_SEC=0` still means no limiter anywhere, and a
 * deployment that has chosen that must not sweep.
 *
 * Only LIVE reads are gated: under BASE_RPC_SOURCE=stub there is no provider
 * bucket to exhaust.
 */
export function assertRpcBudgetConfigured(): void {
  if (resolveBaseRpcSource() !== "live") return;
  if (resolveRpcRateBudget()) return;
  throw new Error(
    "wallet-backfill: refusing to run with BASE_RPC_MAX_CALLS_PER_SEC=0 (pacing explicitly disabled) — " +
      "the backfill shares the live sampler's per-IP RPC budget and must never run unpaced (PD6, issue #651). " +
      "Unset the variable to use the conservative default instead.",
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
  /** Days at the shared-leg circuit breaker's terminal state (issue #761):
   *  still a disclosed gap, no longer re-selected every run, retried
   *  automatically once WALLET_BACKFILL_LEG_RETRY_COOLDOWN_MINUTES has passed
   *  since the leg's last refusal. Unlike `exhausted`, this clears itself the
   *  moment the underlying leg is fixed — no hand-written SQL required. */
  blocked: string[];
  /** Same days as `blocked`, naming which leg tripped and why — what the
   *  dispatcher output (repair.ts::repairGaps) surfaces on EVERY run, not just
   *  the run that tripped it. Populated by planWalletBackfill, which has the
   *  raw rows selectBackfillDays()'s pure signature does not. */
  blockedDetail: { date: string; leg: string; detail: string | null }[];
}

/**
 * Derive the work list FROM THE DATA, via the same gap detector the operator
 * surface reads.
 *
 * Deliberately not from a cursor and not from job rows: markets §4.1's
 * unification point is that there must be exactly ONE notion of "which days are missing",
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
  if (ordered.length === 0) {
    return { days: [], totalMissing: 0, deferred: 0, retrying: 0, exhausted: [], blocked: [], blockedDetail: [] };
  }

  const rows = await db<
    { sample_date: Date; status: string; defer_leg: string | null; defer_leg_at: Date | null; detail: string | null }[]
  >`
    SELECT sample_date, status, defer_leg, defer_leg_at, detail FROM wallet_backfill_state
  `;
  const byStatus = new Map(rows.map((r) => [isoDay(new Date(r.sample_date).getTime()), r.status]));
  // A 'blocked' day is let back into candidates only once its cooldown has
  // elapsed since the leg's last refusal — the one automatic probe per
  // cooldown window that lets a corrected leg heal its days without an
  // operator running SQL by hand.
  const cooldownMs = legRetryCooldownMs();
  const retryEligible = new Set(
    rows
      .filter(
        (r) =>
          r.status === "blocked" &&
          (r.defer_leg_at == null || now.getTime() - new Date(r.defer_leg_at).getTime() >= cooldownMs),
      )
      .map((r) => isoDay(new Date(r.sample_date).getTime())),
  );
  const plan = selectBackfillDays(ordered, byStatus, maxDaysPerRun(), retryEligible);
  const blockedSet = new Set(plan.blocked);
  const blockedDetail = rows
    .filter((r) => blockedSet.has(isoDay(new Date(r.sample_date).getTime())))
    .map((r) => ({ date: isoDay(new Date(r.sample_date).getTime()), leg: r.defer_leg ?? "unknown", detail: r.detail }));
  return { ...plan, blockedDetail };
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
 * A status cannot overrule the data. Every input here is already a detected
 * gap, so 'filled' or 'skipped' means the checkpoint and active rows disagree
 * and the day must be retried. Only 'exhausted' suppresses automatic spending;
 * it remains disclosed as a gap.
 */
export function selectBackfillDays(
  orderedMissing: string[],
  byStatus: Map<string, string>,
  cap: number,
  /** Blocked days whose cooldown has elapsed — let back into candidates for
   *  one more attempt. Defaults to empty so every existing caller (and every
   *  status other than 'blocked') is unaffected. */
  retryEligibleBlocked: ReadonlySet<string> = new Set(),
): WalletBackfillPlan {
  const candidates = orderedMissing.filter((d) => {
    const status = byStatus.get(d);
    if (status === "exhausted") return false;
    if (status === "blocked" && !retryEligibleBlocked.has(d)) return false;
    return true;
  });
  return {
    days: candidates.slice(0, cap),
    totalMissing: candidates.length,
    deferred: Math.max(0, candidates.length - cap),
    retrying: candidates.filter((d) => byStatus.has(d)).length,
    exhausted: orderedMissing.filter((d) => byStatus.get(d) === "exhausted"),
    blocked: orderedMissing.filter((d) => byStatus.get(d) === "blocked"),
    blockedDetail: [],
  };
}

// ── The permanent date→block cache, backed by Postgres ───────────────────────

export function dayBlockCache(db: Db): DayBlockCache {
  return {
    async get(date) {
      const rows = await db<{
        block_number: string;
        block_hash: string | null;
        block_timestamp: Date;
        boundary_next_block_number: string | null;
        boundary_next_block_hash: string | null;
        boundary_next_block_timestamp: Date | null;
      }[]>`
        SELECT block_number, block_hash, block_timestamp,
               boundary_next_block_number, boundary_next_block_hash,
               boundary_next_block_timestamp
          FROM chain_day_blocks
         WHERE sample_date = ${date}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        blockNumber: Number(row.block_number),
        blockHash: row.block_hash,
        blockTimestampSec: Math.floor(new Date(row.block_timestamp).getTime() / 1000),
        boundaryNextBlockNumber:
          row.boundary_next_block_number === null ? null : Number(row.boundary_next_block_number),
        boundaryNextBlockHash: row.boundary_next_block_hash,
        boundaryNextBlockTimestampSec: row.boundary_next_block_timestamp === null
          ? null
          : Math.floor(new Date(row.boundary_next_block_timestamp).getTime() / 1000),
      };
    },
    async set(date, proof) {
      await db`
        INSERT INTO chain_day_blocks
          (sample_date, block_number, block_hash, block_timestamp,
           boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp)
        VALUES
          (${date}, ${proof.blockNumber}, ${proof.blockHash},
           ${new Date(proof.blockTimestampSec * 1000)},
           ${proof.boundaryNextBlockNumber}, ${proof.boundaryNextBlockHash},
           ${proof.boundaryNextBlockTimestampSec === null
             ? null
             : new Date(proof.boundaryNextBlockTimestampSec * 1000)})
        ON CONFLICT (sample_date) DO UPDATE SET
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          block_timestamp = EXCLUDED.block_timestamp,
          boundary_next_block_number = EXCLUDED.boundary_next_block_number,
          boundary_next_block_hash = EXCLUDED.boundary_next_block_hash,
          boundary_next_block_timestamp = EXCLUDED.boundary_next_block_timestamp,
          resolved_at = now()
      `;
    },
  };
}

// ── The permanent address→floor cache, backed by Postgres (issue #760) ──────

export function addressFloorCache(db: Db): AddressFloorCache {
  return {
    async get(address) {
      const rows = await db<{ floor_block: string }[]>`
        SELECT floor_block FROM chain_address_floors WHERE address = ${address}
      `;
      const row = rows[0];
      return row ? Number(row.floor_block) : null;
    },
    async set(address, floorBlock) {
      await db`
        INSERT INTO chain_address_floors (address, floor_block)
        VALUES (${address}, ${floorBlock})
        ON CONFLICT (address) DO UPDATE SET
          floor_block = EXCLUDED.floor_block,
          resolved_at = now()
      `;
    },
  };
}

/** Tracked assets whose block-addressed reads use CODE PRESENCE as the
 *  silent-zero signal (§6.1) — i.e. every leg actually read via a contract
 *  call at `address`. Excludes 'native' (ETH's balance comes from
 *  eth_getBalance against a WALLET address, which returns a genuine zero for
 *  any account, never the "no code here" shape isEmptyReturnData exists to
 *  catch — `address` on the ETH row is only WETH's PRICING address, not a
 *  balanceOf target, see config.ts) and assets with no address at all
 *  (SP500, valuationKind 'config'). */
function floorEligibleAssets(assets: readonly TrackedAsset[]): (TrackedAsset & { address: string })[] {
  return assets.filter((a): a is TrackedAsset & { address: string } => a.address !== null && a.valuationKind !== "native");
}

// ── The per-day executor ─────────────────────────────────────────────────────

export type BackfillDayStatus = "filled" | "skipped" | "failed" | "exhausted" | "blocked";

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
  /** The BATCHED resolver. Optional so a caller that injects only the per-day
   *  `resolveBlock` still drives the real executor (every existing test does);
   *  production supplies it and takes the lockstep path. */
  resolveBlocks?(
    dates: readonly string[],
    opts: RpcCallOptions,
    cache: DayBlockCache,
    now: Date,
  ): Promise<DayBlockOutcome[]>;
  readChainAmounts(reads: KeyedAssetRead[], logLabel: string, readOpts: ChainReadOptions): Promise<Map<string, ChainAmount>>;
  /** The MULTI-BLOCK reader. Optional for the same reason `resolveBlocks` is:
   *  a caller injecting only the single-block `readChainAmounts` still drives
   *  the real executor. Production supplies it, so a window's days are read in
   *  two requests rather than two per day. */
  readChainAmountsAtBlocks?(
    reads: KeyedAssetRead[],
    logLabel: string,
    blockTags: readonly string[],
    readOpts: ChainReadOptions,
  ): Promise<Map<string, Map<string, ChainAmount>>>;
  loadPrices(assets: TrackedAsset[], fromDate: string, toDate: string): Promise<HistoricalPriceTable>;
  /** The per-address earliest-valid-block floor (issue #760). Optional so a
   *  caller injecting only the required deps above — every existing test does
   *  — still drives the real executor with no floor check at all, exactly the
   *  prior behaviour: an omitted dep here changes nothing. Production supplies
   *  the real chain-backed resolver, so a day preceding a tracked address's
   *  deployment is skipped rather than fought to `exhausted`. */
  resolveAddressFloors?(
    addresses: readonly string[],
    opts: RpcCallOptions,
    cache: AddressFloorCache,
  ): Promise<Map<string, AddressFloor>>;
}

export const defaultWalletBackfillDeps: WalletBackfillDeps = {
  resolveBlock: (date, opts, cache, now) => resolveDayBlock(date, opts, cache, undefined, now),
  resolveBlocks: (dates, opts, cache, now) => resolveDayBlocks(dates, opts, cache, undefined, now),
  readChainAmounts: readChainAmountsBatched,
  readChainAmountsAtBlocks,
  loadPrices: loadHistoricalPrices,
  resolveAddressFloors: (addresses, opts, cache) => resolveAddressFloors(addresses, opts, cache),
};

const AGG = (symbol: string): string => `agg:${symbol}`;
const SLV = (walletIndex: number, symbol: string): string => `slv:${walletIndex}:${symbol}`;

/**
 * Build EVERY keyed read a day needs in ONE batch.
 *
 * The aggregate feed keys by symbol (raw balances summed across every prop
 * wallet); the sleeve feed keys per (wallet, symbol). They overlap, and the
 * overlap is deliberately not deduplicated: Multicall3 charges per eth_call and
 * not per inner read (27 inner reads cost ONE token — markets §3.4), so an extra
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
  const manifest = resolveWalletSnapshotManifest(assets, wallets);
  const reads: KeyedAssetRead[] = manifest.balanceAssets.map((asset) => ({ key: AGG(asset.symbol), asset, wallets }));

  const sleeveTargets: { key: string; walletAddress: string; asset: TrackedAsset }[] = [];
  for (const target of manifest.sleeveKeys) {
    const key = SLV(target.walletIndex, target.asset.symbol);
    reads.push({ key, asset: target.asset, wallets: [target.walletAddress] });
    sleeveTargets.push({ key, walletAddress: target.walletAddress, asset: target.asset });
  }
  return { reads, sleeveTargets };
}

interface WalletSnapshotCompleteness {
  complete: boolean;
  missingBalanceSymbols: string[];
  missingSleeveKeys: string[];
  balanceRows: number;
  sleeveRows: number;
}

/** Inspect active rows against the same manifest the writer uses.
 *
 * counts-quarantined: DELIBERATE — quarantined rows are selected so they can be
 * counted as occupied evidence awaiting archival, but they are excluded from
 * the present-key sets and therefore can never make a snapshot complete. */
async function inspectWalletSnapshot(
  db: Db,
  date: string,
  manifest: WalletSnapshotManifest,
  lockRows = false,
): Promise<WalletSnapshotCompleteness> {
  const balances = await db<{ symbol: string; provenance: string }[]>`
    SELECT symbol, provenance
      FROM wallet_balance_samples
     WHERE sample_date = ${date}
     ${lockRows ? db`FOR UPDATE` : db``}
  `;
  // counts-quarantined: DELIBERATE — same evidence/coverage distinction above.
  const sleeves = await db<{ wallet_address: string; symbol: string; provenance: string }[]>`
    SELECT wallet_address, symbol, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = ${date}
     ${lockRows ? db`FOR UPDATE` : db``}
  `;
  const balanceSymbols = new Set(
    balances.filter((row) => row.provenance !== QUARANTINED_PROVENANCE).map((row) => row.symbol),
  );
  const sleeveKeys = new Set(
    sleeves
      .filter((row) => row.provenance !== QUARANTINED_PROVENANCE)
      .map((row) => sleeveManifestKey(row.wallet_address, row.symbol)),
  );
  const missingBalanceSymbols = manifest.balanceAssets
    .map((asset) => asset.symbol)
    .filter((symbol) => !balanceSymbols.has(symbol));
  const missingSleeveKeys = manifest.sleeveKeys
    .map((key) => sleeveManifestKey(key.walletAddress, key.asset.symbol))
    .filter((key) => !sleeveKeys.has(key));
  return {
    complete: missingBalanceSymbols.length === 0 && missingSleeveKeys.length === 0,
    missingBalanceSymbols,
    missingSleeveKeys,
    balanceRows: balances.length,
    sleeveRows: sleeves.length,
  };
}

/** Record a day's refusal. Lifted out of the executor unchanged so the window
 *  and the single-day path cannot drift in how a failure is written down. */
async function failDay(
  db: Db,
  date: string,
  detail: string,
  blockNumber: number | null = null,
): Promise<BackfillDayResult> {
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
}

/** Record a refusal that was NOT this day's fault — a shared leg failed and took
 *  the whole window with it.
 *
 *  WHY THIS IS NOT `failDay`. The per-day ceiling
 *  (WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY, default 3) exists to stop spending
 *  provider budget on a day that cannot be read. Once #739 made the WINDOW the
 *  unit, three shared legs — the historical price load, the whole-window chain
 *  read, and the resolver's head-block probe — began failing every day at once.
 *  Charging each of them to every day turned a single transient into a
 *  ten-day-wide charge, and the queue's own degraded retry
 *  (worker/loop.ts, backoff 2^attempts seconds) lands three of those inside
 *  about ten seconds. `exhausted` is terminal — selectBackfillDays() re-plans
 *  only undefined and 'failed' — so roughly ten seconds of provider trouble
 *  retired ten days permanently, recoverable only by hand-written SQL.
 *
 *  So: a day is charged an attempt only for a refusal attributable to that day
 *  (its block unreadable, its legs unreadable, its own assets unpriced). A
 *  shared-leg failure is written down as 'failed' with the detail, `attempts`
 *  left alone (recordState treats null as "leave the counter"), and the day
 *  stays re-plannable on the next sweep. The gap is still a gap and still
 *  reported by GET /api/admin/gaps either way — what differs is whether the
 *  system will ever try again.
 *
 *  ISSUE #761 — never charging an attempt is right for a TRANSIENT shared leg
 *  and wrong for a PERMANENT one: a mistyped pin or a delisted pool refuses
 *  IDENTICALLY on every retry, so with no counter at all the same days were
 *  re-selected on every scheduled run forever. `leg` names which shared leg is
 *  to blame (a stable identity — "price-load", "price-pool:<symbols>",
 *  "block-resolve-head", "chain-read-window", "snapshot-write" — not the raw
 *  error text, so a 429 one run and a timeout the next still count as the SAME
 *  leg misbehaving). bumpDeferStreak() below counts consecutive, SEPARATE
 *  refusals of that leg; crossing legTerminalThreshold() moves the day to the
 *  terminal 'blocked' status instead of another 'failed' — still disclosed,
 *  no longer re-selected every run, and retried automatically once its
 *  cooldown elapses (planWalletBackfill), which is what makes a corrected leg
 *  heal its days without hand-written SQL. */
async function deferDay(
  db: Db,
  date: string,
  detail: string,
  leg: string,
  now: Date,
  blockNumber: number | null = null,
): Promise<BackfillDayResult> {
  const streak = await bumpDeferStreak(db, date, leg, now);
  const blocked = streak >= legTerminalThreshold();
  const status: BackfillDayStatus = blocked ? "blocked" : "failed";
  const fullDetail = blocked
    ? `${detail} — BLOCKED: shared leg '${leg}' refused ${streak} consecutive times; retried automatically ` +
      `once ${Math.round(legRetryCooldownMs() / 60_000)}m have passed since the last refusal, no SQL needed`
    : detail;
  await db`
    UPDATE wallet_backfill_state
       SET status = ${status}, block_number = ${blockNumber}, detail = ${fullDetail}, attempted_at = now()
     WHERE sample_date = ${date}
  `;
  console.warn(
    `wallet-backfill: ${date} ${blocked ? "BLOCKED" : "deferred"} (shared leg '${leg}', attempt not charged, streak ${streak}) — ${detail}`,
  );
  // A blocked day, like an exhausted one, returns ok:true so the queue stops
  // marking the run degraded over a state that is already known and disclosed
  // — what has paused is the spending, not the reporting.
  return blocked
    ? { ok: true, sampleDate: date, status, blockNumber, balanceRows: 0, sleeveRows: 0, detail: fullDetail }
    : { ok: false, sampleDate: date, status, blockNumber, balanceRows: 0, sleeveRows: 0, detail: fullDetail, error: fullDetail };
}

/**
 * Advance (or start) the per-day, per-leg consecutive-refusal streak, and
 * return the resulting count.
 *
 * DEBOUNCED, DELIBERATELY. The queue retries a degraded job with its own
 * exponential backoff (worker/loop.ts, 2^attempts seconds, capped at 3600) —
 * so a single transient provider blip can call deferDay() for the SAME leg
 * two or three times within about ten seconds, exactly the burst deferDay
 * exists to absorb without spending a day's attempt ceiling. Without a
 * debounce, that one blip would ALSO trip the leg breaker on its own. Two
 * calls for the same leg less than legDebounceMs() apart are therefore folded
 * into the SAME streak entry (the streak does not advance, and the streak
 * clock does not reset either — otherwise a burst faster than the debounce
 * window could starve the counter indefinitely); calls further apart than
 * that — in practice, on separate scheduled dispatcher runs — count as
 * genuinely separate refusals.
 *
 * A leg change resets the streak to 1: a different symptom is a different
 * incident, not a continuation of the old one.
 */
async function bumpDeferStreak(db: Db, date: string, leg: string, now: Date): Promise<number> {
  const debounceMs = legDebounceMs();
  const [row] = await db<{ defer_streak: number }[]>`
    INSERT INTO wallet_backfill_state (sample_date, status, defer_leg, defer_streak, defer_leg_at)
    VALUES (${date}, 'failed', ${leg}, 1, ${now})
    ON CONFLICT (sample_date) DO UPDATE SET
      defer_streak = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM ${leg} THEN 1
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > ${now}::timestamptz - (${debounceMs}::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_streak
        ELSE wallet_backfill_state.defer_streak + 1
      END,
      defer_leg = ${leg},
      defer_leg_at = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM ${leg} THEN ${now}::timestamptz
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > ${now}::timestamptz - (${debounceMs}::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_leg_at
        ELSE ${now}::timestamptz
      END
    RETURNING defer_streak
  `;
  return row!.defer_streak;
}

async function skipDay(
  db: Db,
  date: string,
  detail: string,
  blockNumber: number | null = null,
): Promise<BackfillDayResult> {
  await recordState(db, date, "skipped", blockNumber, 0, 0, detail, null);
  return { ok: true, sampleDate: date, status: "skipped", blockNumber, balanceRows: 0, sleeveRows: 0, detail };
}

/**
 * Repair a WINDOW of days — the batched executor, and the ONLY executor.
 *
 * WHY A WINDOW IS THE UNIT NOW. The provider meters HTTP hits, and the two
 * costs a day carries are both shareable across days:
 *
 *   * BLOCK RESOLUTION — the searches are independent across days, so they run
 *     in lockstep and a whole window's blocks cost about what one day's cost
 *     (chain/block-resolver.ts::resolveDayBlocks). This was ~80% of a run.
 *   * HISTORICAL PRICES — loadHistoricalPrices already takes a DATE RANGE and
 *     pages daily candles, so a window loads once where the per-day executor
 *     loaded N times. That is not just cheaper, it is the fix for an observed
 *     failure: on 2026-08-22 a repair run lost 2026-03-18 to a price-feed 429
 *     caused by nothing but its own per-day fan-out.
 *
 * WHAT DOES NOT CHANGE, AND MUST NOT. Every day is still written in ITS OWN
 * transaction with its own checkpoint, so an interruption still loses at most
 * one day. Every day still fails ALONE — a window is a batching unit, never a
 * blast radius. And a day is still DAY-ATOMIC: if any leg of it fails, nothing
 * is written for it and it stays in the gap report.
 */
export async function backfillWalletWindow(
  db: Db,
  dates: readonly string[],
  deps: WalletBackfillDeps = defaultWalletBackfillDeps,
  now: Date = new Date(),
): Promise<BackfillDayResult[]> {
  const out = new Map<string, BackfillDayResult>();
  const cutoff = lastClosedDay(now);
  const closed: string[] = [];
  for (const date of dates) {
    if (date > cutoff) {
      out.set(date, await skipDay(db, date, `${date} has not closed yet — the live sampler owns the current day`));
      continue;
    }
    closed.push(date);
  }
  const settle = (): BackfillDayResult[] =>
    dates.map(
      (d) =>
        out.get(d) ?? {
          ok: false,
          sampleDate: d,
          status: "failed" as const,
          blockNumber: null,
          balanceRows: 0,
          sleeveRows: 0,
          detail: "no outcome",
          error: "no outcome",
        },
    );
  if (closed.length === 0) return settle();

  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();
  const manifest = resolveWalletSnapshotManifest(assets, wallets);

  // Checkpoint state is only replayable when the active rows still prove it.
  // A 'filled' checkpoint beside an incomplete snapshot is stale operational
  // metadata, not permission to suppress repair. Complete live/seed days need
  // no historical RPC at all; exhausted incomplete days remain disclosed but
  // keep their existing budget stop.
  const priorState = await db<{ sample_date: string; status: BackfillDayStatus; block_number: number | null; balance_rows: number; sleeve_rows: number; detail: string | null }[]>`
    SELECT sample_date::text AS sample_date, status, block_number, balance_rows, sleeve_rows, detail
      FROM wallet_backfill_state
     WHERE sample_date = ANY(${closed}::date[])
       AND status IN ('filled', 'skipped', 'exhausted')
  `;
  const settled = new Map(priorState.map((r) => [r.sample_date, r]));
  const pending: string[] = [];
  for (const date of closed) {
    const s = settled.get(date);
    const completeness = await inspectWalletSnapshot(db, date, manifest);
    if (!completeness.complete && s?.status !== "exhausted") {
      pending.push(date);
      continue;
    }
    if (!s) {
      out.set(date, await skipDay(db, date, "already populated with a complete expected balance+sleeve snapshot"));
      continue;
    }
    out.set(date, {
      ok: true,
      sampleDate: date,
      status: s.status,
      blockNumber: s.block_number,
      balanceRows: s.balance_rows,
      sleeveRows: s.sleeve_rows,
      detail: s.detail ?? `already ${s.status} by an earlier pass over this window`,
    });
  }
  if (pending.length === 0) return settle();
  closed.length = 0;
  closed.push(...pending);

  assertRpcBudgetConfigured();

  // 1. dates → blocks. Permanent cache, so a re-run over the same window is free.
  const resolvedByDate = await resolveWindowBlocks(db, closed, deps, now);
  let readable: { date: string; resolved: ResolvedDayBlock }[] = [];
  for (const date of closed) {
    const r = resolvedByDate.get(date);
    if (!r || !r.ok) {
      // A day whose OWN search failed earns an attempt; one that only lost the
      // window's shared head read does not (DayBlockOutcome.shared).
      const detail = `block resolution failed: ${r ? r.error : "no outcome"}`;
      out.set(
        date,
        r && !r.ok && r.shared ? await deferDay(db, date, detail, "block-resolve-head", now) : await failDay(db, date, detail),
      );
      continue;
    }
    readable.push({ date, resolved: r.resolved });
  }
  if (readable.length === 0) return settle();

  // 1.5. Per-address earliest-valid-block floor (issue #760; markets §6.1,
  //      §8.1). A day whose resolved block precedes a tracked address's floor
  //      PREDATES that contract's deployment — not a failure, a certainty —
  //      so it is skipped, with NO attempt charged, before either the shared
  //      price load or the shared chain read is issued for it. The floor is a
  //      CHAIN fact (chain/address-floor-resolver.ts) checked unconditionally
  //      against every tracked address, independent of that asset's
  //      configured `deployedAt` — a CONFIGURATION fact that can predate,
  //      postdate, or (today) coincide with the real deployment block; this is
  //      exactly the gap #749's deployedAt filtering left open (§8.1). Skipping
  //      here never silences GET /api/admin/gaps: that endpoint derives from
  //      the sample tables via expectedKeys/deployedAt, never from
  //      wallet_backfill_state, so a genuinely uncovered day still shows as a
  //      gap. `resolveAddressFloors` is optional so a caller injecting only
  //      the required deps — every existing test does — takes this branch's
  //      prior (unchanged) behaviour: no floor check at all.
  if (deps.resolveAddressFloors) {
    const opts = { rpcUrl: config.baseRpcUrl };
    const floorAssets = floorEligibleAssets(assets);
    const addresses = [...new Set(floorAssets.map((a) => a.address))];
    const floors = addresses.length > 0
      ? await deps.resolveAddressFloors(addresses, opts, addressFloorCache(db))
      : new Map<string, AddressFloor>();
    const stillReadable: { date: string; resolved: ResolvedDayBlock }[] = [];
    for (const { date, resolved } of readable) {
      const below = floorAssets.filter((a) => {
        const floor = floors.get(a.address);
        return floor !== undefined && resolved.blockNumber < floor.floorBlock;
      });
      if (below.length > 0) {
        const detail = `below earliest-valid-block floor: ${below
          .map((a) => `${a.symbol} (${a.address}) floors at block ${floors.get(a.address)!.floorBlock}`)
          .join(", ")}`;
        out.set(date, await skipDay(db, date, detail, resolved.blockNumber));
        continue;
      }
      stillReadable.push({ date, resolved });
    }
    readable = stillReadable;
    if (readable.length === 0) return settle();
  }

  // 2. Prices for the WHOLE window in ONE load, spanning its first to last day.
  //    A load failure fails every day it covers — the same refusal the per-day
  //    path made, just made once.
  const span = readable.map((r) => r.date).sort();
  let prices: HistoricalPriceTable;
  try {
    prices = await deps.loadPrices(
      assets.filter((a) => a.valuationKind !== "config"),
      span[0]!,
      span[span.length - 1]!,
    );
  } catch (err) {
    // Shared leg: one load covers every day in the window, so its failure is not
    // any one day's fault and charges none of them an attempt. See deferDay().
    for (const { date, resolved } of readable) {
      out.set(date, await deferDay(db, date, `historical price load failed: ${String(err)}`, "price-load", now, resolved.blockNumber));
    }
    return settle();
  }

  // 3. Read EVERY day's legs at ITS OWN block, in two requests for the whole
  //    window rather than two per day. The reads are identical across days —
  //    only the block tag differs — so this is the same independent axis the
  //    resolver batches (markets §7). A block the reader could not answer comes back
  //    all-{ok:false} and fails just that day, below.
  const blockTags = readable.map(({ resolved }) => toBlockTag(resolved.blockNumber));
  let amountsByTag: Map<string, Map<string, ChainAmount>> | null = null;
  if (deps.readChainAmountsAtBlocks && readable.length > 0) {
    const { reads } = buildDayReads(assets, wallets);
    try {
      amountsByTag = await deps.readChainAmountsAtBlocks(
        reads,
        `wallet-backfill ${span[0]}..${span[span.length - 1]}`,
        blockTags,
        { strictEmptyReturn: true },
      );
    } catch (err) {
      // A whole-window read failure fails every day it covered — the same
      // refusal each day would have made alone, made once. Made once, it is
      // also charged once: no day's attempt counter moves. See deferDay().
      for (const { date, resolved } of readable) {
        out.set(
          date,
          await deferDay(db, date, `chain read failed at block ${resolved.blockNumber}: ${String(err)}`, "chain-read-window", now, resolved.blockNumber),
        );
      }
      return settle();
    }
  }

  for (const { date, resolved } of readable) {
    const pre = amountsByTag?.get(toBlockTag(resolved.blockNumber)) ?? null;
    out.set(date, await repairResolvedDay(db, date, resolved, prices, wallets, assets, deps, pre, now));
  }
  return settle();
}

/**
 * Repair exactly ONE day — the N=1 case of the window, deliberately not a
 * second implementation. Two executors would be two sets of invariants to keep
 * honest, and the day-atomic write path is the last place to accept that.
 */
export async function backfillWalletDay(
  db: Db,
  date: string,
  deps: WalletBackfillDeps = defaultWalletBackfillDeps,
  now: Date = new Date(),
): Promise<BackfillDayResult> {
  return (await backfillWalletWindow(db, [date], deps, now))[0]!;
}

/**
 * The window's blocks, batched when the deps can batch and one-at-a-time when
 * they cannot.
 *
 * The fallback is not dead weight: `resolveBlocks` is optional precisely so a
 * caller that injects only the single-day `resolveBlock` — every existing test
 * does — still drives the real executor. Production supplies both and takes the
 * lockstep path.
 */
/** A day's block, or why it has none. `shared` is forwarded from
 *  DayBlockOutcome (chain/block-resolver.ts): true means the window's single
 *  head read failed, so this day never got its own chance and must not be
 *  charged an attempt for it. */
type WindowBlockOutcome =
  | { ok: true; resolved: ResolvedDayBlock }
  | { ok: false; error: string; shared?: boolean };

async function resolveWindowBlocks(
  db: Db,
  dates: readonly string[],
  deps: WalletBackfillDeps,
  now: Date,
): Promise<Map<string, WindowBlockOutcome>> {
  const opts = { rpcUrl: config.baseRpcUrl };
  const cache = dayBlockCache(db);
  const out = new Map<string, WindowBlockOutcome>();

  if (deps.resolveBlocks) {
    const outcomes = await deps.resolveBlocks(dates, opts, cache, now);
    for (let i = 0; i < dates.length; i++) {
      const o = outcomes[i];
      const date = dates[i]!;
      if (!o) out.set(date, { ok: false, error: "no outcome" });
      else if (o.ok) out.set(date, { ok: true, resolved: o });
      // `shared` must survive this remap: it is what tells the caller the
      // failure was the window's one head read, not this day's own search.
      else out.set(date, { ok: false, error: o.error, shared: o.shared === true });
    }
    return out;
  }

  for (const date of dates) {
    try {
      out.set(date, { ok: true, resolved: await deps.resolveBlock(date, opts, cache, now) });
    } catch (err) {
      out.set(date, { ok: false, error: String(err) });
    }
  }
  return out;
}

/**
 * Repair one day whose block is already resolved and whose prices are already
 * loaded.
 *
 * DAY-ATOMIC, and that is a correctness requirement rather than tidiness: round
 * 2 of the chain read (`convertToAssets` NAV, chain/wallet-valuation.ts) depends
 * on round 1's output, so a half-read day produces a total that is plausible and
 * wrong. If any leg of the day fails, NOTHING is written for it and the day
 * stays in the gap report.
 */
async function repairResolvedDay(
  db: Db,
  date: string,
  resolved: ResolvedDayBlock,
  prices: HistoricalPriceTable,
  wallets: string[],
  assets: TrackedAsset[],
  deps: WalletBackfillDeps,
  /** This day's legs, already read as part of the window's batched pass. Null
   *  when the caller had no multi-block reader, in which case this day reads
   *  its own block on its own — the pre-batch behaviour, unchanged. */
  preRead: Map<string, ChainAmount> | null = null,
  /** Threaded down purely so the shared-leg circuit breaker (issue #761) can
   *  compare against a deterministic, injectable clock rather than the real
   *  wall clock — every other timestamp decision in this module already takes
   *  `now` explicitly for the same reason. */
  now: Date = new Date(),
): Promise<BackfillDayResult> {
  const fail = (detail: string, blockNumber: number | null = null): Promise<BackfillDayResult> =>
    failDay(db, date, detail, blockNumber);
  const blockTag = toBlockTag(resolved.blockNumber);

  // 2. Read every leg AT THAT BLOCK, with the silent-zero rail armed.
  const { reads, sleeveTargets } = buildDayReads(assets, wallets);
  let amounts: Map<string, ChainAmount>;
  if (preRead) {
    amounts = preRead;
  } else {
    try {
      amounts = await deps.readChainAmounts(reads, `wallet-backfill ${date}`, { blockTag, strictEmptyReturn: true });
    } catch (err) {
      return fail(`chain read failed at block ${resolved.blockNumber}: ${String(err)}`, resolved.blockNumber);
    }
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
  const invalidAmounts = reads
    .filter((r) => {
      const amount = amounts.get(r.key);
      return amount?.ok === true && (!Number.isFinite(amount.amount) || amount.amount < 0);
    })
    .map((r) => r.key);
  if (invalidAmounts.length > 0) {
    return fail(
      `${invalidAmounts.length} leg(s) returned a negative or non-finite amount at block ${resolved.blockNumber} (${invalidAmounts.slice(0, 6).join(", ")})`,
      resolved.blockNumber,
    );
  }

  // 3. Price at that DATE (not at spot), from the window's shared table. A
  //    missing price fails the day rather than valuing a real holding at zero,
  //    which would read as a drawdown.
  const priceFor = (symbol: string): number | undefined => prices.get(symbol)?.get(date);
  const unpriced = reads
    .map((r) => r.asset.symbol)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .filter((s) => {
      const price = priceFor(s);
      return !Number.isFinite(price ?? NaN) || price! <= 0;
    });
  if (unpriced.length > 0) {
    // WHOSE FAULT the missing price is decides whether this day is CHARGED for
    // it, and the price table says which: a symbol with no entry at all was
    // refused at its POOL (loadHistoricalPrices leaves a refused symbol out
    // entirely and gives every symbol it resolved a map, empty or not), while a
    // symbol whose map is simply blank on this date has a thin day of its own.
    //
    // A pool-level refusal is a SHARED LEG by construction — the pool is the
    // same for every day in the window, and the module's own contract is that
    // retrying returns the same refusal — so charging it to each day is exactly
    // the accounting deferDay() exists to prevent: three window retries inside
    // ten seconds would flip every day to the terminal 'exhausted', and the days
    // would stay unrepaired after the pin or the vendor was fixed, recoverable
    // only by hand-written SQL. The gap is disclosed either way; what differs is
    // whether the system will ever try again.
    const refused = unpriced.filter((s) => !prices.has(s));
    if (refused.length > 0) {
      return deferDay(
        db,
        date,
        `no price source for ${refused.join(", ")} — the pool refused to price it for the whole window`,
        `price-pool:${[...refused].sort().join(",")}`,
        now,
        resolved.blockNumber,
      );
    }
    return fail(`no ${date} price for ${unpriced.join(", ")}`, resolved.blockNumber);
  }
  const invalidValues = reads
    .filter((r) => {
      const amount = amounts.get(r.key);
      const price = priceFor(r.asset.symbol);
      return amount?.ok === true && price !== undefined && !Number.isFinite(amount.amount * price);
    })
    .map((r) => r.key);
  if (invalidValues.length > 0) {
    return fail(
      `${invalidValues.length} leg(s) produced a non-finite USD value at block ${resolved.blockNumber} (${invalidValues.slice(0, 6).join(", ")})`,
      resolved.blockNumber,
    );
  }

  // 4. Commit one COMPLETE active snapshot. If the day is partial or contains
  //    quarantine, its original rows move to immutable evidence before both
  //    active tables are rebuilt. Archive, replacement, completeness proof and
  //    checkpoint are one transaction; any failure restores the original state.
  const sampledAt = new Date(resolved.blockTimestampSec * 1000);
  const manifest = resolveWalletSnapshotManifest(assets, wallets);
  let balanceRows = 0;
  let sleeveRows = 0;
  let status: BackfillDayStatus = "filled";
  let detail: string | null = null;

  try {
    await db.begin(async (tx) => {
      const txDb = tx as unknown as Db;
      balanceRows = 0;
      sleeveRows = 0;
      status = "filled";
      detail = null;

      // Serialize every repair/live writer for this date. Row locks alone do
      // not cover a missing natural key that a concurrent sampler could insert
      // between evidence copy and DELETE.
      await lockWalletSnapshotDate(tx, date);
      // Lock every active row whose value may be archived. Without this, a
      // concurrent UPDATE could commit after the evidence SELECT but before the
      // DELETE, removing a version that was never preserved.
      const before = await inspectWalletSnapshot(txDb, date, manifest, true);

      if (before.complete) {
        const [existingState] = await tx<{ status: BackfillDayStatus }[]>`
          SELECT status FROM wallet_backfill_state WHERE sample_date = ${date}
        `;
        status = existingState?.status === "filled" ? "filled" : "skipped";
        balanceRows = status === "filled" ? manifest.balanceAssets.length : 0;
        sleeveRows = status === "filled" ? manifest.sleeveKeys.length : 0;
        detail = "already populated with a complete expected balance+sleeve snapshot";
      } else {
        // counts-quarantined: DELIBERATE. Every original row is copied before
        // active deletion; quarantined rows receive the more specific reason.
        await tx`
          INSERT INTO wallet_balance_sample_evidence
            (original_id, sample_date, symbol, amount, price_usd, value_usd,
             provenance, sampled_at, strategy_nav_idle_only, evidence_reason,
             replacement_block_number, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at)
          SELECT id, sample_date, symbol, amount, price_usd, value_usd,
                 provenance, sampled_at, strategy_nav_idle_only,
                 CASE WHEN provenance = ${QUARANTINED_PROVENANCE}
                      THEN 'quarantined-replacement'
                      ELSE 'incomplete-snapshot-replacement' END,
                 ${resolved.blockNumber}, snapshot_run_id, amount_observed_at,
                 price_observed_at, recorded_at
            FROM wallet_balance_samples
           WHERE sample_date = ${date}
        `;
        // counts-quarantined: DELIBERATE — same evidence-preserving transition.
        await tx`
          INSERT INTO wallet_sleeve_sample_evidence
            (original_id, sample_date, wallet_address, symbol, amount, price_usd,
             value_usd, provenance, sampled_at, evidence_reason,
             replacement_block_number, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at)
          SELECT id, sample_date, wallet_address, symbol, amount, price_usd,
                 value_usd, provenance, sampled_at,
                 CASE WHEN provenance = ${QUARANTINED_PROVENANCE}
                      THEN 'quarantined-replacement'
                      ELSE 'incomplete-snapshot-replacement' END,
                 ${resolved.blockNumber}, snapshot_run_id, amount_observed_at,
                 price_observed_at, recorded_at
            FROM wallet_sleeve_samples
           WHERE sample_date = ${date}
        `;
        await tx`DELETE FROM wallet_balance_samples WHERE sample_date = ${date}`;
        await tx`DELETE FROM wallet_sleeve_samples WHERE sample_date = ${date}`;

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
          `;
          balanceRows += 1;
        }

        for (const t of sleeveTargets) {
          const amount = amounts.get(t.key)!;
          if (!amount.ok) continue; // unreachable: checked above
          const priceUsd = priceFor(t.asset.symbol)!;
          await tx`
            INSERT INTO wallet_sleeve_samples
              (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
            VALUES
              (${date}, ${t.walletAddress}, ${t.asset.symbol}, ${amount.amount}, ${priceUsd}, ${amount.amount * priceUsd}, 'backfilled', ${sampledAt})
          `;
          sleeveRows += 1;
        }

        const after = await inspectWalletSnapshot(txDb, date, manifest);
        if (
          !after.complete ||
          after.balanceRows !== manifest.balanceAssets.length ||
          after.sleeveRows !== manifest.sleeveKeys.length
        ) {
          throw new Error(
            `snapshot completeness validation failed: missing balances [${after.missingBalanceSymbols.join(", ")}], ` +
              `missing sleeves [${after.missingSleeveKeys.join(", ")}], rows ${after.balanceRows}/${after.sleeveRows}`,
          );
        }
        detail = before.balanceRows + before.sleeveRows > 0
          ? `replaced incomplete snapshot; archived ${before.balanceRows} balance and ${before.sleeveRows} sleeve row(s)`
          : null;
      }

      // `filled` is written only after both active key sets passed validation,
      // and it commits with the evidence and replacement rows. A successful
      // write clears any shared-leg streak this date was carrying — whatever
      // leg it was, it was not the reason this attempt succeeded.
      await tx`
        INSERT INTO wallet_backfill_state
          (sample_date, status, block_number, balance_rows, sleeve_rows, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
        VALUES
          (${date}, ${status}, ${resolved.blockNumber}, ${balanceRows}, ${sleeveRows}, ${detail}, now(), NULL, 0, NULL)
        ON CONFLICT (sample_date) DO UPDATE SET
          status       = EXCLUDED.status,
          block_number = EXCLUDED.block_number,
          balance_rows = EXCLUDED.balance_rows,
          sleeve_rows  = EXCLUDED.sleeve_rows,
          detail       = EXCLUDED.detail,
          attempted_at = EXCLUDED.attempted_at,
          defer_leg    = NULL,
          defer_streak = 0,
          defer_leg_at = NULL
      `;
    });
  } catch (err) {
    return deferDay(
      db,
      date,
      `transactional snapshot write failed: ${err instanceof Error ? err.message : String(err)}`,
      "snapshot-write",
      now,
      resolved.blockNumber,
    );
  }

  return {
    ok: true,
    sampleDate: date,
    status,
    blockNumber: resolved.blockNumber,
    balanceRows,
    sleeveRows,
    detail,
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
//
// Every caller of this function (failDay, skipDay) writes a DAY-SPECIFIC
// outcome, never a shared-leg one, so it always clears the shared-leg streak
// (issue #761): whatever leg a prior run blamed, this day's own problem is a
// different incident, and a day that just succeeded or was skipped is not
// mid-streak with anything.
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
      (sample_date, status, block_number, balance_rows, sleeve_rows, attempts, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
    VALUES
      (${date}, ${status}, ${blockNumber}, ${balanceRows}, ${sleeveRows}, ${attempts ?? 0}, ${detail}, now(), NULL, 0, NULL)
    ON CONFLICT (sample_date) DO UPDATE SET
      status       = EXCLUDED.status,
      block_number = EXCLUDED.block_number,
      balance_rows = EXCLUDED.balance_rows,
      sleeve_rows  = EXCLUDED.sleeve_rows,
      attempts     = COALESCE(${attempts}, wallet_backfill_state.attempts),
      detail       = EXCLUDED.detail,
      attempted_at = EXCLUDED.attempted_at,
      defer_leg    = NULL,
      defer_streak = 0,
      defer_leg_at = NULL
  `;
}
