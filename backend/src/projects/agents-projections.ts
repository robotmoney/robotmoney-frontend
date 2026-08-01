// /agents "OpenClaw Agents" directory projection (issue #385,
// docs/bot-analytics-ui-port-plan.md §5.7, P2.2). Ports the retired
// robotmoney-bot-analytics Agents.tsx aggregation onto this repo's Postgres
// backend: one row per tracked agent (openclaw_agents), spanning every
// project — not the /projects directory's MIN_SCORE gate, and not grouped by
// project the way projects/projections.ts is. `backend/src/api/routes/
// dashboards.ts` is the thin adapter that exposes this as
// GET /api/dashboards/agents.
//
// Real data only (honesty contract, docs/architecture.md §11, issues
// #98/#346): a fresh deploy with empty tables returns `{ agents: [],
// summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0,
// totalBalanceUsd: 0 } }`, never fabricated rows.
//
// Wallet balance (§5.7's WALLET/BALANCE columns) is resolved the same way the
// plan describes for the P1.1 endpoint: joining wallet balances by the
// agent's own `wallet_address` against `tracked_wallets.address`,
// case-insensitively (the two tables are populated by independent discovery
// passes and never agree on address case).
//
// Sparkline note (§4.3): the canonical `toWeeklyBuckets` helper is P0.5's job
// (issue #381, not yet landed as of this issue) — weekly bucketing here is a
// page-local stand-in, matching the precedent already set in
// entities-projections.ts (issue #384) and alpine/views/projects.js's
// sparkSvg(). Semantics match the plan: 26 Monday-anchored weeks, "last"
// (forward-filled) aggregation for score/balance series, "sum" for the x402
// volume series.
import { sql } from "../db/client.ts";
import type { AgentDirectoryRow, AgentsDirectoryResponse, AgentsDirectorySummary } from "@robotmoney/contract";

export type { AgentDirectoryRow, AgentsDirectoryResponse, AgentsDirectorySummary };

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// postgres.js returns numeric/decimal columns as strings; coerce to a finite
// number or null so DTO consumers never see a stringified figure. (Page-local
// copy of the same helper projections.ts keeps private — see file header.)
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Monday of the UTC week containing `dateStr` (YYYY-MM-DD), as YYYY-MM-DD.
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const deltaToMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return d.toISOString().slice(0, 10);
}

// Page-local stand-in for the plan's shared `toWeeklyBuckets` (see file
// header). `agg: "last"` forward-fills the previous week's value into any
// week with no rows; `agg: "sum"` leaves gaps as 0. Returns up to `weeks`
// buckets, oldest first — fewer when the entity has less history (never
// fabricated padding).
function toWeeklyBuckets(rows: { date: string; value: number }[], weeks: number, agg: "last" | "sum"): number[] {
  if (rows.length === 0) return [];
  const byWeek = new Map<string, number[]>();
  for (const r of rows) {
    const wk = mondayOf(r.date);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(r.value);
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
  let carry = 0;
  const out: number[] = [];
  for (const wk of trimmed) {
    const vals = byWeek.get(wk);
    if (agg === "sum") {
      out.push(vals ? vals.reduce((s, v) => s + v, 0) : 0);
    } else {
      if (vals && vals.length) carry = vals[vals.length - 1];
      out.push(carry);
    }
  }
  return out;
}

// Composite SCORE (§5.7): max(x402_score, productivity_score, a log-scaled
// trailing-30d-revenue proxy) so an agent with strong revenue but no x402/
// productivity signal (yet) isn't scored zero. Capped at 100 to match the
// other two inputs' own [0,100] range.
function compositeScore(x402Score: number | null, productivityScore: number | null, revenue30d: number): number {
  const revenueProxy = Math.min(100, Math.log10(Math.max(0, revenue30d) + 1) * 25);
  return Math.max(x402Score ?? 0, productivityScore ?? 0, revenueProxy);
}

const WEEKS = 26;

export async function fetchAgentsDirectory(): Promise<AgentsDirectoryResponse> {
  const agents = await sql`
    SELECT id, name, protocol_standard, x402_score, x402_txn_count, x402_volume_usd,
           productivity_score, is_active, wallet_address
    FROM openclaw_agents
  `;
  if (!agents.length) {
    return { agents: [], summary: { active: 0, idle: 0, x402Txns: 0, x402VolumeUsd: 0, totalBalanceUsd: 0 } };
  }

  const agentIds = agents.map((a) => a.id as string);
  const cutoff30 = since(30);
  const cutoff182 = since(7 * WEEKS);

  // Wallet balances: match by lowercased address (§5.7 — the two tables are
  // populated by independent discovery passes and never agree on case).
  const wallets = await sql`SELECT id, address, balance_usd FROM tracked_wallets WHERE address IS NOT NULL`;
  const walletByAddr = new Map<string, { id: string; balanceUsd: number | null }>();
  for (const w of wallets) {
    const addr = (w.address as string | null)?.toLowerCase();
    if (!addr) continue;
    walletByAddr.set(addr, { id: w.id as string, balanceUsd: num(w.balance_usd) });
  }

  const matchedWalletIds = new Set<string>();
  for (const a of agents) {
    const addr = (a.wallet_address as string | null)?.toLowerCase();
    if (!addr) continue;
    const w = walletByAddr.get(addr);
    if (w) matchedWalletIds.add(w.id);
  }

  const [revenue, agentSnaps, walletSnaps] = await Promise.all([
    sql`SELECT agent_id, revenue_date::text AS revenue_date, revenue_usd FROM agent_revenue_daily
        WHERE agent_id IN ${sql(agentIds)} AND revenue_date >= ${cutoff30}`,
    sql`SELECT agent_id, snapshot_date::text AS snapshot_date, x402_volume_usd, productivity_score
        FROM daily_agent_snapshots WHERE agent_id IN ${sql(agentIds)} AND snapshot_date >= ${cutoff182}`,
    matchedWalletIds.size
      ? sql`SELECT wallet_id, snapshot_date::text AS snapshot_date, total_balance_usd FROM daily_wallet_snapshots
            WHERE wallet_id IN ${sql([...matchedWalletIds])} AND snapshot_date >= ${cutoff182}`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const rev30ByAgent = new Map<string, number>();
  for (const r of revenue) {
    const id = r.agent_id as string;
    rev30ByAgent.set(id, (rev30ByAgent.get(id) ?? 0) + (num(r.revenue_usd) ?? 0));
  }

  const scoreSnapsByAgent = new Map<string, { date: string; value: number }[]>();
  const volSnapsByAgent = new Map<string, { date: string; value: number }[]>();
  for (const s of agentSnaps) {
    const id = s.agent_id as string;
    const date = s.snapshot_date as string;
    (scoreSnapsByAgent.get(id) ?? scoreSnapsByAgent.set(id, []).get(id)!).push({ date, value: num(s.productivity_score) ?? 0 });
    (volSnapsByAgent.get(id) ?? volSnapsByAgent.set(id, []).get(id)!).push({ date, value: num(s.x402_volume_usd) ?? 0 });
  }

  const balSnapsByWallet = new Map<string, { date: string; value: number }[]>();
  for (const s of walletSnaps) {
    const id = s.wallet_id as string;
    (balSnapsByWallet.get(id) ?? balSnapsByWallet.set(id, []).get(id)!).push({
      date: s.snapshot_date as string,
      value: num(s.total_balance_usd) ?? 0,
    });
  }

  const rows: AgentDirectoryRow[] = agents.map((a) => {
    const id = a.id as string;
    const rev30 = rev30ByAgent.get(id) ?? 0;
    const x402Score = num(a.x402_score);
    const productivityScore = num(a.productivity_score);
    const walletAddress = (a.wallet_address as string | null) ?? null;
    const matchedWallet = walletAddress ? walletByAddr.get(walletAddress.toLowerCase()) : undefined;
    const protocol = (a.protocol_standard as string | null) ?? null;

    return {
      id,
      name: (a.name as string) ?? "",
      protocol,
      isFacilitator: protocol === "facilitator",
      active: !!a.is_active,
      score: compositeScore(x402Score, productivityScore, rev30),
      x402Txns: num(a.x402_txn_count) ?? 0,
      x402VolumeUsd: num(a.x402_volume_usd) ?? 0,
      balanceUsd: matchedWallet?.balanceUsd ?? null,
      walletAddress,
      sparkline: {
        score: toWeeklyBuckets(scoreSnapsByAgent.get(id) ?? [], WEEKS, "last"),
        x402: toWeeklyBuckets(volSnapsByAgent.get(id) ?? [], WEEKS, "sum"),
        balance: matchedWallet ? toWeeklyBuckets(balSnapsByWallet.get(matchedWallet.id) ?? [], WEEKS, "last") : [],
      },
    };
  });

  // Summary strip (§5.7): "{active} active / {idle} idle · x402 txns: N ·
  // x402 vol: $N · Total balance: $N". Counted over active rows only, matching
  // the /list overview's convention (issue #384) of excluding pending/inactive
  // rows from headline aggregates.
  const activeRows = rows.filter((r) => r.active);
  const summary: AgentsDirectorySummary = {
    active: activeRows.length,
    idle: rows.length - activeRows.length,
    x402Txns: activeRows.reduce((s, r) => s + r.x402Txns, 0),
    x402VolumeUsd: activeRows.reduce((s, r) => s + r.x402VolumeUsd, 0),
    totalBalanceUsd: activeRows.reduce((s, r) => s + (r.balanceUsd ?? 0), 0),
  };

  // Default sort: composite score desc (§5.7 "default composite desc") — the
  // client may re-sort interactively, but the initial payload order matches.
  rows.sort((a, b) => b.score - a.score);

  return { agents: rows, summary };
}
