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
  config,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  resolveSp500,
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { sql } from "../db/client.ts";
import {
  decodeUint256,
  encodeBalanceOfCall,
  encodeConvertToAssetsCall,
  encodeGetEthBalanceCall,
  multicall3Aggregate3,
  MULTICALL3_ADDRESS,
  type Aggregate3Result,
  type Call3,
  type RpcCallOptions,
} from "./base-rpc-client.ts";
import { fetchAssetPriceUsd } from "./token-prices.ts";

// 'seed' = a pre-launch history row backfilled from the ported baked constants
// (chain/wallet-history-seed.ts), NOT a live chain read — honesty invariant from
// migration 0014 ("a value is NEVER fabricated or falsely labelled 'live'").
export type Provenance = "live" | "stub" | "stale" | "seed";

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
}

export interface WalletHistoryPoint {
  date: string; // ISO calendar day
  byAsset: Record<string, number>; // sparse: only symbols present that day
  totalUsd: number;
}

export interface WalletBalances {
  asOf: string;
  totalUsd: number;
  source: BaseRpcSource;
  priceSource: PriceSource;
  holdings: WalletHolding[];
  history: WalletHistoryPoint[];
}

const PRICE_VENDOR: Record<string, string> = { usdc: "pinned", gecko: "geckoterminal", yahoo: "yahoo" };

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

function amountFrom(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// Per-asset chain amount: either a summed token amount, or a failure flag that
// makes the caller degrade THAT asset to its last-persisted 'stale' sample. A
// failure is a sub-call that reverted (allowFailure) OR the whole batch throwing.
type ChainAmount = { ok: true; amount: number } | { ok: false };

// Read EVERY asset's on-chain amount in at most TWO eth_calls via Multicall3,
// regardless of wallet/asset count — this is the 429-storm fix. Round 1 batches
// one balanceOf / getEthBalance sub-call per (asset × wallet); round 2 batches
// convertToAssets(shares) for each strategy that has shares. Provenance honesty
// is preserved EXACTLY: a reverted sub-call (success:false) fails just its asset;
// a thrown batch fails every chain-read asset (matching the old all-fail path);
// config (SP500) is never a chain read and is unaffected by an RPC failure.
async function readChainAmounts(assets: TrackedAsset[], wallets: string[]): Promise<Map<string, ChainAmount>> {
  const opts = rpcOpts();
  const out = new Map<string, ChainAmount>();

  // config (SP500): off-chain size from config, no derivatives-venue positions
  // API — never a chain read, so never affected by an RPC failure.
  for (const a of assets) {
    if (a.valuationKind === "config") out.set(a.symbol, { ok: true, amount: resolveSp500().size });
  }
  const chainAssets = assets.filter((a) => a.valuationKind !== "config");
  if (chainAssets.length === 0) return out;

  // ── Round 1: one sub-call per (asset × wallet). ────────────────────────────
  const legs: { symbol: string }[] = [];
  const calls: Call3[] = [];
  for (const a of chainAssets) {
    for (const w of wallets) {
      // native → Multicall3 getEthBalance(wallet); every other kind (erc20 /
      // aave aToken / strategy shares) → balanceOf(wallet) on the token/strategy.
      const target = a.valuationKind === "native" ? MULTICALL3_ADDRESS : a.address!;
      const callData = a.valuationKind === "native" ? encodeGetEthBalanceCall(w) : encodeBalanceOfCall(w);
      calls.push({ target, allowFailure: true, callData });
      legs.push({ symbol: a.symbol });
    }
  }

  const rawSum = new Map<string, bigint>();
  const errored = new Set<string>();
  let round1: Aggregate3Result[];
  try {
    round1 = await multicall3Aggregate3(calls, opts);
  } catch (err) {
    // The whole batch eth_call failed (transport/HTTP/JSON-RPC) — degrade EVERY
    // chain-read leg to stale, exactly as the pre-batch all-fail path did.
    console.error("wallet-balances: batched round-1 multicall failed, degrading all chain legs to stale:", err);
    for (const a of chainAssets) out.set(a.symbol, { ok: false });
    return out;
  }
  for (let i = 0; i < legs.length; i++) {
    const r = round1[i];
    const symbol = legs[i]!.symbol;
    if (!r || !r.success) {
      errored.add(symbol); // a reverted sub-call fails just this asset
      continue;
    }
    rawSum.set(symbol, (rawSum.get(symbol) ?? 0n) + decodeUint256(r.returnData));
  }

  // ── Round 2: ERC-4626 NAV convertToAssets(shares) per strategy w/ shares. ──
  const navCalls: Call3[] = [];
  const navSymbols: string[] = [];
  for (const a of chainAssets) {
    if (a.valuationKind !== "strategy" || errored.has(a.symbol)) continue;
    const shares = rawSum.get(a.symbol) ?? 0n;
    if (shares > 0n) {
      navCalls.push({ target: a.address!, allowFailure: true, callData: encodeConvertToAssetsCall(shares) });
      navSymbols.push(a.symbol);
    }
  }
  const navRaw = new Map<string, bigint>();
  if (navCalls.length > 0) {
    let round2: Aggregate3Result[];
    try {
      round2 = await multicall3Aggregate3(navCalls, opts);
    } catch (err) {
      console.error("wallet-balances: batched round-2 NAV multicall failed, degrading strategy legs to stale:", err);
      for (const s of navSymbols) errored.add(s);
      round2 = [];
    }
    for (let i = 0; i < navSymbols.length; i++) {
      const r = round2[i];
      if (!r || !r.success) {
        errored.add(navSymbols[i]!);
        continue;
      }
      navRaw.set(navSymbols[i]!, decodeUint256(r.returnData));
    }
  }

  // ── Resolve each asset's amount (or its failure). ──────────────────────────
  for (const a of chainAssets) {
    if (errored.has(a.symbol)) {
      out.set(a.symbol, { ok: false });
      continue;
    }
    switch (a.valuationKind) {
      case "erc20":
      case "aave": // Aave V3 aToken balanceOf is already underlying-denominated (1:1).
      case "native":
        out.set(a.symbol, { ok: true, amount: amountFrom(rawSum.get(a.symbol) ?? 0n, a.decimals) });
        break;
      case "strategy": {
        // shares==0 → NAV is 0 with no round-2 call (matches callConvertToAssets(0)).
        const shares = rawSum.get(a.symbol) ?? 0n;
        const assetsRaw = shares > 0n ? (navRaw.get(a.symbol) ?? 0n) : 0n;
        out.set(a.symbol, { ok: true, amount: amountFrom(assetsRaw, 6) }); // underlying USDC (6 dp)
        break;
      }
    }
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
// read. Each leg is independent: on ANY failure (the chain read reverted/degraded
// in readChainAmounts, OR the price fetch throws) it degrades to its last-
// persisted sample marked 'stale' — the other legs are unaffected. Price fetches
// (gecko/yahoo/pinned) hit DIFFERENT hosts than the rate-limited RPC, so they
// stay per-asset and unbatched.
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
  };
  const degrade = async (err: unknown): Promise<WalletHolding> => {
    console.error(`wallet-balances: ${asset.symbol} live read failed, degrading to last-persisted sample:`, err);
    const persisted = await lastPersistedHolding(asset.symbol).catch(() => null);
    return {
      ...base,
      amount: persisted?.amount ?? null,
      priceUsd: persisted?.priceUsd ?? null,
      valueUsd: persisted?.valueUsd ?? null,
      provenance: "stale",
    };
  };
  // The chain read failed (a reverted sub-call or a thrown batch) → stale.
  if (!chainAmount.ok) return degrade(new Error(`${asset.symbol} chain read unavailable`));
  try {
    const priceUsd = await fetchAssetPriceUsd(asset, priceSource);
    const amount = chainAmount.amount;
    return {
      ...base,
      amount,
      priceUsd,
      valueUsd: amount * priceUsd,
      provenance: source === "stub" || priceSource === "stub" ? "stub" : "live",
    };
  } catch (err) {
    return degrade(err);
  }
}

// Continuous history from persisted samples (seeded once from the baked series,
// then accumulated forward by the daily sampler). byAsset is sparse per day
// (ZYFAI/GIZA/SP500 are intermittent); the eight fixed series' group/colour
// ORDER is carried by holdings[]/resolveTrackedAssets, which the frontend
// iterates — byAsset is a lookup, not the ordering.
async function loadHistory(): Promise<WalletHistoryPoint[]> {
  const rows = await sql<{ sample_date: Date; symbol: string; value_usd: string }[]>`
    SELECT sample_date, symbol, value_usd
      FROM wallet_balance_samples
     ORDER BY sample_date ASC, symbol ASC
  `;
  const byDate = new Map<string, WalletHistoryPoint>();
  for (const r of rows) {
    const date = (r.sample_date instanceof Date ? r.sample_date : new Date(r.sample_date))
      .toISOString()
      .slice(0, 10);
    let point = byDate.get(date);
    if (!point) {
      point = { date, byAsset: {}, totalUsd: 0 };
      byDate.set(date, point);
    }
    const v = Number(r.value_usd);
    point.byAsset[r.symbol] = v;
    point.totalUsd += v;
  }
  return [...byDate.values()];
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: WalletBalances } | null = null;

export function _resetWalletBalancesCacheForTests(): void {
  cache = null;
}

export async function fetchWalletBalances(): Promise<WalletBalances> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

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
  const history = await loadHistory().catch(() => [] as WalletHistoryPoint[]);

  const value: WalletBalances = {
    asOf: new Date(now).toISOString(),
    totalUsd,
    source,
    priceSource,
    holdings,
    history,
  };
  cache = { at: now, value };
  return value;
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
    { symbol: string; amount: string | null; price_usd: string | null; value_usd: string | null; provenance: string; sampled_at: Date }[]
  >`
    SELECT DISTINCT ON (symbol) symbol, amount, price_usd, value_usd, provenance, sampled_at
      FROM wallet_balance_samples
     ORDER BY symbol, sample_date DESC, sampled_at DESC
  `;
  const latest = new Map(rows.map((r) => [r.symbol, r]));

  // Iterate resolveTrackedAssets() (NOT the samples table) so ordering and the
  // chain/group/color/priceSource metadata the table doesn't store are preserved.
  const holdings: WalletHolding[] = assets.map((a) => {
    const base = {
      symbol: a.symbol,
      chain: "base" as const,
      group: a.group,
      color: a.color,
      priceSource: PRICE_VENDOR[a.priceKind] ?? a.priceKind,
    };
    const row = latest.get(a.symbol);
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
  const history = await loadHistory().catch(() => [] as WalletHistoryPoint[]);

  // asOf = freshest served sample's real timestamp (data age), or now() if empty.
  const asOfMs = rows.reduce((max, r) => {
    const t = (r.sampled_at instanceof Date ? r.sampled_at : new Date(r.sampled_at)).getTime();
    return t > max ? t : max;
  }, 0);
  const asOf = new Date(asOfMs > 0 ? asOfMs : Date.now()).toISOString();

  return { asOf, totalUsd, source, priceSource, holdings, history };
}
