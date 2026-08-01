// Admin overview/queue/retry/schedule-toggle/audit surface (issue #155,
// docs/architecture.md). Runs against the ephemeral Postgres the preload
// provisions (real DB, never mocked) — if Postgres is absent the preload
// THROWS, so this suite fails red rather than skipping.
//
// Ordering note: several assertions below insert a fresh row and immediately
// call the handler in the SAME synchronous test body (no `await` boundary to
// another test file runs in between), so "the newest row" is deterministically
// the one just inserted even though other test files in this suite also write
// to shared kinds like `regime.classify` / `research.refresh` and shared rows
// like the seeded `job_schedules`.
import { test, expect } from "bun:test";
import { sql, jsonValue } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";
import { PRODUCTION_KINDS, RESEARCH_STALE_DAYS } from "../../src/admin/overview.ts";

const PROD = { adminToken: "s3cret-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;

const KIND = `sfc_${crypto.randomUUID().slice(0, 8)}`; // unique per-run kind for isolation

function req(method: string, path: string, token?: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["X-Admin-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const call = (r: Request, cfg: typeof PROD | typeof INSECURE = PROD) => handleAdmin(r, new URL(r.url), cfg);

async function insertJob(fields: Record<string, unknown>): Promise<number> {
  const [row] = await sql`INSERT INTO jobs ${sql({ kind: KIND, status: "pending", ...fields })} RETURNING id`;
  return Number(row.id);
}
async function insertRun(jobId: number, fields: Record<string, unknown>) {
  await sql`INSERT INTO job_runs ${sql({ job_id: jobId, kind: KIND, status: "succeeded", ...fields })}`;
}

// ── Fail-closed auth ordering ──────────────────────────────────────────────

test("prod-mode with no token → 403 on every new admin route, before body parsing", async () => {
  expect((await call(req("GET", "/api/admin/overview")))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/audit")))?.status).toBe(403);
  // Malformed JSON bodies must never be parsed before the auth guard runs.
  const badBody = new Request("http://x/api/admin/jobs/1/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expect((await handleAdmin(badBody, new URL(badBody.url), PROD))?.status).toBe(403);
  const badSchedule = new Request("http://x/api/admin/schedules/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  expect((await handleAdmin(badSchedule, new URL(badSchedule.url), PROD))?.status).toBe(403);
});

test("wrong token → 403 on new routes", async () => {
  expect((await call(req("GET", "/api/admin/overview", "nope")))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/audit", "nope")))?.status).toBe(403);
  expect((await call(req("POST", "/api/admin/jobs/1/retry", "nope"), PROD))?.status).toBe(403);
  expect((await call(req("PATCH", "/api/admin/schedules/1", "nope"), PROD))?.status).toBe(403);
});

// ── GET /api/admin/overview ─────────────────────────────────────────────────

test("overview: queue counts reflect a freshly inserted job", async () => {
  const before = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  const beforeCount = (before?.body as { queueCounts: Record<string, number> }).queueCounts.pending ?? 0;
  await insertJob({ status: "pending" });
  const after = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  expect(after?.status).toBe(200);
  const afterBody = after?.body as { queueCounts: Record<string, number> };
  expect(afterBody.queueCounts.pending).toBe(beforeCount + 1);
});

test("overview: production-kind alert distinctions (dead, running-too-long, healthy)", async () => {
  // dead
  const deadJobId = await insertJob({ kind: "regime.classify", status: "dead", last_error: "boom" });
  await insertRun(deadJobId, { kind: "regime.classify", status: "dead", error: "boom" });
  let res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  let body = res?.body as { production: Array<{ kind: string; alert: string; lastJobStatus: string }> };
  let rc = body.production.find((p) => p.kind === "regime.classify")!;
  expect(rc.alert).toBe("dead");
  expect(rc.lastJobStatus).toBe("dead");

  // running too long — locked well past the default JOB_VISIBILITY_TIMEOUT (300s)
  await sql`INSERT INTO jobs ${sql({ kind: "regime.classify", status: "running", locked_by: "w1" })}`;
  await sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE kind = 'regime.classify' AND status = 'running' AND locked_by = 'w1'`;
  res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  body = res?.body as typeof body;
  rc = body.production.find((p) => p.kind === "regime.classify")!;
  expect(rc.alert).toBe("running");
  expect((rc as unknown as { runningTooLong: boolean }).runningTooLong).toBe(true);

  // healthy — succeeded run is now the newest for research.refresh
  const okJobId = await insertJob({ kind: "research.refresh", status: "succeeded" });
  await insertRun(okJobId, { kind: "research.refresh", status: "succeeded" });
  res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  body = res?.body as typeof body;
  const rr = body.production.find((p) => p.kind === "research.refresh")!;
  expect(rr.alert).toBe("healthy");

  expect(PRODUCTION_KINDS).toEqual(["regime.classify", "research.refresh"]);
});

test("overview: regime + research freshness (RESEARCH_STALE_DAYS)", async () => {
  expect(RESEARCH_STALE_DAYS).toBe(2);
  const today = new Date().toISOString().slice(0, 10);
  // #398: regime freshness is derived from the real per-indicator `raw_date`
  // observations in `indicators`, never from the row's own `date` column (the
  // pipeline forward-fills that to today on every run regardless of whether
  // the underlying sources refreshed) — so the seeded row must carry current
  // indicator observations to read as fresh here.
  const indicators = jsonValue([
    { id: "T10Y2Y", panel: "macro", raw_date: today },
    { id: "DEFI_TVL", panel: "onchain", raw_date: today },
  ]);
  await sql`
    INSERT INTO regime_snapshots (date, indicators) VALUES (${today}, ${sql.json(indicators)})
    ON CONFLICT (date) DO UPDATE SET indicators = EXCLUDED.indicators`;
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES ('channel-divergence', ${today}, ${sql.json(jsonValue({}))}) ON CONFLICT (signal_key, date) DO NOTHING`;
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES ('late-cycle-signals', ${today}, ${sql.json(jsonValue({}))}) ON CONFLICT (signal_key, date) DO NOTHING`;

  const res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  const body = res?.body as {
    regime: { asof: string | null; stale: boolean; ageDays: number | null; panelObservationDates: Record<string, string | null> };
    research: Array<{ signalKey: string; stale: boolean; ageDays: number | null }>;
  };
  expect(body.regime.asof).toBe(today);
  expect(body.regime.stale).toBe(false);
  expect(body.regime.ageDays).toBe(0);
  expect(body.regime.panelObservationDates).toEqual({ macro: today, onchain: today });
  const cd = body.research.find((r) => r.signalKey === "channel-divergence")!;
  expect(cd.stale).toBe(false);
  expect(cd.ageDays).toBe(0);
});

test("overview: #398 regression — a today-dated regime_snapshots row with STALE indicator observations reports regime.stale === true", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const indicators = jsonValue([
    { id: "T10Y2Y", panel: "macro", raw_date: old },
    { id: "DEFI_TVL", panel: "onchain", raw_date: old },
  ]);
  // The row's own `date` (today) mirrors the pipeline's forward-fill; only
  // the embedded indicators' raw_date is old. Pre-fix, this read as fresh.
  await sql`
    INSERT INTO regime_snapshots (date, indicators) VALUES (${today}, ${sql.json(indicators)})
    ON CONFLICT (date) DO UPDATE SET indicators = EXCLUDED.indicators`;

  const res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  const body = res?.body as {
    regime: { asof: string | null; stale: boolean; ageDays: number | null };
    alerts: Array<{ level: string; source: string }>;
  };
  expect(body.regime.stale).toBe(true);
  expect(body.regime.asof).toBe(old);
  expect(body.regime.ageDays).toBe(10);
  expect(body.alerts.some((a) => a.source === "regime" && a.level === "stale")).toBe(true);
});

test("overview: enabled analytics schedules + next committee event + alert shape", async () => {
  const committeeId = await insertJob({
    kind: "committee.publish_brief",
    status: "pending",
    run_after: new Date(Date.now() + 60 * 60 * 1000),
  });
  const res = await call(req("GET", "/api/admin/overview", PROD.adminToken));
  expect(res?.status).toBe(200);
  const body = res?.body as {
    enabledAnalyticsSchedules: Array<{ kind: string }>;
    nextCommitteeEvent: { jobId: number; kind: string } | null;
    alerts: Array<{ level: string; source: string; message: string }>;
  };
  // External producer owns cadence; no consumer-DB analytics schedule is enabled.
  expect(body.enabledAnalyticsSchedules).toEqual([]);
  expect(body.nextCommitteeEvent).not.toBeNull();
  expect(body.nextCommitteeEvent!.jobId).toBeGreaterThanOrEqual(0);
  const ALLOWED = new Set(["not_run", "running", "degraded", "failed", "dead", "stale", "healthy"]);
  for (const a of body.alerts) expect(ALLOWED.has(a.level)).toBe(true);
  void committeeId;
});

// ── GET /api/admin/jobs and /api/admin/runs — filters, scope, cursor, 400s ─

test("jobs: kind/status/scope filters + cursor pagination + limit bounds", async () => {
  const scopeId = crypto.randomUUID();
  const idA = await insertJob({ status: "pending", scope_type: "committee_session", scope_id: scopeId });
  const idB = await insertJob({ status: "dead", scope_type: "committee_session", scope_id: scopeId });
  const idC = await insertJob({ status: "pending" }); // no scope

  const byKind = await call(req("GET", `/api/admin/jobs?kind=${KIND}`, PROD.adminToken));
  const kindBody = byKind?.body as { jobs: { id: number }[] };
  const ids = kindBody.jobs.map((j) => Number(j.id));
  expect(ids).toContain(idA);
  expect(ids).toContain(idB);
  expect(ids).toContain(idC);

  const byStatus = await call(req("GET", `/api/admin/jobs?kind=${KIND}&status=dead`, PROD.adminToken));
  const statusBody = byStatus?.body as { jobs: { id: number; status: string }[] };
  expect(statusBody.jobs.every((j) => j.status === "dead")).toBe(true);
  expect(statusBody.jobs.some((j) => Number(j.id) === idB)).toBe(true);

  const byScope = await call(req("GET", `/api/admin/jobs?kind=${KIND}&scopeType=committee_session&scopeId=${scopeId}`, PROD.adminToken));
  const scopeBody = byScope?.body as { jobs: { id: number }[] };
  const scopeIds = scopeBody.jobs.map((j) => Number(j.id));
  expect(scopeIds.sort()).toEqual([idA, idB].sort());

  // Cursor pagination over the 3 KIND rows, one page at a time.
  const page1 = await call(req("GET", `/api/admin/jobs?kind=${KIND}&limit=1`, PROD.adminToken));
  const p1 = page1?.body as { jobs: { id: number }[]; nextCursor: string | null };
  expect(p1.jobs.length).toBe(1);
  expect(p1.nextCursor).not.toBeNull();
  const page2 = await call(req("GET", `/api/admin/jobs?kind=${KIND}&limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`, PROD.adminToken));
  const p2 = page2?.body as { jobs: { id: number }[]; nextCursor: string | null };
  expect(p2.jobs.length).toBe(1);
  expect(Number(p2.jobs[0].id)).not.toBe(Number(p1.jobs[0].id));

  // 400s
  expect((await call(req("GET", "/api/admin/jobs?limit=0", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?limit=201", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?limit=abc", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?cursor=not-valid-base64!!", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?status=bogus", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", `/api/admin/jobs?scopeId=${scopeId}`, PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?createdFrom=not-a-date", PROD.adminToken)))?.status).toBe(400);
});

test("runs: kind/status filters + cursor pagination + 400s", async () => {
  const jobId = await insertJob({ status: "succeeded" });
  await insertRun(jobId, { status: "succeeded" });
  await insertRun(jobId, { status: "failed", error: "x" });

  const byKind = await call(req("GET", `/api/admin/runs?kind=${KIND}`, PROD.adminToken));
  const kindBody = byKind?.body as { runs: { kind: string }[] };
  expect(kindBody.runs.length).toBeGreaterThanOrEqual(2);
  expect(kindBody.runs.every((r) => r.kind === KIND)).toBe(true);

  const byStatus = await call(req("GET", `/api/admin/runs?kind=${KIND}&status=failed`, PROD.adminToken));
  const statusBody = byStatus?.body as { runs: { status: string }[] };
  expect(statusBody.runs.every((r) => r.status === "failed")).toBe(true);

  const page1 = await call(req("GET", `/api/admin/runs?kind=${KIND}&limit=1`, PROD.adminToken));
  const p1 = page1?.body as { runs: unknown[]; nextCursor: string | null };
  expect(p1.runs.length).toBe(1);
  expect(p1.nextCursor).not.toBeNull();

  expect((await call(req("GET", "/api/admin/runs?limit=abc", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/runs?cursor=%%%", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/runs?status=bogus", PROD.adminToken)))?.status).toBe(400);
});

// ── POST /api/admin/jobs/:id/retry ──────────────────────────────────────────

test("retry: clones a dead job, unique dedupe key, audit linking both ids, source unchanged", async () => {
  const payload = { asof: "2026-01-01", note: "retry-me" };
  const deadId = await insertJob({ status: "dead", payload: sql.json(jsonValue(payload)), priority: 7, dedupe_key: `orig:${crypto.randomUUID()}` });

  const res = await call(req("POST", `/api/admin/jobs/${deadId}/retry`, PROD.adminToken, { reason: "recovering after transient outage" }));
  expect(res?.status).toBe(202);
  const body = res?.body as { jobId: number; sourceJobId: number; auditRequestId: string };
  expect(body.sourceJobId).toBe(deadId);
  expect(body.jobId).not.toBe(deadId);

  const [clone] = await sql`SELECT kind, payload, priority, status, dedupe_key FROM jobs WHERE id = ${body.jobId}`;
  expect(clone.kind).toBe(KIND);
  expect(clone.payload).toEqual(payload);
  expect(clone.priority).toBe(7);
  expect(clone.status).toBe("pending");
  expect(clone.dedupe_key).not.toBeNull();

  const [source] = await sql`SELECT status FROM jobs WHERE id = ${deadId}`;
  expect(source.status).toBe("dead");

  const [audit] = await sql`SELECT action, target_type, target_id, scope, request_id FROM audit_log WHERE request_id = ${body.auditRequestId}`;
  expect(audit.action).toBe("retry_job");
  expect(audit.target_type).toBe("job");
  expect(Number(audit.target_id)).toBe(body.jobId);
  expect(audit.scope).toEqual({ sourceJobId: deadId, newJobId: body.jobId });
});

test("retry: non-dead statuses → 409, missing job → 404, no queue rows change", async () => {
  const reason = { reason: "attempting a retry that should be rejected" };
  for (const status of ["pending", "running", "succeeded", "failed"]) {
    const id = await insertJob({ status });
    const before = await sql`SELECT count(*)::int AS n FROM jobs`;
    const res = await call(req("POST", `/api/admin/jobs/${id}/retry`, PROD.adminToken, reason));
    expect(res?.status).toBe(409);
    const after = await sql`SELECT count(*)::int AS n FROM jobs`;
    expect(after[0].n).toBe(before[0].n);
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    expect(row.status).toBe(status);
  }
  const missing = await call(req("POST", "/api/admin/jobs/99999999/retry", PROD.adminToken, reason));
  expect(missing?.status).toBe(404);
  const badId = await call(req("POST", "/api/admin/jobs/abc/retry", PROD.adminToken, reason));
  expect(badId?.status).toBe(400);
});

test("retry: validation — short reason and unknown fields → 400", async () => {
  const deadId = await insertJob({ status: "dead" });
  expect((await call(req("POST", `/api/admin/jobs/${deadId}/retry`, PROD.adminToken, { reason: "short" })))?.status).toBe(400);
  expect((await call(req("POST", `/api/admin/jobs/${deadId}/retry`, PROD.adminToken, {})))?.status).toBe(400);
  expect(
    (await call(req("POST", `/api/admin/jobs/${deadId}/retry`, PROD.adminToken, { reason: "a valid ten char reason", extra: true })))?.status,
  ).toBe(400);
});

test("retry: admin cannot retry analytics producer jobs", async () => {
  for (const kind of PRODUCTION_KINDS) {
    const deadId = await insertJob({ kind, status: "dead" });
    const before = await sql`SELECT count(*)::int AS n FROM jobs`;
    const res = await call(
      req("POST", `/api/admin/jobs/${deadId}/retry`, PROD.adminToken, { reason: "analytics producer boundary test" }),
    );
    expect(res?.status).toBe(409);
    const after = await sql`SELECT count(*)::int AS n FROM jobs`;
    expect(after[0].n).toBe(before[0].n);
  }
});

// ── PATCH /api/admin/schedules/:id ──────────────────────────────────────────

test("schedule toggle: admin cannot enable retired consumer analytics schedules", async () => {
  const [row] = await sql`SELECT id, enabled FROM job_schedules WHERE kind = 'regime.classify' LIMIT 1`;
  const target = !row.enabled;
  const res = await call(
    req("PATCH", `/api/admin/schedules/${row.id}`, PROD.adminToken, { enabled: target, reason: "operational toggle for test coverage" }),
  );
  expect(res?.status).toBe(409);
  const [updated] = await sql`SELECT enabled, cron, kind FROM job_schedules WHERE id = ${row.id}`;
  expect(updated.enabled).toBe(row.enabled);
  expect(updated.kind).toBe("regime.classify"); // untouched
});

test("schedule toggle: 400/404/409 for unknown fields, missing, protected fields, non-analytics kind, committee demo rows", async () => {
  const [regime] = await sql`SELECT id FROM job_schedules WHERE kind = 'regime.classify' LIMIT 1`;
  const reason = "a perfectly fine operational reason";

  // unknown field
  expect((await call(req("PATCH", `/api/admin/schedules/${regime.id}`, PROD.adminToken, { enabled: true, reason, cron: "* * * * *" })))?.status).toBe(400);
  // missing schedule
  expect((await call(req("PATCH", "/api/admin/schedules/999999", PROD.adminToken, { enabled: true, reason })))?.status).toBe(404);
  // non-boolean enabled
  expect((await call(req("PATCH", `/api/admin/schedules/${regime.id}`, PROD.adminToken, { enabled: "yes", reason })))?.status).toBe(400);
  // short reason
  expect((await call(req("PATCH", `/api/admin/schedules/${regime.id}`, PROD.adminToken, { enabled: true, reason: "no" })))?.status).toBe(400);

  // non-analytics kind
  const [vault] = await sql`SELECT id FROM job_schedules WHERE kind = 'vault.sample_share_price' LIMIT 1`;
  expect((await call(req("PATCH", `/api/admin/schedules/${vault.id}`, PROD.adminToken, { enabled: false, reason })))?.status).toBe(400);

  // committee demo row
  const [committee] = await sql`SELECT id FROM job_schedules WHERE kind LIKE 'committee.%' LIMIT 1`;
  expect((await call(req("PATCH", `/api/admin/schedules/${committee.id}`, PROD.adminToken, { enabled: true, reason })))?.status).toBe(409);
  const [unchanged] = await sql`SELECT enabled FROM job_schedules WHERE id = ${committee.id}`;
  expect(unchanged.enabled).toBe(false); // seeded disabled, still disabled
});

// ── GET /api/admin/audit ────────────────────────────────────────────────────

test("audit: filters, cursor pagination, and redaction of credential-shaped keys", async () => {
  const actor = `sfc-actor-${crypto.randomUUID().slice(0, 8)}`;
  await sql`
    INSERT INTO audit_log (actor, action, target_type, target_id, reason, before_state, after_state, scope)
    VALUES (
      ${actor}, 'test_action', 'job', '123', 'covering redaction',
      ${sql.json(jsonValue({ status: "dead" }))},
      ${sql.json(jsonValue({
        status: "pending",
        credential: { token: "tok_should_not_leak" },
        headers: { Authorization: "Bearer secret", Cookie: "session=abc" },
        secret: "sssh",
        password: "hunter2",
        signature: "ed25519-sig-should-not-leak",
      }))},
      ${sql.json(jsonValue({ note: "plain" }))}
    )`;

  const res = await call(req("GET", `/api/admin/audit?actor=${actor}`, PROD.adminToken));
  expect(res?.status).toBe(200);
  const body = res?.body as { items: Array<Record<string, unknown>>; nextCursor: string | null };
  expect(body.items.length).toBe(1);
  const row = body.items[0];
  expect(row.actor).toBe(actor);
  expect(row.action).toBe("test_action");
  expect(row.target_type).toBe("job");
  expect(row.target_id).toBe("123");
  const after = row.after_state as Record<string, unknown>;
  expect(after.status).toBe("pending"); // non-sensitive fields pass through
  expect(JSON.stringify(after)).not.toContain("tok_should_not_leak");
  expect(JSON.stringify(after)).not.toContain("Bearer secret");
  expect(JSON.stringify(after)).not.toContain("session=abc");
  expect(JSON.stringify(after)).not.toContain("sssh");
  expect(JSON.stringify(after)).not.toContain("hunter2");
  expect(JSON.stringify(after)).not.toContain("ed25519-sig-should-not-leak");
  expect((after.credential as Record<string, unknown>).token).toBe("[redacted]");
  expect(after.secret).toBe("[redacted]");
  expect(after.password).toBe("[redacted]");
  expect(after.signature).toBe("[redacted]");

  // action filter narrows to zero for a non-matching action
  const noMatch = await call(req("GET", `/api/admin/audit?actor=${actor}&action=nope`, PROD.adminToken));
  expect((noMatch?.body as { items: unknown[] }).items.length).toBe(0);

  // 400s
  expect((await call(req("GET", "/api/admin/audit?limit=0", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/audit?cursor=***", PROD.adminToken)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/audit?from=not-a-date", PROD.adminToken)))?.status).toBe(400);
});

test("audit: cursor pagination walks distinct pages", async () => {
  const actor = `sfc-page-${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO audit_log (actor, action) VALUES (${actor}, ${`action_${i}`})`;
  }
  const page1 = await call(req("GET", `/api/admin/audit?actor=${actor}&limit=1`, PROD.adminToken));
  const p1 = page1?.body as { items: { id: number }[]; nextCursor: string | null };
  expect(p1.items.length).toBe(1);
  expect(p1.nextCursor).not.toBeNull();
  const page2 = await call(req("GET", `/api/admin/audit?actor=${actor}&limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`, PROD.adminToken));
  const p2 = page2?.body as { items: { id: number }[]; nextCursor: string | null };
  expect(p2.items.length).toBe(1);
  expect(p2.items[0].id).not.toBe(p1.items[0].id);
});

test("insecure config opens the new admin routes without a token", async () => {
  const res = await call(req("GET", "/api/admin/overview"), INSECURE);
  expect(res?.status).toBe(200);
  const auditRes = await call(req("GET", "/api/admin/audit"), INSECURE);
  expect(auditRes?.status).toBe(200);
});
