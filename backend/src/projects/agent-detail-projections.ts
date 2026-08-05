// /agents/:id "Money-agent dossier" AgentProfile projection (issue #390,
// docs/bot-analytics-ui-port-plan.md §5.8, P3.2). One agent's full detail:
// identity + socials (via its project), trust-evidence rail, x402/wallet
// money strip inputs, a 26-week x402-volume series for the PerformanceChart,
// and its project's vaults/wallets (§5.7's `fetchAgentsDirectory` in
// agents-projections.ts is the directory-row sibling this shares its
// composite-score formula and weekly-bucketing helper with — kept as
// page-local copies here, matching that file's own documented precedent,
// rather than a premature shared module for two call sites).
//
// Real data only (honesty contract, docs/architecture.md §11, issues
// #98/#346): a missing agent id returns `null` (the route adapter turns
// that into a 404), never a fabricated row. Every derived field below
// (evidence status, whyIncluded/openGaps copy, wallet status) is computed
// from real columns already on openclaw_agents/projects/tracked_wallets/
// agent_vaults — nothing here invents a number or a proof that doesn't
// exist in the database.
//
// Two fields the plan's original source app carried do NOT exist in this
// schema and are honestly omitted rather than guessed: `discovery_source`
// (no column) and x402 "unique buyers" (no column — x402_resources_count is
// the only x402 dimension beyond txns/volume/score). The Voting & Reputation
// section (§5.8: "hidden until agent_score_votes backing exists, P1.6") and
// the Recent Transactions Blockscout trail (§5.8: "Via P1.7 proxy" — no
// onchain proxy endpoint exists in this repo yet) are likewise NOT rendered
// by the frontend view — both are their own separate, already-planned work
// items (P1.6/P1.7), and per D10's "never render a button that does
// nothing" precedent this issue does not stub either as a dead control.
import { sql } from "../db/client.ts";
import type { AgentDetail, AgentEvidence, AgentVaultSummary, AgentWalletSummary } from "@robotmoney/contract";

export type { AgentDetail };

// openclaw_agents.id is a `uuid PRIMARY KEY` — pre-validating the shape means
// an arbitrary/malformed :id segment (e.g. the dash-shell smoke test's
// `/agents/clawd` placeholder) resolves to this function's existing null →
// 404 contract instead of a Postgres "invalid input syntax for type uuid"
// 500 (same convention as dossier-projections.ts's UUID_RE).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// postgres.js returns numeric/decimal columns as strings; coerce to a finite
// number or null (page-local copy — see agents-projections.ts's own copy of
// this same helper for why it isn't shared yet).
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  const deltaToMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return d.toISOString().slice(0, 10);
}

// "sum" weekly bucketing only — this file's one series is x402 volume
// (§4.3's `agg: "sum"` row), so the `agg:"last"` branch agents-projections.ts
// carries is dropped here rather than copied unused.
function toWeeklySumBuckets(rows: { date: string; value: number }[], weeks: number): number[] {
  if (rows.length === 0) return [];
  const byWeek = new Map<string, number>();
  for (const r of rows) {
    const wk = mondayOf(r.date);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + r.value);
  }
  const weekKeys = [...byWeek.keys()].sort();
  const firstWeek = weekKeys[0];
  const lastWeek = weekKeys[weekKeys.length - 1];
  const allWeeks: string[] = [];
  let cursor = firstWeek;
  while (cursor <= lastWeek) {
    allWeeks.push(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    cursor = d.toISOString().slice(0, 10);
  }
  const trimmed = allWeeks.slice(-weeks);
  return trimmed.map((wk) => byWeek.get(wk) ?? 0);
}

// Same composite formula as agents-projections.ts's compositeScore (§5.7) —
// kept in sync deliberately: the dossier's "Evidence score" must equal the
// directory row's SCORE column for the same agent.
function compositeScore(x402Score: number | null, productivityScore: number | null, revenue30d: number): number {
  const revenueProxy = Math.min(100, Math.log10(Math.max(0, revenue30d) + 1) * 25);
  return Math.max(x402Score ?? 0, productivityScore ?? 0, revenueProxy);
}

const WEEKS = 26;
const FRESH_DAYS = 14;
const STALE_DAYS = 60;

export async function fetchAgentDetail(id: string): Promise<AgentDetail | null> {
  if (!UUID_RE.test(id)) return null;

  const [agent] = await sql`
    SELECT a.id, a.name, a.protocol_standard, a.x402_score, a.x402_txn_count, a.x402_resources_count,
           a.x402_volume_usd, a.cumulative_revenue_usd, a.productivity_score, a.is_active,
           a.wallet_address, a.source_confidence, a.enriched_at, a.created_at, a.project_id,
           p.overview_short, p.website_url, p.twitter_handle
    FROM openclaw_agents a
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.id = ${id}
  `;
  if (!agent) return null;

  const cutoff30 = since(30);
  const cutoff182 = since(7 * WEEKS);

  const [revenueRows, snapRows, wallets, vaults] = await Promise.all([
    sql`SELECT revenue_date::text AS revenue_date, revenue_usd FROM agent_revenue_daily
        WHERE agent_id = ${id} AND revenue_date >= ${cutoff30}`,
    sql`SELECT snapshot_date::text AS snapshot_date, x402_volume_usd FROM daily_agent_snapshots
        WHERE agent_id = ${id} AND snapshot_date >= ${cutoff182}`,
    agent.project_id
      ? sql`SELECT id, label, address, chain, balance_usd FROM tracked_wallets WHERE project_id = ${agent.project_id as string}`
      : Promise.resolve([] as Record<string, unknown>[]),
    agent.project_id
      ? sql`SELECT id, name, strategy_type, tvl_usd, yield_apy FROM agent_vaults WHERE project_id = ${agent.project_id as string}`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const revenue30 = revenueRows.reduce((s, r) => s + (num(r.revenue_usd) ?? 0), 0);
  const x402Sparkline = toWeeklySumBuckets(
    snapRows.map((s) => ({ date: s.snapshot_date as string, value: num(s.x402_volume_usd) ?? 0 })),
    WEEKS,
  );

  const walletAddress = (agent.wallet_address as string | null) ?? null;
  const walletAddrLower = walletAddress?.toLowerCase() ?? null;
  const matched = walletAddrLower ? wallets.find((w) => (w.address as string | null)?.toLowerCase() === walletAddrLower) : undefined;
  const walletBalanceUsd = matched ? num(matched.balance_usd) : null;

  const walletList: AgentWalletSummary[] = wallets.map((w) => ({
    id: w.id as string,
    label: (w.label as string) ?? "",
    address: (w.address as string | null) ?? null,
    chain: (w.chain as string | null) ?? null,
    balanceUsd: num(w.balance_usd),
    isAgentWallet: !!matched && w.id === matched.id,
  }));

  const vaultList: AgentVaultSummary[] = vaults.map((v) => ({
    id: v.id as string,
    name: (v.name as string) ?? "",
    strategyType: (v.strategy_type as string | null) ?? null,
    tvlUsd: num(v.tvl_usd),
    apy: num(v.yield_apy),
  }));

  const x402Score = num(agent.x402_score);
  const productivityScore = num(agent.productivity_score);
  const x402Txns = num(agent.x402_txn_count) ?? 0;
  const x402VolumeUsd = num(agent.x402_volume_usd) ?? 0;
  const cumulativeRevenueUsd = num(agent.cumulative_revenue_usd);
  const enrichedAt = (agent.enriched_at as string | null) ?? null;
  const websiteUrl = (agent.website_url as string | null) ?? null;
  const twitterHandle = (agent.twitter_handle as string | null) ?? null;

  // ── Evidence rail (§5.8) — deterministic, over real columns only ────────
  const daysSince = (iso: string | null): number | null => {
    if (!iso) return null;
    const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    return Number.isFinite(d) ? d : null;
  };
  const freshDays = daysSince(enrichedAt);

  const evidence: AgentEvidence = {
    wallet: walletAddress ? (walletBalanceUsd != null && walletBalanceUsd > 0 ? "verified" : "partial") : "missing",
    moneyIn: revenue30 > 0 ? "verified" : (cumulativeRevenueUsd ?? 0) > 0 ? "partial" : "missing",
    x402: x402Txns > 0 ? "verified" : "missing",
    identity: websiteUrl || twitterHandle ? "verified" : "missing",
    freshness: freshDays == null ? "missing" : freshDays <= FRESH_DAYS ? "verified" : freshDays <= STALE_DAYS ? "partial" : "missing",
  };

  const whyIncluded: string[] = [];
  const openGaps: string[] = [];
  if (evidence.wallet === "verified") whyIncluded.push("Wallet balance verified against a tracked, matched address.");
  else openGaps.push(evidence.wallet === "partial" ? "Wallet linked but no positive tracked balance yet." : "No wallet address linked yet.");
  if (evidence.moneyIn === "verified") whyIncluded.push(`Trailing-30d revenue recorded ($${revenue30.toFixed(2)}).`);
  else openGaps.push(evidence.moneyIn === "partial" ? "Historical revenue exists, but none in the trailing 30 days." : "No recorded revenue yet.");
  if (evidence.x402 === "verified") whyIncluded.push(`x402 usage recorded (${x402Txns} txns).`);
  else openGaps.push("No x402 transaction history recorded yet.");
  if (evidence.identity === "verified") whyIncluded.push("Website or social identity on file.");
  else openGaps.push("No website or social link on file.");
  if (evidence.freshness === "verified") whyIncluded.push("Enrichment data is fresh (within 14 days).");
  else openGaps.push(evidence.freshness === "partial" ? "Enrichment data is aging (14-60 days old)." : "Enrichment data is stale or missing.");

  return {
    id: agent.id as string,
    name: (agent.name as string) ?? "",
    protocol: (agent.protocol_standard as string | null) ?? null,
    isFacilitator: agent.protocol_standard === "facilitator",
    active: !!agent.is_active,
    description: (agent.overview_short as string | null) ?? null,
    websiteUrl,
    twitterHandle,
    walletAddress,
    walletBalanceUsd,
    createdAt: (agent.created_at as Date).toISOString?.() ?? String(agent.created_at),
    enrichedAt,
    confidence: (agent.source_confidence as "high" | "medium" | "low" | null) ?? null,
    score: compositeScore(x402Score, productivityScore, revenue30),
    x402Score,
    x402Txns,
    x402VolumeUsd,
    x402Resources: num(agent.x402_resources_count) ?? 0,
    revenue30dUsd: revenue30,
    cumulativeRevenueUsd,
    productivityScore,
    x402Sparkline,
    evidence,
    whyIncluded,
    openGaps,
    vaults: vaultList,
    wallets: walletList,
  };
}
