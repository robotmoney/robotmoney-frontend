// The projects pipelines' reads and writes, run by the api for the pipeline
// worker (issue 1034, decision D75). worker/handlers/projects.ts pulls the
// provider payloads and applies the pure transforms; every statement here is
// one that handler used to run on the worker's own pool. snapshot_daily and
// recompute_coverage read and write only persisted state, so each runs here as
// one operation in one transaction, as it did in the worker.
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";
import type { DiscoveredProject } from "../../projects/access/data-source.ts";
import {
  coinSnapshotRow,
  computeCoverage,
  type AgentSnapshot,
  type CoverageInputs,
  type RevenueRow,
  type SourceConfidence,
} from "../../projects/transforms.ts";

// Every statement here is the projects pipelines', reached through the
// pipeline routes.
const HANDLER = ["src/api/routes/pipeline"];

const activeProjects = registerQuery({
  role: "rm_app",
  object: "projects",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:discover.activeCount",
  purpose: "Count the projects a previous discovery run left live, before the upserts.",
  callers: HANDLER,
  probe: {
    statement: `SELECT count(*)::int AS n FROM projects WHERE status = 'active' AND resolved_at IS NOT NULL`,
  },
});

const upsertProjects = registerQuery({
  role: "rm_app",
  object: "projects",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.upsertProjects",
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
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.upsertAgents",
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
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.upsertCoins",
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
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.upsertWallets",
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
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.upsertVaults",
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
  role: "rm_app",
  object: "projects",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:discover.deactivate",
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
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:refreshCoins.select",
  purpose: "Read the active coins to refresh.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, coingecko_id, contract_address, chain FROM lobster_coins WHERE is_active = true`,
  },
});

const updateCoin = registerQuery({
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:refreshCoins.update",
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
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:refreshWallets.select",
  purpose: "Read the active wallets that have an address.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, address, chain FROM tracked_wallets WHERE is_active = true AND address IS NOT NULL`,
  },
});

const updateWallet = registerQuery({
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:refreshWallets.update",
  purpose: "Write a wallet's refreshed balance.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE tracked_wallets SET balance_usd = $1::numeric, last_tx_at = now(), refreshed_at = now() WHERE id = $2::uuid`,
    params: [1, "00000000-0000-0000-0000-000000000000"],
  },
});

const selectVirtualsAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:syncRevenue.virtualsAgents",
  purpose: "Read the active agents whose revenue comes from Virtuals.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, virtuals_agent_id, wallet_address FROM openclaw_agents
    WHERE is_active = true AND (protocol_standard = 'virtuals' OR virtuals_agent_id IS NOT NULL)`,
  },
});

const selectAgentSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:syncRevenue.agentSnapshots",
  purpose: "Read the trailing daily agent snapshots the x402 revenue rollup sums.",
  callers: HANDLER,
  probe: {
    statement: `SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd
    FROM daily_agent_snapshots WHERE snapshot_date >= $1::date`,
    params: ["2000-01-01"],
  },
});

const upsertRevenue = registerQuery({
  role: "rm_app",
  object: "agent_revenue_daily",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:syncRevenue.upsert",
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
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.coins",
  purpose: "Read the active coins to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, price_usd, market_cap, volume_24h FROM lobster_coins WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertCoinSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_coin_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.upsertCoinSnapshots",
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
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.agents",
  purpose: "Read the active agents to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, x402_volume_usd, x402_txn_count, productivity_score FROM openclaw_agents WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertAgentSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_agent_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.upsertAgentSnapshots",
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
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.wallets",
  purpose: "Read the active wallets to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, balance_usd FROM tracked_wallets WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertWalletSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_wallet_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.upsertWalletSnapshots",
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
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.vaults",
  purpose: "Read the active vaults to snapshot, optionally scoped to projects.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, tvl_usd FROM agent_vaults WHERE is_active = true AND ($1::uuid[] IS NULL OR project_id = ANY($1::uuid[]))`,
    params: [null],
  },
});

const upsertTvlSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_tvl_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:snapshotDaily.upsertTvlSnapshots",
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
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:fetchVaults.select",
  purpose: "Read the active live vaults that have an address.",
  callers: HANDLER,
  probe: {
    statement: `SELECT id, vault_address, chain, strategy_type, protocol FROM agent_vaults
    WHERE is_active = true AND data_source = 'live' AND vault_address IS NOT NULL`,
  },
});

const updateVault = registerQuery({
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:fetchVaults.update",
  purpose: "Write a vault's refreshed TVL and refresh status.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE agent_vaults SET tvl_usd = $1::numeric, refreshed_at = now(),
        last_refresh_status = $2 WHERE id = $3::uuid`,
    params: [1, "ok", "00000000-0000-0000-0000-000000000000"],
  },
});

const markVaultFailed = registerQuery({
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:fetchVaults.markFailed",
  purpose: "Mark a vault whose live read failed, keeping its last-persisted TVL.",
  callers: HANDLER,
  probe: {
    statement: `UPDATE agent_vaults SET last_refresh_status = 'failed' WHERE id = $1::uuid`,
    params: ["00000000-0000-0000-0000-000000000000"],
  },
});

const upsertVaultTvl = registerQuery({
  role: "rm_app",
  object: "daily_tvl_snapshots",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:fetchVaults.upsertTvl",
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
  role: "rm_app",
  object: "projects",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_projects",
  purpose: "Read projects for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_openclaw_agents",
  purpose: "Read openclaw_agents for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageCoins = registerQuery({
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_lobster_coins",
  purpose: "Read lobster_coins for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageWallets = registerQuery({
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_tracked_wallets",
  purpose: "Read tracked_wallets for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageVaults = registerQuery({
  role: "rm_app",
  object: "agent_vaults",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_agent_vaults",
  purpose: "Read agent_vaults for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageAgentSnaps = registerQuery({
  role: "rm_app",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_daily_agent_snapshots",
  purpose: "Read daily_agent_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageCoinSnaps = registerQuery({
  role: "rm_app",
  object: "daily_coin_snapshots",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_daily_coin_snapshots",
  purpose: "Read daily_coin_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const coverageWalletSnaps = registerQuery({
  role: "rm_app",
  object: "daily_wallet_snapshots",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.read_daily_wallet_snapshots",
  purpose: "Read daily_wallet_snapshots for the coverage scoring select, which joins eight relations.",
  callers: HANDLER,
  probe: COVERAGE_PROBE,
});

const updateCoverage = registerQuery({
  role: "rm_app",
  object: "projects",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/projects:recomputeCoverage.update",
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


// Rows are written in batched multi-row statements rather than one round trip
// per row: the real roster is 1,037 projects + 1,767 facets = 2,804 statements.
// Chunked so no single statement approaches Postgres' 65,535 bind-parameter
// ceiling as the roster grows.
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

// ── Discovery ────────────────────────────────────────────────────────────────

/** How many projects a previous discovery run left live (`projects.active_discovered_count`). */
export async function activeDiscoveredCount(db: RegistryDb): Promise<number> {
  const [activeRow] = await on(db, activeProjects)`
    SELECT count(*)::int AS n FROM projects WHERE status = 'active' AND resolved_at IS NOT NULL`;
  return activeRow.n as number;
}

/** A discovered project with its facets: one project row plus one row per facet. */
export function discoveredRowCount(projects: readonly DiscoveredProject[]): number {
  return projects.reduce((n, p) => n + 1 + p.agents.length + p.coins.length + p.wallets.length + p.vaults.length, 0);
}

/**
 * Upsert discovered projects and their facets (`projects.upsert_discovered`).
 * Returns how many projects it upserted.
 *
 * overview_short / overview_long are ADMIN-MANAGED free text (issue #93):
 * seeded on first insert only, NEVER overwritten on a scheduled re-run. Their
 * columns are deliberately absent from the DO UPDATE set so an admin edit
 * (POST /api/projects/admin/:slug) survives every subsequent discovery pass,
 * while display_name / description / logo / facet columns still refresh.
 */
export async function upsertDiscovered(tx: RegistryDb, projects: readonly DiscoveredProject[], discoveredAt: Date): Promise<number> {
  const idBySlug = new Map<string, string>();
  let upserted = 0;
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
  return upserted;
}

/**
 * Mark inactive every live, discovery-written project absent from `slugs`
 * (`projects.deactivate_missing`). Rows are marked inactive, NEVER deleted:
 * their facet/snapshot history is FK-linked and a later run that re-discovers
 * the slug flips it back. Scoped to `resolved_at IS NOT NULL` so only rows a
 * previous discovery run wrote are eligible. Returns how many it deactivated.
 */
export async function deactivateMissing(tx: RegistryDb, slugs: readonly string[]): Promise<number> {
  const removed = await on(tx, deactivateProjects)`
    UPDATE projects SET status = 'inactive', updated_at = now()
     WHERE status = 'active' AND resolved_at IS NOT NULL AND NOT (slug = ANY(${[...slugs]}))
    RETURNING id`;
  return removed.length;
}

// ── Market refresh ───────────────────────────────────────────────────────────

/** Every active coin's market keys (`projects.active_coins`). */
export async function activeCoins(db: RegistryDb): Promise<{ id: string; coingecko_id: string | null; contract_address: string | null; chain: string | null }[]> {
  return [...await on(db, selectCoins)<{ id: string; coingecko_id: string | null; contract_address: string | null; chain: string | null }>`
    SELECT id, coingecko_id, contract_address, chain FROM lobster_coins WHERE is_active = true`];
}

/** One coin's refreshed market fields. */
export interface CoinMarketUpdate {
  id: string;
  f: { price_usd: number | null; market_cap: number | null; fdv: number | null; volume_24h: number | null; percent_change_24h: number | null };
}

/** Write refreshed market fields (`projects.update_coins`). Returns how many coins it updated. */
export async function updateCoins(tx: RegistryDb, updates: readonly CoinMarketUpdate[]): Promise<number> {
  for (const u of updates) {
    await on(tx, updateCoin)`UPDATE lobster_coins SET
      price_usd = ${u.f.price_usd}, market_cap = ${u.f.market_cap}, fdv = ${u.f.fdv},
      volume_24h = ${u.f.volume_24h}, percent_change_24h = ${u.f.percent_change_24h}, refreshed_at = now()
      WHERE id = ${u.id}`;
  }
  return updates.length;
}

// ── Wallet refresh ───────────────────────────────────────────────────────────

/** Every active wallet with an address (`projects.active_wallets`). */
export async function activeWallets(db: RegistryDb): Promise<{ id: string; address: string | null; chain: string | null }[]> {
  return [...await on(db, selectWallets)<{ id: string; address: string | null; chain: string | null }>`
    SELECT id, address, chain FROM tracked_wallets WHERE is_active = true AND address IS NOT NULL`];
}

/** Write each wallet's refreshed balance (`projects.update_wallet_balances`). Returns how many it updated. */
export async function updateWalletBalances(tx: RegistryDb, updates: readonly { id: string; balance: number }[]): Promise<number> {
  for (const u of updates) {
    await on(tx, updateWallet)`UPDATE tracked_wallets SET balance_usd = ${u.balance}, last_tx_at = now(), refreshed_at = now() WHERE id = ${u.id}`;
  }
  return updates.length;
}

// ── Revenue sync ─────────────────────────────────────────────────────────────

/** Active agents with a virtuals identity (`projects.virtuals_agents`). */
export async function virtualsAgents(db: RegistryDb): Promise<{ id: string; virtuals_agent_id: string | null; wallet_address: string | null }[]> {
  return [...await on(db, selectVirtualsAgents)<{ id: string; virtuals_agent_id: string | null; wallet_address: string | null }>`
    SELECT id, virtuals_agent_id, wallet_address FROM openclaw_agents
    WHERE is_active = true AND (protocol_standard = 'virtuals' OR virtuals_agent_id IS NOT NULL)`];
}

/** The persisted daily agent snapshots since `since` (`projects.agent_snapshots_since`), for the x402 rollup. */
export async function agentSnapshotsSince(db: RegistryDb, since: string): Promise<AgentSnapshot[]> {
  return [...await on(db, selectAgentSnapshots)<AgentSnapshot>`
    SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd
    FROM daily_agent_snapshots WHERE snapshot_date >= ${since}`];
}

/** Upsert revenue rows on (agent_id, revenue_date, source) (`projects.upsert_revenue`). Returns how many. */
export async function upsertRevenueRows(tx: RegistryDb, rows: readonly RevenueRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const json = rows as RevenueRow[];
  await on(tx, upsertRevenue)`INSERT INTO agent_revenue_daily ${tx(json, "agent_id", "revenue_date", "revenue_usd", "source")}
    ON CONFLICT (agent_id, revenue_date, source) DO UPDATE SET revenue_usd = EXCLUDED.revenue_usd`;
  return rows.length;
}

// ── Daily snapshots ──────────────────────────────────────────────────────────

/**
 * Roll the current persisted state into the day's snapshots
 * (`projects.snapshot_daily`), in `tx`. `ids` scopes it to those projects;
 * null is the whole directory (an explicit empty list never builds `IN ()`).
 */
export async function snapshotDailyRollup(
  tx: RegistryDb,
  day: string,
  ids: readonly string[] | null,
): Promise<{ coins: number; agents: number; wallets: number; vaults: number }> {
  const result = { coins: 0, agents: 0, wallets: 0, vaults: 0 };
  const scope = ids && ids.length > 0 ? [...ids] : null;
  const coins = await on(tx, selectCoinsToSnapshot)<{ id: string; price_usd: number | string | null; market_cap: number | string | null; volume_24h: number | string | null }>`
    SELECT id, price_usd, market_cap, volume_24h FROM lobster_coins WHERE is_active = true AND (${scope}::uuid[] IS NULL OR project_id = ANY(${scope}::uuid[]))`;
  if (coins.length) {
    const rows = coins.map((c) => coinSnapshotRow(c, day));
    await on(tx, upsertCoinSnapshots)`INSERT INTO daily_coin_snapshots ${tx(rows, "coin_id", "snapshot_date", "price_usd", "market_cap", "volume_24h")}
      ON CONFLICT (coin_id, snapshot_date) DO UPDATE SET
        price_usd = EXCLUDED.price_usd, market_cap = EXCLUDED.market_cap, volume_24h = EXCLUDED.volume_24h`;
    result.coins = rows.length;
  }

  const agents = await on(tx, selectAgentsToSnapshot)<{ id: string; x402_volume_usd: unknown; x402_txn_count: unknown; productivity_score: unknown }>`
    SELECT id, x402_volume_usd, x402_txn_count, productivity_score FROM openclaw_agents WHERE is_active = true AND (${scope}::uuid[] IS NULL OR project_id = ANY(${scope}::uuid[]))`;
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
    SELECT id, balance_usd FROM tracked_wallets WHERE is_active = true AND (${scope}::uuid[] IS NULL OR project_id = ANY(${scope}::uuid[]))`;
  if (wallets.length) {
    const rows = wallets.map((w) => ({ wallet_id: w.id, snapshot_date: day, total_balance_usd: Number(w.balance_usd) || 0 }));
    await on(tx, upsertWalletSnapshots)`INSERT INTO daily_wallet_snapshots ${tx(rows, "wallet_id", "snapshot_date", "total_balance_usd")}
      ON CONFLICT (wallet_id, snapshot_date) DO UPDATE SET total_balance_usd = EXCLUDED.total_balance_usd`;
    result.wallets = rows.length;
  }

  const vaults = await on(tx, selectVaultsToSnapshot)<{ id: string; tvl_usd: unknown }>`
    SELECT id, tvl_usd FROM agent_vaults WHERE is_active = true AND (${scope}::uuid[] IS NULL OR project_id = ANY(${scope}::uuid[]))`;
  if (vaults.length) {
    const rows = vaults.map((v) => ({ vault_id: v.id, snapshot_date: day, tvl_usd: Number(v.tvl_usd) || 0 }));
    await on(tx, upsertTvlSnapshots)`INSERT INTO daily_tvl_snapshots ${tx(rows, "vault_id", "snapshot_date", "tvl_usd")}
      ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`;
    result.vaults = rows.length;
  }
  return result;
}

// ── Vault data ───────────────────────────────────────────────────────────────

/** Active live vaults with an address (`projects.live_vaults`). */
export async function liveVaults(db: RegistryDb): Promise<{ id: string; vault_address: string | null; chain: string | null; strategy_type: string | null; protocol: string | null }[]> {
  return [...await on(db, selectLiveVaults)<{ id: string; vault_address: string | null; chain: string | null; strategy_type: string | null; protocol: string | null }>`
    SELECT id, vault_address, chain, strategy_type, protocol FROM agent_vaults
    WHERE is_active = true AND data_source = 'live' AND vault_address IS NOT NULL`];
}

/**
 * Record a vault refresh (`projects.record_vault_reads`): each read vault's
 * TVL and the day's TVL snapshot, and each failed vault marked 'failed' with
 * its last-persisted TVL kept (issue 1291).
 */
export async function recordVaultReads(
  tx: RegistryDb,
  day: string,
  updates: readonly { id: string; tvl: number }[],
  failedIds: readonly string[],
): Promise<number> {
  for (const u of updates) {
    await on(tx, updateVault)`UPDATE agent_vaults SET tvl_usd = ${u.tvl}, refreshed_at = now(),
      last_refresh_status = ${u.tvl > 0 ? "ok" : "empty"} WHERE id = ${u.id}`;
    await on(tx, upsertVaultTvl)`INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd)
      VALUES (${u.id}, ${day}, ${u.tvl})
      ON CONFLICT (vault_id, snapshot_date) DO UPDATE SET tvl_usd = EXCLUDED.tvl_usd`;
  }
  for (const id of failedIds) {
    await on(tx, markVaultFailed)`UPDATE agent_vaults SET last_refresh_status = 'failed' WHERE id = ${id}`;
  }
  return updates.length + failedIds.length;
}

// ── Identity resolution + coverage scoring (no network) ──────────────────────
function confidenceFromRank(rank: number | null): SourceConfidence {
  return rank === 3 ? "high" : rank === 2 ? "medium" : rank === 1 ? "low" : null;
}

/**
 * Recompute each project's coverage scores from persisted state
 * (`projects.recompute_coverage`), in `tx`. `ids` scopes it; null is the whole
 * directory. Returns how many projects it updated.
 */
export async function recomputeCoverageScores(tx: RegistryDb, ids: readonly string[] | null): Promise<number> {
  const scope = ids && ids.length > 0 ? [...ids] : null;
  const rows = await on(tx, projectsRead, coverageAgents, coverageCoins, coverageWallets, coverageVaults, coverageAgentSnaps, coverageCoinSnaps, coverageWalletSnaps)<Record<string, unknown>>`
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
    FROM projects p WHERE (${scope}::uuid[] IS NULL OR p.id = ANY(${scope}::uuid[]))`;

  let updated = 0;
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
  return updated;
}
