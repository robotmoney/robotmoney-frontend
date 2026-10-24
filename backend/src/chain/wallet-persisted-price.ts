// The persisted-price fallback's read, run by the api (issue 1034, decision
// D75). When a live price read fails, a wallet valuation falls back to a recent
// persisted per-symbol price (chain/wallet-valuation.ts persistedFallbackReader).
// The pipeline worker's samplers and projects source reach this read over
// /api/pipeline/** (worker/persisted-price.ts); the api's own wallet-sleeves
// feed uses dbPersistedFallbackReader below.
import { sql } from "../db/client.ts";
import { on, registerQuery, type RegistryDb } from "../db/registry.ts";
import { ASSET_PRICE_TIME_BASIS } from "../ops/asset-price-basis.ts";
import {
  MAX_PERSISTED_PRICE_AGE_MS,
  persistedFallbackReader,
  QUARANTINED_PROVENANCE,
  type WalletPriceReader,
} from "./wallet-valuation.ts";

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
// `price_usd` column.
//
// Issue #927: the live sampler no longer writes `price_usd` on ordinary
// samples, so TODAY's row (the common case above) has `price_usd IS NULL`
// from the moment it is written — `asset_prices` never covers today either
// (it is keyed by CLOSED-day UTC candles). Requiring `price_usd IS NOT NULL`
// here would make this whole stale-degrade path (#173: serve a recent sample
// when the live provider read fails) permanently unreachable the instant a
// deployment picks up #927, which is a live-read-failure regression, not a
// cleanup. `value_usd` is still written by every sampler row (#927 only drops
// `price_usd`), and it is the exact same JS double `amount * price` the
// sampler computed at sample time — so a row missing `price_usd` derives it
// back out as `value_usd / amount` instead.
// The fallback read below, as tests/db-registry-execution.test.ts runs it: the
// call site's own statement (that test holds the two to the same text), under
// both declarations it joins.
const RECENT_PRICE_PROBE = {
  statement: `SELECT wbs.price_usd, wbs.amount, wbs.value_usd, wbs.sampled_at,
           ap.price_usd AS asset_price_usd,
           (wbs.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = $1
     WHERE wbs.symbol = $2
       AND (wbs.price_usd IS NOT NULL OR (wbs.value_usd IS NOT NULL AND wbs.amount IS NOT NULL AND wbs.amount <> 0))
       AND wbs.sampled_at <= now()
       AND wbs.provenance <> $3
       AND wbs.superseded_at IS NULL
     ORDER BY wbs.sampled_at DESC
     LIMIT 1`,
  params: [ASSET_PRICE_TIME_BASIS, "USDC", QUARANTINED_PROVENANCE],
};

const fallbackSample = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/chain/wallet-persisted-price:recentPersistedPrice.samples",
  purpose: "Read a symbol's newest recent sample price, for the fallback when a live price read fails.",
  callers: ["src/api/routes/dashboards", "src/api/routes/pipeline"],
  probe: RECENT_PRICE_PROBE,
});

const fallbackPrice = registerQuery({
  role: "rm_app",
  object: "asset_prices",
  privileges: ["SELECT"],
  site: "src/chain/wallet-persisted-price:recentPersistedPrice.prices",
  purpose: "Join the settled asset price for the fallback sample's day, which the fallback read LEFT JOINs.",
  callers: ["src/api/routes/dashboards", "src/api/routes/pipeline"],
  probe: RECENT_PRICE_PROBE,
});

/**
 * A symbol's newest sample price, if it is at most MAX_PERSISTED_PRICE_AGE_MS
 * old (the pipeline read `wallet.recent_persisted_price`).
 */
export async function recentPersistedPrice(db: RegistryDb, symbol: string): Promise<{ priceUsd: number; sampledAt: string } | null> {
  const rows = await on(db, fallbackSample, fallbackPrice)<{
    price_usd: string | null;
    amount: string | null;
    value_usd: string | null;
    sampled_at: Date;
    asset_price_usd: string | null;
    is_closed: boolean;
  }>`
    SELECT wbs.price_usd, wbs.amount, wbs.value_usd, wbs.sampled_at,
           ap.price_usd AS asset_price_usd,
           (wbs.sample_date < (now() AT TIME ZONE 'UTC')::date) AS is_closed
      FROM wallet_balance_samples wbs
      LEFT JOIN asset_prices ap
        ON ap.symbol = wbs.symbol
       AND ap.price_date = wbs.sample_date
       AND ap.time_basis = ${ASSET_PRICE_TIME_BASIS}
     WHERE wbs.symbol = ${symbol}
       AND (wbs.price_usd IS NOT NULL OR (wbs.value_usd IS NOT NULL AND wbs.amount IS NOT NULL AND wbs.amount <> 0))
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
       -- D55 (6): nor is a row the repair pass superseded (migration 0104):
       -- the delete it replaces left no such row to serve.
       AND wbs.superseded_at IS NULL
     ORDER BY wbs.sampled_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const derivedPriceUsd = row.price_usd != null
    ? Number(row.price_usd)
    : row.value_usd != null && row.amount != null && Number(row.amount) !== 0
      ? Number(row.value_usd) / Number(row.amount)
      : null;
  if (derivedPriceUsd == null) return null;
  const sampledAt = row.sampled_at instanceof Date ? row.sampled_at : new Date(row.sampled_at);
  const sampledAtMs = sampledAt.getTime();
  if (Date.now() - sampledAtMs > MAX_PERSISTED_PRICE_AGE_MS) return null; // too old — not eligible
  const priceUsd = row.is_closed && row.asset_price_usd != null ? Number(row.asset_price_usd) : derivedPriceUsd;
  return { priceUsd, sampledAt: sampledAt.toISOString() };
}


/** The fallback reader on the api's own pool. */
export const dbPersistedFallbackReader: WalletPriceReader = persistedFallbackReader((symbol) => recentPersistedPrice(sql, symbol));
