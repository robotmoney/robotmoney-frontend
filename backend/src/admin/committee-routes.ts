// STUB — reserved for issue #152 (committee admin topics/members/roster/
// lifecycle API, PR #169). No-op composition seam only (issue #176): this
// registrar owns nothing yet and always returns `null`, so wiring it into
// `handleAdmin`'s registrar chain (admin.ts) changes no runtime behavior.
//
// Canonical shape: docs/plan-admin-surface.md §6.3 route table —
//   GET/POST  /api/admin/committee/subjects
//   GET/PATCH /api/admin/committee/subjects/:id
//   POST      /api/admin/committee/subjects/:id/deactivate
//   GET       /api/admin/committee/members[/:id]
//   POST      /api/admin/committee/members[/:id/{activate,deactivate,reactivate,rotate-key,reject}]
//   GET/POST  /api/admin/committee/sessions[/:id]
//   PATCH     /api/admin/committee/sessions/:id/roster
//   POST      /api/admin/committee/sessions/:id/actions/:action
//   GET       /api/admin/committee/overview
//
// This is the CANONICAL family — `X-Admin-Token`-privileged, mounted through
// `handleAdmin` alongside research/operations — and is DISTINCT from the
// existing legacy `/api/committee/admin/:action` dispatcher
// (`backend/src/api/routes/committee-admin.ts` /
// `backend/src/committee/admin.ts`, mounted separately via `committee.ts`).
// Per docs/plan-admin-surface.md §6.3: "The generic existing
// `/api/committee/admin/:action` endpoints remain for demo compatibility but
// the new browser must not call them."
//
// ── Recorded contract decision (issue #176 seam-report) ─────────────────────
// Committee lifecycle actions (`POST .../sessions/:id/actions/:action` for
// brief/close/reopen/cancel/aggregate/publish) are QUEUED, not synchronous:
// the endpoint enqueues a worker job and returns 202 with
// `{ jobId, auditRequestId, existing }` (spec §6.3 "Manual actions enqueue the
// same worker kind used by scheduled actions and return 202 with a job id.").
// A repeat of an action already reflected in state returns 200 with
// `{ idempotent: true }` — that is the ONLY synchronous 2xx case in the
// lifecycle-action family. This is now settled explicitly in
// docs/plan-admin-surface.md §2 to remove any ambiguity.
//
// PR #169 (issue #152)'s current implementation calls the guarded
// committee/admin.ts transition functions SYNCHRONOUSLY from the legacy
// `/api/committee/admin/sessions/:id/{cancel,close,reopen,aggregate,publish}`
// routes and returns their 200/201/409 result directly — it does not enqueue
// a job. PR #172 (issue #159)'s frontend was built against the queued-202
// contract (`contract/src/admin.d.ts` in that PR documents the divergence
// explicitly). Rebase guidance: #152 needs an ADDITIVE job-enqueuing handler
// registered here, at `/api/admin/committee/sessions/:id/actions/:action`,
// that wraps its existing guarded transition functions in a queue job (worker
// kinds `committee.cancel`, `committee.reopen_window`, and the existing
// scheduled-lifecycle kinds per spec §6.3) before merge, so the shipped
// backend matches #159's already-built frontend. The existing synchronous
// `/api/committee/admin/*` routes can remain as-is for demo/manual-ops use —
// they are simply not what the new admin browser calls.
import type { AdminAuthConfig, AdminRegistrar, AdminRouteResult } from "./types.ts";

export async function registerCommitteeAdminRoutes(
  _req: Request,
  _url: URL,
  _cfg: AdminAuthConfig,
): Promise<AdminRouteResult | null> {
  return null;
}

// Type-check the stub against the shared registrar contract at compile time.
const _typeCheck: AdminRegistrar = registerCommitteeAdminRoutes;
void _typeCheck;
