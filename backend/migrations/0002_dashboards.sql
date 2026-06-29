-- Dashboard time-series. The worker upserts on natural unique keys so re-running
-- a scheduled slot overwrites rather than duplicates. The API reads these.

CREATE TABLE vault_tvl (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL,
  vault_address     text NOT NULL,
  asset_symbol      text NOT NULL,
  asset_name        text,
  balance           numeric,
  price_usd         numeric,
  value_usd         numeric,
  total_vault_value numeric,
  total_shares      numeric,
  share_price       numeric,
  UNIQUE (ts, vault_address, asset_symbol)
);
CREATE INDEX vault_tvl_ts_idx ON vault_tvl (ts);

CREATE TABLE wallet_balances (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL,
  wallet_address text NOT NULL,
  chain          text NOT NULL,
  asset_symbol   text NOT NULL,
  asset_name     text,
  balance        numeric,
  price_usd      numeric,
  value_usd      numeric,
  UNIQUE (ts, wallet_address, asset_symbol)
);
CREATE INDEX wallet_balances_ts_idx ON wallet_balances (ts);

CREATE TABLE prices (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL,
  symbol    text NOT NULL,
  price_usd numeric,
  source    text,
  UNIQUE (ts, symbol)
);
CREATE INDEX prices_ts_idx ON prices (ts);

CREATE TABLE vault_apy (
  date        date PRIMARY KEY,
  apy_7d      numeric,
  apy_30d     numeric,
  share_price numeric,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE regime_snapshots (
  date                 date PRIMARY KEY,
  composite            numeric,
  composite_percentile numeric,
  regime               text,
  macro_regime         text,
  onchain_regime       text,
  factor_regime        text,
  percentiles          jsonb,
  indicators           jsonb
);

CREATE TABLE regime_indicators (
  id            bigserial PRIMARY KEY,
  indicator_key text NOT NULL,
  date          date NOT NULL,
  value         numeric,
  source        text,
  UNIQUE (indicator_key, date)
);
CREATE INDEX regime_indicators_key_date_idx ON regime_indicators (indicator_key, date);

CREATE TABLE research_signals (
  id         bigserial PRIMARY KEY,
  signal_key text NOT NULL,
  date       date NOT NULL,
  payload    jsonb,
  UNIQUE (signal_key, date)
);
