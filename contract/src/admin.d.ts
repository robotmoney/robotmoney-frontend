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

// Admin surface DTOs for the committee operations UI (issue #159).
//
// Scope: the committee-facing slice of docs/plan-admin-surface.md §6.3 — topics
// (committee_subjects), members, sessions/roster/lifecycle, and the audit feed.
// Research-run and queue-job admin DTOs are declared above (issue #155) — the
// existing `/api/admin/{auth,jobs,jobs/:id,runs,audit}` routes are that
// surface's contract, not this one.
//
// These types describe the contract this UI was built against. Issue #152
// (the backend for these routes) had not merged when this UI shipped; see the
// PR description for the specific places its shipped implementation diverges
// (synchronous 200 responses for lifecycle transitions instead of the 202 job
// envelope, and partial topic field-shape validation).

import type { CommitteeMember, CommitteeSubject } from "./committee";

// ── Shared request primitives ───────────────────────────────────────────────

/** Trimmed, 10..500 character justification required on every admin mutation. */
export type AdminReason = string;

export interface AdminMutationResponse<T> {
  item: T;
  auditRequestId: string;
  /** Present only on a response that mints a new bearer credential. */
  credential?: { token: string };
}

export interface AdminJobEnqueueResponse {
  jobId: number | string;
  auditRequestId: string;
  existing: boolean;
}

export type AdminErrorCode = "stale_version" | "invalid_transition" | "duplicate";

export interface AdminErrorResponse {
  error: string;
  code?: AdminErrorCode;
  current?: unknown;
}

// ── Topics (committee_subjects) ─────────────────────────────────────────────

export type SubjectSourceType = "rpc" | "manual" | "vault_tvl" | "framework";
export type SubjectRecommendationType = "position_actions" | "bucket_weights";
export type SubjectStatus = "active" | "inactive";

export interface AdminWalletEntry {
  address: string;
  chain: string;
  label?: string;
}

/** Admin projection of a topic: CommitteeSubject plus the optimistic-lock version. */
export interface AdminTopic extends CommitteeSubject {
  version: number;
  updatedAt: string;
}

export interface TopicWriteRequest {
  version?: number; // absent on create, required on edit/deactivate
  id?: string; // required on create (^[a-z0-9][a-z0-9-]{1,63}$), forbidden on edit
  name: string;
  status?: SubjectStatus; // create defaults active
  operator: string;
  homepage?: string | null;
  xHandle?: string | null;
  thesisBlurb: string;
  wallets: AdminWalletEntry[];
  nftContracts: AdminWalletEntry[];
  source: { type: SubjectSourceType };
  recommendationType: SubjectRecommendationType;
  linkedMemberId?: string | null;
  structuralNotes: string[];
  lastReviewed?: string | null; // YYYY-MM-DD
  reason: AdminReason;
}

export interface TopicDeactivateRequest {
  version: number;
  reason: AdminReason;
}

export interface AdminTopicListResponse {
  items: AdminTopic[];
  nextCursor: string | null;
}

// ── Members ──────────────────────────────────────────────────────────────

export type AdminMemberStatus = "applied" | "active" | "inactive";
export type ApplicationStatus = "pending" | "approved" | "rejected";

/** Private admin member projection: never token_hash or a bearer token. */
export interface AdminMember extends CommitteeMember {
  version: number;
  updatedAt: string;
  contactEmail: string | null;
  applicationStatus: ApplicationStatus | null;
  activeKeyId: string | null;
  activeKeyCreatedAt: string | null;
  participation: AdminMemberParticipationEntry[];
}

export interface AdminMemberParticipationEntry {
  sessionId: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  rosterStatus: "expected" | "excused" | "submitted" | "absent";
  stance: string | null;
  receivedAt: string | null;
}

export interface MemberProfileWrite {
  version: number; // profile edit only
  name: string;
  tagline?: string | null;
  lens?: string | null;
  mandate?: string | null;
  biases?: unknown;
  voiceMd?: string | null;
  mode?: string | null;
  operator?: string | null;
  avatar?: unknown;
  contactEmail?: string | null;
  reason: AdminReason;
}

export type ManualMemberCreateRequest = Omit<MemberProfileWrite, "version"> & {
  memberId: string;
  publicKey: string;
};

export interface MemberStatusRequest {
  version: number;
  publicKey?: string; // required for reactivate and rotate-key; forbidden otherwise
  reason: AdminReason;
}

export interface AdminMemberListResponse {
  items: AdminMember[];
  nextCursor: string | null;
}

// ── Committee sessions / roster / lifecycle ────────────────────────────────

export type CommitteeSessionState =
  | "scheduled"
  | "collecting"
  | "window_closed"
  | "aggregated"
  | "published"
  | "cancelled";

export type CommitteeSessionAction =
  | "publish_brief"
  | "close_window"
  | "reopen_window"
  | "aggregate"
  | "publish"
  | "cancel";

export interface SessionCreateRequest {
  subjectId: string;
  date: string; // YYYY-MM-DD
  briefOpensAt: string; // ISO instant
  windowClosesAt: string; // ISO instant
  publishAt: string; // ISO instant
  reason: AdminReason;
}

export type RosterOperation = "add" | "excuse" | "restore";

export interface RosterPatchRequest {
  version: number;
  operation: RosterOperation;
  memberId: string;
  reason: AdminReason;
}

export interface SessionActionRequest {
  version: number;
  reason?: AdminReason; // required for cancel, early close, reopen, manual retry
  windowClosesAt?: string; // required for reopen
}

export type RosterRowStatus = "expected" | "excused" | "submitted" | "absent";

export interface AdminRosterRow {
  memberId: string;
  memberName: string;
  memberLens: string | null;
  status: RosterRowStatus;
  includedAt: string;
  excusedAt: string | null;
  reason: string | null;
  recommendation: AdminRosterRecommendation | null;
}

/** Signature and canonicalPayload are admin-only and always collapsed by default. */
export interface AdminRosterRecommendation {
  id: string;
  stance: string;
  confidence: number;
  receivedAt: string;
  verified: boolean;
  body: string | null;
  memoUrl: string | null;
  nonce: string;
  signature: string;
  canonicalPayload: string;
}

export interface AdminSessionJobLink {
  action: CommitteeSessionAction;
  jobId: number | string | null;
  status: string | null;
  runAfter: string | null;
}

export interface AdminSessionEvent {
  id: number | string;
  fromState: CommitteeSessionState | null;
  toState: CommitteeSessionState;
  action: string;
  actor: string;
  reason: string | null;
  jobId: number | string | null;
  at: string;
}

/** Complete operational session DTO backing /admin/committee/sessions/:id. */
export interface AdminSession {
  id: string;
  version: number;
  updatedAt: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  state: CommitteeSessionState;
  briefOpensAt: string | null;
  windowClosesAt: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  cancelledAt: string | null;
  roster: AdminRosterRow[];
  jobs: AdminSessionJobLink[];
  events: AdminSessionEvent[];
  aggregate: AdminSessionAggregate | null;
  nextLegalActions: CommitteeSessionAction[];
}

export interface AdminSessionAggregate {
  stances: Record<string, number>;
  meanConfidence: number | null;
  expectedCount: number;
  submittedCount: number;
  absentCount: number;
  consensus: string[];
  disagreements: unknown[];
  actions?: unknown[];
  weights?: unknown[];
  sourceRecommendationIds: string[];
}

export interface AdminSessionListResponse {
  items: AdminSession[];
  nextCursor: string | null;
}

// ── Committee audit ────────────────────────────────────────────────────────

export type AuditOutcome = "succeeded" | "failed";

/**
 * Append-only admin mutation record. Never carries secrets, token hashes,
 * bearer tokens, signatures, full recommendation bodies, or request headers.
 */
export interface AdminAuditEntry {
  id: number | string;
  at: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  outcome: AuditOutcome;
  requestId: string;
  jobId: number | string | null;
  sessionId: string | null;
  beforeSummary: unknown;
  afterSummary: unknown;
}

export interface AdminAuditListResponse {
  items: AdminAuditEntry[];
  nextCursor: string | null;
}
