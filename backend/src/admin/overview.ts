// GET /api/admin/overview projection (issue #155, docs/architecture.md
// US-A2). Composes queue counts, historical consumer-kind (regime.classify /
// research.refresh) run health, regime + research staleness, any accidentally
// enabled legacy analytics schedules, the next queued swarm event, and an explicit
// `alerts` feed distinguishing not_run/running/degraded/failed/dead/stale/
// healthy — never guessed, always derived from the same columns the rest of
// the admin surface reads.
import { sql } from "../db/client.ts";
import { computeRegimeSnapshotStaleness, type RegimeStaleness } from "../analytics/report/regime-projection.ts";
import { loadRosterSeedManifest } from "../projects/seed/roster-seed.ts";

// Research signals are considered stale after this many UTC calendar days
// without a new row — named per docs/architecture.md US-A2 ("Use a
// named constant RESEARCH_STALE_DAYS = 2 in the admin projection").
export const RESEARCH_STALE_DAYS = 2;

// Retired consumer-queue analytics kinds. The overview still recognizes them
// so stale/dead rows remain visible and admin mutation paths can reject them;
// the independent producer does not enqueue either kind.
export const PRODUCTION_KINDS = ["regime.classify", "research.refresh"] as const;
export type ProductionKind = (typeof PRODUCTION_KINDS)[number];

// Kinds the overview raises run-health alerts for. This is deliberately NOT
// PRODUCTION_KINDS: that constant carries a second, unrelated meaning — "owned
// by the independent analytics producer, so admin may not retry or toggle it"
// (api/routes/admin.ts) — and the projects pipelines are neither producer-owned
// nor retired. They are, however, the live scheduled jobs that actually keep
// the public directory current, and until now nothing alerted on them at all:
// the alert feed covered exactly two retired kinds. Worse, an exhausted degrade
// settles the job 'succeeded' (worker/loop.ts), so a permanently broken
// discovery run looked healthy forever.
// issue #614: these five sampler kinds are the ones a frozen scheduler was
// silently taking down — wallet.sample_balances/sample_sleeves is the
// AUM-gap incident this issue was filed from, and none of the five were
// previously monitored at all, so a wedged producer had zero alerting.
export const SAMPLER_KINDS = [
  "wallet.sample_balances",
  "wallet.sample_sleeves",
  "vault.sample_share_price",
  "vault.sample_adapters",
  "buybacks.refresh",
] as const;

export const MONITORED_KINDS = [
  ...PRODUCTION_KINDS,
  "projects.discover",
  "projects.refresh_coins",
  "projects.refresh_wallets",
  "projects.sync_revenue",
  "projects.snapshot_daily",
  "projects.fetch_vaults",
  "projects.recompute_coverage",
  ...SAMPLER_KINDS,
] as const;
export type MonitoredKind = (typeof MONITORED_KINDS)[number];

// Cadence-appropriate staleness budget for kinds where "the last run
// succeeded" is not, on its own, proof the pipeline is current (issue #614).
// Latest-point-STATUS alone can't catch a scheduler wedge: a job that last ran
// six weeks ago still reads lastRunStatus 'succeeded' forever. Each budget is
// a wide multiple of the seeded cron cadence (src/db/seed.ts SCHEDULES) so
// ordinary tick jitter or a worker restart never flickers the alert — only a
// genuinely stuck producer does.
const KIND_STALE_AFTER_MS: Partial<Record<MonitoredKind, number>> = {
  "wallet.sample_balances": 10 * 60_000, // cron: every minute
  "wallet.sample_sleeves": 10 * 60_000, // cron: every minute
  "vault.sample_share_price": 4 * 60 * 60_000, // cron: hourly
  "vault.sample_adapters": 4 * 60 * 60_000, // cron: hourly
  "buybacks.refresh": 24 * 60 * 60_000, // cron: every 6h
};

// The two research-signal natural keys research.refresh persists.
const RESEARCH_SIGNAL_KEYS = ["channel-divergence", "late-cycle-signals"] as const;

export type AlertLevel = "not_run" | "running" | "degraded" | "failed" | "dead" | "stale" | "healthy";

export interface Alert {
  level: AlertLevel;
  source: string; // e.g. "regime.classify", "regime", "research:channel-divergence"
  message: string;
}

export interface ProductionKindHealth {
  kind: MonitoredKind;
  lastJobId: number | null;
  lastJobStatus: string | null;
  lastRunStatus: string | null; // succeeded | failed | degraded, from the latest job_runs row
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  runningTooLong: boolean; // status='running' AND locked_at < now() - JOB_VISIBILITY_TIMEOUT
  alert: AlertLevel;
}

export interface AdminOverview {
  serverDate: string; // UTC YYYY-MM-DD the freshness checks were measured against
  queueCounts: Record<string, number>; // jobs.status -> count
  production: ProductionKindHealth[];
  regime: RegimeStaleness;
  research: Array<{ signalKey: string; latestDate: string | null; ageDays: number | null; stale: boolean }>;
  enabledAnalyticsSchedules: Array<{ id: number; kind: string; cron: string; nextRunAt: string | null }>;
  nextSwarmEvent: { jobId: number; kind: string; runAfter: string; scopeType: string | null; scopeId: string | null } | null;
  rosterSeed: RosterSeedHealth;
  alerts: Alert[];
}

// Health of the committed v0 identity roster the live discovery source serves.
// Everything under `manifest` is what the artifact DECLARES about itself (its
// checksum is verified at load, not here); `activeProjectCount` is what is
// actually persisted. The two side by side are the operator's only way to see
// that the directory is serving a stale or partial roster — the leaderboard's
// own freshness panel reads persisted timestamps, so it cannot report a seed
// that never loaded.
export interface RosterSeedHealth {
  generatedAt: string | null;
  ageDays: number | null;
  declaredProjectCount: number | null;
  checksumPrefix: string | null;
  activeProjectCount: number; // persisted rows a discovery pass wrote and left active
  error: string | null; // manifest unreadable/unsupported — the seed cannot load at all
}

function visibilityTimeoutSeconds(): number {
  return Number(process.env.JOB_VISIBILITY_TIMEOUT ?? 300);
}

export async function getOverviewProjection(): Promise<AdminOverview> {
  const serverDate = new Date().toISOString().slice(0, 10);
  const alerts: Alert[] = [];

  // ── Queue counts ───────────────────────────────────────────────────────
  const statusRows = await sql`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`;
  const queueCounts: Record<string, number> = {};
  for (const r of statusRows) queueCounts[r.status] = r.n;

  // ── Production-kind health ────────────────────────────────────────────
  const production: ProductionKindHealth[] = [];
  for (const kind of MONITORED_KINDS) {
    const [lastJob] = await sql`
      SELECT id, status, locked_at
        FROM jobs WHERE kind = ${kind}
       ORDER BY id DESC LIMIT 1`;
    const [lastRun] = await sql`
      SELECT status, started_at, finished_at
        FROM job_runs WHERE kind = ${kind}
       ORDER BY started_at DESC LIMIT 1`;

    const runningTooLong =
      lastJob?.status === "running" &&
      lastJob.locked_at != null &&
      Date.now() - new Date(lastJob.locked_at).getTime() > visibilityTimeoutSeconds() * 1000;

    let alert: AlertLevel;
    if (!lastRun && !lastJob) alert = "not_run";
    else if (lastJob?.status === "dead") alert = "dead";
    else if (runningTooLong) alert = "running";
    else if (lastJob?.status === "running") alert = "running";
    else if (lastRun?.status === "dead") alert = "dead";
    else if (lastRun?.status === "failed") alert = "failed";
    else if (lastRun?.status === "degraded") alert = "degraded";
    else if (lastRun?.status === "succeeded") alert = "healthy";
    else alert = "not_run";

    // A wedged scheduler (issue #614) leaves the LAST run reading 'succeeded'
    // forever — it just never runs again. Downgrade a healthy last run to
    // 'stale' once it is older than this kind's cadence-appropriate budget,
    // so the pipeline going quiet is visible even though nothing ever
    // actually failed.
    const staleAfterMs = KIND_STALE_AFTER_MS[kind];
    if (alert === "healthy" && staleAfterMs != null) {
      const finishedAt = lastRun?.finished_at ? new Date(lastRun.finished_at).getTime() : null;
      if (finishedAt == null || Date.now() - finishedAt > staleAfterMs) alert = "stale";
    }

    const health: ProductionKindHealth = {
      kind,
      lastJobId: lastJob ? Number(lastJob.id) : null,
      lastJobStatus: lastJob?.status ?? null,
      lastRunStatus: lastRun?.status ?? null,
      lastRunStartedAt: lastRun?.started_at ? new Date(lastRun.started_at).toISOString() : null,
      lastRunFinishedAt: lastRun?.finished_at ? new Date(lastRun.finished_at).toISOString() : null,
      runningTooLong,
      alert,
    };
    production.push(health);
    if (runningTooLong) {
      alerts.push({ level: "running", source: kind, message: `${kind} has been running longer than the visibility timeout` });
    } else if (alert !== "healthy" && alert !== "running") {
      alerts.push({ level: alert, source: kind, message: `${kind} last run: ${alert}` });
    }
  }

  // ── Regime staleness ───────────────────────────────────────────────────
  // Derived from the latest row's real per-indicator `raw_date`s (issue
  // #398), never from its `date` column — that column is forward-filled to
  // today on every pipeline run regardless of whether the underlying sources
  // actually refreshed, so it can never surface a frozen data source.
  const [regimeRow] = await sql`SELECT indicators FROM regime_snapshots ORDER BY date DESC LIMIT 1`;
  const regime = computeRegimeSnapshotStaleness(regimeRow?.indicators ?? null, serverDate);
  if (regime.stale) alerts.push({ level: "stale", source: "regime", message: "regime snapshot is stale" });
  else alerts.push({ level: "healthy", source: "regime", message: "regime snapshot is fresh" });

  // ── Research signal freshness (RESEARCH_STALE_DAYS) ───────────────────
  const research: AdminOverview["research"] = [];
  for (const key of RESEARCH_SIGNAL_KEYS) {
    const [row] = await sql`SELECT date FROM research_signals WHERE signal_key = ${key} ORDER BY date DESC LIMIT 1`;
    const latestDate = row?.date
      ? typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10)
      : null;
    let ageDays: number | null = null;
    let stale = true;
    if (latestDate) {
      const a = Date.parse(`${latestDate}T00:00:00Z`);
      const t = Date.parse(`${serverDate}T00:00:00Z`);
      ageDays = Number.isFinite(a) && Number.isFinite(t) ? Math.round((t - a) / 86_400_000) : null;
      stale = ageDays == null || ageDays > RESEARCH_STALE_DAYS;
    }
    research.push({ signalKey: key, latestDate, ageDays, stale });
    alerts.push({
      level: stale ? "stale" : "healthy",
      source: `research:${key}`,
      message: stale ? `${key} is stale (RESEARCH_STALE_DAYS=${RESEARCH_STALE_DAYS})` : `${key} is fresh`,
    });
  }

  // ── Enabled analytics schedules ────────────────────────────────────────
  const scheduleRows = await sql`
    SELECT id, kind, cron, next_run_at
      FROM job_schedules
     WHERE enabled = true AND kind = ANY(${[...PRODUCTION_KINDS]})
     ORDER BY kind`;
  const enabledAnalyticsSchedules = scheduleRows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    cron: r.cron,
    nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
  }));

  // ── Next swarm event (derived from the queue only — swarm session
  // scheduling itself is out of this issue's scope) ─────────────────────
  const [swarmJob] = await sql`
    SELECT id, kind, run_after, scope_type, scope_id
      FROM jobs
     WHERE kind LIKE 'swarm.%' AND status = 'pending'
     ORDER BY run_after ASC LIMIT 1`;
  const nextSwarmEvent = swarmJob
    ? {
        jobId: Number(swarmJob.id),
        kind: swarmJob.kind,
        runAfter: new Date(swarmJob.run_after).toISOString(),
        scopeType: swarmJob.scope_type ?? null,
        scopeId: swarmJob.scope_id ?? null,
      }
    : null;

  // ── Roster seed health ─────────────────────────────────────────────────
  // The directory's identity data comes from a COMMITTED artifact that only an
  // operator can refresh, so "when was it captured" and "how much of it is
  // actually live" are the two numbers that say whether the public directory is
  // current — and neither was reachable anywhere before this. Manifest only: the
  // ~1.1 MB data file is not read on an admin request.
  const [activeRow] = await sql`
    SELECT count(*)::int AS n FROM projects WHERE status = 'active' AND resolved_at IS NOT NULL`;
  const activeProjectCount = Number(activeRow?.n ?? 0);
  let rosterSeed: RosterSeedHealth = {
    generatedAt: null,
    ageDays: null,
    declaredProjectCount: null,
    checksumPrefix: null,
    activeProjectCount,
    error: null,
  };
  try {
    const manifest = await loadRosterSeedManifest();
    const generatedAtMs = new Date(manifest.generatedAt).getTime();
    rosterSeed = {
      generatedAt: manifest.generatedAt,
      ageDays: Number.isNaN(generatedAtMs) ? null : Math.floor((Date.now() - generatedAtMs) / 86_400_000),
      declaredProjectCount: manifest.projectCount,
      checksumPrefix: manifest.checksum?.slice(0, 12) ?? null,
      activeProjectCount,
      error: null,
    };
  } catch (e) {
    // Reported, never swallowed: an unreadable manifest means discoverProjects()
    // will throw and the nightly pass will degrade — which settles 'succeeded'
    // once attempts are exhausted, so this entry is the only honest signal.
    rosterSeed = { ...rosterSeed, error: e instanceof Error ? e.message : String(e) };
  }
  if (rosterSeed.error) {
    alerts.push({ level: "failed", source: "projects.roster_seed", message: `roster seed unreadable: ${rosterSeed.error}` });
  } else if (activeProjectCount === 0) {
    alerts.push({
      level: "not_run",
      source: "projects.roster_seed",
      message: `roster seed declares ${rosterSeed.declaredProjectCount} project(s) but none are persisted and active`,
    });
  } else if (rosterSeed.declaredProjectCount != null && activeProjectCount < rosterSeed.declaredProjectCount) {
    alerts.push({
      level: "degraded",
      source: "projects.roster_seed",
      message:
        `roster seed declares ${rosterSeed.declaredProjectCount} project(s), ${activeProjectCount} persisted and active ` +
        `(seed generatedAt ${rosterSeed.generatedAt}, ${rosterSeed.ageDays}d old)`,
    });
  } else {
    alerts.push({
      level: "healthy",
      source: "projects.roster_seed",
      message: `roster seed ${rosterSeed.checksumPrefix} generatedAt ${rosterSeed.generatedAt} (${rosterSeed.ageDays}d old), ${activeProjectCount} active project(s)`,
    });
  }

  return {
    serverDate,
    queueCounts,
    production,
    regime,
    research,
    enabledAnalyticsSchedules,
    nextSwarmEvent,
    rosterSeed,
    alerts,
  };
}
