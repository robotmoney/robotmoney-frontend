// Projects pipeline handlers (issue #87). Ports the six deprecated bot-analytics
// edge-function buckets onto the kind→handler worker pattern:
//   projects.discover          ← discover-agents/virtuals/acp/wallets
//   projects.refresh_coins     ← refresh-lobster-coins (CoinGecko + DexScreener)
//   projects.refresh_wallets   ← refresh-wallet-balances
//   projects.sync_revenue      ← sync-agent-revenue-virtuals + -x402
//   projects.snapshot_daily    ← snapshot-daily
//   projects.fetch_vaults      ← fetch-vault-data
//   projects.recompute_coverage← resolve_project_identity + compute_project_coverage
//
// Each handler pulls provider payloads through the data-source seam
// (projects/access) and applies the pure transforms (projects/transforms.ts).
// DEGRADE-TO-PERSISTED: every extractor call is done BEFORE any write; if it
// throws, the handler logs loudly, writes NOTHING (last-persisted rows stay
// intact), and returns a non-success status ({ ok:false, status:"degraded" }).
// Nothing on the path is fabricated. All writes upsert on natural keys so a
// re-run never duplicates rows.
import { sql } from "../../db/worker-client.ts";
import { on, registerQuery } from "../../db/registry.ts";

// Every statement here is a job handler's, so it runs as rm_worker and the
// handler module is its own entry (worker/handlers/ is the entry directory).
const HANDLER = ["src/worker/handlers/projects"];

const activeProjects = registerQuery({
  role: "rm_worker",
  object: "projects",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:discover.activeCount",
  purpose: "Count the projects a previous discovery run left live, before the upserts.",
  callers: HANDLER,
  probe: {
    statement: `SELECT count(*)::int AS n FROM projects WHERE status = 'active' AND resolved_at IS NOT NULL`,
  },
});

const upsertProjects = registerQuery({
  role: "rm_worker",
  object: "projects",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.upsertProjects",
  purpose: "Upsert the discovered project identities on their slug, leaving the admin-managed overview text alone.",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO projects (slug, display_name, description, overview_short, logo_url, website_url,
                              twitter_handle, is_sticky, status, resolved_at)
        SELECT s, dn, de, de, lu, wu, th, st::boolean, 'active', $1::timestamptz
          FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(s, dn, de, lu, wu, th, st)
        ON CONFLICT (slug) DO UPDATE SET
          display_name = EXCLUDED.display_name, description = EXCLUDED.description,
          logo_url = EXCLUDED.logo_url, website_url = EXCLUDED.website_url, twitter_handle = EXCLUDED.twitter_handle,
          is_sticky = EXCLUDED.is_sticky, status = 'active', resolved_at = EXCLUDED.resolved_at, updated_at = now()
        RETURNING id, slug`,
    params: ["2000-01-01T00:00:00Z", "{}", "{}", "{}", "{}", "{}", "{}", "{}"],
  },
});

const upsertAgents = registerQuery({
  role: "rm_worker",
  object: "openclaw_agents",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.upsertAgents",
  purpose: "Upsert the discovered agent facets on (project, name).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO openclaw_agents (project_id, name, protocol_standard, wallet_address, virtuals_agent_id,
          x402_score, x402_txn_count, x402_resources_count, x402_volume_usd, productivity_score,
          source_confidence, enriched_at)
        SELECT p::uuid, n, ps, wa, va, xs::numeric, xt::integer, xr::integer, xv::numeric, prod::numeric, sc, $1::timestamptz
          FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
               AS t(p, n, ps, wa, va, xs, xt, xr, xv, prod, sc)
        ON CONFLICT (project_id, name) DO UPDATE SET
          protocol_standard = EXCLUDED.protocol_standard, wallet_address = EXCLUDED.wallet_address,
          virtuals_agent_id = EXCLUDED.virtuals_agent_id, x402_score = EXCLUDED.x402_score,
          x402_txn_count = EXCLUDED.x402_txn_count, x402_resources_count = EXCLUDED.x402_resources_count,
          x402_volume_usd = EXCLUDED.x402_volume_usd, productivity_score = EXCLUDED.productivity_score,
          source_confidence = EXCLUDED.source_confidence, enriched_at = EXCLUDED.enriched_at`,
    params: ["2000-01-01T00:00:00Z", "{}", "{}", "{}", "{}", "{}", "{}", "{}", "{}", "{}", "{}", "{}"],
  },
});

const upsertCoins = registerQuery({
  role: "rm_worker",
  object: "lobster_coins",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.upsertCoins",
  purpose: "Upsert the discovered coin facets on (project, name).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO lobster_coins (project_id, name, ticker, coingecko_id, contract_address, chain)
        SELECT p::uuid, n, tk, cg, ca, ch
          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(p, n, tk, cg, ca, ch)
        ON CONFLICT (project_id, name) DO UPDATE SET
          ticker = EXCLUDED.ticker, coingecko_id = EXCLUDED.coingecko_id,
          contract_address = EXCLUDED.contract_address, chain = EXCLUDED.chain`,
    params: ["{}", "{}", "{}", "{}", "{}", "{}"],
  },
});

const upsertWallets = registerQuery({
  role: "rm_worker",
  object: "tracked_wallets",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.upsertWallets",
  purpose: "Upsert the discovered wallet facets on (project, label).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO tracked_wallets (project_id, label, chain, address)
        SELECT p::uuid, l, ch, ad
          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
               AS t(p, l, ch, ad)
        ON CONFLICT (project_id, label) DO UPDATE SET chain = EXCLUDED.chain, address = EXCLUDED.address`,
    params: ["{}", "{}", "{}", "{}"],
  },
});

const upsertVaults = registerQuery({
  role: "rm_worker",
  object: "agent_vaults",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.upsertVaults",
  purpose: "Upsert the discovered vault facets on (project, name).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, protocol, data_source)
        SELECT p::uuid, n, va, ch, st, pr, ds
          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(p, n, va, ch, st, pr, ds)
        ON CONFLICT (project_id, name) DO UPDATE SET
          vault_address = EXCLUDED.vault_address, chain = EXCLUDED.chain, strategy_type = EXCLUDED.strategy_type,
          protocol = EXCLUDED.protocol, data_source = EXCLUDED.data_source`,
    params: ["{}", "{}", "{}", "{}", "{}", "{}", "{}"],
  },
});

const deactivateProjects = registerQuery({
  role: "rm_worker",
  object: "projects",
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:discover.deactivate",
  purpose: "Mark projects a trusted discovery run no longer lists as inactive, never deleting them.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE projects SET status = 'inactive', updated_at = now()
         WHERE status = 'active' AND resolved_at IS NOT NULL AND NOT (slug = ANY($1::text[]))
        RETURNING id`,
    params: ["{}"],
  },
});

const selectCoins = registerQuery({
  role: "rm_worker",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:refreshCoins.select",
  purpose: "Read the active coins to refresh.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, coingecko_id, contract_address, chain FROM lobster_coins WHERE is_active = true`,
  },
});

const updateCoin = registerQuery({
  role: "rm_worker",
  object: "lobster_coins",
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:refreshCoins.update",
  purpose: "Write a coin's refreshed market fields.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE lobster_coins SET
        price_usd = $1::numeric, market_cap = $2::numeric, fdv = $3::numeric,
        volume_24h = $4::numeric, percent_change_24h = $5::numeric, refreshed_at = now()
        WHERE id = $6::uuid`,
    params: [1, 1, 1, 1, 1, "00000000-0000-0000-0000-000000000000"],
  },
});

const selectWallets = registerQuery({
  role: "rm_worker",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:refreshWallets.select",
  purpose: "Read the active wallets that have an address.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, address, chain FROM tracked_wallets WHERE is_active = true AND address IS NOT NULL`,
  },
});

const updateWallet = registerQuery({
  role: "rm_worker",
  object: "tracked_wallets",
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:refreshWallets.update",
  purpose: "Write a wallet's refreshed balance.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE tracked_wallets SET balance_usd = $1::numeric, last_tx_at = now(), refreshed_at = now() WHERE id = $2::uuid`,
    params: [1, "00000000-0000-0000-0000-000000000000"],
  },
});

const selectVirtualsAgents = registerQuery({
  role: "rm_worker",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:syncRevenue.virtualsAgents",
  purpose: "Read the active agents whose revenue comes from Virtuals.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, virtuals_agent_id, wallet_address FROM openclaw_agents
    WHERE is_active = true AND (protocol_standard = 'virtuals' OR virtuals_agent_id IS NOT NULL)`,
  },
});

const selectAgentSnapshots = registerQuery({
  role: "rm_worker",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:syncRevenue.agentSnapshots",
  purpose: "Read the trailing daily agent snapshots the x402 revenue rollup sums.",
  callers: HANDLER,
  probe: {
    statement: `SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd
    FROM daily_agent_snapshots WHERE snapshot_date >= $1::date`,
    params: ["2000-01-01"],
  },
});

const upsertRevenue = registerQuery({
  role: "rm_worker",
  object: "agent_revenue_daily",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:syncRevenue.upsert",
  purpose: "Upsert an agent's daily revenue rows on (agent, date, source).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO agent_revenue_daily (agent_id, revenue_date, revenue_usd, source)
      SELECT $1::uuid, $2::date, $3::numeric, $4 WHERE false
      ON CONFLICT (agent_id, revenue_date, source) DO UPDATE SET revenue_usd = EXCLUDED.revenue_usd`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1, "probe"],
  },
});

const selectCoinsToSnapshot = registerQuery({
  role: "rm_worker",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.coins",
  purpose: "Read the active coins to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, price_usd, market_cap, volume_24h FROM lobster_coins WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertCoinSnapshots = registerQuery({
  role: "rm_worker",
  object: "daily_coin_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.upsertCoinSnapshots",
  purpose: "Upsert today's coin snapshots on (coin, date).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO daily_coin_snapshots (coin_id, snapshot_date, price_usd, market_cap, volume_24h)
        SELECT $1::uuid, $2::date, $3::numeric, $4::numeric, $5::numeric WHERE false
        ON CONFLICT (coin_id, snapshot_date) DO UPDATE SET
          price_usd = EXCLUDED.price_usd, market_cap = EXCLUDED.market_cap, volume_24h = EXCLUDED.volume_24h`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1, 1, 1],
  },
});

const selectAgentsToSnapshot = registerQuery({
  role: "rm_worker",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.agents",
  purpose: "Read the active agents to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, x402_volume_usd, x402_txn_count, productivity_score FROM openclaw_agents WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertAgentSnapshots = registerQuery({
  role: "rm_worker",
  object: "daily_agent_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.upsertAgentSnapshots",
  purpose: "Upsert today's agent snapshots on (agent, date).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO daily_agent_snapshots (agent_id, snapshot_date, x402_volume_usd, x402_txn_count, productivity_score)
        SELECT $1::uuid, $2::date, $3::numeric, $4::integer, $5::numeric WHERE false
        ON CONFLICT (agent_id, snapshot_date) DO UPDATE SET
          x402_volume_usd = EXCLUDED.x402_volume_usd, x402_txn_count = EXCLUDED.x402_txn_count,
          productivity_score = EXCLUDED.productivity_score`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1, 1, 1],
  },
});

const selectWalletsToSnapshot = registerQuery({
  role: "rm_worker",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.wallets",
  purpose: "Read the active wallets to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, balance_usd FROM tracked_wallets WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertWalletSnapshots = registerQuery({
  role: "rm_worker",
  object: "daily_wallet_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.upsertWalletSnapshots",
  purpose: "Upsert today's wallet snapshots on (wallet, date).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO daily_wallet_snapshots (wallet_id, snapshot_date, total_balance_usd)
        SELECT $1::uuid, $2::date, $3::numeric WHERE false
        ON CONFLICT (wallet_id, snapshot_date) DO UPDATE SET total_balance_usd = EXCLUDED.total_balance_usd`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1],
  },
});

const selectVaultsToSnapshot = registerQuery({
  role: "rm_worker",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.vaults",
  purpose: "Read the active vaults to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, tvl_usd FROM agent_vaults WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertTvlSnapshots = registerQuery({
  role: "rm_worker",
  object: "daily_tvl_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:snapshotDaily.upsertTvlSnapshots",
  purpose: "Upsert today's vault TVL snapshots on (vault, date).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd)
        SELECT $1::uuid, $2::date, $3::numeric WHERE false
        ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1],
  },
});

const selectLiveVaults = registerQuery({
  role: "rm_worker",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:fetchVaults.select",
  purpose: "Read the active live vaults that have an address.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, vault_address, chain, strategy_type, protocol FROM agent_vaults
    WHERE is_active = true AND data_source = 'live' AND vault_address IS NOT NULL`,
  },
});

const updateVault = registerQuery({
  role: "rm_worker",
  object: "agent_vaults",
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:fetchVaults.update",
  purpose: "Write a vault's refreshed TVL and refresh status.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE agent_vaults SET tvl_usd = $1::numeric, refreshed_at = now(),
        last_refresh_status = $2 WHERE id = $3::uuid`,
    params: [1, "ok", "00000000-0000-0000-0000-000000000000"],
  },
});

const upsertVaultTvl = registerQuery({
  role: "rm_worker",
  object: "daily_tvl_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:fetchVaults.upsertTvl",
  purpose: "Upsert a vault's TVL snapshot for today on (vault, date).",
  callers: HANDLER,
  probe: {
    statement: `INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd)
        SELECT $1::uuid, $2::date, $3::numeric WHERE false
        ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01", 1],
  },
});

const COVERAGE_PROBE = {
  statement: `    SELECT
      p.id, p.logo_url, p.description, p.twitter_handle, p.website_url, p.display_name, p.slug, p.resolved_at,
      EXISTS(SELECT 1 FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS has_agent,
      EXISTS(SELECT 1 FROM lobster_coins  c WHERE c.project_id = p.id AND c.is_active) AS has_coin,
      EXISTS(SELECT 1 FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS has_wallet,
      EXISTS(SELECT 1 FROM agent_vaults   v WHERE v.project_id = p.id AND v.is_active) AS has_vault,
      (SELECT bool_or(COALESCE(productivity_score,0) > 0) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_prod,
      (SELECT bool_or(COALESCE(x402_txn_count,0) > 0 OR COALESCE(cumulative_revenue_usd,0) > 0) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_rev,
      (SELECT max(CASE source_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_conf,
      (SELECT bool_or(enriched_at IS NOT NULL) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_enriched,
      (SELECT bool_or(COALESCE(price_usd,0) > 0) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_price,
      (SELECT bool_or(COALESCE(market_cap,0) > 0) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_mcap,
      (SELECT bool_or(contract_address IS NOT NULL) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_contract,
      (SELECT bool_or(coingecko_id IS NOT NULL) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_cg,
      (SELECT bool_or(COALESCE(balance_usd,0) > 0) FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS w_bal,
      (SELECT bool_or(last_tx_at > now() - interval '90 days') FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS w_tx,
      (SELECT bool_or(COALESCE(tvl_usd,0) > 0) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_tvl,
      (SELECT bool_or(yield_apy IS NOT NULL) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_apy,
      (SELECT bool_or(vault_address IS NOT NULL) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_addr,
      COALESCE((SELECT count(*) FROM daily_agent_snapshots s JOIN openclaw_agents a ON a.id = s.agent_id WHERE a.project_id = p.id), 0) >= 7 AS h_agent,
      COALESCE((SELECT count(*) FROM daily_coin_snapshots s JOIN lobster_coins c ON c.id = s.coin_id WHERE c.project_id = p.id), 0) >= 7 AS h_coin,
      COALESCE((SELECT count(*) FROM daily_wallet_snapshots s JOIN tracked_wallets w ON w.id = s.wallet_id WHERE w.project_id = p.id), 0) >= 7 AS h_wallet
    FROM projects p WHERE ($1::uuid[] IS NULL OR p.id = ANY($1::uuid[]))`,
  params: [null],
} as const;

const projectsRead = registerQuery({
  role: "rm_worker",
  object: "projects",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_projects",
  purpose: "Read projects for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageAgents = registerQuery({
  role: "rm_worker",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_openclaw_agents",
  purpose: "Read openclaw_agents for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageCoins = registerQuery({
  role: "rm_worker",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_lobster_coins",
  purpose: "Read lobster_coins for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageWallets = registerQuery({
  role: "rm_worker",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_tracked_wallets",
  purpose: "Read tracked_wallets for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageVaults = registerQuery({
  role: "rm_worker",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_agent_vaults",
  purpose: "Read agent_vaults for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageAgentSnaps = registerQuery({
  role: "rm_worker",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_daily_agent_snapshots",
  purpose: "Read daily_agent_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageCoinSnaps = registerQuery({
  role: "rm_worker",
  object: "daily_coin_snapshots",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_daily_coin_snapshots",
  purpose: "Read daily_coin_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageWalletSnaps = registerQuery({
  role: "rm_worker",
  object: "daily_wallet_snapshots",
  privileges: ["SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.read_daily_wallet_snapshots",
  purpose: "Read daily_wallet_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const updateCoverage = registerQuery({
  role: "rm_worker",
  object: "projects",
  privileges: ["UPDATE", "SELECT"],
  site: "src/worker/handlers/projects:recomputeCoverage.update",
  purpose: "Write a project's coverage scores and facet flags.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE projects SET
        has_agent = $1::boolean, has_coin = $2::boolean,
        has_wallet = $3::boolean, has_vault = $4::boolean,
        breadth_score = $5::smallint, identity_score = $6::smallint, onchain_score = $7::smallint,
        activity_score = $8::smallint, data_coverage_score = $9::smallint, coverage_calculated_at = now(), updated_at = now()
        WHERE id = $10::uuid`,
    params: [false, false, false, false, 1, 1, 1, 1, 1, "00000000-0000-0000-0000-000000000000"],
  },
});

import { declineReplayedSlot, isReplayedSlot } from "./slot.ts";
import { selectProjectsDataSource } from "../../projects/access/select.ts";
import type { DiscoveredProject, ProjectsDataSource } from "../../projects/access/data-source.ts";
import {
  coinGeckoFields,
  computeCoverage,
  coinSnapshotRow,
  dexScreenerBest,
  vaultTvlErc4626,
  virtualsRevenueRow,
  x402RevenueRows,
  type AgentSnapshot,
  type CoverageInputs,
  type RevenueRow,
  type SourceConfidence,
} from "../../projects/transforms.ts";

export interface HandlerResult {
  ok: boolean;
  status: "ok" | "degraded" | "skipped";
  [k: string]: unknown;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const since30 = (): string => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

function degraded(kind: string, err: unknown, extra: Record<string, unknown> = {}): HandlerResult {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[projects.${kind}] extractor failed — keeping last-persisted rows (degraded):`, message);
  return { ok: false, status: "degraded", error: message, ...extra };
}

// ── Discovery ────────────────────────────────────────────────────────────────

// resolved_at / enriched_at describe WHEN THE IDENTITY DATA WAS CAPTURED, not
// when this job last ran — the leaderboard's source-health panel
// (projects/leaderboard-projections.ts sourceHealth) reads enriched_at and
// calls a source "healthy" when it is within 36h. The live source serves a
// committed roster frozen at its manifest's generatedAt, so stamping now() on
// those rows every night would report a months-old dataset as fresh forever.
// A source that declares its as-of wins; one that does not (the hermetic
// fixture) falls back to wall-clock now, which for it is the truth.
export function resolveDiscoveryTimestamp(asOf: string | null | undefined, now: Date = new Date()): Date {
  if (asOf == null) return now;
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) {
    // Never silently substitute now() for an unparseable claim — that is how a
    // fabricated freshness gets in through the back door.
    throw new Error(`projects.discover: data source declared an unparseable discoveredAsOf ${JSON.stringify(asOf)}`);
  }
  return parsed;
}

// Rows are written in batched multi-row statements rather than one round trip
// per row: the real roster is 1,037 projects + 1,767 facets = 2,804 statements,
// and the analytics lane drains serially in a single worker, so at a managed
// database's RTT that transaction alone blocks every other projects.*/vault.*/
// wallet.* job for minutes. Chunked so no single statement approaches Postgres'
// 65,535 bind-parameter ceiling as the roster grows.
const UPSERT_CHUNK_ROWS = 400;

// Every unnest() column below is bound as text[] and cast back in SQL. Mixing
// element types across driver-inferred array parameters is where this pattern
// breaks (postgres.js infers a scalar OID for a homogeneous boolean array, and
// the server then refuses `boolean` → `boolean[]`); one param type with an
// explicit server-side cast is unambiguous for every column.
const numText = (v: number | null | undefined): string | null => (v == null ? null : String(v));

function chunked<T>(rows: readonly T[], size = UPSERT_CHUNK_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// A multi-row `ON CONFLICT DO UPDATE` fails outright ("cannot affect row a
// second time") if two rows in the SAME statement collide on the conflict key,
// so the batching above only holds while the payload is unique on exactly the
// keys the upserts target. The seed loader already enforces this
// (projects/seed/roster-seed.ts validateRoster), but discover() accepts any
// data source, so it is re-checked here and reported as a degrade rather than
// surfacing as a raw Postgres error mid-transaction.
export function assertUpsertKeysUnique(projects: readonly DiscoveredProject[]): void {
  const slugs = new Set<string>();
  for (const p of projects) {
    if (slugs.has(p.slug)) throw new Error(`projects.discover: duplicate project slug ${JSON.stringify(p.slug)} in the discovered payload`);
    slugs.add(p.slug);
    const check = (facet: string, key: string, values: string[]) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) {
          throw new Error(
            `projects.discover: project ${p.slug} has two ${facet} rows sharing ${key} ${JSON.stringify(v)} — ` +
              `they collide on the (project_id, ${key}) upsert key`,
          );
        }
        seen.add(v);
      }
    };
    check("agent", "name", p.agents.map((a) => a.name));
    check("coin", "name", p.coins.map((c) => c.name));
    check("wallet", "label", p.wallets.map((w) => w.label));
    check("vault", "name", p.vaults.map((v) => v.name));
  }
}

// A discovery run that carries fewer projects than this fraction of what is
// currently live does NOT deactivate anything — it reports the shortfall
// instead. Auto-deactivation is only safe when the incoming roster is trusted
// to be complete; layering it on top of a silent under-extraction would take
// the whole directory down automatically. An operator who means it enqueues the
// job with payload {"allowShrink": true}.
export const DISCOVERY_SHRINK_FLOOR_RATIO = 0.1;

export async function discover(
  payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  let projects: DiscoveredProject[];
  let discoveredAt: Date;
  try {
    projects = await source.discoverProjects();
    discoveredAt = resolveDiscoveryTimestamp(await source.discoveredAsOf?.());
    assertUpsertKeysUnique(projects);
  } catch (err) {
    return degraded("discover", err);
  }

  const allowShrink = payload.allowShrink === true;
  let upserted = 0;
  let deactivated = 0;
  let shrinkRefusal: string | null = null;

  await sql.begin(async (tx) => {
    // Captured BEFORE the upserts, while it still means "rows a previous
    // discovery run left live".
    const [activeRow] = await on(tx, activeProjects)`
      SELECT count(*)::int AS n FROM projects WHERE status = 'active' AND resolved_at IS NOT NULL`;
    const activeBefore = activeRow.n as number;

    // overview_short / overview_long are ADMIN-MANAGED free text (issue #93):
    // seeded on first insert only, NEVER overwritten on a scheduled re-run.
    // Their columns are deliberately absent from the DO UPDATE set so an admin
    // edit (POST /api/projects/admin/:slug) survives every subsequent discovery
    // pass, while display_name / description / logo / facet columns still refresh.
    // (No AI/LLM enrichment exists anywhere on this path.)
    const idBySlug = new Map<string, string>();
    for (const batch of chunked(projects)) {
      const returned = await on(tx, upsertProjects)`
        INSERT INTO projects (slug, display_name, description, overview_short, logo_url, website_url,
                              twitter_handle, is_sticky, status, resolved_at)
        SELECT s, dn, de, de, lu, wu, th, st::boolean, 'active', ${discoveredAt}
          FROM unnest(${batch.map((p) => p.slug)}::text[], ${batch.map((p) => p.display_name)}::text[],
                      ${batch.map((p) => p.description)}::text[], ${batch.map((p) => p.logo_url)}::text[],
                      ${batch.map((p) => p.website_url)}::text[], ${batch.map((p) => p.twitter_handle)}::text[],
                      ${batch.map((p) => String(p.is_sticky))}::text[]) AS t(s, dn, de, lu, wu, th, st)
        ON CONFLICT (slug) DO UPDATE SET
          display_name = EXCLUDED.display_name, description = EXCLUDED.description,
          logo_url = EXCLUDED.logo_url, website_url = EXCLUDED.website_url, twitter_handle = EXCLUDED.twitter_handle,
          is_sticky = EXCLUDED.is_sticky, status = 'active', resolved_at = EXCLUDED.resolved_at, updated_at = now()
        RETURNING id, slug`;
      for (const r of returned) idBySlug.set(r.slug as string, r.id as string);
      upserted += batch.length;
    }

    const pid = (slug: string): string => {
      const id = idBySlug.get(slug);
      if (!id) throw new Error(`projects.discover: project ${slug} was upserted but returned no id`);
      return id;
    };

    const agentRows = projects.flatMap((p) => p.agents.map((a) => ({ pid: pid(p.slug), a })));
    for (const batch of chunked(agentRows)) {
      await on(tx, upsertAgents)`
        INSERT INTO openclaw_agents (project_id, name, protocol_standard, wallet_address, virtuals_agent_id,
          x402_score, x402_txn_count, x402_resources_count, x402_volume_usd, productivity_score,
          source_confidence, enriched_at)
        SELECT p::uuid, n, ps, wa, va, xs::numeric, xt::integer, xr::integer, xv::numeric, prod::numeric, sc, ${discoveredAt}
          FROM unnest(${batch.map((r) => r.pid)}::text[], ${batch.map((r) => r.a.name)}::text[],
                      ${batch.map((r) => r.a.protocol_standard)}::text[],
                      ${batch.map((r) => r.a.wallet_address ?? null)}::text[],
                      ${batch.map((r) => r.a.virtuals_agent_id ?? null)}::text[],
                      ${batch.map((r) => numText(r.a.x402_score))}::text[],
                      ${batch.map((r) => numText(r.a.x402_txn_count))}::text[],
                      ${batch.map((r) => numText(r.a.x402_resources_count))}::text[],
                      ${batch.map((r) => numText(r.a.x402_volume_usd))}::text[],
                      ${batch.map((r) => numText(r.a.productivity_score))}::text[],
                      ${batch.map((r) => r.a.source_confidence ?? null)}::text[])
               AS t(p, n, ps, wa, va, xs, xt, xr, xv, prod, sc)
        ON CONFLICT (project_id, name) DO UPDATE SET
          protocol_standard = EXCLUDED.protocol_standard, wallet_address = EXCLUDED.wallet_address,
          virtuals_agent_id = EXCLUDED.virtuals_agent_id, x402_score = EXCLUDED.x402_score,
          x402_txn_count = EXCLUDED.x402_txn_count, x402_resources_count = EXCLUDED.x402_resources_count,
          x402_volume_usd = EXCLUDED.x402_volume_usd, productivity_score = EXCLUDED.productivity_score,
          source_confidence = EXCLUDED.source_confidence, enriched_at = EXCLUDED.enriched_at`;
    }

    const coinRows = projects.flatMap((p) => p.coins.map((c) => ({ pid: pid(p.slug), c })));
    for (const batch of chunked(coinRows)) {
      await on(tx, upsertCoins)`
        INSERT INTO lobster_coins (project_id, name, ticker, coingecko_id, contract_address, chain)
        SELECT p::uuid, n, tk, cg, ca, ch
          FROM unnest(${batch.map((r) => r.pid)}::text[], ${batch.map((r) => r.c.name)}::text[],
                      ${batch.map((r) => r.c.ticker)}::text[],
                      ${batch.map((r) => r.c.coingecko_id ?? null)}::text[],
                      ${batch.map((r) => r.c.contract_address ?? null)}::text[],
                      ${batch.map((r) => r.c.chain ?? null)}::text[]) AS t(p, n, tk, cg, ca, ch)
        ON CONFLICT (project_id, name) DO UPDATE SET
          ticker = EXCLUDED.ticker, coingecko_id = EXCLUDED.coingecko_id,
          contract_address = EXCLUDED.contract_address, chain = EXCLUDED.chain`;
    }

    const walletRows = projects.flatMap((p) => p.wallets.map((w) => ({ pid: pid(p.slug), w })));
    for (const batch of chunked(walletRows)) {
      await on(tx, upsertWallets)`
        INSERT INTO tracked_wallets (project_id, label, chain, address)
        SELECT p::uuid, l, ch, ad
          FROM unnest(${batch.map((r) => r.pid)}::text[], ${batch.map((r) => r.w.label)}::text[],
                      ${batch.map((r) => r.w.chain)}::text[], ${batch.map((r) => r.w.address)}::text[])
               AS t(p, l, ch, ad)
        ON CONFLICT (project_id, label) DO UPDATE SET chain = EXCLUDED.chain, address = EXCLUDED.address`;
    }

    const vaultRows = projects.flatMap((p) => p.vaults.map((v) => ({ pid: pid(p.slug), v })));
    for (const batch of chunked(vaultRows)) {
      await on(tx, upsertVaults)`
        INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, protocol, data_source)
        SELECT p::uuid, n, va, ch, st, pr, ds
          FROM unnest(${batch.map((r) => r.pid)}::text[], ${batch.map((r) => r.v.name)}::text[],
                      ${batch.map((r) => r.v.vault_address ?? null)}::text[],
                      ${batch.map((r) => r.v.chain ?? null)}::text[],
                      ${batch.map((r) => r.v.strategy_type ?? null)}::text[],
                      ${batch.map((r) => r.v.protocol ?? null)}::text[],
                      ${batch.map((r) => r.v.data_source ?? null)}::text[]) AS t(p, n, va, ch, st, pr, ds)
        ON CONFLICT (project_id, name) DO UPDATE SET
          vault_address = EXCLUDED.vault_address, chain = EXCLUDED.chain, strategy_type = EXCLUDED.strategy_type,
          protocol = EXCLUDED.protocol, data_source = EXCLUDED.data_source`;
    }

    // ── Reconciliation ────────────────────────────────────────────────────
    // Without this, discovery is append-only: `projections.ts` serves
    // `WHERE status = 'active'`, nothing else in the repo ever deactivates a
    // project, and so a project dropped from the roster — or the entire roster,
    // if this change were reverted — stays in the public directory forever with
    // a frozen resolved_at, removable only by hand-written SQL against prod.
    // Rows are marked inactive, NEVER deleted: their facet/snapshot history is
    // FK-linked and a later run that re-discovers the slug flips it back.
    // Scoped to `resolved_at IS NOT NULL` so only rows a previous discovery run
    // wrote are eligible — a smoke-seeded or manually inserted project is never
    // touched by a discovery pass that has no opinion about it.
    const floor = Math.ceil(activeBefore * (1 - DISCOVERY_SHRINK_FLOOR_RATIO));
    if (!allowShrink && activeBefore > 0 && projects.length < floor) {
      shrinkRefusal =
        `discovered ${projects.length} project(s) against ${activeBefore} currently active — below the ` +
        `${Math.round(DISCOVERY_SHRINK_FLOOR_RATIO * 100)}% shrink floor of ${floor}; deactivation SKIPPED ` +
        `(re-enqueue with payload {"allowShrink":true} if the roster really did shrink)`;
      console.error(`[projects.discover] ${shrinkRefusal}`);
    } else {
      const slugs = projects.map((p) => p.slug);
      const removed = await on(tx, deactivateProjects)`
        UPDATE projects SET status = 'inactive', updated_at = now()
         WHERE status = 'active' AND resolved_at IS NOT NULL AND NOT (slug = ANY(${slugs}))
        RETURNING id`;
      deactivated = removed.length;
      if (deactivated > 0) {
        console.warn(`[projects.discover] deactivated ${deactivated} project(s) absent from the discovered roster`);
      }
    }
  });
  return { ok: true, status: "ok", projects: upserted, deactivated, shrinkRefusal };
}

// ── Market refresh ───────────────────────────────────────────────────────────
export async function refreshCoins(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const coins = await on(sql, selectCoins)<{ id: string; coingecko_id: string | null; contract_address: string | null; chain: string | null }>`
    SELECT id, coingecko_id, contract_address, chain FROM lobster_coins WHERE is_active = true`;
  if (!coins.length) return { ok: true, status: "ok", updated: 0 };

  const cg = coins.filter((c) => c.coingecko_id);
  const dex = coins.filter((c) => !c.coingecko_id && c.contract_address);

  // Extract first; a single failure degrades the whole run (no partial writes).
  const updates: { id: string; f: ReturnType<typeof coinGeckoFields> }[] = [];
  try {
    if (cg.length) {
      const rows = await source.coinGeckoMarkets(cg.map((c) => c.coingecko_id as string));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of cg) {
        const r = byId.get(c.coingecko_id as string);
        if (r) updates.push({ id: c.id, f: coinGeckoFields(r) });
      }
    }
    for (const c of dex) {
      const payload = await source.dexScreenerToken(c.contract_address as string);
      const res = dexScreenerBest(payload, { contract_address: c.contract_address as string, chain: c.chain });
      if (res.status === "ok") updates.push({ id: c.id, f: res.values });
    }
  } catch (err) {
    return degraded("refresh_coins", err, { updated: 0 });
  }

  await sql.begin(async (tx) => {
    for (const u of updates) {
      await on(tx, updateCoin)`UPDATE lobster_coins SET
        price_usd = ${u.f.price_usd}, market_cap = ${u.f.market_cap}, fdv = ${u.f.fdv},
        volume_24h = ${u.f.volume_24h}, percent_change_24h = ${u.f.percent_change_24h}, refreshed_at = now()
        WHERE id = ${u.id}`;
    }
  });
  return { ok: true, status: "ok", updated: updates.length };
}

// ── Wallet refresh ───────────────────────────────────────────────────────────
// Issue #346: each wallet degrades INDEPENDENTLY. Previously a single wallet's
// read failure (e.g. an unsupported chain, or a transient RPC error) caught at
// the loop level and aborted the WHOLE run — every other wallet's balance,
// including ones on a chain with a real live path, stayed stuck at its last
// value even though nothing was wrong with it. Now a failing wallet keeps its
// last-persisted balance_usd (nothing fabricated) while every wallet whose
// read succeeded still updates.
export async function refreshWallets(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const wallets = await on(sql, selectWallets)<{ id: string; address: string | null; chain: string | null }>`
    SELECT id, address, chain FROM tracked_wallets WHERE is_active = true AND address IS NOT NULL`;
  if (!wallets.length) return { ok: true, status: "ok", updated: 0, failed: 0 };

  const updates: { id: string; balance: number }[] = [];
  let failed = 0;
  for (const w of wallets) {
    try {
      const balance = await source.walletBalanceUsd(w.address as string, w.chain ?? "base");
      updates.push({ id: w.id, balance });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[projects.refresh_wallets] wallet ${w.id} live read failed, keeping last-persisted balance (degraded):`, message);
    }
  }

  if (updates.length) {
    await sql.begin(async (tx) => {
      for (const u of updates) {
        await on(tx, updateWallet)`UPDATE tracked_wallets SET balance_usd = ${u.balance}, last_tx_at = now(), refreshed_at = now() WHERE id = ${u.id}`;
      }
    });
  }

  if (failed === 0) return { ok: true, status: "ok", updated: updates.length, failed: 0 };
  // Some (or all) wallets degraded. `ok` must reflect ANY per-wallet failure
  // (not "did at least one wallet succeed") so it stays consistent with every
  // other handler's ok<->status:"degraded" pairing and with loop.ts's
  // isDegradedResult gate, which keys retry/backoff/admin-visibility purely
  // off `ok === false`. A partial failure that also reported ok:true here
  // fell through to the ordinary success path (status='succeeded', last_error
  // cleared, no backoff, invisible to GET /api/admin/runs?status=degraded) —
  // and for wallets whose chain has no live RPC path wired yet (see
  // projects/access/live-source.ts), that failure is permanent, not transient.
  return { ok: false, status: "degraded", updated: updates.length, failed };
}

// ── Revenue sync (virtuals fee revenue + x402 volume rollup) ─────────────────
export async function syncRevenue(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const day = today();

  const virtualsAgents = await on(sql, selectVirtualsAgents)<{ id: string; virtuals_agent_id: string | null; wallet_address: string | null }>`
    SELECT id, virtuals_agent_id, wallet_address FROM openclaw_agents
    WHERE is_active = true AND (protocol_standard = 'virtuals' OR virtuals_agent_id IS NOT NULL)`;

  const rows: RevenueRow[] = [];
  try {
    for (const a of virtualsAgents) {
      const token = a.virtuals_agent_id || a.wallet_address;
      if (!token) continue;
      const payload = await source.dexScreenerToken(token);
      const row = virtualsRevenueRow(payload, { agent_id: a.id, date: day });
      if (row) rows.push(row);
    }
  } catch (err) {
    return degraded("sync_revenue", err, { upserted: 0 });
  }

  // x402 rollup reads already-persisted daily_agent_snapshots (no network).
  const snaps = await on(sql, selectAgentSnapshots)<AgentSnapshot>`
    SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd
    FROM daily_agent_snapshots WHERE snapshot_date >= ${since30()}`;
  rows.push(...x402RevenueRows(snaps));

  if (!rows.length) return { ok: true, status: "ok", upserted: 0 };
  await sql.begin(async (tx) => {
    await on(tx, upsertRevenue)`INSERT INTO agent_revenue_daily ${tx(rows, "agent_id", "revenue_date", "revenue_usd", "source")}
      ON CONFLICT (agent_id, revenue_date, source) DO UPDATE SET revenue_usd = EXCLUDED.revenue_usd`;
  });
  return { ok: true, status: "ok", upserted: rows.length };
}

// ── Daily snapshots ──────────────────────────────────────────────────────────
// Optional payload.project_ids scopes the snapshot to specific projects (the
// legacy compute was per-project; prod fires it unscoped for the whole directory).
export async function snapshotDaily(payload: Record<string, unknown> = {}): Promise<HandlerResult> {
  // Class C (NOT_BACKFILLABLE, issue #614): this is a rollup of CURRENT
  // persisted state (lobster_coins, openclaw_agents, tracked_wallets,
  // agent_vaults) — there is no historical version of those rows to read, so
  // a replayed slot for a past date would write TODAY's current values under
  // a stale day-key, fabricating history rather than recording it.
  if (isReplayedSlot(payload)) return declineReplayedSlot("projects.snapshot_daily", payload);
  const day = today();
  // An explicit empty project_ids:[] must fall back to the whole-directory
  // (unscoped) query, NOT build `IN ()` — that is invalid SQL and would throw.
  const ids = Array.isArray(payload.project_ids) && payload.project_ids.length > 0 ? (payload.project_ids as string[]) : null;
  const result = { coins: 0, agents: 0, wallets: 0, vaults: 0 };

  await sql.begin(async (tx) => {
    const coins = await on(tx, selectCoinsToSnapshot)<{ id: string; price_usd: number | string | null; market_cap: number | string | null; volume_24h: number | string | null }>`
      SELECT id, price_usd, market_cap, volume_24h FROM lobster_coins WHERE is_active = true AND (${ids}::uuid[] IS NULL OR project_id = ANY(${ids}::uuid[]))`;
    if (coins.length) {
      const rows = coins.map((c) => coinSnapshotRow(c, day));
      await on(tx, upsertCoinSnapshots)`INSERT INTO daily_coin_snapshots ${tx(rows, "coin_id", "snapshot_date", "price_usd", "market_cap", "volume_24h")}
        ON CONFLICT (coin_id, snapshot_date) DO UPDATE SET
          price_usd = EXCLUDED.price_usd, market_cap = EXCLUDED.market_cap, volume_24h = EXCLUDED.volume_24h`;
      result.coins = rows.length;
    }

    const agents = await on(tx, selectAgentsToSnapshot)<{ id: string; x402_volume_usd: unknown; x402_txn_count: unknown; productivity_score: unknown }>`
      SELECT id, x402_volume_usd, x402_txn_count, productivity_score FROM openclaw_agents WHERE is_active = true AND (${ids}::uuid[] IS NULL OR project_id = ANY(${ids}::uuid[]))`;
    if (agents.length) {
      const rows = agents.map((a) => ({
        agent_id: a.id,
        snapshot_date: day,
        x402_volume_usd: Number(a.x402_volume_usd) || 0,
        x402_txn_count: Number(a.x402_txn_count) || 0,
        productivity_score: Number(a.productivity_score) || 0,
      }));
      await on(tx, upsertAgentSnapshots)`INSERT INTO daily_agent_snapshots ${tx(rows, "agent_id", "snapshot_date", "x402_volume_usd", "x402_txn_count", "productivity_score")}
        ON CONFLICT (agent_id, snapshot_date) DO UPDATE SET
          x402_volume_usd = EXCLUDED.x402_volume_usd, x402_txn_count = EXCLUDED.x402_txn_count,
          productivity_score = EXCLUDED.productivity_score`;
      result.agents = rows.length;
    }

    const wallets = await on(tx, selectWalletsToSnapshot)<{ id: string; balance_usd: unknown }>`
      SELECT id, balance_usd FROM tracked_wallets WHERE is_active = true AND (${ids}::uuid[] IS NULL OR project_id = ANY(${ids}::uuid[]))`;
    if (wallets.length) {
      const rows = wallets.map((w) => ({ wallet_id: w.id, snapshot_date: day, total_balance_usd: Number(w.balance_usd) || 0 }));
      await on(tx, upsertWalletSnapshots)`INSERT INTO daily_wallet_snapshots ${tx(rows, "wallet_id", "snapshot_date", "total_balance_usd")}
        ON CONFLICT (wallet_id, snapshot_date) DO UPDATE SET total_balance_usd = EXCLUDED.total_balance_usd`;
      result.wallets = rows.length;
    }

    const vaults = await on(tx, selectVaultsToSnapshot)<{ id: string; tvl_usd: unknown }>`
      SELECT id, tvl_usd FROM agent_vaults WHERE is_active = true AND (${ids}::uuid[] IS NULL OR project_id = ANY(${ids}::uuid[]))`;
    if (vaults.length) {
      const rows = vaults.map((v) => ({ vault_id: v.id, snapshot_date: day, tvl_usd: Number(v.tvl_usd) || 0 }));
      await on(tx, upsertTvlSnapshots)`INSERT INTO daily_tvl_snapshots ${tx(rows, "vault_id", "snapshot_date", "tvl_usd")}
        ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`;
      result.vaults = rows.length;
    }
  });
  return { ok: true, status: "ok", ...result };
}

// ── Vault data ───────────────────────────────────────────────────────────────
export async function fetchVaults(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const day = today();
  const vaults = await on(sql, selectLiveVaults)<{ id: string; vault_address: string | null; chain: string | null; strategy_type: string | null; protocol: string | null }>`
    SELECT id, vault_address, chain, strategy_type, protocol FROM agent_vaults
    WHERE is_active = true AND data_source = 'live' AND vault_address IS NOT NULL`;
  if (!vaults.length) return { ok: true, status: "ok", updated: 0 };

  const updates: { id: string; tvl: number }[] = [];
  try {
    for (const v of vaults) {
      const read = await source.vaultErc4626Read(v.vault_address as string, v.chain ?? "base");
      updates.push({ id: v.id, tvl: vaultTvlErc4626(read) });
    }
  } catch (err) {
    return degraded("fetch_vaults", err, { updated: 0 });
  }

  await sql.begin(async (tx) => {
    for (const u of updates) {
      await on(tx, updateVault)`UPDATE agent_vaults SET tvl_usd = ${u.tvl}, refreshed_at = now(),
        last_refresh_status = ${u.tvl > 0 ? "ok" : "empty"} WHERE id = ${u.id}`;
      await on(tx, upsertVaultTvl)`INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd)
        VALUES (${u.id}, ${day}, ${u.tvl})
        ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`;
    }
  });
  return { ok: true, status: "ok", updated: updates.length };
}

// ── Identity resolution + coverage scoring (no network) ──────────────────────
function confidenceFromRank(rank: number | null): SourceConfidence {
  return rank === 3 ? "high" : rank === 2 ? "medium" : rank === 1 ? "low" : null;
}

export async function recomputeCoverage(payload: Record<string, unknown> = {}): Promise<HandlerResult> {
  // Empty project_ids:[] → unscoped (whole directory), never invalid `IN ()`.
  const ids = Array.isArray(payload.project_ids) && payload.project_ids.length > 0 ? (payload.project_ids as string[]) : null;
  const rows = await on(sql, projectsRead, coverageAgents, coverageCoins, coverageWallets, coverageVaults, coverageAgentSnaps, coverageCoinSnaps, coverageWalletSnaps)<Record<string, unknown>>`
    SELECT
      p.id, p.logo_url, p.description, p.twitter_handle, p.website_url, p.display_name, p.slug, p.resolved_at,
      EXISTS(SELECT 1 FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS has_agent,
      EXISTS(SELECT 1 FROM lobster_coins  c WHERE c.project_id = p.id AND c.is_active) AS has_coin,
      EXISTS(SELECT 1 FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS has_wallet,
      EXISTS(SELECT 1 FROM agent_vaults   v WHERE v.project_id = p.id AND v.is_active) AS has_vault,
      (SELECT bool_or(COALESCE(productivity_score,0) > 0) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_prod,
      (SELECT bool_or(COALESCE(x402_txn_count,0) > 0 OR COALESCE(cumulative_revenue_usd,0) > 0) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_rev,
      (SELECT max(CASE source_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_conf,
      (SELECT bool_or(enriched_at IS NOT NULL) FROM openclaw_agents a WHERE a.project_id = p.id AND a.is_active) AS a_enriched,
      (SELECT bool_or(COALESCE(price_usd,0) > 0) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_price,
      (SELECT bool_or(COALESCE(market_cap,0) > 0) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_mcap,
      (SELECT bool_or(contract_address IS NOT NULL) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_contract,
      (SELECT bool_or(coingecko_id IS NOT NULL) FROM lobster_coins c WHERE c.project_id = p.id AND c.is_active) AS c_cg,
      (SELECT bool_or(COALESCE(balance_usd,0) > 0) FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS w_bal,
      (SELECT bool_or(last_tx_at > now() - interval '90 days') FROM tracked_wallets w WHERE w.project_id = p.id AND w.is_active) AS w_tx,
      (SELECT bool_or(COALESCE(tvl_usd,0) > 0) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_tvl,
      (SELECT bool_or(yield_apy IS NOT NULL) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_apy,
      (SELECT bool_or(vault_address IS NOT NULL) FROM agent_vaults v WHERE v.project_id = p.id AND v.is_active) AS v_addr,
      COALESCE((SELECT count(*) FROM daily_agent_snapshots s JOIN openclaw_agents a ON a.id = s.agent_id WHERE a.project_id = p.id), 0) >= 7 AS h_agent,
      COALESCE((SELECT count(*) FROM daily_coin_snapshots s JOIN lobster_coins c ON c.id = s.coin_id WHERE c.project_id = p.id), 0) >= 7 AS h_coin,
      COALESCE((SELECT count(*) FROM daily_wallet_snapshots s JOIN tracked_wallets w ON w.id = s.wallet_id WHERE w.project_id = p.id), 0) >= 7 AS h_wallet
    FROM projects p WHERE (${ids}::uuid[] IS NULL OR p.id = ANY(${ids}::uuid[]))`;

  let updated = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const inputs: CoverageInputs = {
        project: {
          has_agent: r.has_agent as boolean,
          has_coin: r.has_coin as boolean,
          has_wallet: r.has_wallet as boolean,
          has_vault: r.has_vault as boolean,
          logo_url: (r.logo_url as string | null) ?? null,
          description: (r.description as string | null) ?? null,
          twitter_handle: (r.twitter_handle as string | null) ?? null,
          website_url: (r.website_url as string | null) ?? null,
          display_name: (r.display_name as string | null) ?? null,
          slug: r.slug as string,
          resolved_at: (r.resolved_at as string | null) ?? null,
        },
        agent: {
          productivityPositive: !!r.a_prod,
          revenueSignal: !!r.a_rev,
          confidence: confidenceFromRank(r.a_conf == null ? null : Number(r.a_conf)),
          enriched: !!r.a_enriched,
        },
        coin: { pricePositive: !!r.c_price, mcapPositive: !!r.c_mcap, hasContract: !!r.c_contract, hasCoingecko: !!r.c_cg },
        wallet: { balancePositive: !!r.w_bal, recentTx: !!r.w_tx },
        vault: { tvlPositive: !!r.v_tvl, hasApy: !!r.v_apy, hasAddress: !!r.v_addr },
        history: { agent7: !!r.h_agent, coin7: !!r.h_coin, wallet7: !!r.h_wallet },
      };
      const s = computeCoverage(inputs);
      await on(tx, updateCoverage)`UPDATE projects SET
        has_agent = ${inputs.project.has_agent}, has_coin = ${inputs.project.has_coin},
        has_wallet = ${inputs.project.has_wallet}, has_vault = ${inputs.project.has_vault},
        breadth_score = ${s.breadth}, identity_score = ${s.identity}, onchain_score = ${s.onchain},
        activity_score = ${s.activity}, data_coverage_score = ${s.score}, coverage_calculated_at = now(), updated_at = now()
        WHERE id = ${r.id as string}`;
      updated++;
    }
  });
  return { ok: true, status: "ok", updated };
}
