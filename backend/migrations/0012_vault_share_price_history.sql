-- Hourly vault share-price samples backing the live vault-economics APY
-- calculation (issue #40). The worker's `vault.sample_share_price` job (hourly
-- job_schedules cron) reads the vault via Base JSON-RPC and upserts ONE row
-- per (vault_address, sample_hour) — the natural key below — so a retried or
-- overlapping run within the same hour never duplicates a slot, matching the
-- upsert-on-natural-key convention used throughout this schema (see the header
-- comment on 0002_dashboards.sql).
--
-- `total_supply = 0` is stored as-is (never divided); `share_price` is NULL in
-- that case rather than fabricated. This table is intentionally separate from
-- the pre-existing, still-unused `vault_tvl`/`vault_apy` tables (0002): those
-- model a per-asset snapshot row shape that doesn't fit "exactly one row per
-- sampler run" (an acceptance criterion here), so repurposing them would force
-- an awkward multi-row-per-sample encoding. They are left untouched.
CREATE TABLE vault_share_price_history (
  id            bigserial PRIMARY KEY,
  vault_address text NOT NULL,
  sample_hour   timestamptz NOT NULL, -- date_trunc('hour', sampled_at) — the upsert slot
  sampled_at    timestamptz NOT NULL DEFAULT now(),
  total_assets  numeric NOT NULL, -- raw on-chain units (6-decimal USDC)
  total_supply  numeric NOT NULL, -- raw on-chain units (6-decimal, mirrors asset decimals)
  share_price   numeric, -- total_assets / total_supply; NULL iff total_supply = 0
  UNIQUE (vault_address, sample_hour)
);
CREATE INDEX vault_share_price_history_vault_hour_idx
  ON vault_share_price_history (vault_address, sample_hour);
