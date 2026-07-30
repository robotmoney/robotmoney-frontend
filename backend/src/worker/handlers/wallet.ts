// Daily prop-wallet balance sampler (issue #84). Feeds the continuous
// /performance series and the last-live fallback that the per-leg degrade path
// in chain/wallet-balances.ts reads.
//
// sampleWalletBalances: reads every prop wallet live (Base RPC + keyless prices)
// and UPSERTS one row per tracked asset keyed by (sample_date, symbol) — the
// natural key from migration 0014 — so a retried or catch-up run on the same UTC
// day never duplicates a slot (idempotency, day-boundary = UTC calendar day).
//
// The one-time pre-launch history backfill (backfillWalletHistory) lives in
// db/seed.ts — it is migrate/seed tooling on the migration pool, not a worker
// job, and the worker's queue-scoped pool (db/worker-client.ts, issue #106)
// must not be dragged into the migrate one-shot's import graph (a queried
// second pool would keep `bun run migrate` from ever exiting).
import { sql } from "../../db/worker-client.ts";
import { fetchWalletBalances, _resetWalletBalancesCacheForTests } from "../../chain/wallet-balances.ts";
import {
  isPlaceholderAddress,
  resolveBaseRpcSource,
  resolvePriceSource,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../../config.ts";
import {
  persistedFallbackWalletPriceReader,
  readChainAmountsBatched,
  valueLeg,
  type KeyedAssetRead,
} from "../../chain/wallet-valuation.ts";

export async function sampleWalletBalances(_payload: Record<string, unknown>): Promise<unknown> {
  // Fresh read (bypass the request cache) so the sampler records current chain
  // state, not a value memoized by a recent page load.
  _resetWalletBalancesCacheForTests();
  const { holdings } = await fetchWalletBalances();
  const sampleDate = new Date().toISOString().slice(0, 10); // UTC calendar day
  let persisted = 0;
  for (const h of holdings) {
    // Never persist a leg with no value (no live read AND no prior sample) — that
    // would write a fabricated/placeholder row. A degraded 'stale' leg carries
    // its last-persisted value, which is fine to re-record idempotently.
    if (h.valueUsd == null) continue;
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${h.symbol}, ${h.amount}, ${h.priceUsd}, ${h.valueUsd}, ${h.provenance}, now())
      ON CONFLICT (sample_date, symbol) DO UPDATE SET
        amount     = EXCLUDED.amount,
        price_usd  = EXCLUDED.price_usd,
        value_usd  = EXCLUDED.value_usd,
        provenance = EXCLUDED.provenance,
        sampled_at = EXCLUDED.sampled_at
    `;
    persisted += 1;
  }
  return { sampleDate, persisted };
}

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

export async function sampleWalletSleeves(_payload: Record<string, unknown>): Promise<unknown> {
  const source = resolveBaseRpcSource();
  const priceSource = resolvePriceSource();
  const wallets = resolvePropWallets();
  const assets = resolveTrackedAssets();
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));

  const reads: KeyedAssetRead[] = [];
  const readTargets: { walletAddress: string; asset: TrackedAsset; key: string }[] = [];

  for (let i = 0; i < SLEEVE_DEFS.length && i < wallets.length; i++) {
    const def = SLEEVE_DEFS[i]!;
    const address = wallets[i]!;
    const walletAssets = def.symbols
      .map((s) => bySymbol.get(s))
      .filter((a): a is TrackedAsset => a != null && (a.valuationKind === "native" || !isPlaceholderAddress(a.address)));
    for (const a of walletAssets) {
      const key = `${i}:${a.symbol}`;
      reads.push({ key, asset: a, wallets: [address] });
      readTargets.push({ walletAddress: address.toLowerCase(), asset: a, key });
    }
  }

  const chainAmounts = await readChainAmountsBatched(reads, "sampleWalletSleeves");
  const sampleDate = new Date().toISOString().slice(0, 10);
  let persisted = 0;

  for (const { walletAddress, asset, key } of readTargets) {
    const chainAmount = chainAmounts.get(key);
    if (!chainAmount || !chainAmount.ok) continue;

    // Explicit persisted-fallback reader (issue #294): this sampler runs on the
    // worker schedule, not the request path, so a live-price-provider hiccup
    // should still degrade to a recent persisted per-symbol price rather than
    // skipping the sample entirely. This must be passed explicitly here and
    // NOT via valueLeg's default — wallet-balances.ts:133 (fetchWalletBalances,
    // the out-of-scope /api/dashboards/wallet-balances request path) calls
    // valueLeg with no reader argument and must keep inheriting
    // providerWalletPriceReader's original ok:false-on-failure behavior.
    const valued = await valueLeg(asset, chainAmount, source, priceSource, persistedFallbackWalletPriceReader);
    if (!valued.ok) continue;

    await sql`
      INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${walletAddress}, ${asset.symbol}, ${valued.amount}, ${valued.priceUsd}, ${valued.valueUsd}, ${valued.provenance}, now())
      ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
        amount     = EXCLUDED.amount,
        price_usd  = EXCLUDED.price_usd,
        value_usd  = EXCLUDED.value_usd,
        provenance = EXCLUDED.provenance,
        sampled_at = EXCLUDED.sampled_at
    `;
    persisted += 1;
  }

  return { sampleDate, persisted };
}


