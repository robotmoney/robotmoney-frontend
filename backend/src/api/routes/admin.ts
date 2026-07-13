// Admin dashboard for the Postgres task queue (research/analytics pipeline). A
// READ-ONLY surface over the queue tables from migration 0003: `jobs`,
// `job_schedules`, and `job_runs` — where `job_runs.output` (jsonb) + `error`
// (text) ARE the per-run logs. No new table; this handler only SELECTs.
//
// PRIVILEGED with the same guard the committee/projects admin routes use: if
// ADMIN_TOKEN is set, require it as X-Admin-Token (constant-time compared, works
// in every env incl. a public box); if unset, allow only outside prod
// (config.allowInsecure — demo/ephemeral convenience). Fail-closed: prod with no
// token → 403, checked BEFORE any DB work.
import { createHash, timingSafeEqual } from "node:crypto";
import { config as globalConfig } from "../../config.ts";
import { sql } from "../../db/client.ts";

// Constant-time secret comparison (over fixed-length sha256 hashes so lengths
// always match and timing doesn't leak the secret) — mirrors projects.ts.
function secretEq(presented: string | null, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Auth surface for the admin dashboard. Injectable so tests can exercise a
// prod-mode config (token required, insecure disallowed) against the ephemeral DB.
export interface AdminAuthConfig {
  adminToken: string | null;
  allowInsecure: boolean;
}

function requireAdmin(req: Request, cfg: AdminAuthConfig = globalConfig): boolean {
  return cfg.adminToken
    ? secretEq(req.headers.get("X-Admin-Token"), cfg.adminToken)
    : cfg.allowInsecure;
}

// Clamp a `?limit=` query param to [1, max] with a default when unset/invalid.
// Note: an absent/empty param must fall back to `def` — `Number(null)`/`Number("")`
// are 0 (not NaN), which would otherwise clamp up to 1 and truncate the result.
function clampLimit(raw: string | null, def = 100, max = 500): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

// The run columns exposed to the dashboard (job_runs.output/error = the logs).
const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;

// Returns { status, body } or null if the path isn't an /api/admin route this
// handler owns (so index.ts falls through to its 404). Every owned route is
// fail-closed: the 403 guard runs before any DB query.
export async function handleAdmin(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig = globalConfig,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;

  // POST /api/admin/auth — the login form validates the password here (200 iff
  // authorized; the guard below returns 403 otherwise). No body needed.
  if (m === "POST" && p === "/api/admin/auth") {
    if (!requireAdmin(req, cfg)) return FORBIDDEN;
    return { status: 200, body: { ok: true } };
  }

  // GET /api/admin/jobs — recent jobs (all kinds) + all schedules + a status/kind
  // summary computed with GROUP BY.
  if (m === "GET" && p === "/api/admin/jobs") {
    if (!requireAdmin(req, cfg)) return FORBIDDEN;
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
    if (!requireAdmin(req, cfg)) return FORBIDDEN;
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
    if (!requireAdmin(req, cfg)) return FORBIDDEN;
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
