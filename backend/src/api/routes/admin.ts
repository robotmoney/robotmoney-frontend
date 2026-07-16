// /api/admin/* dispatcher. Composes one registrar per domain (issue #176
// integration seam) instead of one growing function — the Admin surface phase
// (docs/plan-admin-surface.md) has multiple issues converging on this
// boundary (#151 research telemetry, #152 committee admin, #155 overview/
// queue/operations, plus two frontend issues), and a single monolithic
// `handleAdmin` would force every PR to edit the same lines.
//
// Each registrar in `backend/src/admin/` owns a disjoint route prefix and
// checks auth BEFORE any body parsing or SQL (fail-closed); this file only
// tries them in order and returns the first non-null result. Behavior for the
// pre-existing queue routes (auth/jobs/jobs:id/runs) and the research
// telemetry routes (issue #151, landed in PR #168) is byte-for-byte unchanged
// from before this split — see `backend/src/admin/queue-routes.ts` and
// `backend/src/admin/research-routes.ts`.
import { config as globalConfig } from "../../config.ts";
import { registerCommitteeAdminRoutes } from "../../admin/committee-routes.ts";
import { registerOperationsAdminRoutes } from "../../admin/operations-routes.ts";
import { registerQueueAdminRoutes } from "../../admin/queue-routes.ts";
import { registerResearchAdminRoutes } from "../../admin/research-routes.ts";
import type { AdminAuthConfig, AdminRegistrar } from "../../admin/types.ts";

// Re-exported for backward compatibility: existing tests and callers import
// `AdminAuthConfig` from this module's original location.
export type { AdminAuthConfig };

// Order is not semantically significant today (every registrar owns a
// disjoint path prefix), but keep the pre-existing queue surface first so it
// stays the cheapest match for the hottest current route.
const REGISTRARS: readonly AdminRegistrar[] = [
  registerQueueAdminRoutes,
  registerResearchAdminRoutes,
  registerCommitteeAdminRoutes,
  registerOperationsAdminRoutes,
];

// Returns { status, body } or null if the path isn't an /api/admin route any
// registrar owns (so index.ts falls through to its 404).
export async function handleAdmin(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig = globalConfig,
): Promise<{ status: number; body: unknown } | null> {
  for (const registrar of REGISTRARS) {
    const result = await registrar(req, url, cfg);
    if (result) return result;
  }
  return null;
}
