// SHARED prop-wallet valuation semantics (maintainability finding 007). The two
// wallet feeds used to carry drifting copies of the same logic:
//   - chain/wallet-balances.ts — the AGGREGATE view (amounts SUMMED across every
//     prop wallet, one holding per tracked symbol), and
//   - chain/wallet-sleeves.ts  — the PER-WALLET view (one amount per
//     (wallet, asset) leg, no cross-wallet sum).
// Everything that must stay identical between them lives here exactly once:
//   1. the Multicall3 BATCHED chain-amount reader (the #119 429-storm fix:
//      ≤2 eth_calls total — round 1 balance/getEthBalance legs (+ each
//      strategy account's idle USDC and maintained-vault share balances,
//      #120/#145), round 2 ERC-4626 convertToAssets NAV per vault with shares),
//   2. the per-valuationKind amount resolution (erc20 / aave aToken / native /
//      strategy = idle USDC + Σ vault NAV, all at 6 dp underlying USDC), and
//   3. the price + degradation valuation step (keyless price read + the
//      'stub'/'live' provenance rule).
// The one thing that legitimately differs — HOW legs aggregate — is the caller's
// choice of KEY: wallet-balances keys every leg by symbol (raw balances sum
// across wallets); wallet-sleeves keys per (wallet, symbol) so each sleeve keeps
// its own amount.
//
// Honesty (#50) is owned here once: a reverted sub-call (allowFailure →
// success:false) fails ONLY its key; a THROWN batch fails EVERY key in that
// batch; a value is never fabricated and provenance is never falsely 'live' —
// callers turn a failed key into their own degrade shape (last-persisted
// 'stale' sample for balances, null-valued 'stale' holding for sleeves).
import {
  config,
  resolveStrategyVaults,
  resolveTrackedAssets,
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

// Price-reader seam for allocation live-data reliability (scout #175).
// Canonical behavior: docs/architecture.md §10.1 and
// docs/contract-live-data.md §3. The production reader below still performs
// exactly the existing provider call. The discriminated result lets #173 add a
// bounded wallet_balance_samples reader without making a persisted quote look
// live or coupling its freshness policy to the sleeve projection.
//
// Resolved open question — max persisted-price age for a `kind: "persisted"`
// quote (#173's implementation, not built here): `wallet.sample_balances`
// writes `wallet_balance_samples` on a 1-minute cron (backend/src/db/seed.ts,
// `job_schedules` row `wallet.sample_balances`). No existing constant governs
// per-symbol price staleness; the nearest precedent is
// `REGIME_STALE_THRESHOLD_DAYS` (analytics/report/regime-projection.ts),
// which sets a ~3x-cadence staleness bound for a daily job. Applying the same
// ~3-5x-cadence multiple to a 1-minute cadence recommends a **5-minute** max
// age: recent enough that a request-time price never looks "live", generous
// enough to absorb one missed/late worker tick. #173 should read this value
// off the sample's `sampled_at`/`sample_date` column and reject (fall through
// to "no persisted price available") anything older, never silently reuse an
// arbitrarily stale row.
export type WalletPriceQuote =
  | { kind: "provider"; priceUsd: number; provenance: "live" | "stub" }
  | { kind: "persisted"; priceUsd: number; provenance: "stale" | "seed"; sampledAt: string };

export interface WalletPriceReader {
  read(asset: TrackedAsset, source: BaseRpcSource, priceSource: PriceSource): Promise<WalletPriceQuote>;
}

export const providerWalletPriceReader: WalletPriceReader = {
  async read(asset, source, priceSource) {
    return {
      kind: "provider",
      priceUsd: await fetchAssetPriceUsd(asset, priceSource),
      provenance: source === "stub" || priceSource === "stub" ? "stub" : "live",
    };
  },
};

// Max age (#173, resolved by scout #175's open-question note above) for a
// `wallet_balance_samples` row to still be eligible as a fallback price when
// the live provider read fails (e.g. GeckoTerminal's keyless quota is
// exhausted). `wallet.sample_balances` writes this table on a 1-minute cron —
// 5 minutes is a ~3-5x-cadence staleness bound, generous enough to absorb one
// missed tick, recent enough that the fallback quote never reads as live.
export const MAX_PERSISTED_PRICE_AGE_MS = 5 * 60_000;

async function recentPersistedPrice(symbol: string): Promise<{ priceUsd: number; sampledAt: string } | null> {
  const rows = await sql<{ price_usd: string | null; sampled_at: Date }[]>`
    SELECT price_usd, sampled_at
      FROM wallet_balance_samples
     WHERE symbol = ${symbol}
       AND price_usd IS NOT NULL
       AND sampled_at <= now()
     ORDER BY sampled_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.price_usd == null) return null;
  const sampledAtMs = row.sampled_at.getTime();
  if (Date.now() - sampledAtMs > MAX_PERSISTED_PRICE_AGE_MS) return null; // too old — not eligible
  return { priceUsd: Number(row.price_usd), sampledAt: row.sampled_at.toISOString() };
}

// Falls back to a recent persisted PER-SYMBOL price (wallet_balance_samples,
// ≤MAX_PERSISTED_PRICE_AGE_MS old) when the live provider price read fails —
// e.g. GeckoTerminal's keyless quota is exhausted (#173). The chain AMOUNT is
// always the caller's fresh on-chain read; only the price falls back, and it
// is never relabelled 'live' — provenance is honestly 'stale' with the
// sample's real sampledAt preserved. A missing or over-age sample rethrows the
// original provider error so the caller degrades exactly as before (never a
// fabricated price, never a silently-exhausted fallback masquerading as data).
export const persistedFallbackWalletPriceReader: WalletPriceReader = {
  async read(asset, source, priceSource) {
    try {
      return await providerWalletPriceReader.read(asset, source, priceSource);
    } catch (err) {
      const persisted = await recentPersistedPrice(asset.symbol).catch(() => null);
      if (!persisted) throw err;
      return { kind: "persisted", priceUsd: persisted.priceUsd, provenance: "stale", sampledAt: persisted.sampledAt };
    }
  },
};

function rpcOpts(): RpcCallOptions {
  return { rpcUrl: config.baseRpcUrl };
}

function amountFrom(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// A key's resolved chain amount: either a token amount, or a failure flag that
// makes the caller degrade THAT key (a reverted sub-call, or the whole batch
// throwing). Callers never see a fabricated number for a failed key.
export type ChainAmount = { ok: true; amount: number } | { ok: false };

// One keyed chain read: `asset` read for each address in `wallets`, with every
// leg's RAW word SUMMED into `key`. The aggregate feed passes all prop wallets
// under key=symbol; the sleeves feed passes a single wallet per key so nothing
// sums. `config`-kind assets are NOT chain reads and must not be passed here.
export interface KeyedAssetRead {
  key: string;
  asset: TrackedAsset;
  wallets: string[];
}

// Read EVERY keyed leg's on-chain amount in at most TWO eth_calls via Multicall3,
// regardless of wallet/asset count — this is the 429-storm fix. Round 1 batches
// one balanceOf / getEthBalance sub-call per (key × wallet) for erc20/aave/
// native legs; for `strategy` keys (issues #120/#145 — the address is the
// agent's SMART-ACCOUNT WALLET itself, not an ERC-4626 share token) round 1
// instead queries the ACCOUNT's idle USDC balance plus its share balance in
// each configured vault (resolveStrategyVaults() — owner-maintained, empty by
// default). Round 2 batches convertToAssets(shares) for every (key, vault)
// pair with a non-zero share balance; NAV = idleUsdc + Σ vault assets.
// Provenance honesty is preserved EXACTLY: a reverted sub-call (success:false)
// fails just its key; a thrown batch fails every key (matching the old
// all-fail path). `logLabel` names the calling feed in the degrade logs.
export async function readChainAmountsBatched(
  reads: KeyedAssetRead[],
  logLabel: string,
): Promise<Map<string, ChainAmount>> {
  const opts = rpcOpts();
  const out = new Map<string, ChainAmount>();
  if (reads.length === 0) return out;
  for (const r of reads) {
    // config (SP500) is an off-chain size — the callers resolve it from config
    // and never pass it here (loud guard, not a silent 0).
    if (r.asset.valuationKind === "config") {
      throw new Error(`${logLabel}: ${r.asset.symbol} (config kind) is not a chain read`);
    }
  }

  // USDC address comes from the SAME resolver every "erc20" USDC leg uses
  // (resolveTrackedAssets, env-overridable) so the idle-balance target always
  // matches whichever USDC contract this deployment is configured against.
  const usdcAddress = resolveTrackedAssets().find((a) => a.symbol === "USDC")?.address;
  const strategyVaults = resolveStrategyVaults();

  // ── Round 1: balance sub-calls. ────────────────────────────────────────────
  // erc20/aave/native → one balanceOf/getEthBalance per (key × wallet), summed.
  // strategy → idle USDC balanceOf(account) + balanceOf(account) on each
  // maintained vault (account = the strategy's own smart-account address).
  type Leg =
    | { key: string; kind: "balance" }
    | { key: string; kind: "idleUsdc" }
    | { key: string; kind: "vaultShare"; vaultIndex: number };
  const legs: Leg[] = [];
  const calls: Call3[] = [];
  for (const r of reads) {
    if (r.asset.valuationKind === "strategy") {
      const account = r.asset.address!;
      if (!usdcAddress) {
        throw new Error(`${logLabel}: ${r.asset.symbol} strategy NAV needs a resolved USDC address`);
      }
      calls.push({ target: usdcAddress, allowFailure: true, callData: encodeBalanceOfCall(account) });
      legs.push({ key: r.key, kind: "idleUsdc" });
      for (let vi = 0; vi < strategyVaults.length; vi++) {
        calls.push({ target: strategyVaults[vi]!.address, allowFailure: true, callData: encodeBalanceOfCall(account) });
        legs.push({ key: r.key, kind: "vaultShare", vaultIndex: vi });
      }
      continue;
    }
    for (const w of r.wallets) {
      // native → Multicall3 getEthBalance(wallet); every other kind (erc20 /
      // aave aToken) → balanceOf(wallet) on the token.
      const target = r.asset.valuationKind === "native" ? MULTICALL3_ADDRESS : r.asset.address!;
      const callData = r.asset.valuationKind === "native" ? encodeGetEthBalanceCall(w) : encodeBalanceOfCall(w);
      calls.push({ target, allowFailure: true, callData });
      legs.push({ key: r.key, kind: "balance" });
    }
  }

  const rawSum = new Map<string, bigint>(); // erc20/aave/native keys
  const idleUsdcRaw = new Map<string, bigint>(); // strategy keys
  const vaultSharesRaw = new Map<string, Map<number, bigint>>(); // strategy key -> vaultIndex -> shares
  const errored = new Set<string>();
  let round1: Aggregate3Result[];
  try {
    round1 = await multicall3Aggregate3(calls, opts);
  } catch (err) {
    // The whole batch eth_call failed (transport/HTTP/JSON-RPC) — degrade EVERY
    // chain-read key to stale, exactly as the pre-batch all-fail path did.
    console.error(`${logLabel}: batched round-1 multicall failed, degrading all chain legs to stale:`, err);
    for (const r of reads) out.set(r.key, { ok: false });
    return out;
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const r = round1[i];
    if (!r || !r.success) {
      errored.add(leg.key); // a reverted sub-call fails the whole key (its NAV)
      continue;
    }
    const value = decodeUint256(r.returnData);
    if (leg.kind === "balance") {
      rawSum.set(leg.key, (rawSum.get(leg.key) ?? 0n) + value);
    } else if (leg.kind === "idleUsdc") {
      idleUsdcRaw.set(leg.key, value);
    } else if (value > 0n) {
      let byVault = vaultSharesRaw.get(leg.key);
      if (!byVault) {
        byVault = new Map();
        vaultSharesRaw.set(leg.key, byVault);
      }
      byVault.set(leg.vaultIndex, value);
    }
  }

  // ── Round 2: ERC-4626 NAV convertToAssets(shares) per (key, vault) w/ shares. ──
  const navCalls: Call3[] = [];
  const navKeys: { key: string; vaultIndex: number }[] = [];
  for (const r of reads) {
    if (r.asset.valuationKind !== "strategy" || errored.has(r.key)) continue;
    const byVault = vaultSharesRaw.get(r.key);
    if (!byVault) continue;
    for (const [vaultIndex, shares] of byVault) {
      navCalls.push({ target: strategyVaults[vaultIndex]!.address, allowFailure: true, callData: encodeConvertToAssetsCall(shares) });
      navKeys.push({ key: r.key, vaultIndex });
    }
  }
  const vaultAssetsRaw = new Map<string, bigint>(); // strategy key -> summed vault assets (6dp USDC)
  if (navCalls.length > 0) {
    let round2: Aggregate3Result[];
    try {
      round2 = await multicall3Aggregate3(navCalls, opts);
    } catch (err) {
      console.error(`${logLabel}: batched round-2 NAV multicall failed, degrading strategy legs to stale:`, err);
      for (const nk of navKeys) errored.add(nk.key);
      round2 = [];
    }
    for (let i = 0; i < navKeys.length; i++) {
      const r = round2[i];
      const { key } = navKeys[i]!;
      if (!r || !r.success) {
        errored.add(key);
        continue;
      }
      vaultAssetsRaw.set(key, (vaultAssetsRaw.get(key) ?? 0n) + decodeUint256(r.returnData));
    }
  }

  // ── Resolve each key's amount (or its failure). ────────────────────────────
  for (const r of reads) {
    if (errored.has(r.key)) {
      out.set(r.key, { ok: false });
      continue;
    }
    switch (r.asset.valuationKind) {
      case "erc20":
      case "aave": // Aave V3 aToken balanceOf is already underlying-denominated (1:1).
      case "native":
        out.set(r.key, { ok: true, amount: amountFrom(rawSum.get(r.key) ?? 0n, r.asset.decimals) });
        break;
      case "strategy": {
        // NAV = idle USDC + Σ convertToAssets(shares) over the maintained vault
        // list — 0 vaults configured degrades gracefully to idle-only, still a
        // real non-reverting live read of the account (issues #120/#145).
        const idle = idleUsdcRaw.get(r.key) ?? 0n;
        const vaultAssets = vaultAssetsRaw.get(r.key) ?? 0n;
        out.set(r.key, { ok: true, amount: amountFrom(idle + vaultAssets, 6) }); // underlying USDC (6 dp)
        break;
      }
    }
  }
  return out;
}

// The price + degradation valuation step, shared verbatim by both feeds: a
// pre-batched chain amount is priced with a per-asset keyless read
// (gecko/yahoo/pinned — DIFFERENT hosts than the rate-limited RPC; the READ
// stays per-asset so each leg degrades alone, while token-prices.ts
// transparently coalesces a same-burst fan-out of gecko reads into one
// comma-separated token_price request — the demo/CI quota fix, cf. #202).
// Any failure (the chain read degraded upstream,
// OR the price fetch throws) comes back as {ok:false} so each caller applies its
// OWN degrade shape — this module never fabricates a value and never labels a
// degraded leg 'live'. Provenance: 'stub' when either source is the hermetic
// stub, 'live' otherwise.
export type LegValuation =
  | { ok: true; amount: number; priceUsd: number; valueUsd: number; provenance: Provenance }
  | { ok: false; error: unknown };

export async function valueLeg(
  asset: TrackedAsset,
  chainAmount: ChainAmount,
  source: BaseRpcSource,
  priceSource: PriceSource,
  priceReader: WalletPriceReader = providerWalletPriceReader,
): Promise<LegValuation> {
  // The chain read failed (a reverted sub-call or a thrown batch) → degrade.
  if (!chainAmount.ok) return { ok: false, error: new Error(`${asset.symbol} chain read unavailable`) };
  try {
    const quote = await priceReader.read(asset, source, priceSource);
    const amount = chainAmount.amount;
    return {
      ok: true,
      amount,
      priceUsd: quote.priceUsd,
      valueUsd: amount * quote.priceUsd,
      provenance: quote.provenance,
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}
