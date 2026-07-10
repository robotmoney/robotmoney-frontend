// Per-prop-wallet holdings breakdown for GET /api/dashboards/wallet-sleeves
// (live-data contract §3). This is the per-wallet view the aggregate
// wallet-balances endpoint does NOT provide: wallet_balance_samples has no
// wallet dimension (UNIQUE (sample_date, symbol) only), so a sleeve MUST do
// fresh per-wallet on-chain reads — it cannot be derived from that table.
//
// Valuation reuses wallet-balances.ts::valueAsset's logic (same valuationKind +
// fetchAssetPriceUsd), but keyed PER wallet (no sumOverWallets). Which symbols a
// wallet can hold is domain metadata (the primary/Bankr wallet holds the general
// tokens; each Stablecoin-Strategy wallet holds only its delegated ERC-4626
// strategy share) — every address/decimals still comes from config
// (resolveTrackedAssets), never a literal here.
//
// Honesty (#50): a placeholder-address asset (e.g. BNKR until BNKR_ADDRESS is
// set) is NEVER eth_called — it is omitted rather than rendered as a live $0. A
// failed leg degrades that holding to value null + provenance 'stale'.
import {
  config,
  isPlaceholderAddress,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { callBalanceOf, callConvertToAssets, ethGetBalance, type RpcCallOptions } from "./base-rpc-client.ts";
import { fetchAssetPriceUsd } from "./token-prices.ts";

export type Provenance = "live" | "stub" | "stale" | "seed";

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
  holdings: SleeveHolding[];
}

export interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: BaseRpcSource;
}

// Which tracked-asset symbols each prop wallet (by resolvePropWallets index)
// holds. The primary/Bankr wallet carries the general tokens; each strategy
// wallet carries only its delegated ERC-4626 strategy share (source of truth:
// robotmoney-site prop-wallet metadata). Symbols resolve to config addresses via
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

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

function amountFrom(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// One asset's live amount held by a SINGLE wallet (no cross-wallet sum). Mirrors
// wallet-balances.ts::readAmount per valuationKind.
async function readAmount(asset: TrackedAsset, wallet: string): Promise<number> {
  const opts = rpcOpts();
  switch (asset.valuationKind) {
    case "erc20":
    case "aave":
      return amountFrom(await callBalanceOf(asset.address!, wallet, opts), asset.decimals);
    case "native":
      return amountFrom(await ethGetBalance(wallet, opts), asset.decimals);
    case "strategy": {
      // ERC-4626 NAV: value this wallet's shares at convertToAssets → USDC (6dp).
      const shares = await callBalanceOf(asset.address!, wallet, opts);
      return amountFrom(await callConvertToAssets(asset.address!, shares, opts), 6);
    }
    case "config":
      // Off-chain config size is not a per-wallet on-chain holding — skip.
      throw new Error(`wallet-sleeves: ${asset.symbol} (config kind) is not a wallet holding`);
  }
}

async function valueHolding(
  asset: TrackedAsset,
  wallet: string,
  source: BaseRpcSource,
  priceSource: PriceSource,
): Promise<SleeveHolding> {
  try {
    const [amount, priceUsd] = await Promise.all([
      readAmount(asset, wallet),
      fetchAssetPriceUsd(asset, priceSource),
    ]);
    return {
      symbol: asset.symbol,
      amount,
      priceUsd,
      valueUsd: amount * priceUsd,
      provenance: source === "stub" || priceSource === "stub" ? "stub" : "live",
    };
  } catch (err) {
    console.error(`wallet-sleeves: ${asset.symbol}@${wallet} read failed, degrading to null:`, err);
    return { symbol: asset.symbol, amount: null, priceUsd: null, valueUsd: null, provenance: "stale" };
  }
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: WalletSleeves } | null = null;

export function _resetWalletSleevesCacheForTests(): void {
  cache = null;
}

export async function getWalletSleeves(): Promise<WalletSleeves> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

  const sleeves: WalletSleeve[] = [];
  for (let i = 0; i < SLEEVE_DEFS.length && i < wallets.length; i++) {
    const def = SLEEVE_DEFS[i]!;
    const address = wallets[i]!;
    // Resolve each configured (non-placeholder) asset for this wallet. A
    // placeholder-address asset is never eth_called (#50) — it is omitted.
    const walletAssets = def.symbols
      .map((s) => bySymbol.get(s))
      .filter((a): a is TrackedAsset => a != null && (a.valuationKind === "native" || !isPlaceholderAddress(a.address)));

    const holdings = await Promise.all(walletAssets.map((a) => valueHolding(a, address, source, priceSource)));
    const totalUsd = Math.round(holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0) * 100) / 100;
    sleeves.push({ name: def.name, address, type: def.type, totalUsd, holdings });
  }

  const value: WalletSleeves = { wallets: sleeves, asOf: new Date(now).toISOString(), source };
  cache = { at: now, value };
  return value;
}
