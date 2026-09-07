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
  resolveStrategyUnderlyingPositions,
  resolveTrackedAssets,
  type BaseRpcSource,
  type PriceSource,
  type TrackedAsset,
} from "../config.ts";
import { sql } from "../db/client.ts";
import {
  decodeAggregate3,
  decodeUint256,
  encodeAggregate3,
  encodeBalanceOfCall,
  encodeConvertToAssetsCall,
  encodeGetEthBalanceCall,
  ethCallBatch,
  isEmptyReturnData,
  multicall3Aggregate3,
  MULTICALL3_ADDRESS,
  type Aggregate3Result,
  type BatchResult,
  type Call3,
  type RpcCallOptions,
} from "./base-rpc-client.ts";
import { fetchAssetPriceUsd } from "./token-prices.ts";
import { ASSET_PRICE_TIME_BASIS } from "../ops/asset-prices.ts";

// 'seed' = a pre-launch history row backfilled from the ported baked constants
// (chain/wallet-history-seed.ts), NOT a live chain read — honesty invariant from
// migration 0014 ("a value is NEVER fabricated or falsely labelled 'live'").
// 'backfilled' (issue #614 AC4) = a genuinely LIVE chain/price read, but one
// written by the scheduler's SAME-BUCKET catch-up path (worker/handlers/
// slot.ts classifySlot) rather than the nominal on-time sample — the read
// itself is exactly as current/honest as 'live', it is only late. Kept
// distinct from 'seed' (never a chain read at all) and 'stale' (a degraded
// leg reusing an OLDER persisted value) so none of the three get conflated.
export type Provenance = "live" | "stub" | "stale" | "seed" | "backfilled";

// A STORAGE-ONLY provenance, deliberately absent from the union above.
//
// Migration 0036 moves every row the pre-de5cf06 backfill wrote to this value:
// the row was written by a price path that asked GeckoTerminal for a POOL
// without naming the TOKEN it meant, so the number may describe a different
// asset entirely (a WETH holding priced at ~60,000 USD — cbBTC's price). See
// docs/code-review/20260823-review-data-integrity-aum-correctness.md §1.
//
// It is not a `Provenance` because it must never reach a response. Every read
// of wallet_balance_samples / wallet_sleeve_samples excludes it, so a
// quarantined day is ABSENT rather than served with a caveat — the review's
// first property is "the value that was true at that moment, or nothing, never
// a plausible substitute", and a badge on a wrong number is a substitute. The
// compiler enforces the absence: assigning this string to a Provenance does not
// typecheck.
//
// Re-admission is T5.1's job, and it restores rows to 'backfilled' one at a
// time against a freshly fetched token-addressed price. Nothing else ever
// writes this value.
export const QUARANTINED_PROVENANCE = "backfilled-quarantined";

// Price-reader seam for allocation live-data reliability (scout #175).
// Canonical behavior: docs/architecture.md §10.1 and
// docs/architecture.md §3. The production reader below still performs
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

// D41 phase 3 (issue #850): whatever row this reader lands on is, in the
// overwhelming common case, TODAY's own live row — the freshness bound below
// already keeps this near-exclusively a "today" fallback (see the comment
// preserved below on why a backfilled row almost never qualifies) — and D41
// says today's live point keeps reading its fused sample row untouched. The
// LEFT JOIN below exists for the narrow remainder: a row whose `sample_date`
// is NOT today (a closed day) that still happens to fall inside the
// freshness window, e.g. a backfill/repair commit landing within minutes of
// UTC midnight for the day it just closed. For that row, and only that row,
// the price it reports comes from `asset_prices` rather than the sample's own
// (soon-to-be-retired, D41 phase 4) `price_usd` column — falling back to the
// sample's own price when `asset_prices` has no row yet, exactly as
// wallet-balances.ts::loadHistory does, for the identical #849 known-gap
// reason (a cleanly-sampled closed day is not guaranteed to have dual-written
// into `asset_prices` yet).
async function recentPersistedPrice(symbol: string): Promise<{ priceUsd: number; sampledAt: string } | null> {
  const rows = await sql<{ price_usd: string | null; sampled_at: Date; asset_price_usd: string | null; is_closed: boolean }[]>`
    SELECT wbs.price_usd, wbs.sampled_at,
           ap.price_usd AS asset_price_usd,
           (wbs.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
     WHERE wbs.symbol = ${symbol}
       AND wbs.price_usd IS NOT NULL
       AND wbs.sampled_at <= now()
       -- A quarantined row's price may describe a DIFFERENT ASSET (migration
       -- 0036) — excluded unconditionally, never served even via the join.
       AND wbs.provenance <> ${QUARANTINED_PROVENANCE}
       -- The MAX_PERSISTED_PRICE_AGE_MS bound below already excludes
       -- quarantined rows in practice too — the backfill only fills CLOSED
       -- days and stamps sampled_at at that day's 23:59, so every backfilled
       -- row is more than five minutes old. That is a happy accident of two
       -- unrelated policies, which is exactly the "correct today by luck"
       -- shape §3 of the review is about; the predicate above makes it
       -- correct by construction instead.
     ORDER BY wbs.sampled_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.price_usd == null) return null;
  const sampledAt = row.sampled_at instanceof Date ? row.sampled_at : new Date(row.sampled_at);
  const sampledAtMs = sampledAt.getTime();
  if (Date.now() - sampledAtMs > MAX_PERSISTED_PRICE_AGE_MS) return null; // too old — not eligible
  // Same JS-side multiplication discipline as loadHistory/computeWalletSleeves:
  // this reader returns a PRICE, not a value, so there is no product to worry
  // about here — only which column's price_usd to read — but the join is
  // still read in JS rather than folded into the WHERE/SELECT arithmetic so a
  // future caller that DOES multiply against it inherits the same exactness.
  const priceUsd = row.is_closed && row.asset_price_usd != null ? Number(row.asset_price_usd) : Number(row.price_usd);
  return { priceUsd, sampledAt: sampledAt.toISOString() };
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

function rpcOpts(blockTag?: string): RpcCallOptions {
  return blockTag === undefined ? { rpcUrl: config.baseRpcUrl } : { rpcUrl: config.baseRpcUrl, blockTag };
}

// Options for a BLOCK-ADDRESSED read (issue #709, markets §5.2). Both fields are
// absent on every live call, and both defaults reproduce the pre-#709 behaviour
// exactly — this is the seam the wallet backfill reads history through, not a
// change to the live sampler.
export interface ChainReadOptions {
  /** Evaluate every sub-call at this block instead of "latest". */
  blockTag?: string;
  /**
   * Treat a sub-call that succeeded with ZERO RETURN BYTES as a FAILURE of its
   * key rather than decoding it to 0 (markets §6.1's silent-zero rail).
   *
   * `success: true` with `returnData: "0x"` means there is no contract at that
   * address AT THAT BLOCK — the normal answer for a day before the target was
   * deployed. On the live path that cannot happen for a configured, deployed
   * token, and `decodeUint256` maps `0x` to `0n` by long-standing design, so
   * this is OFF by default and the live path is untouched. For a backfill it
   * must be ON: decoding it would not read a balance of zero, it would invent
   * one, and a fabricated zero inside a summed AUM total is indistinguishable
   * from a real drawdown once written.
   */
  strictEmptyReturn?: boolean;
}

function amountFrom(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// The sleeve layout: which prop wallet (BY INDEX into resolvePropWallets())
// holds which symbols, and what that sleeve is called.
//
// This lived as THREE separate copies — the sampler
// (worker/handlers/wallet.ts), the read path (chain/wallet-sleeves.ts) and now
// the backfill (ops/wallet-backfill.ts). Three copies of the layout is three
// chances for a backfilled day to disagree with a live-sampled one about which
// (wallet, symbol) rows a day even HAS, which would show up as a permanent
// phantom gap in the sleeve series rather than as an obvious bug. It belongs
// here for the same reason everything else in this file does: it must stay
// identical across the feeds.
export interface SleeveDef {
  name: string;
  type: string;
  symbols: string[];
}
export const SLEEVE_DEFS: SleeveDef[] = [
  { name: "Bankr", type: "primary", symbols: ["USDC", "ROBOTMONEY", "WETH", "ETH", "BNKR"] },
  { name: "Stablecoin Strategy 1", type: "strategy", symbols: ["ZYFAI-SS1"] },
  { name: "Stablecoin Strategy 2", type: "strategy", symbols: ["GIZA-SS1"] },
];

// A key's resolved chain amount: either a token amount, or a failure flag that
// makes the caller degrade THAT key (a reverted sub-call, or the whole batch
// throwing). Callers never see a fabricated number for a failed key.
//
// `strategyPositions` (issue #642) is set ONLY for `strategy` keys and carries
// the NON-IDLE part of the NAV — Σ vault assets + Σ underlying positions, in
// the same 6 dp USDC units as `amount`. `0` means the account holds nothing in
// any configured position and its NAV is idle USDC only, which is ZYFAI-SS1's
// real on-chain state. Callers surface that as
// WalletHolding.strategyNavIdleOnly rather than letting an idle-only reading
// pass for an ordinary one.
export type ChainAmount =
  | { ok: true; amount: number; strategyPositions?: number }
  | { ok: false };

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
// instead queries the ACCOUNT's idle USDC balance, its share balance in each
// ERC-4626 vault (resolveStrategyVaults()), and its balance in each
// underlying-denominated position (resolveStrategyUnderlyingPositions()).
//
// Round 2 batches convertToAssets(shares) for every (key, VAULT) pair with a
// non-zero share balance — and for nothing else. NAV = idleUsdc + Σ vault
// assets + Σ underlying balances.
//
// THE VAULT/UNDERLYING SPLIT IS LOAD-BEARING (issue #642). convertToAssets is
// an ERC-4626 method. aBasUSDC is an Aave aToken (asset() reverts) and cUSDCv3
// is a Compound III Comet; calling convertToAssets on either reverts, and a
// reverted sub-call degrades the WHOLE leg to 'stale' — the exact #120 failure
// mode. Underlying-denominated positions therefore never enter navCalls below:
// their round-1 balanceOf IS the underlying amount and is summed directly.
//
// Provenance honesty is preserved EXACTLY: a reverted sub-call (success:false)
// fails just its key; a thrown batch fails every key (matching the old
// all-fail path). `logLabel` names the calling feed in the degrade logs.
export async function readChainAmountsBatched(
  reads: KeyedAssetRead[],
  logLabel: string,
  readOpts: ChainReadOptions = {},
): Promise<Map<string, ChainAmount>> {
  const tag = readOpts.blockTag ?? "latest";
  const byBlock = await readChainAmountsAtBlocks(reads, logLabel, [tag], readOpts);
  return byBlock.get(tag) ?? new Map<string, ChainAmount>();
}

/**
 * Read every keyed leg AT SEVERAL BLOCKS, in two POSTs rather than two per block.
 *
 * WHY THIS IS THE SHAPE. `aggregate3` already collapses one block's ~27 reads
 * into one `eth_call`, but it executes at a SINGLE block, so a ten-day repair
 * still made ten of them. The calls themselves are identical across blocks —
 * targets and calldata depend only on `reads` — so the whole difference between
 * two days is the block tag, and JSON-RPC array batching is what carries N tags
 * in one request (markets §7).
 *
 * ROUND 2 IS THE HAZARD, AND THE REASON THE STATE IS PER BLOCK. NAV is
 * `idleUsdc + convertToAssets(shares)`, and the shares come from round 1. Every
 * accumulator below therefore lives inside a per-block `BlockState`: pairing one
 * block's shares with another block's exchange rate would produce a total that
 * is real-looking, wrong, and completely silent. The rounds still run in
 * lockstep — all blocks' round 1, then all blocks' round 2 — so batching costs
 * no extra sequential depth.
 *
 * FAILURE IS PER BLOCK. A block whose `eth_call` errors degrades ITS OWN keys to
 * `{ok:false}` and leaves the other blocks untouched, which is the same
 * all-fail-for-this-read outcome the single-block path produced on a throw, just
 * scoped to the block it belongs to.
 */
export async function readChainAmountsAtBlocks(
  reads: KeyedAssetRead[],
  logLabel: string,
  blockTags: readonly string[],
  readOpts: ChainReadOptions = {},
): Promise<Map<string, Map<string, ChainAmount>>> {
  const byBlock = new Map<string, Map<string, ChainAmount>>();
  const tags = [...new Set(blockTags)];
  for (const t of tags) byBlock.set(t, new Map<string, ChainAmount>());
  if (tags.length === 0 || reads.length === 0) return byBlock;

  const strictEmpty = readOpts.strictEmptyReturn === true;
  // A sub-call is usable only if it succeeded AND — under a block-addressed
  // read — actually returned bytes. See ChainReadOptions.strictEmptyReturn.
  const subCallFailed = (r: Aggregate3Result | undefined): boolean =>
    !r || !r.success || (strictEmpty && isEmptyReturnData(r.returnData));
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
  const strategyUnderlying = resolveStrategyUnderlyingPositions();

  // ── Round 1: balance sub-calls. ────────────────────────────────────────────
  // erc20/aave/native → one balanceOf/getEthBalance per (key × wallet), summed.
  // strategy → idle USDC balanceOf(account), + balanceOf(account) on each
  // ERC-4626 vault (shares, converted in round 2), + balanceOf(account) on each
  // underlying-denominated position (already USDC, never converted).
  type Leg =
    | { key: string; kind: "balance" }
    | { key: string; kind: "idleUsdc" }
    | { key: string; kind: "vaultShare"; vaultIndex: number }
    | { key: string; kind: "underlying" };
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
      // Underlying-denominated positions (aTokens): balanceOf IS the USDC
      // amount, so these are summed straight into NAV and are deliberately NOT
      // given a vaultIndex — nothing downstream can route them into round 2's
      // convertToAssets batch (issue #642).
      for (const p of strategyUnderlying) {
        calls.push({ target: p.address, allowFailure: true, callData: encodeBalanceOfCall(account) });
        legs.push({ key: r.key, kind: "underlying" });
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

  // EVERY accumulator is PER BLOCK. Round 2 consumes round 1's shares, so a
  // single shared set of these is exactly how a batched implementation would
  // silently value one day's holdings at another day's exchange rate.
  interface BlockState {
    rawSum: Map<string, bigint>; // erc20/aave/native keys
    idleUsdcRaw: Map<string, bigint>; // strategy keys
    underlyingRaw: Map<string, bigint>; // strategy key -> Σ aToken-style balances (6dp USDC)
    vaultSharesRaw: Map<string, Map<number, bigint>>; // strategy key -> vaultIndex -> shares
    vaultAssetsRaw: Map<string, bigint>; // strategy key -> summed vault assets (6dp USDC)
    errored: Set<string>;
  }
  const states = new Map<string, BlockState>();
  for (const tag of tags) {
    states.set(tag, {
      rawSum: new Map(),
      idleUsdcRaw: new Map(),
      underlyingRaw: new Map(),
      vaultSharesRaw: new Map(),
      vaultAssetsRaw: new Map(),
      errored: new Set(),
    });
  }

  // ── Round 1, every block in ONE request. ──────────────────────────────────
  // The Call3[] is identical for all of them (it depends only on `reads`), so
  // the same aggregate3 payload goes out once per block tag.
  const round1ByTag = await aggregateAcrossBlocks(
    new Map(tags.map((tag) => [tag, calls])),
    logLabel,
    "round-1",
  );

  for (const tag of tags) {
    const st = states.get(tag)!;
    const round1 = round1ByTag.get(tag);
    if (!round1) {
      // This block's eth_call failed — degrade EVERY chain-read key AT THIS
      // BLOCK to stale, exactly as the pre-batch all-fail path did, and leave
      // the other blocks alone.
      for (const r of reads) st.errored.add(r.key);
      continue;
    }
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const r = round1[i];
      if (subCallFailed(r)) {
        st.errored.add(leg.key); // a reverted (or empty, when strict) sub-call fails the whole key
        continue;
      }
      const value = decodeUint256(r!.returnData);
      if (leg.kind === "balance") {
        st.rawSum.set(leg.key, (st.rawSum.get(leg.key) ?? 0n) + value);
      } else if (leg.kind === "idleUsdc") {
        st.idleUsdcRaw.set(leg.key, value);
      } else if (leg.kind === "underlying") {
        st.underlyingRaw.set(leg.key, (st.underlyingRaw.get(leg.key) ?? 0n) + value);
      } else if (value > 0n) {
        let byVault = st.vaultSharesRaw.get(leg.key);
        if (!byVault) {
          byVault = new Map();
          st.vaultSharesRaw.set(leg.key, byVault);
        }
        byVault.set(leg.vaultIndex, value);
      }
    }
  }

  // ── Round 2: ERC-4626 NAV convertToAssets(shares) per (key, vault) w/ shares. ──
  // Built from EACH block's own round-1 shares, then all blocks issued together
  // — one more request, not one more per block.
  const navCallsByTag = new Map<string, Call3[]>();
  const navKeysByTag = new Map<string, { key: string; vaultIndex: number }[]>();
  for (const tag of tags) {
    const st = states.get(tag)!;
    const navCalls: Call3[] = [];
    const navKeys: { key: string; vaultIndex: number }[] = [];
    for (const r of reads) {
      if (r.asset.valuationKind !== "strategy" || st.errored.has(r.key)) continue;
      const byVault = st.vaultSharesRaw.get(r.key);
      if (!byVault) continue;
      for (const [vaultIndex, shares] of byVault) {
        navCalls.push({ target: strategyVaults[vaultIndex]!.address, allowFailure: true, callData: encodeConvertToAssetsCall(shares) });
        navKeys.push({ key: r.key, vaultIndex });
      }
    }
    if (navCalls.length > 0) {
      navCallsByTag.set(tag, navCalls);
      navKeysByTag.set(tag, navKeys);
    }
  }

  if (navCallsByTag.size > 0) {
    const round2ByTag = await aggregateAcrossBlocks(navCallsByTag, logLabel, "round-2 NAV");
    for (const [tag, navKeys] of navKeysByTag) {
      const st = states.get(tag)!;
      const round2 = round2ByTag.get(tag);
      if (!round2) {
        for (const nk of navKeys) st.errored.add(nk.key);
        continue;
      }
      for (let i = 0; i < navKeys.length; i++) {
        const r = round2[i];
        const { key } = navKeys[i]!;
        if (subCallFailed(r)) {
          st.errored.add(key);
          continue;
        }
        st.vaultAssetsRaw.set(key, (st.vaultAssetsRaw.get(key) ?? 0n) + decodeUint256(r!.returnData));
      }
    }
  }

  // ── Resolve each key's amount (or its failure), block by block. ───────────
  for (const tag of tags) {
    const st = states.get(tag)!;
    const out = byBlock.get(tag)!;
    for (const r of reads) {
      if (st.errored.has(r.key)) {
        out.set(r.key, { ok: false });
        continue;
      }
      switch (r.asset.valuationKind) {
        case "erc20":
        case "aave": // Aave V3 aToken balanceOf is already underlying-denominated (1:1).
        case "native":
          out.set(r.key, { ok: true, amount: amountFrom(st.rawSum.get(r.key) ?? 0n, r.asset.decimals) });
          break;
        case "strategy": {
          // NAV = idle USDC + Σ convertToAssets(shares) over the ERC-4626 vaults
          // + Σ balanceOf over the underlying-denominated positions. An account
          // holding NONE of them values as idle-only — still a real,
          // non-reverting live read, but an incomplete picture of an account that
          // is supposed to be deployed, so the non-idle total travels with it as
          // `strategyPositions` for the caller to disclose (issue #642).
          const idle = st.idleUsdcRaw.get(r.key) ?? 0n;
          const vaultAssets = st.vaultAssetsRaw.get(r.key) ?? 0n;
          const underlying = st.underlyingRaw.get(r.key) ?? 0n;
          const positions = vaultAssets + underlying;
          out.set(r.key, {
            ok: true,
            amount: amountFrom(idle + positions, 6), // underlying USDC (6 dp)
            strategyPositions: amountFrom(positions, 6),
          });
          break;
        }
      }
    }
  }
  return byBlock;
}

/**
 * Issue one `aggregate3` per block tag, all in ONE batched request.
 *
 * `undefined` for a tag means that block could not be read — the caller degrades
 * that block's keys and no others. A failure of the REQUEST itself degrades
 * every block in it, which is the same outcome the single-block path produced
 * when the transport was down.
 */
async function aggregateAcrossBlocks(
  callsByTag: Map<string, Call3[]>,
  logLabel: string,
  round: string,
): Promise<Map<string, Aggregate3Result[] | undefined>> {
  const out = new Map<string, Aggregate3Result[] | undefined>();
  const entries = [...callsByTag.entries()].filter(([, c]) => c.length > 0);
  if (entries.length === 0) return out;

  // ONE BLOCK STAYS A PLAIN eth_call, NOT A BATCH OF ONE.
  //
  // Every live caller — the request path, both samplers, the projects wallet
  // read — reads a single block, and wrapping their one call in a JSON-RPC array
  // would change the bytes on the wire for all of them while saving exactly
  // nothing: one call in an array is still one round trip. Array batching earns
  // its keep only when there are several blocks to carry, which is the backfill
  // window and nothing else today.
  if (entries.length === 1) {
    const [tag, c] = entries[0]!;
    try {
      out.set(tag, await multicall3Aggregate3(c, rpcOpts(tag)));
    } catch (err) {
      console.error(`${logLabel}: batched ${round} multicall failed, degrading all chain legs to stale:`, err);
      out.set(tag, undefined);
    }
    return out;
  }

  let res: BatchResult<string>[];
  try {
    res = await ethCallBatch(
      entries.map(([tag, c]) => ({ to: MULTICALL3_ADDRESS, data: encodeAggregate3(c), blockTag: tag })),
      rpcOpts(),
    );
  } catch (err) {
    console.error(`${logLabel}: batched ${round} multicall failed, degrading all chain legs to stale:`, err);
    for (const [tag] of entries) out.set(tag, undefined);
    return out;
  }

  for (let i = 0; i < entries.length; i++) {
    const tag = entries[i]![0];
    const r = res[i];
    if (!r || !r.ok) {
      console.error(
        `${logLabel}: batched ${round} multicall failed at block ${tag}, degrading that block's legs to stale:`,
        r && !r.ok ? r.error.message : "no response",
      );
      out.set(tag, undefined);
      continue;
    }
    try {
      out.set(tag, decodeAggregate3(r.result));
    } catch (err) {
      // Undecodable bytes are not a zero-length result set: treat the block as
      // unread rather than silently valuing every leg at nothing.
      console.error(`${logLabel}: batched ${round} result at block ${tag} did not decode, degrading that block:`, err);
      out.set(tag, undefined);
    }
  }
  return out;
}

// The price + degradation valuation step, shared verbatim by both feeds: a
// pre-batched chain amount is priced with a per-asset keyless read
// (gecko/yahoo/pinned — DIFFERENT hosts than the rate-limited RPC; the READ
// stays per-asset so each leg degrades alone, while token-prices.ts
// transparently coalesces a same-burst fan-out of gecko reads into one
// comma-separated token_price request — the smoke/CI quota fix, cf. #202).
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
