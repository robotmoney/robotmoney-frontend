-- Per-wallet sleeve holdings samples and per-adapter vault balance samples (issue #294).
-- Postgres becomes the indexer of record for every /allocation field.
-- Scheduled worker jobs (wallet.sample_sleeves, vault.sample_adapters) populate
-- these tables; GET /api/dashboards/wallet-sleeves and GET /api/dashboards/vault-economics
-- read from them with ZERO RPC on the request path.

CREATE TABLE wallet_sleeve_samples (
  id             bigserial PRIMARY KEY,
  sample_date    date NOT NULL,          -- UTC calendar day — the upsert slot
  wallet_address text NOT NULL,
  symbol         text NOT NULL,
  amount         numeric,                -- token amount (nullable)
  price_usd      numeric,                -- USD unit price at sample time (nullable)
  value_usd      numeric,                -- amount * price_usd (nullable)
  provenance     text NOT NULL DEFAULT 'live', -- 'live' | 'stub' | 'stale' | 'seed'
  sampled_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sample_date, wallet_address, symbol)
);
CREATE INDEX wallet_sleeve_samples_wallet_sym_date_idx
  ON wallet_sleeve_samples (wallet_address, symbol, sample_date);

CREATE TABLE vault_adapter_samples (
  id              bigserial PRIMARY KEY,
  vault_address   text NOT NULL,
  adapter_address text NOT NULL,
  adapter_name    text NOT NULL,
  sample_hour     timestamptz NOT NULL,  -- date_trunc('hour', sampled_at) — the upsert slot
  balance_usd     numeric,                -- total adapter balance in USD (nullable)
  configured      boolean NOT NULL DEFAULT true,
  provenance      text NOT NULL DEFAULT 'live', -- 'live' | 'stub' | 'stale' | 'seed'
  sampled_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_address, adapter_address, sample_hour)
);
CREATE INDEX vault_adapter_samples_vault_adapter_hour_idx
  ON vault_adapter_samples (vault_address, adapter_address, sample_hour);
