// Per-prop-wallet holdings breakdown for GET /api/dashboards/wallet-sleeves
// (live-data contract §3). This is the per-wallet view the aggregate
// wallet-balances endpoint does NOT provide: wallet_balance_samples has no
// wallet dimension (UNIQUE (sample_date, symbol) only), so a sleeve MUST do
// fresh per-wallet on-chain reads — it cannot be derived from that table.
//
// Valuation is the SHARED module (wallet-valuation.ts, finding 007): the same
// Multicall3 batched reader + per-valuationKind resolution + price/provenance
// step wallet-balances uses, but keyed PER (wallet, symbol) so amounts stay per
// wallet (no cross-wallet sum). All sleeves resolve in ≤2 eth_calls total —
// round 1 balance/getEthBalance legs, round 2 strategy NAV — instead of the old
// per-holding fan-out. Which symbols a wallet can hold is domain metadata (the
// primary/Bankr wallet holds the general tokens; each Stablecoin-Strategy
// "wallet" here is really its own delegated smart-account WALLET, valued at
// account NAV — issues #120/#145, see wallet-valuation.ts) — every
// address/decimals still comes from config (resolveTrackedAssets), never a
// literal here.
//
// Honesty (#50): a placeholder-address asset (e.g. an unconfigured Aave
// aToken leg — every fixed BNKR/WETH/ROBOTMONEY series carries a real default
// address as of #148) is NEVER eth_called — it is omitted rather than
// rendered as a live $0. A failed leg degrades that holding to value null +
// provenance 'stale'.
import {
  isPlaceholderAddress,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type BaseRpcSource,
  type TrackedAsset,
} from "../config.ts";
import {
  persistedFallbackWalletPriceReader,
  readChainAmountsBatched,
  valueLeg,
  type ChainAmount,
  type KeyedAssetRead,
  type Provenance,
  type WalletPriceReader,
} from "./wallet-valuation.ts";

// Provenance is defined once in the shared valuation module and re-exported
// here for callers (same values as wallet-balances: live | stub | stale | seed).
export type { Provenance };

export interface SleeveHolding {
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  provenance: Provenance;
}

export interface WalletSleeve {
  name: string;
  address: string; // lowercased
  type: string; // "primary" | "strategy"
  totalUsd: number; // sum of holdings[].valueUsd (nulls as 0)
  stale: boolean; // true when any holding degraded (provenance 'stale') → totalUsd undercounts
  holdings: SleeveHolding[];
}

export interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: BaseRpcSource;
  stale: boolean; // true when ANY sleeve has a degraded holding, so a naive sum of totalUsd is partial
}

// Dependency seam established by scout #175, activated by #173: production
// serves persistedFallbackWalletPriceReader below, which tries the live
// provider first and falls back to a recent wallet_balance_samples price
// (≤5 minutes old) only when the provider read fails — the chain amount is
// always fresh. Tests can still supply amount and price readers independently;
// a persisted quote is explicitly discriminated by WalletPriceReader and must
// carry stale/seed provenance rather than being relabelled live. See
// docs/architecture.md §10.1 and docs/architecture.md §3.
export interface WalletSleeveReaders {
  readChainAmounts(reads: KeyedAssetRead[], logLabel: string): Promise<Map<string, ChainAmount>>;
  priceReader: WalletPriceReader;
}

const defaultWalletSleeveReaders: WalletSleeveReaders = {
  readChainAmounts: readChainAmountsBatched,
  priceReader: persistedFallbackWalletPriceReader,
};

// Which tracked-asset symbols each prop wallet (by resolvePropWallets index)
// holds. The primary/Bankr wallet carries the general tokens; each strategy
// "wallet" carries only its own strategy symbol, which values the smart-account
// NAV of a DIFFERENT address (asset.address, not this wallet's — issues
// #120/#145; source of truth: robotmoney-site prop-wallet metadata). Symbols
// resolve to config addresses via
// resolveTrackedAssets — no address literal lives here.
interface SleeveDef {
  name: string;
  type: string;
  symbols: string[];
}
const SLEEVE_DEFS: SleeveDef[] = [
  { name: "Bankr", type: "primary", symbols: ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"] },
  { name: "Stablecoin Strategy 1", type: "strategy", symbols: ["ZYFAI-SS1"] },
  { name: "Stablecoin Strategy 2", type: "strategy", symbols: ["GIZA-SS1"] },
];

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: WalletSleeves } | null = null;

export function _resetWalletSleevesCacheForTests(): void {
  cache = null;
}

export async function getWalletSleeves(readers: WalletSleeveReaders = defaultWalletSleeveReaders): Promise<WalletSleeves> {
  const now = Date.now();
  const useProductionCache = readers === defaultWalletSleeveReaders;
  if (useProductionCache && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

  // Resolve each sleeve's configured (non-placeholder) assets, then read EVERY
  // (wallet, asset) leg in ≤2 batched eth_calls via the shared reader. Keys are
  // "(sleeve index):(symbol)" so nothing sums across wallets — each sleeve keeps
  // its own amount (unlike the aggregate wallet-balances feed).
  const resolved: { def: SleeveDef; address: string; walletAssets: TrackedAsset[]; keyOf: (symbol: string) => string }[] = [];
  const reads: KeyedAssetRead[] = [];
  for (let i = 0; i < SLEEVE_DEFS.length && i < wallets.length; i++) {
    const def = SLEEVE_DEFS[i]!;
    const address = wallets[i]!;
    // A placeholder-address asset is never eth_called (#50) — it is omitted.
    const walletAssets = def.symbols
      .map((s) => bySymbol.get(s))
      .filter((a): a is TrackedAsset => a != null && (a.valuationKind === "native" || !isPlaceholderAddress(a.address)));
    const keyOf = (symbol: string): string => `${i}:${symbol}`;
    for (const a of walletAssets) reads.push({ key: keyOf(a.symbol), asset: a, wallets: [address] });
    resolved.push({ def, address, walletAssets, keyOf });
  }
  const chainAmounts = await readers.readChainAmounts(reads, "wallet-sleeves");

  const sleeves: WalletSleeve[] = [];
  for (const { def, address, walletAssets, keyOf } of resolved) {
    const holdings = await Promise.all(
      walletAssets.map(async (a): Promise<SleeveHolding> => {
        const valued = await valueLeg(
          a,
          chainAmounts.get(keyOf(a.symbol)) ?? { ok: false },
          source,
          priceSource,
          readers.priceReader,
        );
        if (!valued.ok) {
          console.error(`wallet-sleeves: ${a.symbol}@${address} read failed, degrading to null:`, valued.error);
          return { symbol: a.symbol, amount: null, priceUsd: null, valueUsd: null, provenance: "stale" };
        }
        return { symbol: a.symbol, amount: valued.amount, priceUsd: valued.priceUsd, valueUsd: valued.valueUsd, provenance: valued.provenance };
      }),
    );
    const totalUsd = Math.round(holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0) * 100) / 100;
    // A 'stale' holding means a leg failed and its value is null (counted as 0),
    // so totalUsd is a partial undercount — flag it so a consumer never reads the
    // total as a confident live figure (mirrors buybacks/token-metrics honesty).
    const stale = holdings.some((h) => h.provenance === "stale");
    sleeves.push({ name: def.name, address, type: def.type, totalUsd, stale, holdings });
  }

  const value: WalletSleeves = {
    wallets: sleeves,
    asOf: new Date(now).toISOString(),
    source,
    stale: sleeves.some((s) => s.stale),
  };
  if (useProductionCache) cache = { at: now, value };
  return value;
}
