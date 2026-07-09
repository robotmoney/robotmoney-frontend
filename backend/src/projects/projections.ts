// Projects directory projection (issue #70). Ports the aggregation that
// robotmoney-bot-analytics src/pages/Projects.tsx ran client-side against Supabase
// onto the new Postgres backend: one identity row per project, enriched live from
// its facet tables (agent / coin / wallet / vault), trailing 30d revenue, and a
// 30d primary-coin price sparkline. This is the single read/projection layer; the
// HTTP route (api/routes/projects.ts) is a thin adapter over it, and the frontend
// stays a consumer over the HTTP boundary.
import { sql } from "../db/client.ts";
import type { Project, ProjectCoin, ProjectWallet, ProjectsResponse } from "@robotmoney/contract";

// Directory floor: only projects in the top coverage tier are listed (matches the
// source MIN_SCORE gate). Kept identical so parity holds across the port.
const MIN_SCORE = 55;

// postgres.js returns numeric/decimal columns as strings; coerce to a finite
// number or null so DTO consumers never see a stringified figure.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function since30(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
}

// The aggregated projects directory, sorted the way the source page loads it:
// first-load sticky pins lead, then by max coin market cap desc, then coverage
// score desc. Interactive re-sorting is a client concern (the Alpine view).
export async function fetchProjects(): Promise<ProjectsResponse> {
  const projects = await sql`
    SELECT id, slug, display_name, logo_url, description, overview_short, overview_long,
           website_url, twitter_handle, data_coverage_score, is_sticky, has_agent
    FROM projects
    WHERE status = 'active' AND data_coverage_score >= ${MIN_SCORE}
    ORDER BY data_coverage_score DESC
  `;
  if (!projects.length) return { projects: [] };

  const ids = projects.map((p) => p.id as string);

  const [coins, wallets, agents, vaults] = await Promise.all([
    sql`SELECT id, project_id, name, ticker, market_cap, fdv, percent_change_24h, price_usd, volume_24h
        FROM lobster_coins WHERE project_id IN ${sql(ids)} AND is_active = true`,
    sql`SELECT id, project_id, label, balance_usd, chain
        FROM tracked_wallets WHERE project_id IN ${sql(ids)} AND is_active = true`,
    sql`SELECT id, project_id, protocol_standard, x402_score, x402_txn_count, x402_resources_count
        FROM openclaw_agents WHERE project_id IN ${sql(ids)} AND is_active = true`,
    sql`SELECT id, project_id, tvl_usd FROM agent_vaults WHERE project_id IN ${sql(ids)} AND is_active = true`,
  ]);

  const agentIds = agents.map((a) => a.id as string);
  const coinIds = coins.map((c) => c.id as string);
  const cutoff = since30();

  const [revenue, snaps] = await Promise.all([
    agentIds.length
      ? sql`SELECT agent_id, revenue_usd FROM agent_revenue_daily
            WHERE agent_id IN ${sql(agentIds)} AND revenue_date >= ${cutoff}`
      : Promise.resolve([] as Record<string, unknown>[]),
    coinIds.length
      ? sql`SELECT coin_id, price_usd FROM daily_coin_snapshots
            WHERE coin_id IN ${sql(coinIds)} AND snapshot_date >= ${cutoff}
            ORDER BY snapshot_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  // ── Group facets by project ────────────────────────────────────────────────
  const coinsByProject = new Map<string, ProjectCoin[]>();
  const coinRawByProject = new Map<string, { id: string }[]>();
  for (const c of coins) {
    const pid = c.project_id as string | null;
    if (!pid) continue;
    (coinsByProject.get(pid) ?? coinsByProject.set(pid, []).get(pid)!).push({
      id: c.id as string,
      ticker: (c.ticker as string | null) ?? null,
      name: (c.name as string) ?? "",
      marketCap: num(c.market_cap),
      fdv: num(c.fdv),
      percentChange24h: num(c.percent_change_24h),
      priceUsd: num(c.price_usd),
      volume24h: num(c.volume_24h),
    });
    (coinRawByProject.get(pid) ?? coinRawByProject.set(pid, []).get(pid)!).push({ id: c.id as string });
  }

  const walletsByProject = new Map<string, ProjectWallet[]>();
  for (const w of wallets) {
    const pid = w.project_id as string | null;
    if (!pid) continue;
    (walletsByProject.get(pid) ?? walletsByProject.set(pid, []).get(pid)!).push({
      id: w.id as string,
      label: (w.label as string) ?? "",
      chain: (w.chain as string | null) ?? null,
      balanceUsd: num(w.balance_usd),
    });
  }

  // Agent → project map + live X402 flag (protocol_standard='x402' OR any x402
  // counter > 0), exactly as the source computed it.
  const agentToProject = new Map<string, string>();
  const x402ByProject = new Set<string>();
  const agentByProject = new Set<string>();
  for (const a of agents) {
    const pid = a.project_id as string | null;
    if (!pid) continue;
    agentToProject.set(a.id as string, pid);
    agentByProject.add(pid);
    const isX402 =
      a.protocol_standard === "x402" ||
      (num(a.x402_score) ?? 0) > 0 ||
      (num(a.x402_txn_count) ?? 0) > 0 ||
      (num(a.x402_resources_count) ?? 0) > 0;
    if (isX402) x402ByProject.add(pid);
  }

  const vaultByProject = new Set<string>();
  const tvlByProject = new Map<string, number>();
  for (const v of vaults) {
    const pid = v.project_id as string | null;
    if (!pid) continue;
    vaultByProject.add(pid);
    tvlByProject.set(pid, (tvlByProject.get(pid) ?? 0) + (num(v.tvl_usd) ?? 0));
  }

  const revenueByProject = new Map<string, number>();
  for (const r of revenue) {
    const pid = agentToProject.get(r.agent_id as string);
    if (!pid) continue;
    revenueByProject.set(pid, (revenueByProject.get(pid) ?? 0) + (num(r.revenue_usd) ?? 0));
  }

  const sparksByCoin = new Map<string, number[]>();
  for (const s of snaps) {
    const cid = s.coin_id as string;
    (sparksByCoin.get(cid) ?? sparksByCoin.set(cid, []).get(cid)!).push(num(s.price_usd) ?? 0);
  }

  // ── Assemble DTO rows ──────────────────────────────────────────────────────
  const rows: (Project & { _maxMc: number })[] = projects.map((p) => {
    const pid = p.id as string;
    const pcoins = coinsByProject.get(pid) ?? [];
    const pwallets = walletsByProject.get(pid) ?? [];
    const maxMarketCap = Math.max(0, ...pcoins.map((c) => c.marketCap ?? 0));
    const maxFdv = Math.max(0, ...pcoins.map((c) => c.fdv ?? 0));
    const maxVolume24h = Math.max(0, ...pcoins.map((c) => c.volume24h ?? 0));
    const walletTotalUsd = pwallets.reduce((s, w) => s + (w.balanceUsd ?? 0), 0);
    const primaryCoinId = coinRawByProject.get(pid)?.[0]?.id;
    const sparkline = (primaryCoinId && sparksByCoin.get(primaryCoinId)) || [];

    const facets = {
      // Trust facet-table presence over the stale has_agent column, matching the
      // source (has_agent has no facet table here, so fall back to the flag).
      agent: agentByProject.has(pid) || !!p.has_agent,
      x402: x402ByProject.has(pid),
      coin: pcoins.length > 0,
      wallet: pwallets.length > 0,
      vault: vaultByProject.has(pid),
    };

    return {
      id: pid,
      slug: p.slug as string,
      displayName: (p.display_name as string) ?? "",
      logoUrl: (p.logo_url as string | null) ?? null,
      description:
        (p.overview_short as string | null) ??
        (p.description as string | null) ??
        (p.overview_long as string | null) ??
        null,
      websiteUrl: (p.website_url as string | null) ?? null,
      twitterHandle: (p.twitter_handle as string | null) ?? null,
      dataCoverageScore: num(p.data_coverage_score),
      isSticky: !!p.is_sticky,
      facets,
      coins: pcoins,
      wallets: pwallets,
      walletTotalUsd,
      revenue30d: revenueByProject.get(pid) ?? 0,
      maxMarketCap,
      maxFdv,
      sparkline,
      volume24h: maxVolume24h,
      tvlUsd: tvlByProject.get(pid) ?? 0,
      _maxMc: maxMarketCap,
    };
  });

  // Default sort: sticky first (first-load pin), then max market cap desc, then
  // coverage score desc — projects without coins sink to the bottom.
  rows.sort((a, b) => {
    if (a.isSticky !== b.isSticky) return a.isSticky ? -1 : 1;
    if (b._maxMc !== a._maxMc) return b._maxMc - a._maxMc;
    return (b.dataCoverageScore ?? 0) - (a.dataCoverageScore ?? 0);
  });

  return { projects: rows.map(({ _maxMc, ...row }) => row) };
}
