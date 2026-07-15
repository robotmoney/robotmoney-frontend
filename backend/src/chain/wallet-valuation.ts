// SHARED prop-wallet valuation semantics (maintainability finding 007). The two
// wallet feeds used to carry drifting copies of the same logic:
//   - chain/wallet-balances.ts — the AGGREGATE view (amounts SUMMED across every
//     prop wallet, one holding per tracked symbol), and
//   - chain/wallet-sleeves.ts  — the PER-WALLET view (one amount per
//     (wallet, asset) leg, no cross-wallet sum).
// Everything that must stay identical between them lives here exactly once:
//   1. the Multicall3 BATCHED chain-amount reader (the #119 429-storm fix:
//      ≤2 eth_calls total — round 1 balance/getEthBalance legs, round 2 ERC-4626
//      convertToAssets NAV for each strategy with shares),
//   2. the per-valuationKind amount resolution (erc20 / aave aToken / native /
//      strategy round-2 NAV at 6 dp underlying USDC), and
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
import { config, type BaseRpcSource, type PriceSource, type TrackedAsset } from "../config.ts";
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
// one balanceOf / getEthBalance sub-call per leg; round 2 batches
// convertToAssets(shares) for each strategy KEY that has shares. Provenance
// honesty is preserved EXACTLY: a reverted sub-call (success:false) fails just
// its key; a thrown batch fails every key (matching the old all-fail path).
// `logLabel` names the calling feed in the degrade logs.
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

  // ── Round 1: one sub-call per (key × wallet). ──────────────────────────────
  const legs: { key: string }[] = [];
  const calls: Call3[] = [];
  for (const r of reads) {
    for (const w of r.wallets) {
      // native → Multicall3 getEthBalance(wallet); every other kind (erc20 /
      // aave aToken / strategy shares) → balanceOf(wallet) on the token/strategy.
      const target = r.asset.valuationKind === "native" ? MULTICALL3_ADDRESS : r.asset.address!;
      const callData = r.asset.valuationKind === "native" ? encodeGetEthBalanceCall(w) : encodeBalanceOfCall(w);
      calls.push({ target, allowFailure: true, callData });
      legs.push({ key: r.key });
    }
  }

  const rawSum = new Map<string, bigint>();
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
    const r = round1[i];
    const key = legs[i]!.key;
    if (!r || !r.success) {
      errored.add(key); // a reverted sub-call fails just this key
      continue;
    }
    rawSum.set(key, (rawSum.get(key) ?? 0n) + decodeUint256(r.returnData));
  }

  // ── Round 2: ERC-4626 NAV convertToAssets(shares) per strategy w/ shares. ──
  const navCalls: Call3[] = [];
  const navKeys: string[] = [];
  for (const r of reads) {
    if (r.asset.valuationKind !== "strategy" || errored.has(r.key)) continue;
    const shares = rawSum.get(r.key) ?? 0n;
    if (shares > 0n) {
      navCalls.push({ target: r.asset.address!, allowFailure: true, callData: encodeConvertToAssetsCall(shares) });
      navKeys.push(r.key);
    }
  }
  const navRaw = new Map<string, bigint>();
  if (navCalls.length > 0) {
    let round2: Aggregate3Result[];
    try {
      round2 = await multicall3Aggregate3(navCalls, opts);
    } catch (err) {
      console.error(`${logLabel}: batched round-2 NAV multicall failed, degrading strategy legs to stale:`, err);
      for (const k of navKeys) errored.add(k);
      round2 = [];
    }
    for (let i = 0; i < navKeys.length; i++) {
      const r = round2[i];
      if (!r || !r.success) {
        errored.add(navKeys[i]!);
        continue;
      }
      navRaw.set(navKeys[i]!, decodeUint256(r.returnData));
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
        // shares==0 → NAV is 0 with no round-2 call (matches callConvertToAssets(0)).
        const shares = rawSum.get(r.key) ?? 0n;
        const assetsRaw = shares > 0n ? (navRaw.get(r.key) ?? 0n) : 0n;
        out.set(r.key, { ok: true, amount: amountFrom(assetsRaw, 6) }); // underlying USDC (6 dp)
        break;
      }
    }
  }
  return out;
}

// The price + degradation valuation step, shared verbatim by both feeds: a
// pre-batched chain amount is priced with a per-asset keyless read
// (gecko/yahoo/pinned — DIFFERENT hosts than the rate-limited RPC, so prices
// stay per-asset and unbatched). Any failure (the chain read degraded upstream,
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
): Promise<LegValuation> {
  // The chain read failed (a reverted sub-call or a thrown batch) → degrade.
  if (!chainAmount.ok) return { ok: false, error: new Error(`${asset.symbol} chain read unavailable`) };
  try {
    const priceUsd = await fetchAssetPriceUsd(asset, priceSource);
    const amount = chainAmount.amount;
    return {
      ok: true,
      amount,
      priceUsd,
      valueUsd: amount * priceUsd,
      provenance: source === "stub" || priceSource === "stub" ? "stub" : "live",
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}
