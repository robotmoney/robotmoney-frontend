// Research pipeline telemetry admin surface (issue #151, PR #168). Moved out
// of the former monolithic `handleAdmin` into its own registrar (issue #176
// integration seam) — behavior is unchanged; only the module boundary and the
// shared auth/limit helpers (backend/src/admin/types.ts) are new.
import { INDICATORS } from "../analytics/analyze/indicators.ts";
import { computeRegimeStaleness } from "../analytics/report/regime-projection.ts";
import { jsonValue, sql } from "../db/client.ts";
import {
  ADMIN_FORBIDDEN,
  clampLimit,
  requireAdmin,
  type AdminAuthConfig,
  type AdminRouteResult,
} from "./types.ts";

// Job kinds/tools this endpoint may enqueue a rerun for. Duplicated (not
// imported) from worker/handlers/analytics.ts's REGIME_TOOL/RESEARCH_TOOLS —
// the API layer never imports worker code — but pinned to the same values.
const RERUN_JOB_KINDS = ["regime.classify", "research.refresh"] as const;
const RERUN_RESEARCH_TOOLS = ["channel-divergence", "late-cycle-signals"] as const;
type RerunJobKind = (typeof RERUN_JOB_KINDS)[number];
type RerunResearchTool = (typeof RERUN_RESEARCH_TOOLS)[number];

// Allowlisted raw_indicator_history indicators: the regime registry plus MNA
// (persisted by the late-cycle-signals research tool, not itself a registry
// indicator — analytics/index.ts). No other table/indicator name is readable
// through this endpoint (issue #151 explicit out-of-scope guard: no arbitrary
// SQL / unallowlisted table access).
const RAW_SERIES_ALLOWLIST = new Set<string>([...INDICATORS.map((i) => i.id), "MNA"]);
const SIGNAL_ALLOWLIST = new Set<string>(RERUN_RESEARCH_TOOLS);

function isIsoDate(v: string | null): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Freshness for one run: age of its `asof` against the server's "today",
// reusing the same stale-if->3-days convention the /regime dashboard uses
// (regime-projection.ts) — the honesty invariant is identical here: a run
// whose as-of date has drifted far from today means the pipeline isn't
// refreshing, not that the run itself failed.
function runFreshness(asof: string) {
  return computeRegimeStaleness(asof, new Date().toISOString().slice(0, 10));
}

export async function registerResearchAdminRoutes(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig,
): Promise<AdminRouteResult | null> {
  const p = url.pathname;
  const m = req.method;

  // GET /api/admin/research/runs — research pipeline telemetry run list
  // (issue #151), optionally filtered by ?kind=&status=, each row carrying
  // run identity, job linkage, source/as-of metadata, a warning count, and
  // freshness. Full stage/warning/artifact detail is reserved for the
  // single-run endpoint below (kept out of the list response deliberately).
  if (m === "GET" && p === "/api/admin/research/runs") {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const limit = clampLimit(url.searchParams.get("limit"));
    const kind = url.searchParams.get("kind");
    const status = url.searchParams.get("status");
    const conds = [];
    if (kind) conds.push(sql`kind = ${kind}`);
    if (status) conds.push(sql`status = ${status}`);
    const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
    const rows = await sql`
      SELECT r.id, r.job_id, r.kind, r.asof::text AS asof, r.source, r.status,
             r.started_at, r.finished_at, r.checksum, r.created_at,
             (SELECT count(*)::int FROM research_pipeline_warnings w WHERE w.run_id = r.id) AS warning_count
        FROM research_pipeline_runs r
        ${where}
       ORDER BY r.created_at DESC
       LIMIT ${limit}`;
    const runs = rows.map((r) => ({ ...r, freshness: runFreshness(r.asof) }));
    return { status: 200, body: { runs } };
  }

  // GET /api/admin/research/runs/:id — one run's full stage timeline,
  // warnings, bounded artifact previews, and freshness. 404 for an unknown id,
  // 400 for a non-numeric one.
  if (m === "GET" && p.startsWith("/api/admin/research/runs/")) {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const idStr = decodeURIComponent(p.slice("/api/admin/research/runs/".length));
    if (!/^\d+$/.test(idStr)) return { status: 400, body: { error: "run id must be numeric" } };
    const id = Number(idStr);
    const [run] = await sql`
      SELECT id, job_id, kind, asof::text AS asof, source, status, started_at, finished_at, checksum, summary, created_at
        FROM research_pipeline_runs WHERE id = ${id}`;
    if (!run) return { status: 404, body: { error: "run not found" } };
    const stages = await sql`
      SELECT stage, sequence, status, summary, started_at, finished_at
        FROM research_pipeline_stages WHERE run_id = ${id} ORDER BY sequence ASC`;
    const warnings = await sql`
      SELECT stage, message, created_at FROM research_pipeline_warnings WHERE run_id = ${id} ORDER BY created_at ASC`;
    const artifacts = await sql`
      SELECT stage, kind, checksum, preview, created_at FROM research_pipeline_artifacts WHERE run_id = ${id} ORDER BY created_at ASC`;
    return {
      status: 200,
      body: { run: { ...run, freshness: runFreshness(run.asof) }, stages, warnings, artifacts },
    };
  }

  // GET /api/admin/research/raw-series/:indicator?from=&to=&limit= — allowlisted
  // read of raw_indicator_history. Rejects unregistered indicators, invalid
  // dates, and excessive limits before touching the database.
  if (m === "GET" && p.startsWith("/api/admin/research/raw-series/")) {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const indicator = decodeURIComponent(p.slice("/api/admin/research/raw-series/".length));
    if (!RAW_SERIES_ALLOWLIST.has(indicator)) return { status: 400, body: { error: `indicator "${indicator}" is not allowlisted` } };
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from !== null && !isIsoDate(from)) return { status: 400, body: { error: "from must be a valid YYYY-MM-DD date" } };
    if (to !== null && !isIsoDate(to)) return { status: 400, body: { error: "to must be a valid YYYY-MM-DD date" } };
    const limit = clampLimit(url.searchParams.get("limit"), 500, 5000);
    const conds = [sql`indicator = ${indicator}`];
    if (from) conds.push(sql`date >= ${from}`);
    if (to) conds.push(sql`date <= ${to}`);
    const where = conds.reduce((a, b) => sql`${a} AND ${b}`);
    const points = await sql`
      SELECT date::text AS date, value FROM raw_indicator_history
       WHERE ${where}
       ORDER BY date DESC LIMIT ${limit}`;
    return { status: 200, body: { indicator, points } };
  }

  // GET /api/admin/research/signals/:key?from=&to=&limit= — allowlisted read
  // of research_signals. Rejects unregistered signal keys.
  if (m === "GET" && p.startsWith("/api/admin/research/signals/")) {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const key = decodeURIComponent(p.slice("/api/admin/research/signals/".length));
    if (!SIGNAL_ALLOWLIST.has(key)) return { status: 400, body: { error: `signal "${key}" is not allowlisted` } };
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from !== null && !isIsoDate(from)) return { status: 400, body: { error: "from must be a valid YYYY-MM-DD date" } };
    if (to !== null && !isIsoDate(to)) return { status: 400, body: { error: "to must be a valid YYYY-MM-DD date" } };
    const limit = clampLimit(url.searchParams.get("limit"), 500, 5000);
    const conds = [sql`signal_key = ${key}`];
    if (from) conds.push(sql`date >= ${from}`);
    if (to) conds.push(sql`date <= ${to}`);
    const where = conds.reduce((a, b) => sql`${a} AND ${b}`);
    const points = await sql`
      SELECT date::text AS date, payload FROM research_signals
       WHERE ${where}
       ORDER BY date DESC LIMIT ${limit}`;
    return { status: 200, body: { key, points } };
  }

  // POST /api/admin/research/rerun — enqueue a complete (regime.classify) or
  // single-tool (research.refresh + tool) rerun for a supplied as-of date.
  // ALWAYS inserts a NEW job with a fresh, unique dedupe key: the original job
  // (if any) is never touched. `reason` is the audit trail for this manual
  // action — carried in the new job's payload alongside the requested kind/
  // tool/as-of (issue #151 depends on #150's fuller audit_log, which had not
  // landed at authoring time; this is the pragmatic substitute — see PR notes).
  if (m === "POST" && p === "/api/admin/research/rerun") {
    if (!requireAdmin(req, cfg)) return ADMIN_FORBIDDEN;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return { status: 400, body: { error: "body must be a JSON object" } };
    const b = body as Record<string, unknown>;
    const kind = b.kind;
    if (typeof kind !== "string" || !RERUN_JOB_KINDS.includes(kind as RerunJobKind)) {
      return { status: 400, body: { error: `kind must be one of ${RERUN_JOB_KINDS.join(", ")}` } };
    }
    const tool = b.tool;
    if (tool != null && (typeof tool !== "string" || !RERUN_RESEARCH_TOOLS.includes(tool as RerunResearchTool))) {
      return { status: 400, body: { error: `tool must be one of ${RERUN_RESEARCH_TOOLS.join(", ")} (or omitted)` } };
    }
    if (kind === "regime.classify" && tool != null) {
      return { status: 400, body: { error: "regime.classify does not take a tool" } };
    }
    const asof = b.asof;
    if (typeof asof !== "string" || !isIsoDate(asof)) return { status: 400, body: { error: "asof must be a valid YYYY-MM-DD date" } };
    const reason = b.reason;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) {
      return { status: 400, body: { error: "reason must be a non-empty string (≤500 chars)" } };
    }
    // Unique per request — never collides with a scheduled slot's dedupe_key
    // (kind:minute) nor with any other rerun, so this NEVER silently no-ops
    // via ON CONFLICT DO NOTHING; every valid rerun request enqueues.
    const dedupeKey = `manual:${kind}:${tool ?? "all"}:${asof}:${crypto.randomUUID()}`;
    const payload = { asof, tool: tool ?? undefined, manual: true, reason, requestedAt: new Date().toISOString() };
    const [row] = await sql`
      INSERT INTO jobs (kind, payload, dedupe_key)
      VALUES (${kind}, ${sql.json(jsonValue(payload))}, ${dedupeKey})
      RETURNING id, kind`;
    return { status: 202, body: { jobId: row.id, kind: row.kind, dedupeKey } };
  }

  return null;
}
