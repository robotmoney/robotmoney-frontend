// ProjectProfile "dossier" projection (issue #389, docs/bot-analytics-ui-
// port-plan.md §5.5, P3.1) — GET /api/projects/:slug. One project's full
// detail: hero fields, KPI strip, all four facet tables in full, a 90d
// raw-daily history series (P1.2: "raw daily mode for profile charts", NOT
// the 26-week bucketing /list and /agents use), a small set of derived ratio
// tiles, and an activity feed scoped to this project's agents.
//
// Real data only (honesty contract, docs/architecture.md §11, issues
// #98/#346): every aggregate here is computed from the SAME facet/snapshot
// tables `projects/projections.ts` (the /projects directory) reads — a
// project that exists but has no coin/wallet/vault/agent rows yet returns
// honestly empty arrays and zeroed KPIs, never fabricated figures.
//
// Two sections the plan (§5.5, §6) describes are deliberately NOT part of
// this DTO — see contract/src/projects.d.ts's ProjectDetail doc comment for
// the full rationale (no `wallet_holdings`-equivalent table for Holdings; no
// buyer/holder column anywhere in this schema for Buyers/Txn).
import { sql } from "../db/client.ts";
import type {
  ProjectActivityEntry,
  ProjectDetail,
  ProjectDetailAgent,
  ProjectDetailCoin,
  ProjectDetailVault,
  ProjectDetailWallet,
  ProjectHistoryPoint,
  ProjectKpis,
  ProjectRatios,
} from "@robotmoney/contract";
import {
  COIN_REFRESH_FRESHNESS_BUDGET_MS,
  isStale,
  num,
  selectPrimaryCoinId,
  WALLET_REFRESH_FRESHNESS_BUDGET_MS,
} from "./projections.ts";

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// §5.6's own "50 fetched" cap on the shared agent_activity_log table applies
// here too, scaled down to the plan's project-scoped figure ("30 max, max-h-96
// scroll").
const ACTIVITY_FETCH_LIMIT = 30;

// NOTE: unlike fetchProjects() (the directory), this does NOT apply the
// MIN_SCORE coverage-tier gate — a direct /projects/:slug link to a real,
// active project should resolve even if that project doesn't (yet) clear the
// directory listing's bar. `status = 'active'` is still enforced so a
// pending-review/inactive project 404s the same as an unknown slug.
export async function fetchProjectDetail(slug: string): Promise<ProjectDetail | null> {
  const [project] = await sql`
    SELECT id, slug, display_name, logo_url, overview_short, overview_long,
           website_url, twitter_handle, data_coverage_score, is_sticky,
           breadth_score, identity_score, onchain_score, activity_score,
           coverage_calculated_at, has_agent
    FROM projects
    WHERE slug = ${slug} AND status = 'active'
  `;
  if (!project) return null;

  const pid = project.id as string;

  const [agents, coins, wallets, vaults] = await Promise.all([
    sql`SELECT id, name, protocol_standard, x402_score, x402_txn_count, x402_resources_count,
               x402_volume_usd, productivity_score, is_active
        FROM openclaw_agents WHERE project_id = ${pid} AND is_active = true`,
    sql`SELECT id, name, ticker, market_cap, fdv, percent_change_24h, price_usd, volume_24h,
               chain, refreshed_at
        FROM lobster_coins WHERE project_id = ${pid} AND is_active = true`,
    sql`SELECT id, label, chain, balance_usd, address, last_tx_at, refreshed_at
        FROM tracked_wallets WHERE project_id = ${pid} AND is_active = true`,
    sql`SELECT id, name, protocol, chain, strategy_type, tvl_usd, yield_apy, vault_address, refreshed_at
        FROM agent_vaults WHERE project_id = ${pid} AND is_active = true`,
  ]);

  const agentIds = agents.map((a) => a.id as string);
  const coinIds = coins.map((c) => c.id as string);
  const walletIds = wallets.map((w) => w.id as string);
  const vaultIds = vaults.map((v) => v.id as string);
  const cutoff30 = since(30);
  const cutoff90 = since(90);

  const [revenue90, coinSnaps90, agentSnaps90, walletSnaps90, vaultSnaps90, activityRows] = await Promise.all([
    agentIds.length
      ? sql`SELECT agent_id, revenue_usd, revenue_date::text AS revenue_date FROM agent_revenue_daily
            WHERE agent_id IN ${sql(agentIds)} AND revenue_date >= ${cutoff90} ORDER BY revenue_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    coinIds.length
      ? sql`SELECT coin_id, snapshot_date::text AS snapshot_date, price_usd, market_cap FROM daily_coin_snapshots
            WHERE coin_id IN ${sql(coinIds)} AND snapshot_date >= ${cutoff90} ORDER BY snapshot_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    agentIds.length
      ? sql`SELECT agent_id, snapshot_date::text AS snapshot_date, productivity_score FROM daily_agent_snapshots
            WHERE agent_id IN ${sql(agentIds)} AND snapshot_date >= ${cutoff90} ORDER BY snapshot_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    walletIds.length
      ? sql`SELECT wallet_id, snapshot_date::text AS snapshot_date, total_balance_usd FROM daily_wallet_snapshots
            WHERE wallet_id IN ${sql(walletIds)} AND snapshot_date >= ${cutoff90} ORDER BY snapshot_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    vaultIds.length
      ? sql`SELECT vault_id, snapshot_date::text AS snapshot_date, tvl_usd FROM daily_tvl_snapshots
            WHERE vault_id IN ${sql(vaultIds)} AND snapshot_date >= ${cutoff90} ORDER BY snapshot_date ASC`
      : Promise.resolve([] as Record<string, unknown>[]),
    agentIds.length
      ? sql`SELECT al.id, al.occurred_at, al.agent_id, al.agent_name, oa.name AS live_agent_name,
                   al.action_type, al.status, al.commit_summary
            FROM agent_activity_log al
            LEFT JOIN openclaw_agents oa ON oa.id = al.agent_id
            WHERE al.agent_id IN ${sql(agentIds)} AND (al.score IS NULL OR al.score <> 0)
            ORDER BY al.occurred_at DESC
            LIMIT ${ACTIVITY_FETCH_LIMIT}`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  // ── Per-agent revenue (30d for the KPI/table, per-date for history/ratios) ──
  const revenue30ByAgent = new Map<string, number>();
  const revenueByDate = new Map<string, number>();
  for (const r of revenue90) {
    const agentId = r.agent_id as string;
    const date = r.revenue_date as string;
    const usd = num(r.revenue_usd) ?? 0;
    revenueByDate.set(date, (revenueByDate.get(date) ?? 0) + usd);
    if (date >= cutoff30) revenue30ByAgent.set(agentId, (revenue30ByAgent.get(agentId) ?? 0) + usd);
  }
  const revenue30dUsd = [...revenue30ByAgent.values()].reduce((s, v) => s + v, 0);

  // ── Coin price/market-cap by date (primary coin only, for history) + per-coin
  // 90d sparkline (for the Tokens facet table) ──────────────────────────────
  const primaryCoinId = selectPrimaryCoinId(
    coins.map((c) => ({ id: c.id as string, marketCap: num(c.market_cap) })),
  );
  const priceByDate = new Map<string, number>();
  const marketCapByDate = new Map<string, number>();
  const sparkByCoin = new Map<string, number[]>();
  for (const s of coinSnaps90) {
    const coinId = s.coin_id as string;
    const date = s.snapshot_date as string;
    const price = num(s.price_usd);
    (sparkByCoin.get(coinId) ?? sparkByCoin.set(coinId, []).get(coinId)!).push(price ?? 0);
    if (coinId === primaryCoinId) {
      if (price != null) priceByDate.set(date, price);
      const mc = num(s.market_cap);
      if (mc != null) marketCapByDate.set(date, mc);
    }
  }

  // ── Treasury by date (wallets + vaults) ──────────────────────────────────
  const walletBalByDate = new Map<string, number>();
  for (const s of walletSnaps90) {
    const date = s.snapshot_date as string;
    walletBalByDate.set(date, (walletBalByDate.get(date) ?? 0) + (num(s.total_balance_usd) ?? 0));
  }
  const vaultTvlByDate = new Map<string, number>();
  for (const s of vaultSnaps90) {
    const date = s.snapshot_date as string;
    vaultTvlByDate.set(date, (vaultTvlByDate.get(date) ?? 0) + (num(s.tvl_usd) ?? 0));
  }

  // ── Avg productivity by date ──────────────────────────────────────────────
  const prodSumByDate = new Map<string, { sum: number; n: number }>();
  for (const s of agentSnaps90) {
    const date = s.snapshot_date as string;
    const score = num(s.productivity_score);
    if (score == null) continue;
    const cur = prodSumByDate.get(date) ?? { sum: 0, n: 0 };
    cur.sum += score;
    cur.n += 1;
    prodSumByDate.set(date, cur);
  }

  // ── Assemble history: union of every date any metric covers, chronological ──
  const allDates = new Set<string>([
    ...priceByDate.keys(),
    ...marketCapByDate.keys(),
    ...revenueByDate.keys(),
    ...walletBalByDate.keys(),
    ...vaultTvlByDate.keys(),
    ...prodSumByDate.keys(),
  ]);
  const history: ProjectHistoryPoint[] = [...allDates].sort().map((date) => {
    const wb = walletBalByDate.get(date);
    const vt = vaultTvlByDate.get(date);
    const treasury = wb == null && vt == null ? null : (wb ?? 0) + (vt ?? 0);
    const prod = prodSumByDate.get(date);
    return {
      date,
      tokenPriceUsd: priceByDate.get(date) ?? null,
      marketCapUsd: marketCapByDate.get(date) ?? null,
      dailyRevenueUsd: revenueByDate.has(date) ? revenueByDate.get(date)! : null,
      treasuryUsd: treasury,
      avgProductivity: prod ? prod.sum / prod.n : null,
    };
  });

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const marketCapUsd = coins.length ? Math.max(0, ...coins.map((c) => num(c.market_cap) ?? 0)) : null;
  const fdvUsd = coins.length ? Math.max(0, ...coins.map((c) => num(c.fdv) ?? 0)) : null;
  const walletBalanceUsd = wallets.reduce((s, w) => s + (num(w.balance_usd) ?? 0), 0);
  const walletCount = wallets.length;
  const vaultTvlUsd = vaults.reduce((s, v) => s + (num(v.tvl_usd) ?? 0), 0);
  const vaultWeightedApy =
    vaultTvlUsd > 0
      ? vaults.reduce((s, v) => s + (num(v.tvl_usd) ?? 0) * (num(v.yield_apy) ?? 0), 0) / vaultTvlUsd
      : null;
  const x402VolumeUsd = agents.reduce((s, a) => s + (num(a.x402_volume_usd) ?? 0), 0);
  const x402TxnCount = agents.reduce((s, a) => s + (num(a.x402_txn_count) ?? 0), 0);
  const psRatioAnnualized =
    marketCapUsd != null && revenue30dUsd > 0 ? marketCapUsd / ((revenue30dUsd * 365) / 30) : null;

  const kpis: ProjectKpis = {
    marketCapUsd,
    fdvUsd,
    revenue30dUsd,
    psRatioAnnualized,
    walletBalanceUsd,
    walletCount,
    vaultTvlUsd,
    vaultWeightedApy,
    x402VolumeUsd,
    x402TxnCount,
  };

  // ── Ratios ────────────────────────────────────────────────────────────────
  const last15 = since(15);
  let rev15 = 0;
  let revPrior15 = 0;
  for (const [date, usd] of revenueByDate) {
    if (date >= last15) rev15 += usd;
    else if (date >= cutoff30) revPrior15 += usd;
  }
  const revenueGrowthPct = revPrior15 > 0 ? ((rev15 - revPrior15) / revPrior15) * 100 : null;
  const treasuryTotal = walletBalanceUsd + vaultTvlUsd;
  const capitalEfficiency = revenue30dUsd > 0 && treasuryTotal > 0 ? revenue30dUsd / treasuryTotal : null;

  const ratios: ProjectRatios = {
    psRatioAnnualized,
    fdvToMarketCap: fdvUsd != null && marketCapUsd ? fdvUsd / marketCapUsd : null,
    tvlToMarketCap: marketCapUsd ? vaultTvlUsd / marketCapUsd : null,
    revenueGrowthPct,
    capitalEfficiency,
  };

  // ── Facet rows ────────────────────────────────────────────────────────────
  const agentRows: ProjectDetailAgent[] = agents.map((a) => ({
    id: a.id as string,
    name: (a.name as string) ?? "",
    href: `/agents/${a.id}`,
    protocolStandard: (a.protocol_standard as string | null) ?? null,
    isActive: !!a.is_active,
    x402Score: num(a.x402_score),
    x402TxnCount: num(a.x402_txn_count),
    x402VolumeUsd: num(a.x402_volume_usd),
    revenue30dUsd: revenue30ByAgent.get(a.id as string) ?? 0,
    productivityScore: num(a.productivity_score),
  }));

  const coinRows: ProjectDetailCoin[] = coins.map((c) => {
    const refreshedAt = c.refreshed_at ? new Date(c.refreshed_at as string | Date) : null;
    return {
      id: c.id as string,
      ticker: (c.ticker as string | null) ?? null,
      name: (c.name as string) ?? "",
      marketCap: num(c.market_cap),
      fdv: num(c.fdv),
      percentChange24h: num(c.percent_change_24h),
      priceUsd: num(c.price_usd),
      volume24h: num(c.volume_24h),
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, COIN_REFRESH_FRESHNESS_BUDGET_MS),
      chain: (c.chain as string | null) ?? null,
      sparkline90d: sparkByCoin.get(c.id as string) ?? [],
    };
  });

  const walletRows: ProjectDetailWallet[] = wallets.map((w) => {
    const refreshedAt = w.refreshed_at ? new Date(w.refreshed_at as string | Date) : null;
    return {
      id: w.id as string,
      label: (w.label as string) ?? "",
      chain: (w.chain as string | null) ?? null,
      balanceUsd: num(w.balance_usd),
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
      address: (w.address as string | null) ?? null,
      lastTxAt: w.last_tx_at ? new Date(w.last_tx_at as string | Date).toISOString() : null,
    };
  });

  const vaultRows: ProjectDetailVault[] = vaults.map((v) => {
    const refreshedAt = v.refreshed_at ? new Date(v.refreshed_at as string | Date) : null;
    return {
      id: v.id as string,
      name: (v.name as string) ?? "",
      protocol: (v.protocol as string | null) ?? null,
      chain: (v.chain as string | null) ?? null,
      strategyType: (v.strategy_type as string | null) ?? null,
      tvlUsd: num(v.tvl_usd),
      yieldApy: num(v.yield_apy),
      vaultAddress: (v.vault_address as string | null) ?? null,
      refreshedAt: refreshedAt ? refreshedAt.toISOString() : null,
      stale: isStale(refreshedAt, WALLET_REFRESH_FRESHNESS_BUDGET_MS),
    };
  });

  // ── Activity feed (P1.6 — always [] until agent_activity_log has a writer;
  // see ProjectDetail's doc comment) ────────────────────────────────────────
  const activity: ProjectActivityEntry[] = activityRows.map((r) => ({
    id: r.id as string,
    occurredAt: new Date(r.occurred_at as string | Date).toISOString(),
    agentId: (r.agent_id as string | null) ?? null,
    agentName: (r.live_agent_name as string | null) ?? (r.agent_name as string) ?? "",
    agentHref: r.agent_id ? `/agents/${r.agent_id}` : null,
    actionType: r.action_type as string,
    status: r.status as ProjectActivityEntry["status"],
    commitSummary: (r.commit_summary as string | null) ?? null,
  }));

  // ── Hero derived fields ───────────────────────────────────────────────────
  const primaryChain =
    coins.find((c) => c.chain)?.chain ??
    wallets.find((w) => w.chain)?.chain ??
    vaults.find((v) => v.chain)?.chain ??
    null;

  let sparkline: number[] = (primaryCoinId && sparkByCoin.get(primaryCoinId)) || [];
  if (sparkline.length === 0) {
    // Same tokenless fallback as the directory row (issue #338): trailing
    // agent activity/revenue by date, chronological.
    const byDate = new Map<string, number>();
    for (const s of agentSnaps90) {
      const date = s.snapshot_date as string;
      const score = num(s.productivity_score) ?? 0;
      if (score > 0) byDate.set(date, (byDate.get(date) ?? 0) + score);
    }
    if (byDate.size === 0) {
      for (const [date, usd] of revenueByDate) if (usd > 0) byDate.set(date, usd);
    }
    sparkline = [...byDate.entries()].sort(([d1], [d2]) => d1.localeCompare(d2)).map(([, v]) => v);
  }

  const facets = {
    agent: agents.length > 0 || !!project.has_agent,
    x402: agents.some(
      (a) =>
        a.protocol_standard === "x402" ||
        (num(a.x402_score) ?? 0) > 0 ||
        (num(a.x402_txn_count) ?? 0) > 0 ||
        (num(a.x402_resources_count) ?? 0) > 0,
    ),
    coin: coins.length > 0,
    wallet: wallets.length > 0,
    vault: vaults.length > 0,
  };

  return {
    id: pid,
    slug: project.slug as string,
    displayName: (project.display_name as string) ?? "",
    logoUrl: (project.logo_url as string | null) ?? null,
    overviewShort: (project.overview_short as string | null) ?? null,
    overviewLong: (project.overview_long as string | null) ?? null,
    websiteUrl: (project.website_url as string | null) ?? null,
    twitterHandle: (project.twitter_handle as string | null) ?? null,
    primaryChain,
    dataCoverageScore: num(project.data_coverage_score),
    breadthScore: num(project.breadth_score),
    identityScore: num(project.identity_score),
    onchainScore: num(project.onchain_score),
    activityScore: num(project.activity_score),
    coverageCalculatedAt: project.coverage_calculated_at
      ? new Date(project.coverage_calculated_at as string | Date).toISOString()
      : null,
    isSticky: !!project.is_sticky,
    facets,
    sparkline,
    kpis,
    ratios,
    agents: agentRows,
    coins: coinRows,
    wallets: walletRows,
    vaults: vaultRows,
    history,
    activity,
  };
}
