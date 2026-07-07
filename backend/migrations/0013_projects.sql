-- Projects analytics (issue #70): the "Agentic Economy Ecosystem" directory ported
-- off the deprecated Supabase stack (robotmoney-bot-analytics src/pages/Projects.tsx)
-- onto the new Postgres backend. One `projects` identity row ties together its
-- facet rows (agent, coin, wallet, vault); the API (/api/projects) aggregates the
-- facets, 30d revenue, and a 30d price sparkline into the directory table.
--
-- Forward-only, applied once, tracked in schema_migrations. Idempotent guards
-- (IF NOT EXISTS) so it is safe to re-run on every boot. Ingestion that POPULATES
-- these tables is explicitly out of scope for #70 — a fresh deploy has empty
-- tables and the endpoint returns `{ projects: [] }`.

-- Unified project identity. Columns mirror the Supabase `projects` table read by
-- the ported Projects.tsx query (display/logo/description/overview_*, canonical
-- social + website, live-recomputed has_* facet flags, data_coverage_score, and
-- the first-load sticky pin).
CREATE TABLE IF NOT EXISTS projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE,
  display_name        text NOT NULL DEFAULT '',
  logo_url            text,
  description         text,
  overview_short      text,
  overview_long       text,
  website_url         text,
  twitter_handle      text,
  data_coverage_score smallint,
  has_agent           boolean NOT NULL DEFAULT false,
  has_coin            boolean NOT NULL DEFAULT false,
  has_wallet          boolean NOT NULL DEFAULT false,
  has_vault           boolean NOT NULL DEFAULT false,
  is_sticky           boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'active', -- active | pending_review | inactive
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_status_score_idx ON projects (status, data_coverage_score DESC);

-- Agent facet. `protocol_standard` + the x402_* counters drive the live X402 flag
-- (protocol_standard='x402' OR any counter > 0). `project_id` links to the owner.
CREATE TABLE IF NOT EXISTS openclaw_agents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid REFERENCES projects(id) ON DELETE SET NULL,
  name                  text NOT NULL DEFAULT '',
  protocol_standard     text,
  x402_score            numeric,
  x402_txn_count        integer,
  x402_resources_count  integer,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openclaw_agents_project_idx ON openclaw_agents (project_id);

-- Coin facet. Multi-token projects list each coin on its own row; the directory
-- sorts by the MAX market cap / FDV across a project's coins.
CREATE TABLE IF NOT EXISTS lobster_coins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  name                text NOT NULL DEFAULT '',
  ticker              text,
  market_cap          numeric,
  fdv                 numeric,
  percent_change_24h  numeric,
  logo_url            text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lobster_coins_project_idx ON lobster_coins (project_id);

-- Vault facet (presence only for the directory's VLT flag).
CREATE TABLE IF NOT EXISTS agent_vaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  name        text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_vaults_project_idx ON agent_vaults (project_id);

-- Wallet facet. The directory sums balance_usd across a project's active wallets
-- and shows a per-wallet breakdown on hover.
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  label        text NOT NULL DEFAULT '',
  chain        text,
  balance_usd  numeric,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracked_wallets_project_idx ON tracked_wallets (project_id);

-- Per-agent daily revenue. The directory sums the trailing 30 days per project.
CREATE TABLE IF NOT EXISTS agent_revenue_daily (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES openclaw_agents(id) ON DELETE CASCADE,
  revenue_date  date NOT NULL DEFAULT CURRENT_DATE,
  revenue_usd   numeric NOT NULL DEFAULT 0,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, revenue_date, source)
);
CREATE INDEX IF NOT EXISTS agent_revenue_daily_agent_date_idx ON agent_revenue_daily (agent_id, revenue_date);

-- Per-coin daily price snapshot. The directory draws a 30d sparkline for a
-- project's primary coin from the trailing snapshots (one point per UTC day).
CREATE TABLE IF NOT EXISTS daily_coin_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id        uuid NOT NULL REFERENCES lobster_coins(id) ON DELETE CASCADE,
  snapshot_date  date NOT NULL DEFAULT CURRENT_DATE,
  price_usd      numeric NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coin_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS daily_coin_snapshots_coin_date_idx ON daily_coin_snapshots (coin_id, snapshot_date);
