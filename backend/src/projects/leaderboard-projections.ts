// "List v3 · Money Agents" leaderboard projection (issue #387, docs/bot-
// analytics-ui-port-plan.md §5.3, P2.7). Server-side port of the original's
// client-side evidence/scoring fallback path (`list3Evidence.ts`) — D8: no
// materialized view + pg_cron here, computed per-request over the same facet
// tables /list (#384) and /projects (#70) already read.
//
// Fidelity note: `list3Evidence.ts` is source in the DEPRECATED
// robotmoney-bot-analytics app and is not available to this repo/issue. The
// plan (§5.3) fixes the signalScore FORMULA verbatim
// (`log10(revenue*5 + wallet*2 + x402*1.5 + mcap*0.15 + 1)*100 + recency
// boost`), which this file implements exactly. The confidence label and
// per-category evidence status are NOT specified beyond "High/Medium/Low"
// and "verified/partial/missing" — this file documents a deterministic,
// real-data-only approximation (never fabricated) rather than guessing at an
// unavailable algorithm; a follow-up issue can tighten it if the original
// logic ever surfaces.
//
// `backend/src/api/routes/dashboards.ts` is the thin adapter exposing this as
// GET /api/dashboards/leaderboard.
import { sql, type DbHandle } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";

// Registered queries (smoke-production-spec.md §7.1): reads, one per
// relation, reached only through GET /api/dashboards/leaderboard. The 30- and
// 182-day revenue windows are one statement with a different cutoff.
const DASHBOARDS = "src/api/routes/dashboards";
const SAMPLE_ID = "00000000-0000-0000-0000-000000000000";

const leaderboardAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.agents",
  purpose: "Read every active agent for the leaderboard.",
  callers: [DASHBOARDS],
  probe: {
    statement: `SELECT id, project_id, name, protocol_standard, wallet_address, enriched_at, is_active
      FROM openclaw_agents WHERE is_active = true`,
  },
});

const leaderboardWallets = registerQuery({
  role: "rm_app",
  object: "tracked_wallets",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.wallets",
  purpose: "Read active tracked wallets so an agent's wallet balance can be matched by address.",
  callers: [DASHBOARDS],
  probe: { statement: "SELECT address, balance_usd, refreshed_at FROM tracked_wallets WHERE is_active = true" },
});

// The three agent-scoped reads join openclaw_agents (is_active) in the
// statement rather than binding the active agents' ids (issue 1690: 909 ids on
// production, one bind parameter each). Each join is declared twice, once per
// relation it reads.
const REVENUE_PROBE = `SELECT r.agent_id, r.revenue_usd, r.revenue_date::text AS revenue_date
      FROM agent_revenue_daily r JOIN openclaw_agents a ON a.id = r.agent_id
     WHERE a.is_active = true AND r.revenue_date >= $1::date`;
const SNAPSHOTS_PROBE = `SELECT s.agent_id, s.snapshot_date::text AS snapshot_date, s.x402_volume_usd, s.x402_txn_count
      FROM daily_agent_snapshots s JOIN openclaw_agents a ON a.id = s.agent_id
     WHERE a.is_active = true AND s.snapshot_date >= $1::date`;
const COINS_PROBE = `SELECT c.id, c.project_id, c.ticker, c.market_cap FROM lobster_coins c
     WHERE c.is_active = true AND c.project_id IN (SELECT a.project_id FROM openclaw_agents a WHERE a.is_active = true)`;

const leaderboardRevenue = registerQuery({
  role: "rm_app",
  object: "agent_revenue_daily",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.revenue",
  purpose: "Read the active agents' daily revenue since a cutoff (the 30- and 182-day windows).",
  callers: [DASHBOARDS],
  probe: { statement: REVENUE_PROBE, params: ["2026-01-01"] },
});

const leaderboardRevenueAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.revenue.agents",
  purpose: "Read the active agents' daily revenue since a cutoff (the 30- and 182-day windows).",
  callers: [DASHBOARDS],
  probe: { statement: REVENUE_PROBE, params: ["2026-01-01"] },
});

const leaderboardSnapshots = registerQuery({
  role: "rm_app",
  object: "daily_agent_snapshots",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.snapshots",
  purpose: "Read the active agents' last 30 days of x402 snapshots.",
  callers: [DASHBOARDS],
  probe: { statement: SNAPSHOTS_PROBE, params: ["2026-01-01"] },
});

const leaderboardSnapshotsAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.snapshots.agents",
  purpose: "Read the active agents' last 30 days of x402 snapshots.",
  callers: [DASHBOARDS],
  probe: { statement: SNAPSHOTS_PROBE, params: ["2026-01-01"] },
});

const leaderboardCoins = registerQuery({
  role: "rm_app",
  object: "lobster_coins",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.coins",
  purpose: "Read the active agents' projects' active coins, to pick each project's best by market cap.",
  callers: [DASHBOARDS],
  probe: { statement: COINS_PROBE },
});

const leaderboardCoinsAgents = registerQuery({
  role: "rm_app",
  object: "openclaw_agents",
  privileges: ["SELECT"],
  site: "src/projects/leaderboard-projections:fetchLeaderboard.coins.agents",
  purpose: "Read the active agents' projects' active coins, to pick each project's best by market cap.",
  callers: [DASHBOARDS],
  probe: { statement: COINS_PROBE },
});
import type { LeaderboardResponse, LeaderboardRow, LeaderboardSourceHealth, ConfidenceLabel, EvidenceStatus } from "@robotmoney/contract";

export type { LeaderboardResponse, LeaderboardRow };

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Same page-local weekly-bucket helper as list2-projections.ts (see that
// file's header for the P0.5/#381 note) — sums revenue into 26 Monday weeks
// for the "26-week money trail" momentum sparkline (§5.3: hidden entirely
// when an agent has no history, never zero-padded).
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  const deltaToMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return d.toISOString().slice(0, 10);
}

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
  return allWeeks.slice(-weeks).map((wk) => byWeek.get(wk) ?? 0);
}

// §5.3 formula, verbatim.
function signalScore(revenue: number, wallet: number, x402: number, mcap: number, recencyBoost: number): number {
  const inner = revenue * 5 + wallet * 2 + x402 * 1.5 + mcap * 0.15 + 1;
  return Math.log10(inner) * 100 + recencyBoost;
}

// Documented approximation (see file header): more days since the agent was
// last observed active erodes the boost linearly to 0 at 10 days, capped at
// 10 points — a small, bounded nudge that never dominates the log-scaled
// money terms above.
function recencyBoost(lastObservedAt: string | null): number {
  if (!lastObservedAt) return 0;
  const days = (Date.now() - new Date(lastObservedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.max(0, 10 - days);
}

function evidenceStatus(present: boolean, partial: boolean): EvidenceStatus {
  if (present) return "verified";
  if (partial) return "partial";
  return "missing";
}

/** The rows the leaderboard is computed from, one list per read. */
export interface LeaderboardRows {
  readonly agents: readonly Record<string, unknown>[];
  readonly wallets: readonly Record<string, unknown>[];
  readonly revenue30: readonly Record<string, unknown>[];
  readonly revenue182: readonly Record<string, unknown>[];
  readonly agentSnaps30: readonly Record<string, unknown>[];
  readonly projectCoins: readonly Record<string, unknown>[];
}

/** `db`: the request pool in the api; a test passes its own gated pool. */
export async function fetchLeaderboard(db: DbHandle = sql): Promise<LeaderboardResponse> {
  // One statement at a time (issue 1690): each takes one request-pool permit
  // and returns it before the next starts. Run together they took five of the
  // api's six request connections, and two leaderboard requests at once left
  // none free (503 db_saturated on production, 2026-11-18).
  const agents = await on(db, leaderboardAgents)`
    SELECT id, project_id, name, protocol_standard, wallet_address, enriched_at, is_active
    FROM openclaw_agents WHERE is_active = true
  `;
  const cutoff30 = since(30);
  const cutoff182 = since(182);
  const wallets = await on(db, leaderboardWallets)`SELECT address, balance_usd, refreshed_at FROM tracked_wallets WHERE is_active = true`;
  const revenue30 = await on(db, leaderboardRevenue, leaderboardRevenueAgents)`SELECT r.agent_id, r.revenue_usd, r.revenue_date::text AS revenue_date
      FROM agent_revenue_daily r JOIN openclaw_agents a ON a.id = r.agent_id
     WHERE a.is_active = true AND r.revenue_date >= ${cutoff30}::date`;
  const revenue182 = await on(db, leaderboardRevenue, leaderboardRevenueAgents)`SELECT r.agent_id, r.revenue_usd, r.revenue_date::text AS revenue_date
      FROM agent_revenue_daily r JOIN openclaw_agents a ON a.id = r.agent_id
     WHERE a.is_active = true AND r.revenue_date >= ${cutoff182}::date`;
  const agentSnaps30 = await on(db, leaderboardSnapshots, leaderboardSnapshotsAgents)`SELECT s.agent_id, s.snapshot_date::text AS snapshot_date, s.x402_volume_usd, s.x402_txn_count
      FROM daily_agent_snapshots s JOIN openclaw_agents a ON a.id = s.agent_id
     WHERE a.is_active = true AND s.snapshot_date >= ${cutoff30}::date`;
  const projectCoins = await on(db, leaderboardCoins, leaderboardCoinsAgents)`SELECT c.id, c.project_id, c.ticker, c.market_cap FROM lobster_coins c
     WHERE c.is_active = true AND c.project_id IN (SELECT a.project_id FROM openclaw_agents a WHERE a.is_active = true)`;
  return buildLeaderboard({ agents, wallets, revenue30, revenue182, agentSnaps30, projectCoins });
}

/** PURE but for the clock. The leaderboard response from its rows. */
export function buildLeaderboard({ agents, wallets, revenue30, revenue182, agentSnaps30, projectCoins }: LeaderboardRows): LeaderboardResponse {
  const walletByAddress = new Map<string, { balance_usd: unknown; refreshed_at: unknown }>();
  for (const w of wallets) {
    const addr = (w.address as string | null)?.toLowerCase();
    if (addr) walletByAddress.set(addr, w as { balance_usd: unknown; refreshed_at: unknown });
  }
  const bestCoinByProject = new Map<string, { id: string; ticker: string | null; market_cap: unknown }>();
  for (const c of projectCoins) {
    const pid = c.project_id as string;
    const prev = bestCoinByProject.get(pid);
    if (!prev || (num(c.market_cap) ?? -Infinity) > (num(prev.market_cap) ?? -Infinity)) {
      bestCoinByProject.set(pid, c as { id: string; ticker: string | null; market_cap: unknown });
    }
  }
  const revenue30ByAgent = new Map<string, number>();
  for (const r of revenue30) {
    const id = r.agent_id as string;
    revenue30ByAgent.set(id, (revenue30ByAgent.get(id) ?? 0) + (num(r.revenue_usd) ?? 0));
  }
  const revenue182ByAgent = new Map<string, { date: string; value: number }[]>();
  const lastRevenueDateByAgent = new Map<string, string>();
  for (const r of revenue182) {
    const id = r.agent_id as string;
    (revenue182ByAgent.get(id) ?? revenue182ByAgent.set(id, []).get(id)!).push({ date: r.revenue_date as string, value: num(r.revenue_usd) ?? 0 });
    const prevDate = lastRevenueDateByAgent.get(id);
    if (!prevDate || (r.revenue_date as string) > prevDate) lastRevenueDateByAgent.set(id, r.revenue_date as string);
  }
  const x402ByAgent = new Map<string, { volume: number; txns: number; lastDate: string | null }>();
  for (const s of agentSnaps30) {
    const id = s.agent_id as string;
    const cur = x402ByAgent.get(id) ?? { volume: 0, txns: 0, lastDate: null };
    cur.volume += num(s.x402_volume_usd) ?? 0;
    cur.txns += num(s.x402_txn_count) ?? 0;
    const d = s.snapshot_date as string;
    if (!cur.lastDate || d > cur.lastDate) cur.lastDate = d;
    x402ByAgent.set(id, cur);
  }

  const scored = agents.map((a) => {
    const id = a.id as string;
    const pid = a.project_id as string | null;
    const linkedCoin = pid ? bestCoinByProject.get(pid) : null;
    const walletAddress = (a.wallet_address as string | null) ?? null;
    const linkedWallet = walletAddress ? walletByAddress.get(walletAddress.toLowerCase()) : null;
    const walletBalanceUsd = linkedWallet ? num(linkedWallet.balance_usd) : null;
    const x402 = x402ByAgent.get(id) ?? { volume: 0, txns: 0, lastDate: null };
    const revenue30d = revenue30ByAgent.get(id) ?? 0;
    const tokenMarketCapUsd = linkedCoin ? num(linkedCoin.market_cap) : null;

    const enrichedAt = toIso(a.enriched_at);
    const lastRevenueIso = lastRevenueDateByAgent.get(id) ? `${lastRevenueDateByAgent.get(id)}T00:00:00.000Z` : null;
    const lastX402Iso = x402.lastDate ? `${x402.lastDate}T00:00:00.000Z` : null;
    const candidates = [enrichedAt, lastRevenueIso, lastX402Iso].filter((v): v is string => !!v);
    const lastObservedAt = candidates.length ? candidates.reduce((a2, b) => (a2 > b ? a2 : b)) : null;

    const score = signalScore(revenue30d, walletBalanceUsd ?? 0, x402.volume, tokenMarketCapUsd ?? 0, recencyBoost(lastObservedAt));

    // Evidence (documented approximation, see file header): each category is
    // "verified" when its real backing data is present and non-zero,
    // "partial" when the identity exists but no value has been observed yet,
    // "missing" otherwise.
    const walletEvidence = evidenceStatus(!!walletBalanceUsd && walletBalanceUsd > 0, !!walletAddress);
    const moneyInEvidence = evidenceStatus(revenue30d > 0, (revenue182ByAgent.get(id)?.length ?? 0) > 0);
    const x402Evidence = evidenceStatus(x402.volume > 0, x402.txns > 0);
    const tokenEvidence = evidenceStatus(!!tokenMarketCapUsd && tokenMarketCapUsd > 0, !!linkedCoin);
    const identityEvidence = evidenceStatus(!!(a.protocol_standard as string | null), false);
    const daysSinceObserved = lastObservedAt ? (Date.now() - new Date(lastObservedAt).getTime()) / 86_400_000 : Infinity;
    const freshnessEvidence = evidenceStatus(daysSinceObserved <= 7, daysSinceObserved <= 30);

    const verifiedCount = [walletEvidence, moneyInEvidence, x402Evidence, tokenEvidence].filter((s) => s === "verified").length;
    const confidence: ConfidenceLabel = verifiedCount >= 3 ? "High" : verifiedCount === 2 ? "Medium" : "Low";

    return {
      id,
      name: (a.name as string) ?? "",
      href: `/agents/${id}`,
      protocol: (a.protocol_standard as string | null) ?? null,
      // No column distinguishes "discovery source" from `protocol_standard`
      // in this schema (unlike the deprecated app's separate field) — never
      // rendering a badge that would just duplicate the protocol badge.
      sourceBadge: null,
      revenue30dUsd: revenue30d,
      walletBalanceUsd,
      walletAddress,
      x402VolumeUsd: x402.volume,
      x402Txns: x402.txns,
      tokenTicker: linkedCoin?.ticker ?? null,
      tokenMarketCapUsd,
      lastObservedAt,
      moneyTrailSparkline: toWeeklySumBuckets(revenue182ByAgent.get(id) ?? [], 26),
      signalScore: score,
      confidence,
      evidence: {
        wallet: walletEvidence,
        moneyIn: moneyInEvidence,
        x402: x402Evidence,
        token: tokenEvidence,
        identity: identityEvidence,
        freshness: freshnessEvidence,
      },
    };
  });

  scored.sort((a, b) => b.signalScore - a.signalScore);
  const rows: LeaderboardRow[] = scored.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));

  const listedAgents = rows.length;
  const verifiedWalletBalanceUsd = rows.reduce((s, r) => s + (r.evidence.wallet === "verified" ? (r.walletBalanceUsd ?? 0) : 0), 0);
  const moneyIn30dUsd = rows.reduce((s, r) => s + (r.revenue30dUsd ?? 0), 0);
  const highConfidenceCount = rows.filter((r) => r.confidence === "High").length;

  // Source health for the "Leaderboard health (debug)" panel (§5.3): real
  // freshness computed from the same rows above, honestly reporting the
  // endpoint's own data timestamps rather than a fabricated MV refresh log
  // (D8 — there is no materialized view / pg_cron equivalent here).
  function sourceHealth(name: string, role: string, dates: (string | null)[]): LeaderboardSourceHealth {
    const total = dates.length;
    const fresh = dates.filter((d) => d && Date.now() - new Date(d).getTime() <= 36 * 3_600_000).length;
    const latest = dates.filter((d): d is string => !!d).reduce((a, b) => (a > b ? a : b), "");
    const status: LeaderboardSourceHealth["status"] = total === 0 ? "empty" : fresh === 0 ? "stale" : fresh === total ? "healthy" : "partial";
    return { name, role, status, freshCount: fresh, totalCount: total, latestRefreshAt: latest || null };
  }

  const debug = {
    rowCount: rows.length,
    lastRefreshAt: new Date().toISOString(),
    sources: [
      sourceHealth("openclaw_agents", "Agent identity + enrichment", agents.map((a) => toIso(a.enriched_at))),
      sourceHealth("tracked_wallets", "Wallet balance evidence", wallets.map((w) => toIso(w.refreshed_at))),
      sourceHealth("agent_revenue_daily", "30d money-in evidence", [...lastRevenueDateByAgent.values()].map((d) => `${d}T00:00:00.000Z`)),
    ],
  };

  return {
    rows,
    stats: { listedAgents, verifiedWalletBalanceUsd, moneyIn30dUsd, highConfidenceCount },
    debug,
    asOf: new Date().toISOString(),
  };
}
