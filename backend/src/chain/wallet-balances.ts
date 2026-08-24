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
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { sql } from "../db/client.ts";
import {
  QUARANTINED_PROVENANCE,
  readChainAmountsBatched,
  valueLeg,
  type ChainAmount,
  type KeyedAssetRead,
  type Provenance,
} from "./wallet-valuation.ts";
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

const PRICE_VENDOR: Record<string, string> = { usdc: "pinned", gecko: "geckoterminal", yahoo: "yahoo" };

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
  //     (docs/technical/data-self-healing.md §10). A real fix needs a stated-at
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

interface PersistedHolding {
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

async function lastPersistedHolding(symbol: string): Promise<PersistedHolding | null> {
  const rows = await sql<{ amount: string | null; price_usd: string | null; value_usd: string }[]>`
    SELECT amount, price_usd, value_usd
      FROM wallet_balance_samples
     WHERE symbol = ${symbol}
       AND provenance <> ${QUARANTINED_PROVENANCE}
     ORDER BY sample_date DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    amount: row.amount == null ? null : Number(row.amount),
    priceUsd: row.price_usd == null ? null : Number(row.price_usd),
    valueUsd: Number(row.value_usd),
  };
}

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
): Promise<WalletHolding> {
  const base = {
    symbol: asset.symbol,
    chain: "base" as const,
    group: asset.group,
    color: asset.color,
    priceSource: PRICE_VENDOR[asset.priceKind] ?? asset.priceKind,
    ...strategyNavDisclosure(asset, chainAmount),
  };
  const valued = await valueLeg(asset, chainAmount, source, priceSource);
  if (valued.ok) {
    return { ...base, amount: valued.amount, priceUsd: valued.priceUsd, valueUsd: valued.valueUsd, provenance: valued.provenance };
  }
  console.error(`wallet-balances: ${asset.symbol} live read failed, degrading to last-persisted sample:`, valued.error);
  const persisted = await lastPersistedHolding(asset.symbol).catch(() => null);
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
async function loadHistory(): Promise<{ history: WalletHistoryPoint[]; historyProvenance: Record<Provenance, number> }> {
  const rows = await sql<{ sample_date: Date; symbol: string; value_usd: string; provenance: Provenance }[]>`
    SELECT sample_date, symbol, value_usd, provenance
      FROM wallet_balance_samples
     WHERE sample_date NOT IN (
             SELECT sample_date FROM wallet_balance_samples
              WHERE provenance = ${QUARANTINED_PROVENANCE}
           )
     ORDER BY sample_date ASC, symbol ASC
  `;
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
    const v = Number(r.value_usd);
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

async function computeWalletBalances(): Promise<WalletBalances> {
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
    assets.map((a) => valueAsset(a, chainAmounts.get(a.symbol) ?? { ok: false }, source, priceSource)),
  );
  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const EMPTY_PROVENANCE: Record<Provenance, number> = { live: 0, stub: 0, stale: 0, seed: 0, backfilled: 0 };
  const { history, historyProvenance } = await loadHistory().catch(() => ({ history: [] as WalletHistoryPoint[], historyProvenance: EMPTY_PROVENANCE }));

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

export const fetchWalletBalances = ttlCached(computeWalletBalances, CACHE_TTL_MS);

export function _resetWalletBalancesCacheForTests(): void {
  fetchWalletBalances._resetForTests();
}

// REQUEST-PATH reader (issue #118): serve the /api/dashboards/wallet-balances
// payload PURELY from persisted `wallet_balance_samples` — ZERO chain calls, ZERO
// price fetches. Chain reads happen ONLY on the backend schedule
// (worker/handlers/wallet.ts sampleWalletBalances → fetchWalletBalances above),
// so a client request never touches the rate-limited public RPC. The served
// provenance is EXACTLY the last scheduled sample per symbol (live/stub/stale/
// seed) — never relabelled, never fabricated. Payload shape is identical to
// fetchWalletBalances so the frontend + goldens are unchanged.
export async function fetchPersistedWalletBalances(): Promise<WalletBalances> {
  // Top-level provenance markers stay config-resolved (no RPC) so hermetic mode
  // still reports 'stub' and the frontend walletNonLive() badge keeps working.
  // Fail-closed resolvers OUTSIDE any try: an invalid marker refuses loudly.
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const assets = resolveTrackedAssets();

  // Latest sample per symbol. The (sample_date, symbol) upsert keeps one row per
  // symbol per UTC day, so "newest sample_date wins" is the last scheduled read.
  const rows = await sql<
    { symbol: string; amount: string | null; price_usd: string | null; value_usd: string | null; provenance: string; strategy_nav_idle_only: boolean | null; sampled_at: Date }[]
  >`
    SELECT DISTINCT ON (symbol) symbol, amount, price_usd, value_usd, provenance, strategy_nav_idle_only, sampled_at
      FROM wallet_balance_samples
     WHERE provenance <> ${QUARANTINED_PROVENANCE}
     ORDER BY symbol, sample_date DESC, sampled_at DESC
  `;
  const latest = new Map(rows.map((r) => [r.symbol, r]));

  // Iterate resolveTrackedAssets() (NOT the samples table) so ordering and the
  // chain/group/color/priceSource metadata the table doesn't store are preserved.
  const holdings: WalletHolding[] = assets.map((a) => {
    const row = latest.get(a.symbol);
    const base = {
      symbol: a.symbol,
      chain: "base" as const,
      group: a.group,
      color: a.color,
      priceSource: PRICE_VENDOR[a.priceKind] ?? a.priceKind,
      // issue #642 — this is the feed the HTTP route serves, so the
      // idle-USDC-only disclosure has to reach it too. It cannot be recomputed
      // here (zero RPC on the request path, issue #118), so it is echoed from
      // what the sampler recorded (migration 0032). NULL — a pre-0032 row, a
      // seeded row, a leg with no sample yet, or a non-strategy symbol — stays
      // ABSENT rather than becoming `false`: "not known" is not "positions
      // contributed".
      ...(row?.strategy_nav_idle_only == null ? {} : { strategyNavIdleOnly: row.strategy_nav_idle_only }),
    };
    if (!row) {
      // No scheduled sample yet for this symbol → honest 'stale' with null
      // values (never fabricate a number the schedule hasn't produced).
      return { ...base, amount: null, priceUsd: null, valueUsd: null, provenance: "stale" as Provenance };
    }
    return {
      ...base,
      amount: row.amount == null ? null : Number(row.amount),
      priceUsd: row.price_usd == null ? null : Number(row.price_usd),
      valueUsd: row.value_usd == null ? null : Number(row.value_usd),
      provenance: row.provenance as Provenance, // exactly what the schedule persisted
    };
  });

  const totalUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const EMPTY_PROVENANCE: Record<Provenance, number> = { live: 0, stub: 0, stale: 0, seed: 0, backfilled: 0 };
  const { history, historyProvenance } = await loadHistory().catch(() => ({ history: [] as WalletHistoryPoint[], historyProvenance: EMPTY_PROVENANCE }));

  // asOf = freshest served sample's real timestamp (data age), or now() if empty.
  const asOfMs = rows.reduce((max, r) => {
    const t = (r.sampled_at instanceof Date ? r.sampled_at : new Date(r.sampled_at)).getTime();
    return t > max ? t : max;
  }, 0);
  const asOf = new Date(asOfMs > 0 ? asOfMs : Date.now()).toISOString();

  return { asOf, totalUsd, source, priceSource, holdings, history, historyProvenance };
}
