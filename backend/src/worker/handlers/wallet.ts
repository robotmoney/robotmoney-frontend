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
//
// D41 phase 4 (issue #927): the live sampler now dual-writes price data to
// `asset_prices` and no longer writes `price_usd` to `wallet_balance_samples`,
// mirroring the change #851 made to `repairResolvedDay`.
//
// PR #946 review fix: sampleWalletSleeves (below) now does its OWN
// asset_prices dual-write too, rather than relying on sampleWalletBalances —
// a separate, independently-scheduled job — to have covered the same
// (date, symbol) that tick. See the comment on sampleWalletSleeves for why
// that reliance was a false invariant.
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
  sleeveSymbols,
  valueLeg,
  type KeyedAssetRead,
} from "../../chain/wallet-valuation.ts";
import { classifySlot, declineReplayedSlot } from "./slot.ts";
import { lockWalletSnapshotDate } from "../../ops/wallet-snapshot-manifest.ts";
import { writeAssetPrice, type AssetPriceSource } from "../../ops/asset-prices.ts";
import { resolvePoolForToken } from "../../chain/historical-prices.ts";

/** The instant a UTC daily candle for `date` closes — one day after `date`'s
 *  own midnight (issue #927's asset_prices dual-write; `observed_at`). */
function dayCloseInstant(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
}

// Shared by both samplers' dual-write gate: only a genuinely fresh-this-tick
// read is eligible to be written into asset_prices under TODAY's date. A
// degraded ('stale'/'seed') leg is carrying an OLD price forward, and
// dual-writing that under today's date would misrepresent today's eventual
// close once it becomes a closed day tomorrow. 'stub'/'live' both count as
// fresh (deterministic test fixture vs. a real provider read — neither is a
// degrade); only 'stale'/'seed' are excluded.
function isFreshThisTick(provenance: string): boolean {
  return provenance === "live" || provenance === "stub";
}

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
  const assets = resolveTrackedAssets();
  const assetBySymbol = new Map(assets.map((a) => [a.symbol, a]));

  // D41 phase 4 (issue #927): resolve pool keys for the asset_prices dual-write,
  // once per symbol, outside the transaction (resolvePoolForToken may reach the
  // network). Metadata only: a resolution failure never fails the day the
  // amounts write already succeeded for.
  //
  // Gated on isFreshThisTick(h.provenance), same gate the dual-write below
  // uses, for two reasons: (1) a degraded ('stale'/'seed') leg is carrying an
  // OLD price forward, and dual-writing that into asset_prices under TODAY's
  // date would misrepresent today's eventual close once it becomes a closed
  // day tomorrow; (2) `resolvePoolForToken` never caches a FAILED lookup (by
  // design — "a failed discovery must not be cached as a permanent
  // negative"), so during a sustained price-host outage every gecko-priced
  // symbol would retry pool discovery on EVERY tick forever — exactly the
  // retry-amplifying traffic against an already-exhausted host that the
  // #202/429-exhaustion tests guard against. Skipping resolution for legs that
  // already failed to price fresh this tick keeps this cron silent (no pool
  // lookups at all) for exactly the symbols that are failing. 'stub'/'live'
  // both count as fresh (deterministic test fixture vs. a real provider read
  // — neither is a degrade); only 'stale'/'seed' are excluded. (isFreshThisTick
  // is shared with sampleWalletSleeves below — see its module-level def above.)
  const poolKeyBySymbol = new Map<string, string | null>();
  for (const h of holdings) {
    if (!isFreshThisTick(h.provenance)) continue;
    const asset = assetBySymbol.get(h.symbol);
    if (asset?.priceKind === "gecko" && asset.address && !poolKeyBySymbol.has(h.symbol)) {
      try {
        poolKeyBySymbol.set(h.symbol, await resolvePoolForToken(asset.address));
      } catch {
        poolKeyBySymbol.set(h.symbol, null);
      }
    }
  }

  return sql.begin(async (tx) => {
    await lockWalletSnapshotDate(tx, sampleDate);
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
      // issue #642: the sampler is the ONLY place that knows whether a strategy
      // leg's NAV came from idle USDC alone — the request path serves persisted
      // rows with zero RPC and cannot re-derive it. `undefined` (every
      // non-strategy leg, and any leg whose read failed) persists as NULL:
      // not-applicable/not-known, never a fabricated `false`. See migration 0032.
      const strategyNavIdleOnly = h.strategyNavIdleOnly ?? null;
      const asset = assetBySymbol.get(h.symbol);
      const priceUsd = h.priceUsd;
      // D41 phase 4 (issue #927): price_usd is NOT written to wallet_balance_samples.
      // asset_prices is the sole write target for price data now that #850 switched
      // every read site to the join; leaving this column NULL on a live-sampled row
      // is deliberate, not an oversight, and value_usd still carries the fused
      // amount*price product a caller may need before the join lands its row.
      await tx`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, value_usd, provenance, strategy_nav_idle_only, sampled_at)
        VALUES
          (${sampleDate}, ${h.symbol}, ${h.amount}, ${h.valueUsd}, ${provenance}, ${strategyNavIdleOnly}, now())
        ON CONFLICT (sample_date, symbol) DO UPDATE SET
          amount     = EXCLUDED.amount,
          value_usd  = EXCLUDED.value_usd,
          provenance = EXCLUDED.provenance,
          strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only,
          sampled_at = EXCLUDED.sampled_at
      `;

      // D41 phase 4 — dual-write the price row alongside the sample row,
      // once per (date, symbol) from the aggregate leg. Gated on
      // isFreshThisTick(h.provenance) for the same reason the pool-key
      // resolution above is: a degraded ('stale'/'seed') leg's price is OLD,
      // not this tick's observation, and writing it into asset_prices under
      // TODAY's date would misrepresent that day's eventual close (see the
      // extended rationale above).
      if (asset && isFreshThisTick(h.provenance) && priceUsd != null && Number.isFinite(priceUsd) && priceUsd > 0) {
        const source: AssetPriceSource = asset.priceKind === "usdc" ? "pinned" : "geckoterminal";
        const poolKey = source === "pinned" ? null : (poolKeyBySymbol.get(h.symbol) ?? null);
        const now = new Date();
        await writeAssetPrice(tx as any, {
          priceDate: sampleDate,
          symbol: h.symbol,
          priceUsd,
          source,
          poolKey,
          tokenAddress: source === "pinned" ? null : (asset.address ?? null),
          observedAt: dayCloseInstant(sampleDate),
          fetchedAt: now,
          configIdentity: source === "pinned"
            ? "pinned:usd:1.00"
            : `geckoterminal:pool:${poolKey ?? "unresolved"}`,
        });
      }

      persisted += 1;
    }
    return { sampleDate, persisted };
  });
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
    const walletAssets = sleeveSymbols(def)
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
  // Review finding (PR #946, RELIABILITY_CROSS_JOB_ATOMICITY_FALSE_INVARIANT):
  // this sampler used to rely ENTIRELY on sampleWalletBalances — a separate,
  // independently-scheduled job (wallet.sample_balances vs wallet.sample_sleeves
  // in db/seed.ts, each its own transaction, no ordering/joint-success
  // guarantee) — to have already dual-written asset_prices for the same
  // (date, symbol) that tick. Because the two jobs are independent, a symbol
  // could price fresh in the sleeve leg on a tick where the balance leg's read
  // for that same symbol degraded or simply didn't run, leaving a sleeve row
  // with no covering asset_prices row — the read-side fallback would still
  // catch it, but the write-side invariant this file's tests claim ("a
  // cleanly-sampled day can never trigger the fallback") was false for that
  // shape. Fixed by giving this sampler its OWN dual-write, gated the same way
  // sampleWalletBalances gates its own (isFreshThisTick), so each job is
  // independently correct and neither depends on the other's success this
  // tick. `writeAssetPrice`'s ON CONFLICT DO UPDATE upsert makes it harmless
  // for both jobs to write the same (date, symbol) — dualWrittenSymbols below
  // just avoids redundant writes for a symbol common to several sleeves in the
  // SAME tick, not a correctness requirement.
  const poolKeyBySymbol = new Map<string, string | null>();
  const dualWrittenSymbols = new Set<string>();
  return sql.begin(async (tx) => {
    await lockWalletSnapshotDate(tx, sampleDate);
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

      // D41 phase 4 (issue #927): price_usd is NOT written to
      // wallet_sleeve_samples, mirroring both sampleWalletBalances above and
      // repairResolvedDay's already-shipped (#851) sleeve write. asset_prices
      // is the sole write target for price data; value_usd still carries the
      // fused amount*price product.
      await tx`
        INSERT INTO wallet_sleeve_samples
          (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
        VALUES
          (${sampleDate}, ${walletAddress}, ${asset.symbol}, ${valued.amount}, ${valued.valueUsd}, ${provenance}, now())
        ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
          amount     = EXCLUDED.amount,
          value_usd  = EXCLUDED.value_usd,
          provenance = EXCLUDED.provenance,
          sampled_at = EXCLUDED.sampled_at
      `;

      // Own dual-write (see the block comment above `sql.begin`): gated on
      // isFreshThisTick(valued.provenance) for the exact reason
      // sampleWalletBalances' gate is — a degraded ('stale'/'seed') leg is
      // carrying an OLD price forward, and writing that under TODAY's date
      // would misrepresent today's eventual close once it becomes a closed
      // day tomorrow. One write per (date, symbol) per tick: several sleeves
      // can share a symbol (issue #948 — every wallet reads every
      // chain-readable tracked asset), so dualWrittenSymbols skips the
      // repeats rather than reissuing an upsert that would just overwrite
      // itself with an equivalent price.
      if (
        isFreshThisTick(valued.provenance) &&
        Number.isFinite(valued.priceUsd) &&
        valued.priceUsd > 0 &&
        !dualWrittenSymbols.has(asset.symbol)
      ) {
        dualWrittenSymbols.add(asset.symbol);
        const priceSourceKind: AssetPriceSource = asset.priceKind === "usdc" ? "pinned" : "geckoterminal";
        let poolKey: string | null = null;
        if (priceSourceKind === "geckoterminal" && asset.address) {
          if (poolKeyBySymbol.has(asset.symbol)) {
            poolKey = poolKeyBySymbol.get(asset.symbol) ?? null;
          } else {
            try {
              poolKey = await resolvePoolForToken(asset.address);
            } catch {
              poolKey = null;
            }
            poolKeyBySymbol.set(asset.symbol, poolKey);
          }
        }
        const now = new Date();
        await writeAssetPrice(tx as any, {
          priceDate: sampleDate,
          symbol: asset.symbol,
          priceUsd: valued.priceUsd,
          source: priceSourceKind,
          poolKey,
          tokenAddress: priceSourceKind === "pinned" ? null : (asset.address ?? null),
          observedAt: dayCloseInstant(sampleDate),
          fetchedAt: now,
          configIdentity: priceSourceKind === "pinned"
            ? "pinned:usd:1.00"
            : `geckoterminal:pool:${poolKey ?? "unresolved"}`,
        });
      }

      persisted += 1;
    }

    return { sampleDate, persisted };
  });
}
