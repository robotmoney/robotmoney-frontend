// Admin surface DTOs (issue #155, docs/plan-admin-surface.md). Scoped to the
// overview projection, queue job/run/retry, schedule-toggle, and audit
// endpoints this issue owns. New endpoints use camelCase bodies; the
// pre-existing GET /api/admin/jobs|jobs/:id|runs keep their original
// snake_case row shape (backward compatible with the deployed admin UI) and
// only gain new optional scope/cursor fields.

export type AdminAlertLevel =
  | "not_run"
  | "running"
  | "degraded"
  | "failed"
  | "dead"
  | "stale"
  | "healthy";

export interface AdminAlert {
  level: AdminAlertLevel;
  source: string;
  message: string;
}

export interface AdminProductionKindHealth {
  kind: "regime.classify" | "research.refresh";
  lastJobId: number | null;
  lastJobStatus: string | null;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  runningTooLong: boolean;
  alert: AdminAlertLevel;
}

export interface AdminRegimeStaleness {
  asof: string | null;
  serverDate: string;
  ageDays: number | null;
  stale: boolean;
  thresholdDays: number;
}

export interface AdminResearchFreshness {
  signalKey: string;
  latestDate: string | null;
  ageDays: number | null;
  stale: boolean;
}

export interface AdminEnabledSchedule {
  id: number;
  kind: string;
  cron: string;
  nextRunAt: string | null;
}

export interface AdminNextCommitteeEvent {
  jobId: number;
  kind: string;
  runAfter: string;
  scopeType: string | null;
  scopeId: string | null;
}

export interface AdminOverview {
  serverDate: string;
  queueCounts: Record<string, number>;
  production: AdminProductionKindHealth[];
  regime: AdminRegimeStaleness;
  research: AdminResearchFreshness[];
  enabledAnalyticsSchedules: AdminEnabledSchedule[];
  nextCommitteeEvent: AdminNextCommitteeEvent | null;
  alerts: AdminAlert[];
}

// ── Queue jobs/runs (extended list — see routes.js for filter query params) ─
export interface AdminJobRow {
  id: number;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  scope_type: string | null;
  scope_id: string | null;
  requested_by: string | null;
}

export interface AdminJobsResponse {
  jobs: AdminJobRow[];
  schedules: unknown[];
  summary: { byStatus: Record<string, number>; byKind: Record<string, number> };
  nextCursor: string | null;
}

export interface AdminRunRow {
  id: number;
  job_id: number | null;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  output: unknown;
}

export interface AdminRunsResponse {
  runs: AdminRunRow[];
  nextCursor: string | null;
}

// ── Dead-job retry ───────────────────────────────────────────────────────
export interface DeadJobRetryRequest {
  reason: string; // trimmed, 10..500 characters
}

export interface DeadJobRetryResponse {
  jobId: number;
  sourceJobId: number;
  auditRequestId: string;
}

// ── Schedule enabled/disabled toggle ────────────────────────────────────
export interface ScheduleToggleRequest {
  enabled: boolean;
  reason: string;
}

export interface ScheduleToggleResponse {
  item: { id: number; kind: string; cron: string; enabled: boolean };
  auditRequestId: string;
}

// ── Redacted audit list ──────────────────────────────────────────────────
export interface AdminAuditRow {
  id: number;
  request_id: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before_state: unknown;
  after_state: unknown;
  outcome: string;
  job_id: number | null;
  session_id: string | null;
  scope: unknown;
  at: string;
}

export interface AdminAuditResponse {
  items: AdminAuditRow[];
  nextCursor: string | null;
}
