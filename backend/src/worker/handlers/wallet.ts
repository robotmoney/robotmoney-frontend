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
  SLEEVE_DEFS,
  valueLeg,
  type KeyedAssetRead,
} from "../../chain/wallet-valuation.ts";
import { classifySlot, declineReplayedSlot } from "./slot.ts";

export async function sampleWalletBalances(payload: Record<string, unknown> = {}): Promise<unknown> {
  // issue #614 AC4: a slot replayed for a bucket (UTC calendar day here)
  // that has already closed cannot be honoured — chain balances are read at
  // "latest" and prices are spot-only, so there is no way to answer "what
  // was this on a past day" without fabricating it. Decline explicitly.
  // A slot replayed WITHIN today's still-open bucket (a wedged scheduler
  // catching up a few hours late) is different: a read taken right now is
  // exactly as honest for today as an on-time sample would have been, so it
  // proceeds — tagged 'backfilled' (below) rather than 'live' so the catch-up
  // stays distinguishable from the nominal scheduled sample.
  const replay = classifySlot(payload, "daily");
  if (replay === "past-bucket") return declineReplayedSlot("wallet.sample_balances", payload);
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
    // Only a genuinely LIVE leg is relabelled 'backfilled' on a same-bucket
    // catch-up — a leg that already degraded to 'stub'/'stale' keeps that
    // (more specific, more important) label rather than being overwritten.
    const provenance = replay === "same-bucket-catchup" && h.provenance === "live" ? "backfilled" : h.provenance;
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${h.symbol}, ${h.amount}, ${h.priceUsd}, ${h.valueUsd}, ${provenance}, now())
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

// SLEEVE_DEFS is imported from chain/wallet-valuation.ts (it was duplicated
// here and in chain/wallet-sleeves.ts). The backfill driver writes the same
// (wallet, symbol) rows this sampler does, and a third copy of the layout would
// let a repaired day silently disagree with a live-sampled one about which rows
// a day even has.

export async function sampleWalletSleeves(payload: Record<string, unknown> = {}): Promise<unknown> {
  const sleeveReplay = classifySlot(payload, "daily");
  if (sleeveReplay === "past-bucket") return declineReplayedSlot("wallet.sample_sleeves", payload);
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
    // Same relabelling rule as sampleWalletBalances above: only a genuinely
    // LIVE leg becomes 'backfilled' on a same-bucket catch-up.
    const provenance = sleeveReplay === "same-bucket-catchup" && valued.provenance === "live" ? "backfilled" : valued.provenance;

    await sql`
      INSERT INTO wallet_sleeve_samples
        (sample_date, wallet_address, symbol, amount, price_usd, value_usd, provenance, sampled_at)
      VALUES
        (${sampleDate}, ${walletAddress}, ${asset.symbol}, ${valued.amount}, ${valued.priceUsd}, ${valued.valueUsd}, ${provenance}, now())
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


