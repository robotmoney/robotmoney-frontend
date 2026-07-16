// Admin dashboard for the Postgres task queue (research/analytics pipeline). A
// READ-ONLY surface over the queue tables from migration 0003: `jobs`,
// `job_schedules`, and `job_runs` — where `job_runs.output` (jsonb) + `error`
// (text) ARE the per-run logs. No new table; this registrar only SELECTs.
//
// Moved verbatim out of the former monolithic `handleAdmin` (issue #176
// integration seam) — behavior is byte-for-byte unchanged; only the module
// boundary is new. This is the pre-existing queue surface; issue #155 extends
// list/retry/schedule-toggle behavior in `operations-routes.ts`, not here, to
// keep the two domains' PRs from editing the same lines.
import { sql } from "../db/client.ts";
import {
  ADMIN_FORBIDDEN,
  clampLimit,
  requireAdmin,
  type AdminAuthConfig,
  type AdminRouteResult,
} from "./types.ts";

export async function registerQueueAdminRoutes(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig,
): Promise<AdminRouteResult | null> {
  const p = url.pathname;
  const m = req.method;

  // POST /api/admin/auth — the login form validates the password here (200 iff
  // authorized; the guard below returns 403 otherwise). No body needed.
  if (m === "POST" && p === "/api/admin/auth") {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    return { status: 200, body: { ok: true } };
  }

  // GET /api/admin/jobs — recent jobs (all kinds) + all schedules + a status/kind
  // summary computed with GROUP BY.
  if (m === "GET" && p === "/api/admin/jobs") {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const limit = clampLimit(url.searchParams.get("limit"));
    const jobs = await sql`
      SELECT id, kind, status, priority, attempts, max_attempts, run_after,
             locked_at, locked_by, last_error, created_at, updated_at
        FROM jobs
       ORDER BY id DESC
       LIMIT ${limit}`;
    const schedules = await sql`
      SELECT id, kind, cron, timezone, enabled, last_enqueued_at, next_run_at
        FROM job_schedules
       ORDER BY kind`;
    const byStatusRows = await sql`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`;
    const byKindRows = await sql`SELECT kind, count(*)::int AS n FROM jobs GROUP BY kind`;
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRows) byStatus[r.status] = r.n;
    const byKind: Record<string, number> = {};
    for (const r of byKindRows) byKind[r.kind] = r.n;
    return { status: 200, body: { jobs, schedules, summary: { byStatus, byKind } } };
  }

  // GET /api/admin/jobs/:id — one job plus its recent runs (the logs). Reject a
  // non-numeric id with 400; 404 when the id doesn't exist.
  if (m === "GET" && p.startsWith("/api/admin/jobs/")) {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const idStr = decodeURIComponent(p.slice("/api/admin/jobs/".length));
    if (!/^\d+$/.test(idStr)) return { status: 400, body: { error: "job id must be numeric" } };
    const id = Number(idStr);
    const [job] = await sql`
      SELECT id, kind, payload, status, priority, attempts, max_attempts, run_after,
             locked_at, locked_by, last_error, dedupe_key, created_at, updated_at
        FROM jobs WHERE id = ${id}`;
    if (!job) return { status: 404, body: { error: "job not found" } };
    const runs = await sql`
      SELECT id, job_id, kind, started_at, finished_at, status, error, output
        FROM job_runs WHERE job_id = ${id}
       ORDER BY started_at DESC
       LIMIT 100`;
    return { status: 200, body: { job, runs } };
  }

  // GET /api/admin/runs — the recent job_runs feed across all jobs (the logs),
  // optionally filtered by ?kind= and ?status=.
  if (m === "GET" && p === "/api/admin/runs") {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const limit = clampLimit(url.searchParams.get("limit"));
    const kind = url.searchParams.get("kind");
    const status = url.searchParams.get("status");
    // Compose an optional WHERE from only the filters that were supplied.
    const conds = [];
    if (kind) conds.push(sql`kind = ${kind}`);
    if (status) conds.push(sql`status = ${status}`);
    const where = conds.length
      ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;
    const runs = await sql`
      SELECT id, job_id, kind, started_at, finished_at, status, error, output
        FROM job_runs
        ${where}
       ORDER BY started_at DESC
       LIMIT ${limit}`;
    return { status: 200, body: { runs } };
  }

  return null;
}
