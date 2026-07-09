-- Projects data pipelines (issue #87). Issue #70/PR #74 ported the 0013 projects
-- SCHEMA + read projection only; none of the ~25 legacy bot-analytics edge
-- functions that POPULATE these tables were ported, so prod /projects ran against
-- empty tables. This migration extends the 0013 schema with the columns and
-- snapshot tables the ported pipelines need (market refresh, revenue sync, daily
-- snapshots, vault data, discovery, enrichment, coverage scoring), mirroring the
-- legacy Supabase columns those transforms read/write.
--
-- Forward-only, applied once, tracked in schema_migrations. Every statement is
-- guarded (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so re-running on every boot
-- is safe and byte-stable. Purely additive: no existing column is dropped or
-- retyped, so the shipped #70 projection + /api/projects contract stay intact.

-- ── Coin facet: provider identity + refreshed market fields ──────────────────
-- coingecko_id / contract_address / chain select the market-refresh provider
-- (CoinGecko for listed coins, DexScreener best-pair for on-chain-only tokens);
-- price_usd / volume_24h / refreshed_at are written by projects.refresh_coins.
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS coingecko_id     text;
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS contract_address text;
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS chain            text;
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS price_usd        numeric;
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS volume_24h       numeric;
ALTER TABLE lobster_coins ADD COLUMN IF NOT EXISTS refreshed_at     timestamptz;

-- ── Agent facet: revenue-source identity + coverage inputs ───────────────────
-- wallet_address / virtuals_agent_id resolve the DexScreener token for the
-- Virtuals fee-revenue sync; x402_volume_usd feeds the x402 rollup; the rest are
-- coverage-score inputs the legacy compute_project_coverage() read.
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS wallet_address        text;
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS virtuals_agent_id     text;
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS x402_volume_usd       numeric;
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS cumulative_revenue_usd numeric;
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS productivity_score    numeric;
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS source_confidence     text;  -- high | medium | low
ALTER TABLE openclaw_agents ADD COLUMN IF NOT EXISTS enriched_at           timestamptz;

-- ── Wallet facet: on-chain address + activity recency (coverage input) ───────
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS address    text;
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS last_tx_at timestamptz;
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS refreshed_at timestamptz;

-- ── Vault facet: on-chain read config + refreshed TVL/yield ──────────────────
-- data_source='live' + strategy_type/protocol select the ERC-4626 totalAssets()
-- read vs the DexScreener-LP fallback in projects.fetch_vaults.
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS vault_address      text;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS protocol           text;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS data_source        text;  -- live | static
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS chain              text;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS strategy_type      text;  -- erc4626 | lp
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS tvl_usd            numeric;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS yield_apy          numeric;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS refreshed_at       timestamptz;
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS last_refresh_status text;

-- ── Project identity: enrichment + coverage bookkeeping ──────────────────────
-- The four sub-scores + resolved_at/coverage_calculated_at mirror the columns
-- the legacy compute_project_coverage() / resolve_project_identity() wrote.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS breadth_score         smallint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS identity_score        smallint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS onchain_score         smallint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS activity_score        smallint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS coverage_calculated_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS resolved_at           timestamptz;

-- ── Coin snapshot: additive market columns (sparkline already reads price_usd) ─
ALTER TABLE daily_coin_snapshots ADD COLUMN IF NOT EXISTS market_cap numeric;
ALTER TABLE daily_coin_snapshots ADD COLUMN IF NOT EXISTS volume_24h numeric;

-- ── Facet natural keys so discovery UPSERTS are idempotent AND row-id-stable ──
-- Discovery re-runs must UPDATE the same facet row (not delete/re-insert) so the
-- daily-snapshot / revenue rows that reference agent_id / coin_id by FK survive.
-- project_id is nullable but always set on discovered facets, so these are the
-- ON CONFLICT targets for the discovery upsert.
CREATE UNIQUE INDEX IF NOT EXISTS openclaw_agents_project_name_idx  ON openclaw_agents (project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS lobster_coins_project_name_idx    ON lobster_coins (project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS tracked_wallets_project_label_idx ON tracked_wallets (project_id, label);
CREATE UNIQUE INDEX IF NOT EXISTS agent_vaults_project_name_idx     ON agent_vaults (project_id, name);

-- ── New daily snapshot tables (7-day-history coverage inputs + x402 rollup) ──
-- Per-agent daily x402 volume / txn / productivity. sync_revenue rolls the
-- trailing-30d x402_volume_usd up into agent_revenue_daily (source='x402').
CREATE TABLE IF NOT EXISTS daily_agent_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           uuid NOT NULL REFERENCES openclaw_agents(id) ON DELETE CASCADE,
  snapshot_date      date NOT NULL DEFAULT CURRENT_DATE,
  x402_volume_usd    numeric NOT NULL DEFAULT 0,
  x402_txn_count     integer NOT NULL DEFAULT 0,
  productivity_score numeric NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS daily_agent_snapshots_agent_date_idx ON daily_agent_snapshots (agent_id, snapshot_date);

-- Per-wallet daily balance snapshot (7-day-history coverage input).
CREATE TABLE IF NOT EXISTS daily_wallet_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         uuid NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  snapshot_date     date NOT NULL DEFAULT CURRENT_DATE,
  total_balance_usd numeric NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS daily_wallet_snapshots_wallet_date_idx ON daily_wallet_snapshots (wallet_id, snapshot_date);

-- Per-vault daily TVL snapshot (feeds a vault TVL history sparkline; coverage).
CREATE TABLE IF NOT EXISTS daily_tvl_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id      uuid NOT NULL REFERENCES agent_vaults(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  tvl_usd       numeric NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS daily_tvl_snapshots_vault_date_idx ON daily_tvl_snapshots (vault_id, snapshot_date);
