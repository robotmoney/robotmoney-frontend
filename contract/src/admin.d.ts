// Admin surface DTOs (docs/plan-admin-surface.md). Issue #176 integration seam:
// this file is created here, ahead of the domain PRs, specifically so #155
// (issue #155, overview/queue/operations) and #152/#159 (issue #152 backend +
// issue #159 committee UI) extend DISJOINT named sections of ONE existing
// file instead of each creating `contract/src/admin.d.ts` from scratch — two
// competing "new file" diffs at the same path cannot be merged automatically,
// but two additions to an already-existing file's disjoint sections can.
//
// Only the primitives shared by every admin mutation route are declared here
// (spec §6.3). Domain-specific request/response shapes belong to the issue
// that implements that domain — add them under your section below rather
// than widening these shared types.

// ── Shared mutation envelope (spec §6.3) ────────────────────────────────────

/** Trimmed, 10..500 character justification required on every admin mutation. */
export type AdminReason = string;

/** Synchronous create/update response shape ({ item, auditRequestId }, 200/201). */
export interface AdminMutationResponse<T> {
  item: T;
  auditRequestId: string;
  /** Present only on a response that mints a new bearer credential. */
  credential?: { token: string };
}

/**
 * Queued-operation response shape ({ jobId, auditRequestId, existing }, 202).
 * Per the issue #176 seam-report: committee session lifecycle actions
 * (`POST /api/admin/committee/sessions/:id/actions/:action`) return THIS
 * shape, never a synchronous AdminMutationResponse — see committee-routes.ts
 * in the backend for the full recorded decision and rebase guidance.
 */
export interface AdminJobEnqueueResponse {
  jobId: number | string;
  auditRequestId: string;
  existing: boolean;
}

/** 409 response shape for a stale optimistic-concurrency version or illegal transition. */
export interface AdminConflictResponse {
  error: string;
  code: "stale_version" | "invalid_transition" | "duplicate";
  current?: unknown;
}

// ── Section: overview, queue, operations, audit (issue #155) ────────────────
// Reserved. Add this domain's DTOs here (overview cards/alerts, schedule
// toggle, dead-job retry, audit list) — do not touch the committee section
// below.

// ── Section: committee admin — topics, members, sessions, roster, lifecycle,
// audit (issue #152 backend / issue #159 committee UI) ──────────────────────
// Reserved. Add this domain's DTOs here (TopicWriteRequest,
// ManualMemberCreateRequest, SessionCreateRequest, RosterPatchRequest,
// SessionActionRequest, etc. per spec §6.3) — do not touch the operations
// section above. Session-action responses are AdminJobEnqueueResponse (202),
// per the recorded decision above.
