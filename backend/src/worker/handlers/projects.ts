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
import { sql } from "../../db/client.ts";
import { selectProjectsDataSource } from "../../projects/access/select.ts";
import type { ProjectsDataSource } from "../../projects/access/data-source.ts";
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
  status: "ok" | "degraded";
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
export async function discover(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  let projects;
  try {
    projects = await source.discoverProjects();
  } catch (err) {
    return degraded("discover", err);
  }

  let upserted = 0;
  await sql.begin(async (tx) => {
    for (const p of projects) {
      // overview_short / overview_long are ADMIN-MANAGED free text (issue #93):
      // seeded on first insert only, NEVER overwritten on a scheduled re-run.
      // Their columns are deliberately absent from the DO UPDATE set so an admin
      // edit (POST /api/projects/admin/:slug) survives every subsequent discovery
      // pass, while display_name / description / logo / facet columns still refresh.
      // (No AI/LLM enrichment exists anywhere on this path.)
      const [{ id }] = await tx`
        INSERT INTO projects (slug, display_name, description, overview_short, logo_url, website_url, twitter_handle, is_sticky, status, resolved_at)
        VALUES (${p.slug}, ${p.display_name}, ${p.description}, ${p.description}, ${p.logo_url}, ${p.website_url}, ${p.twitter_handle}, ${p.is_sticky}, 'active', now())
        ON CONFLICT (slug) DO UPDATE SET
          display_name = EXCLUDED.display_name, description = EXCLUDED.description,
          logo_url = EXCLUDED.logo_url, website_url = EXCLUDED.website_url, twitter_handle = EXCLUDED.twitter_handle,
          is_sticky = EXCLUDED.is_sticky, status = 'active', resolved_at = now(), updated_at = now()
        RETURNING id`;
      const pid = id as string;

      for (const a of p.agents) {
        await tx`
          INSERT INTO openclaw_agents (project_id, name, protocol_standard, wallet_address, virtuals_agent_id,
            x402_score, x402_txn_count, x402_resources_count, x402_volume_usd, productivity_score, source_confidence, enriched_at)
          VALUES (${pid}, ${a.name}, ${a.protocol_standard}, ${a.wallet_address ?? null}, ${a.virtuals_agent_id ?? null},
            ${a.x402_score ?? null}, ${a.x402_txn_count ?? null}, ${a.x402_resources_count ?? null}, ${a.x402_volume_usd ?? null},
            ${a.productivity_score ?? null}, ${a.source_confidence ?? null}, now())
          ON CONFLICT (project_id, name) DO UPDATE SET
            protocol_standard = EXCLUDED.protocol_standard, wallet_address = EXCLUDED.wallet_address,
            virtuals_agent_id = EXCLUDED.virtuals_agent_id, x402_score = EXCLUDED.x402_score,
            x402_txn_count = EXCLUDED.x402_txn_count, x402_resources_count = EXCLUDED.x402_resources_count,
            x402_volume_usd = EXCLUDED.x402_volume_usd, productivity_score = EXCLUDED.productivity_score,
            source_confidence = EXCLUDED.source_confidence, enriched_at = now()`;
      }
      for (const c of p.coins) {
        await tx`
          INSERT INTO lobster_coins (project_id, name, ticker, coingecko_id, contract_address, chain)
          VALUES (${pid}, ${c.name}, ${c.ticker}, ${c.coingecko_id ?? null}, ${c.contract_address ?? null}, ${c.chain ?? null})
          ON CONFLICT (project_id, name) DO UPDATE SET
            ticker = EXCLUDED.ticker, coingecko_id = EXCLUDED.coingecko_id,
            contract_address = EXCLUDED.contract_address, chain = EXCLUDED.chain`;
      }
      for (const w of p.wallets) {
        await tx`
          INSERT INTO tracked_wallets (project_id, label, chain, address)
          VALUES (${pid}, ${w.label}, ${w.chain}, ${w.address})
          ON CONFLICT (project_id, label) DO UPDATE SET chain = EXCLUDED.chain, address = EXCLUDED.address`;
      }
      for (const v of p.vaults) {
        await tx`
          INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, protocol, data_source)
          VALUES (${pid}, ${v.name}, ${v.vault_address ?? null}, ${v.chain ?? null}, ${v.strategy_type ?? null}, ${v.protocol ?? null}, ${v.data_source ?? null})
          ON CONFLICT (project_id, name) DO UPDATE SET
            vault_address = EXCLUDED.vault_address, chain = EXCLUDED.chain, strategy_type = EXCLUDED.strategy_type,
            protocol = EXCLUDED.protocol, data_source = EXCLUDED.data_source`;
      }
      upserted++;
    }
  });
  return { ok: true, status: "ok", projects: upserted };
}

// ── Market refresh ───────────────────────────────────────────────────────────
export async function refreshCoins(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const coins = await sql<{ id: string; coingecko_id: string | null; contract_address: string | null; chain: string | null }[]>`
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
      await tx`UPDATE lobster_coins SET
        price_usd = ${u.f.price_usd}, market_cap = ${u.f.market_cap}, fdv = ${u.f.fdv},
        volume_24h = ${u.f.volume_24h}, percent_change_24h = ${u.f.percent_change_24h}, refreshed_at = now()
        WHERE id = ${u.id}`;
    }
  });
  return { ok: true, status: "ok", updated: updates.length };
}

// ── Wallet refresh ───────────────────────────────────────────────────────────
export async function refreshWallets(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const wallets = await sql<{ id: string; address: string | null; chain: string | null }[]>`
    SELECT id, address, chain FROM tracked_wallets WHERE is_active = true AND address IS NOT NULL`;
  if (!wallets.length) return { ok: true, status: "ok", updated: 0 };

  const updates: { id: string; balance: number }[] = [];
  try {
    for (const w of wallets) {
      const balance = await source.walletBalanceUsd(w.address as string, w.chain ?? "base");
      updates.push({ id: w.id, balance });
    }
  } catch (err) {
    return degraded("refresh_wallets", err, { updated: 0 });
  }

  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`UPDATE tracked_wallets SET balance_usd = ${u.balance}, last_tx_at = now(), refreshed_at = now() WHERE id = ${u.id}`;
    }
  });
  return { ok: true, status: "ok", updated: updates.length };
}

// ── Revenue sync (virtuals fee revenue + x402 volume rollup) ─────────────────
export async function syncRevenue(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const day = today();

  const virtualsAgents = await sql<{ id: string; virtuals_agent_id: string | null; wallet_address: string | null }[]>`
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
  const snaps = await sql<AgentSnapshot[]>`
    SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd
    FROM daily_agent_snapshots WHERE snapshot_date >= ${since30()}`;
  rows.push(...x402RevenueRows(snaps));

  if (!rows.length) return { ok: true, status: "ok", upserted: 0 };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO agent_revenue_daily ${tx(rows)}
      ON CONFLICT (agent_id, revenue_date, source) DO UPDATE SET revenue_usd = EXCLUDED.revenue_usd`;
  });
  return { ok: true, status: "ok", upserted: rows.length };
}

// ── Daily snapshots ──────────────────────────────────────────────────────────
// Optional payload.project_ids scopes the snapshot to specific projects (the
// legacy compute was per-project; prod fires it unscoped for the whole directory).
export async function snapshotDaily(payload: Record<string, unknown> = {}): Promise<HandlerResult> {
  const day = today();
  const ids = Array.isArray(payload.project_ids) ? (payload.project_ids as string[]) : null;
  const result = { coins: 0, agents: 0, wallets: 0, vaults: 0 };

  await sql.begin(async (tx) => {
    const scope = (col: string) => (ids ? tx`AND ${tx(col)} IN ${tx(ids)}` : tx``);

    const coins = await tx<{ id: string; price_usd: number | string | null; market_cap: number | string | null; volume_24h: number | string | null }[]>`
      SELECT id, price_usd, market_cap, volume_24h FROM lobster_coins WHERE is_active = true ${scope("project_id")}`;
    if (coins.length) {
      const rows = coins.map((c) => coinSnapshotRow(c, day));
      await tx`INSERT INTO daily_coin_snapshots ${tx(rows)}
        ON CONFLICT (coin_id, snapshot_date) DO UPDATE SET
          price_usd = EXCLUDED.price_usd, market_cap = EXCLUDED.market_cap, volume_24h = EXCLUDED.volume_24h`;
      result.coins = rows.length;
    }

    const agents = await tx<{ id: string; x402_volume_usd: unknown; x402_txn_count: unknown; productivity_score: unknown }[]>`
      SELECT id, x402_volume_usd, x402_txn_count, productivity_score FROM openclaw_agents WHERE is_active = true ${scope("project_id")}`;
    if (agents.length) {
      const rows = agents.map((a) => ({
        agent_id: a.id,
        snapshot_date: day,
        x402_volume_usd: Number(a.x402_volume_usd) || 0,
        x402_txn_count: Number(a.x402_txn_count) || 0,
        productivity_score: Number(a.productivity_score) || 0,
      }));
      await tx`INSERT INTO daily_agent_snapshots ${tx(rows)}
        ON CONFLICT (agent_id, snapshot_date) DO UPDATE SET
          x402_volume_usd = EXCLUDED.x402_volume_usd, x402_txn_count = EXCLUDED.x402_txn_count,
          productivity_score = EXCLUDED.productivity_score`;
      result.agents = rows.length;
    }

    const wallets = await tx<{ id: string; balance_usd: unknown }[]>`
      SELECT id, balance_usd FROM tracked_wallets WHERE is_active = true ${scope("project_id")}`;
    if (wallets.length) {
      const rows = wallets.map((w) => ({ wallet_id: w.id, snapshot_date: day, total_balance_usd: Number(w.balance_usd) || 0 }));
      await tx`INSERT INTO daily_wallet_snapshots ${tx(rows)}
        ON CONFLICT (wallet_id, snapshot_date) DO UPDATE SET total_balance_usd = EXCLUDED.total_balance_usd`;
      result.wallets = rows.length;
    }

    const vaults = await tx<{ id: string; tvl_usd: unknown }[]>`
      SELECT id, tvl_usd FROM agent_vaults WHERE is_active = true ${scope("project_id")}`;
    if (vaults.length) {
      const rows = vaults.map((v) => ({ vault_id: v.id, snapshot_date: day, tvl_usd: Number(v.tvl_usd) || 0 }));
      await tx`INSERT INTO daily_tvl_snapshots ${tx(rows)}
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
  const vaults = await sql<{ id: string; vault_address: string | null; chain: string | null; strategy_type: string | null; protocol: string | null }[]>`
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
      await tx`UPDATE agent_vaults SET tvl_usd = ${u.tvl}, refreshed_at = now(),
        last_refresh_status = ${u.tvl > 0 ? "ok" : "empty"} WHERE id = ${u.id}`;
      await tx`INSERT INTO daily_tvl_snapshots (vault_id, snapshot_date, tvl_usd)
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
  const ids = Array.isArray(payload.project_ids) ? (payload.project_ids as string[]) : null;
  const rows = await sql<Record<string, unknown>[]>`
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
    FROM projects p ${ids ? sql`WHERE p.id IN ${sql(ids)}` : sql``}`;

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
      await tx`UPDATE projects SET
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
