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
// CORRECTED (PR #172 review, 2026-07-16): the original version of this file
// invented a parallel `/api/admin/committee/*` contract (PATCH verbs, a single
// roster PATCH, `version`, a 202 job envelope) that assumed issue #152's
// backend hadn't shipped yet. It merged weeks earlier as PR #169 at a
// DIFFERENT, already-live prefix — `/api/committee/admin/*`
// (backend/src/api/routes/committee-admin.ts + backend/src/committee/admin.ts)
// — with its own verbs, action names, and response shapes. Every type below
// now describes THAT real, already-shipped surface. Where the real backend
// exposes strictly less than the original design assumed (no single-session
// admin GET, no admin session list, no linked-jobs-by-session, no per-member
// participation history, no signature/canonicalPayload disclosure), the type
// is trimmed rather than fabricated — the frontend composes what it can from
// the routes that actually exist (see committee-session.js's header comment
// for the exact composition).

import type { CommitteeMember, CommitteeSubject } from "./committee";

// ── Topics (committee_subjects) ─────────────────────────────────────────────
// Matches backend/src/committee/admin.ts toSubjectAdmin() and the
// committee-admin.ts `subjects` routes exactly.

export type SubjectSourceType = "rpc" | "manual" | "vault_tvl" | "framework";
export type SubjectRecommendationType = "position_actions" | "bucket_weights";
export type SubjectStatus = "active" | "inactive";

export interface AdminWalletEntry {
  address: string;
  chain: string;
  label?: string;
}

/** Admin projection of a topic — backend toSubjectAdmin()'s exact shape. */
export interface AdminTopic extends CommitteeSubject {
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** POST .../subjects body (parseSubjectCreate: `id`/`name` required, rest
 * optional passthrough — the backend does not validate wallets/source/etc.
 * shape beyond storing it as JSON). */
export interface TopicCreateRequest {
  id: string;
  name: string;
  operator?: string;
  homepage?: string;
  xHandle?: string;
  thesisBlurb?: string;
  wallets?: AdminWalletEntry[];
  nftContracts?: AdminWalletEntry[];
  source?: { type: SubjectSourceType };
  recommendationType?: SubjectRecommendationType;
  linkedMemberId?: string | null;
  structuralNotes?: string[];
  lastReviewed?: string | null; // YYYY-MM-DD
}

/** POST .../subjects/:id/update body. The optimistic-lock field the backend
 * reads is `expectedVersion` (parseExpectedVersion) — NOT `version`. */
export interface TopicUpdateRequest extends Partial<Omit<TopicCreateRequest, "id">> {
  expectedVersion: number;
}

/** POST .../subjects/:id/deactivate body. */
export interface TopicDeactivateRequest {
  expectedVersion: number;
}

/** GET .../subjects response envelope — `subjects`, not `items`. */
export interface AdminTopicListResponse {
  subjects: AdminTopic[];
}

// ── Members ──────────────────────────────────────────────────────────────
// Matches backend/src/committee/admin.ts toMemberAdmin() and the
// committee-admin.ts `members`/`applications` routes exactly. The backend has
// no admin read for active-key metadata (activeKeyId/activeKeyCreatedAt) or
// cross-session participation history — those fields do not exist on this DTO.

export type AdminMemberStatus = "applied" | "active" | "inactive";
export type ApplicationStatus = "pending" | "approved" | "rejected";

/** Private admin member projection — backend toMemberAdmin()'s exact shape. */
export interface AdminMember {
  id: string;
  status: AdminMemberStatus;
  version: number;
  name: string;
  tagline: string | null;
  lens: string | null;
  mandate: string | null;
  contactEmail: string | null;
  appliedAt: string | null;
  activatedAt: string | null;
  updatedAt: string;
}

/** GET .../applications row. listApplicationsAdmin() returns raw, unprojected
 * SELECT rows — snake_case is the actual wire shape, not a typo. */
export interface AdminApplicationRow {
  id: number | string;
  member_id: string;
  status: ApplicationStatus;
  created_at: string;
  reviewed_at: string | null;
}

/** GET .../members response envelope — `members`, not `items`. */
export interface AdminMemberListResponse {
  members: AdminMember[];
}

/** GET .../applications response envelope. */
export interface AdminApplicationListResponse {
  applications: AdminApplicationRow[];
}

/** POST .../members body (manual add). The field is `contact`
 * (backend/src/api/validation.ts parseManualMember) — NOT `contactEmail`. */
export interface ManualMemberCreateRequest {
  memberId: string;
  name: string;
  publicKey: string;
  lens?: string;
  contact?: string;
}

/** POST .../members/:id/review body — the ONLY route that activates or
 * rejects an application; there is no separate `activate`/`reject` endpoint,
 * and no version check on either decision. */
export interface MemberReviewRequest {
  decision: "approve" | "reject";
}

/** POST .../members/:id/deactivate and .../reactivate bodies. Reactivate
 * mints a fresh credential against the member's last on-file public key —
 * it does NOT accept a new `publicKey` (only rotate-key does). */
export interface MemberVersionedRequest {
  expectedVersion: number;
}

/** POST .../members/:id/rotate-key body. `publicKey` is OPTIONAL: omitted,
 * the backend rotates the bearer credential against the existing on-file key.
 * No `expectedVersion` — key rotation is not optimistic-locked. */
export interface MemberRotateKeyRequest {
  publicKey?: string;
}

// ── Committee sessions / roster / lifecycle ────────────────────────────────
// The real backend (issue #152) exposes NO single-session admin GET, NO admin
// session list, and no linked-jobs-by-session or per-session event feed. The
// frontend composes a session detail view from three sources: the PUBLIC
// session list/detail routes (ROUTES.committee.sessions /
// ROUTES.committee.session), the admin roster GET, and — only transiently,
// right after a lifecycle POST — that POST's own response. See
// committee-session.js's header comment for the exact composition and what
// was dropped (linked jobs, signature/canonicalPayload disclosure).

export type CommitteeSessionState =
  | "scheduled"
  | "collecting"
  | "window_closed"
  | "aggregated"
  | "published"
  | "cancelled";

/** The only 5 lifecycle actions the admin HTTP surface exposes
 * (committee-admin.ts sessions dispatcher). scheduled→collecting
 * ("publish_brief" in the job-kind vocabulary) is worker/job-queue-driven
 * only — there is no manual admin action for it. */
export type CommitteeSessionAction = "cancel" | "close" | "reopen" | "aggregate" | "publish";

/** POST .../sessions body (parseSessionCreate — all five fields required). */
export interface SessionCreateRequest {
  date: string; // YYYY-MM-DD, UTC calendar date
  subjectId: string;
  briefOpensAt: string; // ISO instant
  windowClosesAt: string; // ISO instant
  publishAt: string; // ISO instant
}

/** POST .../sessions response (createSessionAdmin) — 201 for a new session,
 * 200 when re-scheduling an existing still-`scheduled` session. Note this is
 * the ONLY route that ever returns `version`; no GET route exposes it. */
export interface SessionCreateResponse {
  ok: boolean;
  status: number;
  session: { id: string; date: string; subjectId: string; subjectName: string | null; state: CommitteeSessionState; version: number };
  rosterSize: number;
  jobIds: number[];
}

/** Public projection (committee/projections.ts toSession()) — the only
 * session list/detail source. There is NO version, briefOpensAt, or
 * publishAt field on any GET route (those exist only transiently on the
 * create response above). */
export interface CommitteeSessionSummary {
  id: string;
  date: string;
  subjectId: string;
  subjectName: string | null;
  state: CommitteeSessionState;
  windowClosesAt: string | null;
  publishedAt: string | null;
  regimeSummary: unknown;
  subjectSnapshotTotalValueUsd: number | null;
  synthesis: unknown;
  committeeRecommendation: unknown;
  socialDraftId: string | null;
  generatedAt: string;
}

export type RosterOperation = "add" | "excuse" | "restore";

/** POST .../sessions/:id/roster/{add|excuse|restore} body — every roster
 * mutation is one of THREE separate endpoints, never a single PATCH with an
 * `operation` field. No version — roster rows are not optimistic-locked. */
export interface RosterMutationRequest {
  memberId: string;
}

/** GET .../sessions/:id/roster row. getSessionRoster() returns raw,
 * unprojected SELECT rows — snake_case is the actual wire shape. There is no
 * `submitted`/`absent` status value here (only `expected`/`excused` — whether
 * a member submitted is derived by cross-referencing the public session's
 * `takes`, not stored on this row). */
export interface AdminRosterRow {
  member_id: string;
  member_name: string;
  member_lens: string | null;
  status: "expected" | "excused";
  included_at: string | null;
  excused_at: string | null;
  reason: string | null;
}

/** POST .../sessions/:id/{cancel|close|reopen|aggregate|publish} body.
 * `expectedVersion` is OPTIONAL — the REST handler does
 * `parseExpectedVersion(b) ?? undefined`, and guardedTransition only checks it
 * when present. There is no `reason` or `windowClosesAt` field: the REST
 * handler never reads either from the body (the domain layer's `reason`
 * param exists but nothing populates it over HTTP yet). */
export interface SessionActionRequest {
  expectedVersion?: number;
}

// ── Committee audit ────────────────────────────────────────────────────────

/** Synchronous response shared by every session lifecycle action
 * (fromResult() in committee-admin.ts) — NOT a 202 job-queue envelope; there
 * is no `jobId`/`existing` field. `idempotent` is set when the requested
 * state equals the current state (no-op: no version bump, no new event row).
 * A successful `aggregate` call additionally spreads in
 * committee/domain.ts aggregateSession()'s rollup fields, which are NOT
 * persisted anywhere queryable afterward — this response is the only time
 * they're available. */
export interface SessionActionResponse {
  ok: boolean;
  status: number;
  error?: string;
  idempotent?: boolean;
  session?: { id: string; state: CommitteeSessionState; version: number };
  [key: string]: unknown;
}

// ── Audit (committee-scoped) ────────────────────────────────────────────────
// GET .../audit row — the raw audit_log table shape (listAuditLog SELECT),
// shared with every other committee-admin mutation (subjects/members/
// sessions), not a committee-only feed. `scope` is a free-form JSON blob
// whose keys vary per `action` (e.g. session_transition carries
// {sessionId, from, to, action}); there is no targetType/targetId/reason/
// outcome/requestId/jobId column — those belonged to the invented generic
// `/api/admin/audit` design (a separate, still-unbuilt surface — see
// ROUTES.admin.audit — not this committee-scoped one).
export interface CommitteeAuditEntry {
  id: number | string;
  actor: string;
  action: string;
  scope: Record<string, unknown>;
  at: string;
}

export interface CommitteeAuditListResponse {
  entries: CommitteeAuditEntry[];
}

// ── Re-exported for callers that only need the member/subject base shape ────
export type { CommitteeMember, CommitteeSubject };
