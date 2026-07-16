// STUB — reserved for issue #155 (admin overview, queue controls, and
// operational API, PR #170). No-op composition seam only (issue #176): this
// registrar owns nothing yet and always returns `null`, so wiring it into
// `handleAdmin`'s registrar chain (admin.ts) changes no runtime behavior.
//
// Canonical shape: docs/plan-admin-surface.md §6.3 route table —
//   GET   /api/admin/overview
//   POST  /api/admin/jobs/:id/retry
//   PATCH /api/admin/schedules/:id
//   GET   /api/admin/audit
//
// Rebase guidance for #155/PR170: move these blocks (and
// `backend/src/admin/audit.ts`, `cursor.ts`, `overview.ts` PR170 already adds
// as domain modules) so this registrar calls into them, mirroring
// `queue-routes.ts`'s existing/queue split. `/api/admin/jobs` and
// `/api/admin/jobs/:id` (GET, list/detail) stay owned by
// `queue-routes.ts::registerQueueAdminRoutes` — only the NEW
// `/api/admin/jobs/:id/retry` (POST) verb belongs here, so the two registrars
// share the `/api/admin/jobs*` prefix without owning the same routes.
import type { AdminAuthConfig, AdminRegistrar, AdminRouteResult } from "./types.ts";

export async function registerOperationsAdminRoutes(
  _req: Request,
  _url: URL,
  _cfg: AdminAuthConfig,
): Promise<AdminRouteResult | null> {
  return null;
}

// Type-check the stub against the shared registrar contract at compile time.
const _typeCheck: AdminRegistrar = registerOperationsAdminRoutes;
void _typeCheck;
