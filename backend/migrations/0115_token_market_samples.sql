-- compat: additive
-- metadata_version: 1
--
-- The token page's market reading, sampled by the worker and served by the api
-- (v0.6.0 release finding, 2026-10-08).
--
-- WHY. GET /api/dashboards/token-metrics (RM-156, src/chain/token-metrics.ts)
-- read ROBOTMONEY's and WETH's prices and the token pool's liquidity and volume
-- from GeckoTerminal on the api's request path. The api holds no CoinGecko key
-- (runbook R8.w: the key is in no api environment), so those reads went to the
-- keyless host, and on the production-shaped stage target they ran out of
-- retries on HTTP 429. The worker that holds the key now reads these values on
-- its schedule (src/worker/handlers/token-market.ts, run by the
-- wallet.sample_balances tick) and upserts them here. The api reads this row
-- and makes no GeckoTerminal call.
--
-- ONE ROW PER TOKEN, three legs. Each leg (the token's price, WETH's price, the
-- pool's reading) carries its own `*_at`, the instant the worker last read it.
-- A leg whose read failed leaves its columns as they were, so a 429 keeps the
-- last good reading with its true age; the api refuses a reading older than its
-- bound and serves null. A value is never written without its timestamp.
--
-- NOT A LEDGER. This is the latest value of a vendor reading for one web page,
-- not analytics data: D56's ledger rules do not apply, and no history is kept.
--
-- GRANTS. rm_worker writes it (INSERT ... ON CONFLICT DO UPDATE), so it needs
-- INSERT and UPDATE; SELECT it already holds through 0062's default. rm_app
-- reads it through the default the reconciliation (schema/grants.sql) restores.
-- No DELETE or TRUNCATE (D55 (6)).
--
-- ADDITIVE and IDEMPOTENT: a new table, created only if absent; a GRANT already
-- held is a no-op (tests/prod-baseline.test.ts re-applies the newest migration).

CREATE TABLE IF NOT EXISTS token_market_samples (
  token           text        NOT NULL,
  price_usd       numeric,
  price_at        timestamptz,
  weth_usd        numeric,
  weth_at         timestamptz,
  liquidity_usd   numeric,
  volume_24h_usd  numeric,
  volume_30d_usd  numeric,
  pool_at         timestamptz,
  sampled_at      timestamptz NOT NULL,
  CONSTRAINT token_market_samples_pkey PRIMARY KEY (token),
  CONSTRAINT token_market_samples_price_usd_check CHECK (price_usd > 0),
  CONSTRAINT token_market_samples_weth_usd_check CHECK (weth_usd > 0),
  CONSTRAINT token_market_samples_liquidity_usd_check CHECK (liquidity_usd >= 0),
  CONSTRAINT token_market_samples_volume_24h_usd_check CHECK (volume_24h_usd >= 0),
  CONSTRAINT token_market_samples_volume_30d_usd_check CHECK (volume_30d_usd >= 0),
  CONSTRAINT token_market_samples_price_at_check CHECK ((price_usd IS NULL) = (price_at IS NULL)),
  CONSTRAINT token_market_samples_weth_at_check CHECK ((weth_usd IS NULL) = (weth_at IS NULL))
);

GRANT INSERT, UPDATE ON token_market_samples TO rm_worker;
