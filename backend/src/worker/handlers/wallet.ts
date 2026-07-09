// Daily prop-wallet balance sampler + one-time history backfill (issue #84).
// Feeds the continuous /performance series and the last-live fallback that the
// per-leg degrade path in chain/wallet-balances.ts reads.
//
// sampleWalletBalances: reads every prop wallet live (Base RPC + keyless prices)
// and UPSERTS one row per tracked asset keyed by (sample_date, symbol) — the
// natural key from migration 0014 — so a retried or catch-up run on the same UTC
// day never duplicates a slot (idempotency, day-boundary = UTC calendar day).
//
// backfillWalletHistory: idempotently seeds the pre-launch series carried
// forward from the baked views.js data (chain/wallet-history-seed.ts). Run from
// db/seed.ts as part of `bun run migrate`.
import { sql } from "../../db/client.ts";
import { fetchWalletBalances, _resetWalletBalancesCacheForTests } from "../../chain/wallet-balances.ts";
import { walletHistorySeedRows } from "../../chain/wallet-history-seed.ts";

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

// Idempotent backfill of the pre-launch history. ON CONFLICT DO NOTHING so a
// later live sample for the same (date, symbol) is never clobbered by a re-run.
// Rows are labelled provenance 'seed' — these are ported baked UI constants
// (chain/wallet-history-seed.ts), not live chain reads, so they must NEVER carry
// 'live' (honesty invariant, migration 0014_wallet_balance_samples.sql).
export async function backfillWalletHistory(): Promise<number> {
  const rows = walletHistorySeedRows();
  for (const r of rows) {
    await sql`
      INSERT INTO wallet_balance_samples
        (sample_date, symbol, amount, price_usd, value_usd, provenance)
      VALUES
        (${r.date}, ${r.symbol}, NULL, NULL, ${r.valueUsd}, 'seed')
      ON CONFLICT (sample_date, symbol) DO NOTHING
    `;
  }
  return rows.length;
}
