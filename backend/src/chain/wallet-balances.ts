// Live prop-wallet valuation for GET /api/dashboards/wallet-balances (issue #84).
// Replaces the baked WALLET_SNAPSHOT_TOTAL_USD scalar (/allocation hero) and the
// 99-day walletPerfView series (/performance) that used to live in the frontend
// (alpine/views.js). Reads each configured prop wallet via Base JSON-RPC
// (base-rpc-client.ts) + keyless prices (token-prices.ts) on demand, behind a
// short-TTL in-process cache — the same shape as chain/vault-economics.ts.
//
// Per-holding provenance mirrors #50: 'live' = a real Base RPC + price read;
// 'stub' = the hermetic BASE_RPC_SOURCE/PRICE_SOURCE=stub fixtures; 'stale' = a
// single leg whose live read FAILED and degraded to its last-persisted Postgres
// sample. A value is NEVER fabricated, never silently frozen, and a single bad
// leg never 5xxs the whole endpoint.
import {
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  SP500_SIZE,
  SP500_SIZE_VERIFIED_AT,
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { pipelineRead } from "../worker/pipeline-client.ts";
import {
  QUARANTINED_PROVENANCE,
  readChainAmountsBatched,
  valueLeg,
  type ChainAmount,
  type KeyedAssetRead,
  type Provenance,
} from "./wallet-valuation.ts";
import { ASSET_PRICE_TIME_BASIS } from "../ops/asset-price-basis.ts";
import { ttlCached } from "./ttl-cache.ts";

// Provenance ('seed' = a pre-launch backfilled history row, never a live chain
// read — migration 0014 honesty invariant) is defined once in the shared
// valuation module (wallet-valuation.ts) and re-exported here for callers.
export type { Provenance };

export interface WalletHolding {
  symbol: string;
  chain: "base";
  group: string;
  color: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  priceSource: string; // 'pinned' (USDC) | 'geckoterminal' | 'yahoo'
  provenance: Provenance;
  // issue #642: `true` on a `strategy` leg whose account held NO tracked
  // position, so its NAV is idle USDC only; `false` when a position
  // contributed; absent when not applicable or not known. See
  // contract/src/dashboards.d.ts for the full contract and why this is a
  // separate field rather than a new provenance value.
  strategyNavIdleOnly?: boolean;
  // issue #862 (RM-116): set ONLY on a `config` leg (SP500) to the ISO date its
  // asserted size (config.ts SP500_SIZE) was last confirmed against the venue
  // — SP500_SIZE_VERIFIED_AT, echoed as-is, never persisted or recomputed per
  // sample. Absent on every other holding, whose amount really is READ. Lets a
  // consumer disclose "position size as of <date>" instead of presenting an
  // asserted six-month-old number identically to a live one.
  sizeVerifiedAt?: string | null;
}

export interface WalletHistoryPoint {
  date: string; // ISO calendar day
  byAsset: Record<string, number>; // sparse: only symbols present that day
  totalUsd: number;
  // issue #614 AC5: which kind of row produced this day, so a consumer can
  // distinguish a genuinely LIVE-sampled point from a backfilled/seeded one
  // instead of the whole series reading as one undifferentiated line. Priority
  // when a day mixes provenances across symbols: 'live' (any leg was a real
  // read that day) > 'stale' (a schedule ran but degraded) > 'seed' (ported
  // pre-launch history, never a chain read) > 'stub' (hermetic fixture).
  provenance: Provenance;
}

export interface WalletBalances {
  asOf: string;
  totalUsd: number;
  source: BaseRpcSource;
  priceSource: PriceSource;
  // issue #614 AC5: day counts by history[].provenance, so a consumer can
  // tell "this series is 95% seed rows" without scanning `history` itself —
  // the seam between backfilled and live-sampled history, disclosed rather
  // than smoothed over by a top-level `source` that only ever describes the
  // CURRENT sampler's config, never the composition of what it returned.
  historyProvenance: Record<Provenance, number>;
  holdings: WalletHolding[];
  history: WalletHistoryPoint[];
}

export const PRICE_VENDOR: Record<string, string> = { usdc: "pinned", gecko: "geckoterminal", yahoo: "yahoo" };

// issue #642: NAV-completeness disclosure for the `strategy` legs. A strategy
// leg whose account holds nothing in any configured position values as idle
// USDC only — a real, non-reverting read, but not an ordinary one: the account
// is supposed to be deployed, and the number says nothing about whether the
// position list is right, the capital moved, or the leg was wound down.
// ZYFAI-SS1 is exactly this case on-chain today (0.000044 USDC and no position
// at all), so before #642 /allocation and /performance rendered "an empty
// account" and "a working strategy" identically.
//
// Derived from the READ, not from configuration: with the vault/underlying
// lists now baked constants (config.ts), a config-derived flag would be a
// compile-time constant `false` and would disclose nothing.
function strategyNavDisclosure(
  asset: TrackedAsset,
  chainAmount: ChainAmount,
): { strategyNavIdleOnly?: boolean } {
  if (asset.valuationKind !== "strategy") return {};
  // A FAILED read is not an idle-only read — it is a degraded one, already
  // labelled 'stale'. Claiming "no positions" from a reverted call would be
  // asserting a fact the chain never gave us.
  if (!chainAmount.ok) return {};
  return { strategyNavIdleOnly: (chainAmount.strategyPositions ?? 0) === 0 };
}

// Read EVERY asset's on-chain amount in at most TWO eth_calls via the SHARED
// Multicall3 batched reader (wallet-valuation.ts — the 429-storm fix, finding
// 007). This is the AGGREGATE view: every leg is keyed by SYMBOL so raw balances
// SUM across all prop wallets (the sleeves feed keys per-wallet instead).
// Provenance honesty is owned by the shared reader: a reverted sub-call fails
// just its asset; a thrown batch fails every chain-read asset; config (SP500) is
// never a chain read and is unaffected by an RPC failure.
async function readChainAmounts(assets: TrackedAsset[], wallets: string[]): Promise<Map<string, ChainAmount>> {
  const out = new Map<string, ChainAmount>();

  // config (SP500): off-chain size from the committed SP500_SIZE constant, no
  // derivatives-venue positions API — never a chain read, so never affected by an
  // RPC failure, and `ok: true` unconditionally.
  //
  // THE KNOWN GAP (issue #641), recorded here rather than fixed here. `ok: true`
  // means "this number was available", NOT "this number is current": a size that
  // has gone stale renders as a plausible dollar figure and never degrades to
  // 'stale' the way a failed chain read does. That is a real defect and it is NOT
  // closed by #641 — surfacing it is deliberately left as follow-up, because the
  // honest fix is not a local edit:
  //   - `Provenance` is not a DTO-local label. It is PERSISTED (the enumeration
  //     documented on wallet_balance_samples.provenance, migration 0014), rolled
  //     up per day by loadHistory()/historyProvenance, and rendered by the
  //     frontend legend, so a 'config' member is a storage + contract + UI change,
  //     and it would relabel a leg whose PRICE really was read live.
  //   - An `asOf` for the size would have to be INVENTED. Nothing records when the
  //     owner last stated it; the only available timestamps are process/deploy
  //     start, which describe the container rather than the number — precisely the
  //     plausible-but-fabricated signal this codebase refuses to emit
  //     (docs/technical/markets-asset-pricing-ingest.md §6.1). A real fix needs a stated-at
  //     date to travel WITH the size, which is a design question, not a patch.
  // What #641 does change: the size is now a committed constant instead of an env
  // override no container could receive, so drift is at least VISIBLE — it moves
  // in a reviewed diff with a date attached, not silently inside one droplet's
  // environment. The disclosure question stays with the parent #647 / PD7, where
  // the "what a detector consumes must carry whether the value was computable"
  // argument already lives.
  for (const a of assets) {
    if (a.valuationKind === "config") out.set(a.symbol, { ok: true, amount: SP500_SIZE });
  }
  const reads: KeyedAssetRead[] = assets
    .filter((a) => a.valuationKind !== "config")
    .map((a) => ({ key: a.symbol, asset: a, wallets }));
  for (const [symbol, amount] of await readChainAmountsBatched(reads, "wallet-balances")) {
    out.set(symbol, amount);
  }
  return out;
}

// THE PERSISTED READS (issue 1034, D75). This module is the wallet sampler's
// live read, run by the pipeline worker, which holds no database credential.
// The two persisted reads it needs (a failed leg's last sample, and the
// history) are the api's: chain/wallet-balances-store.ts runs them, reached
// over /api/pipeline/** by default. GET /api/dashboards/wallet-balances serves
// fetchPersistedWalletBalances from that store module directly.

/** A symbol's newest non-quarantined sample, for the stale-degrade path of a failed live read. */
export interface PersistedHolding {
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

/** One wallet_balance_samples row of the history read, with its day's settled price joined. */
export interface WalletHistoryRow {
  sample_date: Date;
  symbol: string;
  amount: string | null;
  value_usd: string;
  provenance: Provenance;
  asset_price_usd: string | null;
  is_closed: boolean;
}

/** The persisted reads the live valuation needs. */
export interface WalletBalanceReads {
  lastPersistedHolding(symbol: string): Promise<PersistedHolding | null>;
  historyRows(): Promise<WalletHistoryRow[]>;
}

/** The reads, through the api (pipeline/ops.ts `wallet.last_persisted_holding`, `wallet.history_rows`). */
export const pipelineWalletBalanceReads: WalletBalanceReads = {
  lastPersistedHolding: (symbol) => pipelineRead<PersistedHolding | null>("wallet.last_persisted_holding", symbol),
  historyRows: () => pipelineRead<WalletHistoryRow[]>("wallet.history_rows"),
};

// Value a single asset from its (pre-batched) chain amount + a per-asset price
// read via the SHARED valuation step (wallet-valuation.ts::valueLeg). Each leg
// is independent: on ANY failure (the chain read reverted/degraded in
// readChainAmounts, OR the price fetch throws) it degrades to its last-persisted
// sample marked 'stale' — the other legs are unaffected. The degrade SHAPE
// (last-persisted Postgres sample) is this aggregate feed's own; sleeves degrade
// to nulls instead, which is why valueLeg returns {ok:false} rather than a row.
async function valueAsset(
  asset: TrackedAsset,
  chainAmount: ChainAmount,
  source: BaseRpcSource,
  priceSource: PriceSource,
  reads: WalletBalanceReads,
): Promise<WalletHolding> {
  const base = {
    symbol: asset.symbol,
    chain: "base" as const,
    group: asset.group,
    color: asset.color,
    priceSource: PRICE_VENDOR[asset.priceKind] ?? asset.priceKind,
    ...strategyNavDisclosure(asset, chainAmount),
    // issue #862: disclose the asserted-size leg regardless of how this
    // sample turns out (live/stale) — SP500's SIZE is never a chain read
    // either way, so the confirmation date applies unconditionally.
    ...(asset.valuationKind === "config" ? { sizeVerifiedAt: SP500_SIZE_VERIFIED_AT } : {}),
  };
  const valued = await valueLeg(asset, chainAmount, source, priceSource);
  if (valued.ok) {
    return { ...base, amount: valued.amount, priceUsd: valued.priceUsd, valueUsd: valued.valueUsd, provenance: valued.provenance };
  }
  console.error(`wallet-balances: ${asset.symbol} live read failed, degrading to last-persisted sample:`, valued.error);
  const persisted = await reads.lastPersistedHolding(asset.symbol).catch(() => null);
  return {
    ...base,
    amount: persisted?.amount ?? null,
    priceUsd: persisted?.priceUsd ?? null,
    valueUsd: persisted?.valueUsd ?? null,
    provenance: "stale",
  };
}

// PERSISTED (deliberately sparse, not continuous — issue #614) history from
// persisted samples: the seeded portion is ported once from the baked v0
// series and carries its own known gaps, then the daily sampler accumulates
// forward. Any day this pipeline never sampled is simply ABSENT from the
// result — see WalletHistoryPoint's doc comment (contract/src/dashboards.d.ts)
// for why a consumer must not assume day-to-day contiguity. byAsset is
// separately sparse per day (ZYFAI/GIZA/SP500 are intermittent); the eight
// fixed series' group/colour ORDER is carried by holdings[]/
// resolveTrackedAssets, which the frontend iterates — byAsset is a lookup, not
// the ordering.
// 'backfilled' ranks just under 'live' (issue #614 AC4): it IS a genuine
// current read, only a late one, so it is more informative than 'stale' (a
// degraded leg reusing an older value) or 'seed' (never a chain read at all).
const PROVENANCE_PRIORITY: Provenance[] = ["live", "backfilled", "stale", "seed", "stub"];
function dominantProvenance(seen: Set<Provenance>): Provenance {
  for (const p of PROVENANCE_PRIORITY) if (seen.has(p)) return p;
  return "stub"; // unreachable in practice (seen is always non-empty when called)
}

// A quarantined row (migration 0036) drops its WHOLE DAY, not just itself.
//
// Each point's totalUsd is a SUM across that day's symbols, so excluding the
// quarantined rows alone would serve a total that silently omits a holding —
// an understated AUM that looks like a real number and is not disclosed as
// anything. That is precisely the substitution this quarantine exists to stop,
// so a day one of whose legs cannot be trusted is absent in full.
//
// In practice every backfilled day is quarantined whole (0036 moves all of
// them), so the subquery usually removes exactly the days it would anyway; it
// is written this way for the mixed day the (sample_date, symbol) key permits
// but the backfill has never produced — one symbol backfilled, another live.
//
// D41 phase 3 (issue #850): a CLOSED day's value is a read-time join against
// `asset_prices` rather than the sample row's own `value_usd`; TODAY's row is
// the one exception and keeps its fused value (D41: "today's live point keeps
// its fused row"). The LEFT JOIN is deliberately permissive rather than an
// INNER JOIN or a hard read-from-asset_prices-only rewrite: issue #927 shipped
// BOTH the fix that stops the gap from widening (the live sampler now
// dual-writes into `asset_prices` on every ordinary sample) and a scheduled
// backfill (`ops.backfill_asset_prices`, db/seed.ts) that converges
// `asset_prices` coverage for history that predates that change — but that
// convergence happens over successive runs, not instantly on deploy, so a
// closed day can still have no `asset_prices` row yet. Falling back to the
// sample row's own `value_usd` when the join has no row for that
// (date, symbol) is what keeps every existing response correct while that
// convergence is in flight — it is not the live/close COALESCE trap markets
// §5.6 point 1 forbids, because both sides describe the SAME closed day's
// settled price, never a live spot standing in for one. The fallback is kept
// permanently as defense-in-depth (a day whose price fetch never resolved,
// e.g. a symbol with no liquid pool on a given day, would otherwise serve
// nothing rather than the sample's own value).
// The multiplication happens in JS, not SQL: `asset_prices.price_usd` is
// dual-written/seeded from the exact same JS double that produced the sample
// row's `value_usd` (ops/asset-prices.ts::writeAssetPrice, migration 0046's
// seed step), so `Number(amount) * Number(joinedPrice)` reproduces that
// IEEE-754 product exactly — a SQL-side `amount * price_usd` would instead run
// as arbitrary-precision `numeric` arithmetic and could differ in its last
// digits.
export function historyFromRows(
  rows: readonly WalletHistoryRow[],
): { history: WalletHistoryPoint[]; historyProvenance: Record<Provenance, number> } {
  const byDate = new Map<string, WalletHistoryPoint & { _seen: Set<Provenance> }>();
  for (const r of rows) {
    const date = (r.sample_date instanceof Date ? r.sample_date : new Date(r.sample_date))
      .toISOString()
      .slice(0, 10);
    let point = byDate.get(date);
    if (!point) {
      point = { date, byAsset: {}, totalUsd: 0, provenance: "stub", _seen: new Set() };
      byDate.set(date, point);
    }
    // A closed day uses the joined price once asset_prices has a row for it
    // (issue #927 converges this over time — see the extended comment above);
    // until then, and always for today's own row, it falls back to the fused
    // value_usd (D41: "today's live point keeps its fused row").
    const v = r.is_closed && r.amount != null && r.asset_price_usd != null
      ? Number(r.amount) * Number(r.asset_price_usd)
      : Number(r.value_usd);
    point.byAsset[r.symbol] = v;
    point.totalUsd += v;
    point._seen.add(r.provenance);
  }
  const historyProvenance: Record<Provenance, number> = { live: 0, stub: 0, stale: 0, seed: 0, backfilled: 0 };
  const history: WalletHistoryPoint[] = [];
  for (const { _seen, ...point } of byDate.values()) {
    point.provenance = dominantProvenance(_seen);
    historyProvenance[point.provenance] += 1;
    history.push(point);
  }
  return { history, historyProvenance };
}

const CACHE_TTL_MS = 30_000;

async function computeWalletBalances(reads: WalletBalanceReads): Promise<WalletBalances> {
  const now = Date.now();

  // Resolved per call (not module load) so tests can flip the env per case and
  // so provenance always tracks the current source. Fail-closed resolvers are
  // OUTSIDE the try below: an invalid marker must refuse loudly, never degrade
  // into a payload claiming 'live'.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();

  // All on-chain amounts in ≤2 batched eth_calls (the 429-storm fix), then value
  // each asset with its own price read.
  const chainAmounts = await readChainAmounts(assets, wallets);
  const holdings = await Promise.all(
    assets.map((a) => valueAsset(a, chainAmounts.get(a.symbol) ?? { ok: false }, source, priceSource, reads)),
  );
  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const EMPTY_PROVENANCE: Record<Provenance, number> = { live: 0, stub: 0, stale: 0, seed: 0, backfilled: 0 };
  const { history, historyProvenance } = await reads
    .historyRows()
    .then(historyFromRows)
    .catch(() => ({ history: [] as WalletHistoryPoint[], historyProvenance: EMPTY_PROVENANCE }));

  return {
    asOf: new Date(now).toISOString(),
    totalUsd,
    source,
    priceSource,
    holdings,
    history,
    historyProvenance,
  };
}

export const fetchWalletBalances = ttlCached(() => computeWalletBalances(pipelineWalletBalanceReads), CACHE_TTL_MS);

export function _resetWalletBalancesCacheForTests(): void {
  fetchWalletBalances._resetForTests();
}

