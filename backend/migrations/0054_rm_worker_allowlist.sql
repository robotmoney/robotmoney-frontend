-- Replace 0016's broad/default worker grant with an explicit current-table
-- allow-list.  Future tables start inaccessible to rm_worker.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rm_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rm_worker;
GRANT USAGE ON SCHEMA public TO rm_worker;

-- The worker reads projections and configuration, but only these tables are
-- writable by queue/sampler handlers in src/worker/**.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rm_worker;
GRANT INSERT, UPDATE, DELETE ON
  jobs, job_runs, job_schedules,
  vault_share_price_history, vault_adapter_samples,
  wallet_balance_samples, wallet_sleeve_samples,
  projects, openclaw_agents, lobster_coins, tracked_wallets, agent_vaults,
  agent_revenue_daily, daily_coin_snapshots, daily_agent_snapshots,
  daily_wallet_snapshots, daily_tvl_snapshots
TO rm_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rm_worker;
