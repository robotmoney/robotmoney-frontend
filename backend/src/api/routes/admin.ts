// Admin dashboard over the Postgres task queue (research/analytics pipeline)
// plus the overview/retry/schedule-toggle/audit surface added by issue #155
// (docs/architecture.md). `jobs`, `job_schedules`, and `job_runs` are
// migration 0003's tables — `job_runs.output` (jsonb) + `error` (text) ARE the
// per-run logs; `jobs.scope_type/scope_id/requested_by/audit_request_id` and
// the extended `audit_log` columns are migration 0017's additions.
//
// PRIVILEGED with the same guard the swarm/projects admin routes use: if
// ADMIN_TOKEN is set, require it as X-Admin-Token (constant-time compared, works
// in every env incl. a public box); if unset, allow only outside prod
// (config.allowInsecure — demo/ephemeral convenience). Fail-closed: prod with no
// token → 403, checked BEFORE any DB work or body parsing on every owned route.
import { randomUUID } from "node:crypto";
import { config as globalConfig } from "../../config.ts";
import { sql, jsonValue } from "../../db/client.ts";
import { INDICATORS } from "../../analytics/analyze/indicators.ts";
import { computeRegimeStaleness } from "../../analytics/report/regime-projection.ts";
import { decodeCursor, encodeCursor } from "../../admin/cursor.ts";
import { recordAudit, redactAuditRow } from "../../admin/audit.ts";
import { getOverviewProjection, PRODUCTION_KINDS } from "../../admin/overview.ts";
import { isPrivileged } from "../auth.ts";
import { hashKey } from "../../lib/keys.ts";

// Auth surface for the admin dashboard. Injectable so tests can exercise a
// prod-mode config (token required, insecure disallowed) against the ephemeral DB.
export interface AdminAuthConfig {
  adminToken: string | null;
  allowInsecure: boolean;
}

// Clamp a `?limit=` query param to [1, max] with a default when unset/invalid.
// Note: an absent/empty param must fall back to `def` — `Number(null)`/`Number("")`
// are 0 (not NaN), which would otherwise clamp up to 1 and truncate the result.
// Used by the pre-existing (legacy) research-telemetry read endpoints below,
// which silently clamp rather than 400 on a malformed limit; parseLimit (below)
// is the stricter behavior for the issue #155 list endpoints only.
function clampLimit(raw: string | null, def = 100, max = 500): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;
const BAD = (error: string) => ({ status: 400, body: { error } }) as const;

// Raised by the shared list-param parsing below; every catch site maps it to
// a 400 (never a 500) — this is the mechanism behind "400 responses for
// malformed cursor, limit, date, status, or scope parameters" (issue #155 AC).
class ValidationError extends Error {}

// Strict limit parsing for the new/extended list endpoints (docs/plan-admin-
// surface.md §6.3: "limit default 50/max 200"). Unlike the legacy behavior,
// an EXPLICITLY supplied but malformed limit is a 400, not a silent clamp —
// only an absent/empty param falls back to the default.
function parseLimit(raw: string | null, def = 50, max = 200): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}`);
  }
  return n;
}

function parseCursor(raw: string | null): { id: number } | null {
  try {
    return decodeCursor(raw);
  } catch {
    throw new ValidationError("malformed cursor");
  }
}

const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead", "cancelled"];
function parseJobStatus(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  if (!JOB_STATUSES.includes(raw)) throw new ValidationError(`status must be one of ${JOB_STATUSES.join(", ")}`);
  return raw;
}

const RUN_STATUSES = ["succeeded", "failed", "degraded", "dead"];
function parseRunStatus(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  if (!RUN_STATUSES.includes(raw)) throw new ValidationError(`status must be one of ${RUN_STATUSES.join(", ")}`);
  return raw;
}

// A bare date (YYYY-MM-DD) or a full ISO instant — both parse via Date.parse.
function parseDateParam(raw: string | null, name: string): Date | null {
  if (raw == null || raw === "") return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new ValidationError(`${name} must be a valid ISO date`);
  return new Date(t);
}

// scope_id only makes sense alongside scope_type (it is not a globally unique
// key on its own) — supplying one without the other is a malformed filter.
function parseScope(url: URL): { scopeType: string | null; scopeId: string | null } {
  const scopeType = url.searchParams.get("scopeType");
  const scopeId = url.searchParams.get("scopeId");
  if (scopeId && !scopeType) {
    throw new ValidationError("scopeId requires scopeType");
  }
  return { scopeType: scopeType || null, scopeId: scopeId || null };
}

function validateReason(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("reason is required");
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 500) {
    throw new ValidationError("reason must be 10..500 characters");
  }
  return trimmed;
}

function rejectUnknownFields(body: unknown, allowed: string[]): Record<string, unknown> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ValidationError(`unknown field(s): ${unknown.join(", ")}`);
  return b;
}

// ── Research pipeline telemetry admin surface (issue #151) ──────────────────
const RERUN_RESEARCH_TOOLS = ["channel-divergence", "late-cycle-signals"] as const;

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

// Returns { status, body } or null if the path isn't an /api/admin route this
// handler owns (so index.ts falls through to its 404). Every owned route is
// fail-closed: the 403 guard runs before any DB query or body parsing.
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
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    return { status: 200, body: { ok: true } };
  }

  // GET /api/admin/is-claimed — public claim-status probe: { claimed: boolean },
  // booleans only, never the hash (issue #553 / D32). The demo boot
  // (scripts/lib/demo-main.ts) reads this to decide whether the per-boot token
  // may still be displayed in the TUI. A DB failure propagates to the router's
  // sanitized 500 — never a fabricated "unclaimed".
  if (m === "GET" && p === "/api/admin/is-claimed") {
    const rows = await sql`SELECT 1 FROM admin_credential WHERE id = 1`;
    return { status: 200, body: { claimed: rows.length > 0 } };
  }

  // POST /api/admin/claim — one-time claim (issue #553 / D32): the holder of
  // the current admin credential (the unclaimed TUI-displayed token) sets a
  // persistent password. Stored ONLY as its sha256 hex (lib/keys.ts hashKey —
  // the same posture as swarm member access keys), never plaintext, never
  // logged, never echoed back. The id=1 primary key makes the claim atomic and
  // one-time: a concurrent or repeat claim loses with 409 until an operator
  // deletes the row (recovery path in docs/decisions.md D32).
  if (m === "POST" && p === "/api/admin/claim") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    const b = (await req.json().catch(() => null)) as { password?: unknown } | null;
    const pass = typeof b?.password === "string" ? b.password.trim() : "";
    if (pass.length < 12) return BAD("password must be at least 12 characters");
    const recoveryCode = randomUUID();
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO admin_credential (id, pass_hash, recovery_hash) VALUES (1, ${hashKey(pass)}, ${hashKey(recoveryCode)})`;
        // The credential is not considered claimed unless its required lifecycle
        // audit event commits too. This keeps an audit failure retryable rather
        // than permanently revoking the setup token without an audit record.
        await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'claim_admin_credential', ${tx.json({})})`;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return { status: 409, body: { error: "admin credential already claimed" } };
      }
      throw err;
    }
    return { status: 200, body: { ok: true, recoveryCode } };
  }

  // POST /api/admin/password-change — explicitly change the password
  if (m === "POST" && p === "/api/admin/password-change") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    const b = (await req.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
    const curr = typeof b?.currentPassword === "string" ? b.currentPassword.trim() : "";
    const next = typeof b?.newPassword === "string" ? b.newPassword.trim() : "";
    if (next.length < 12) return BAD("new password must be at least 12 characters");

    // isPrivileged above authenticates the presented password, but a recovery
    // can rotate it before this mutation executes. Keep the comparison in the
    // UPDATE predicate so an old-password holder cannot overwrite that recovery.
    // Password changes also initialize (or rotate) the recovery code. This is
    // the only safe self-service upgrade for legacy claimed rows that predate
    // migration 0029 and therefore have no recoverable secret to disclose.
    const recoveryCode = randomUUID();
    const changed = await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE admin_credential
           SET pass_hash = ${hashKey(next)}, recovery_hash = ${hashKey(recoveryCode)}
         WHERE id = 1 AND pass_hash = ${hashKey(curr)}
         RETURNING id`;
      if (!rows.length) return false;
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'change_admin_password', ${tx.json({})})`;
      return true;
    });
    if (!changed) return { status: 403, body: { error: "invalid current password" } };
    return { status: 200, body: { ok: true, recoveryCode } };
  }

  // POST /api/admin/password-recover — use recovery code to set a new password
  if (m === "POST" && p === "/api/admin/password-recover") {
    const b = (await req.json().catch(() => null)) as { recoveryCode?: unknown; newPassword?: unknown } | null;
    const code = typeof b?.recoveryCode === "string" ? b.recoveryCode.trim() : "";
    const next = typeof b?.newPassword === "string" ? b.newPassword.trim() : "";
    if (next.length < 12) return BAD("new password must be at least 12 characters");

    // Consume the submitted code as part of the update predicate. A prior
    // read followed by an unconditional update lets concurrent recoveries
    // both validate one code and race to replace the credential.
    const newRecoveryCode = randomUUID();
    const consumed = await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE admin_credential
        SET pass_hash = ${hashKey(next)}, recovery_hash = ${hashKey(newRecoveryCode)}
        WHERE id = 1 AND recovery_hash = ${hashKey(code)}
        RETURNING id`;
      if (!rows.length) return false;
      // Returning the replacement code commits only with its audit record. If
      // auditing fails, the old code remains usable rather than being consumed
      // without a successor the operator can see.
      await tx`INSERT INTO audit_log (actor, action, scope) VALUES ('admin', 'recover_admin_password', ${tx.json({})})`;
      return true;
    });
    if (!consumed) {
      return { status: 403, body: { error: "invalid recovery code" } };
    }
    return { status: 200, body: { ok: true, recoveryCode: newRecoveryCode } };
  }

  // GET /api/admin/overview — health cards + explicit alert feed (issue #155,
  // US-A2). Queue counts, historical consumer analytics run health, regime +
  // research staleness, accidentally enabled legacy analytics schedules, the
  // next queued swarm event, and a not_run/running/degraded/failed/dead/
  // stale/healthy alert feed.
  if (m === "GET" && p === "/api/admin/overview") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    return { status: 200, body: await getOverviewProjection() };
  }

  // GET /api/admin/jobs — cursor-paginated jobs (kind/status/scope/created-range
  // filters) + all schedules + a status/kind summary. `jobs`/`schedules`/
  // `summary` are the original response shape (backward compatible); `nextCursor`
  // is additive.
  if (m === "GET" && p === "/api/admin/jobs") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    try {
      const limit = parseLimit(url.searchParams.get("limit"));
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const kind = url.searchParams.get("kind");
      const status = parseJobStatus(url.searchParams.get("status"));
      const { scopeType, scopeId } = parseScope(url);
      const createdFrom = parseDateParam(url.searchParams.get("createdFrom"), "createdFrom");
      const createdTo = parseDateParam(url.searchParams.get("createdTo"), "createdTo");

      const conds = [];
      if (kind) conds.push(sql`kind = ${kind}`);
      if (status) conds.push(sql`status = ${status}`);
      if (scopeType) conds.push(sql`scope_type = ${scopeType}`);
      if (scopeId) conds.push(sql`scope_id = ${scopeId}`);
      if (createdFrom) conds.push(sql`created_at >= ${createdFrom}`);
      if (createdTo) conds.push(sql`created_at <= ${createdTo}`);
      if (cursor) conds.push(sql`id < ${cursor.id}`);
      const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;

      const rows = await sql`
        SELECT id, kind, status, priority, attempts, max_attempts, run_after,
               locked_at, locked_by, last_error, created_at, updated_at,
               scope_type, scope_id, requested_by
          FROM jobs
          ${where}
         ORDER BY id DESC
         LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      const jobs = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(jobs[jobs.length - 1].id) : null;

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
      return { status: 200, body: { jobs, schedules, summary: { byStatus, byKind }, nextCursor } };
    } catch (e) {
      if (e instanceof ValidationError) return BAD(e.message);
      throw e;
    }
  }

  // POST /api/admin/jobs/:id/retry — clone a DEAD job into a new pending job
  // with a unique manual dedupe key. Never mutates the source row. (issue #155,
  // US-Q1.) Checked before the generic GET /api/admin/jobs/:id below since both
  // share the /api/admin/jobs/:id prefix.
  if (m === "POST" && /^\/api\/admin\/jobs\/[^/]+\/retry$/.test(p)) {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    const idStr = decodeURIComponent(p.split("/")[4]);
    if (!/^\d+$/.test(idStr)) return { status: 400, body: { error: "job id must be numeric" } };
    const id = Number(idStr);
    try {
      const body = await req.json().catch(() => null);
      const b = rejectUnknownFields(body, ["reason"]);
      const reason = validateReason(b.reason);

      return await sql.begin(async (tx) => {
        const [job] = await tx`SELECT * FROM jobs WHERE id = ${id} FOR UPDATE`;
        if (!job) return { status: 404, body: { error: "job not found" } };
        if (job.status !== "dead") {
          return {
            status: 409,
            body: { error: "only a dead job can be retried", code: "invalid_transition", current: job.status },
          };
        }
        if (PRODUCTION_KINDS.includes(job.kind)) {
          return {
            status: 409,
            body: { error: "analytics production is owned by the independent producer; admin cannot retry it" },
          };
        }
        const dedupeKey = `admin-retry:${id}:${randomUUID()}`;
        const auditRequestId = randomUUID();
        const [clone] = await tx`
          INSERT INTO jobs (kind, payload, priority, dedupe_key, scope_type, scope_id, requested_by, audit_request_id)
          VALUES (${job.kind}, ${tx.json(job.payload)}, ${job.priority}, ${dedupeKey},
                  ${job.scope_type}, ${job.scope_id}, 'admin', ${auditRequestId})
          RETURNING id`;
        const newJobId = Number(clone.id);
        const audit = await recordAudit(tx, {
          actor: "admin",
          action: "retry_job",
          targetType: "job",
          targetId: String(newJobId),
          reason,
          beforeState: { sourceJobId: id, status: job.status },
          afterState: { newJobId, status: "pending" },
          jobId: newJobId,
          scope: { sourceJobId: id, newJobId },
        });
        return { status: 202, body: { jobId: newJobId, sourceJobId: id, auditRequestId: audit.request_id } };
      });
    } catch (e) {
      if (e instanceof ValidationError) return BAD(e.message);
      throw e;
    }
  }

  // GET /api/admin/jobs/:id — one job (incl. scope/audit-request domain links)
  // plus its recent runs (the logs). Reject a non-numeric id with 400; 404 when
  // the id doesn't exist.
  if (m === "GET" && p.startsWith("/api/admin/jobs/")) {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    const idStr = decodeURIComponent(p.slice("/api/admin/jobs/".length));
    if (!/^\d+$/.test(idStr)) return { status: 400, body: { error: "job id must be numeric" } };
    const id = Number(idStr);
    const [job] = await sql`
      SELECT id, kind, payload, status, priority, attempts, max_attempts, run_after,
             locked_at, locked_by, last_error, dedupe_key, created_at, updated_at,
             scope_type, scope_id, requested_by, audit_request_id
        FROM jobs WHERE id = ${id}`;
    if (!job) return { status: 404, body: { error: "job not found" } };
    const runs = await sql`
      SELECT id, job_id, kind, started_at, finished_at, status, error, output
        FROM job_runs WHERE job_id = ${id}
       ORDER BY started_at DESC
       LIMIT 100`;
    return { status: 200, body: { job, runs } };
  }

  // GET /api/admin/runs — cursor-paginated job_runs feed, optionally filtered by
  // ?kind=&status=&scopeType=&scopeId= (scope filters join through the owning job).
  if (m === "GET" && p === "/api/admin/runs") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    try {
      const limit = parseLimit(url.searchParams.get("limit"));
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const kind = url.searchParams.get("kind");
      const status = parseRunStatus(url.searchParams.get("status"));
      const { scopeType, scopeId } = parseScope(url);

      const conds = [];
      if (kind) conds.push(sql`r.kind = ${kind}`);
      if (status) conds.push(sql`r.status = ${status}`);
      if (scopeType) conds.push(sql`j.scope_type = ${scopeType}`);
      if (scopeId) conds.push(sql`j.scope_id = ${scopeId}`);
      if (cursor) conds.push(sql`r.id < ${cursor.id}`);
      const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;

      const rows = await sql`
        SELECT r.id, r.job_id, r.kind, r.started_at, r.finished_at, r.status, r.error, r.output
          FROM job_runs r
          LEFT JOIN jobs j ON j.id = r.job_id
          ${where}
         ORDER BY r.id DESC
         LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      const runs = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(runs[runs.length - 1].id) : null;
      return { status: 200, body: { runs, nextCursor } };
    } catch (e) {
      if (e instanceof ValidationError) return BAD(e.message);
      throw e;
    }
  }

  // RETIRED analytics-schedule control. Keep the path for fail-closed responses
  // to old clients, but neither regime.classify nor research.refresh can be
  // toggled in the consumer DB: the independent producer owns cadence. Other
  // schedule kinds were never accepted by this endpoint. (D25 / issue #361.)
  if (m === "PATCH" && /^\/api\/admin\/schedules\/[^/]+$/.test(p)) {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    const idStr = decodeURIComponent(p.slice("/api/admin/schedules/".length));
    if (!/^\d+$/.test(idStr)) return { status: 400, body: { error: "schedule id must be numeric" } };
    const id = Number(idStr);
    try {
      const body = await req.json().catch(() => null);
      const b = rejectUnknownFields(body, ["enabled", "reason"]);
      if (typeof b.enabled !== "boolean") throw new ValidationError("enabled must be a boolean");
      validateReason(b.reason);

      return await sql.begin(async (tx) => {
        const [schedule] = await tx`SELECT * FROM job_schedules WHERE id = ${id} FOR UPDATE`;
        if (!schedule) return { status: 404, body: { error: "schedule not found" } };
        if (schedule.kind.startsWith("swarm.")) {
          return {
            status: 409,
            body: {
              error: "legacy/demo swarm schedule — not product scheduling; cannot be toggled",
              code: "invalid_transition",
            },
          };
        }
        if (!(PRODUCTION_KINDS as readonly string[]).includes(schedule.kind)) {
          throw new ValidationError(`schedule kind "${schedule.kind}" is not an analytics schedule`);
        }
        return {
          status: 409,
          body: {
            error: "analytics execution belongs to the independent producer; admin cannot toggle consumer schedules",
            code: "invalid_transition",
          },
        };
      });
    } catch (e) {
      if (e instanceof ValidationError) return BAD(e.message);
      throw e;
    }
  }

  // GET /api/admin/audit — cursor-paginated, filtered, REDACTED audit_log feed.
  // Filters: actor, action, targetType, targetId, from, to. Token/authorization/
  // header/cookie/secret/password/signature keys are stripped from any nested
  // JSON before the row leaves this process (never merely omitted client-side).
  if (m === "GET" && p === "/api/admin/audit") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    try {
      const limit = parseLimit(url.searchParams.get("limit"));
      const cursor = parseCursor(url.searchParams.get("cursor"));
      const actor = url.searchParams.get("actor");
      const action = url.searchParams.get("action");
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");
      const from = parseDateParam(url.searchParams.get("from"), "from");
      const to = parseDateParam(url.searchParams.get("to"), "to");

      const conds = [];
      if (actor) conds.push(sql`actor = ${actor}`);
      if (action) conds.push(sql`action = ${action}`);
      if (targetType) conds.push(sql`target_type = ${targetType}`);
      if (targetId) conds.push(sql`target_id = ${targetId}`);
      if (from) conds.push(sql`at >= ${from}`);
      if (to) conds.push(sql`at <= ${to}`);
      if (cursor) conds.push(sql`id < ${cursor.id}`);
      const where = conds.length ? sql`WHERE ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;

      const rows = await sql`
        SELECT id, request_id, actor, action, target_type, target_id, reason,
               before_state, after_state, outcome, job_id, session_id, scope, at
          FROM audit_log
          ${where}
         ORDER BY id DESC
         LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map(redactAuditRow);
      const nextCursor = hasMore ? encodeCursor(page[page.length - 1].id) : null;
      return { status: 200, body: { items, nextCursor } };
    } catch (e) {
      if (e instanceof ValidationError) return BAD(e.message);
      throw e;
    }
  }

  // GET /api/admin/research/runs — research pipeline telemetry run list
  // (issue #151), optionally filtered by ?kind=&status=, each row carrying
  // run identity, job linkage, source/as-of metadata, a warning count, and
  // freshness. Full stage/warning/artifact detail is reserved for the
  // single-run endpoint below (kept out of the list response deliberately).
  if (m === "GET" && p === "/api/admin/research/runs") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
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
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
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
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
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
    // `source` (issue #397): row-level provenance — null on every pre-migration
    // row (genuinely unknown, never fabricated).
    const points = await sql`
      SELECT date::text AS date, value, source FROM raw_indicator_history
       WHERE ${where}
       ORDER BY date DESC LIMIT ${limit}`;
    return { status: 200, body: { indicator, points } };
  }

  // GET /api/admin/research/signals/:key?from=&to=&limit= — allowlisted read
  // of research_signals. Rejects unregistered signal keys.
  if (m === "GET" && p.startsWith("/api/admin/research/signals/")) {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
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

  // Analytics production is outside the admin authority domain. Keep this
  // retired route explicit so old clients fail closed.
  if (m === "POST" && p === "/api/admin/research/rerun") {
    if (!await isPrivileged(req, cfg)) return FORBIDDEN;
    return {
      status: 409,
      body: { error: "analytics production is owned by the independent producer; admin cannot rerun it" },
    };
  }

  return null;
}
