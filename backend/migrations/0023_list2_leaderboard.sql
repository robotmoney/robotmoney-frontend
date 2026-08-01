-- List v2 + Money-Agent Leaderboard feeds (issue #387,
-- docs/bot-analytics-ui-port-plan.md §5.2/§5.3, P2.6/P2.7). Purely additive
-- columns the two projections read; no existing column is dropped or
-- retyped, so every shipped facet DTO (issue #70/#346/#384) stays intact.
--
-- Forward-only, applied once, tracked in schema_migrations. Guarded
-- (ADD COLUMN IF NOT EXISTS) so re-running on every boot is safe.

-- Vault facet: last on-chain rebalance timestamp (§5.2 Vaults tab
-- "REBALANCED" column). No writer populates this yet — reads honestly as
-- NULL ("—" in the UI) until a rebalance-tracking job exists, matching the
-- honesty contract (#98/#346): never fabricate a rebalance time.
ALTER TABLE agent_vaults ADD COLUMN IF NOT EXISTS last_rebalance_at timestamptz;

-- Wallet facet: coarse category (agent | treasury | multisig | other), §5.2
-- Wallets tab "CATEGORY" column. NULL renders as "—" until discovery/
-- enrichment classifies a wallet.
ALTER TABLE tracked_wallets ADD COLUMN IF NOT EXISTS category text;
