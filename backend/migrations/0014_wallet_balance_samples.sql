-- Daily prop-wallet balance samples backing the live allocation/performance
-- feed (issue #84). Replaces the baked static snapshot that used to live in the
-- frontend (WALLET_SNAPSHOT_TOTAL_USD + walletPerfView's 99-day series in
-- alpine/views.js). The wallet.sample_balances worker reads each prop wallet via
-- Base JSON-RPC + keyless prices and upserts ONE row per (sample_date, symbol) —
-- the natural key below — so a retried or catch-up run on the same UTC day never
-- duplicates a slot, matching the upsert-on-natural-key convention used
-- throughout this schema (see 0012_vault_share_price_history.sql / 0002).
--
-- History is continuous by construction: a one-time backfill (db/seed.ts, gated
-- ON CONFLICT DO NOTHING) seeds the pre-launch series carried forward from the
-- baked views.js data, then the daily sampler accumulates new rows forward.
-- Gap-free per-day balance reconstruction across the pre-launch window would
-- need an archive indexer (explicitly out of scope for #84) — the seeded rows
-- ARE that carried-forward history.
--
-- Provenance mirrors chain/vault-economics.ts (#50): 'live' = a real Base
-- JSON-RPC + price read; 'stub' = the hermetic BASE_RPC_SOURCE=stub fixture;
-- 'stale' = a leg that failed live and degraded to its last-persisted value.
-- A value is NEVER fabricated or falsely labelled 'live'.
CREATE TABLE wallet_balance_samples (
  id           bigserial PRIMARY KEY,
  sample_date  date NOT NULL,          -- UTC calendar day — the upsert slot
  symbol       text NOT NULL,          -- one of the eight tracked-asset labels
  amount       numeric,                -- token amount (nullable: null for a seeded/degraded row with no quantity)
  price_usd    numeric,                -- USD unit price at sample time (nullable)
  value_usd    numeric NOT NULL,       -- amount * price_usd (or config-size * price for SP500)
  provenance   text NOT NULL DEFAULT 'live', -- 'live' | 'stub' | 'stale'
  sampled_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sample_date, symbol)
);
CREATE INDEX wallet_balance_samples_symbol_date_idx
  ON wallet_balance_samples (symbol, sample_date);
