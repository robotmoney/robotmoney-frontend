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

