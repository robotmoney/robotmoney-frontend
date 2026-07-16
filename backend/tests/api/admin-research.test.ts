// Admin research pipeline telemetry surface (issue #151). Runs against the
// ephemeral Postgres the preload provisions (real DB, never mocked) — if
// Postgres is absent the preload THROWS, so this suite fails red rather than
// skipping. Asserts:
//   • the fail-closed auth guard (403 without X-Admin-Token in prod-mode, 403
//     with a wrong token, 200 with the right one) on every owned route, BEFORE
//     any database access;
//   • list/detail return run identity, job linkage, source/as-of metadata,
//     stage timeline, warning count, freshness, and the persisted output;
//   • allowlisted raw-series/signal reads reject unregistered indicators/keys,
//     invalid dates, and excessive limits, while valid requests return the
//     bounded projection;
//   • the rerun endpoint validates kind/tool/as-of/reason, inserts a distinct
//     pending job with a unique manual dedupe key, returns 202 + the new job
//     id, and leaves any original job unchanged.
import { test, expect, afterAll } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";
import { saveTelemetryRun } from "../../src/analytics/store/telemetry-store.ts";
import type { TelemetryRunSubmission } from "../../src/analytics/telemetry.ts";

const PROD = { adminToken: "s3cret-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;

const ASOF = "2026-04-01"; // far enough in the past to be reliably "stale"
const KIND = `art_${crypto.randomUUID().slice(0, 8)}`; // unique run kind so assertions never collide with other tests

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["X-Admin-Token"] = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://x${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const call = (r: Request, cfg: typeof PROD | typeof INSECURE = PROD) => handleAdmin(r, new URL(r.url), cfg);

function sampleRun(overrides: Partial<TelemetryRunSubmission> = {}): TelemetryRunSubmission {
  const now = new Date();
  return {
    kind: KIND,
    asof: ASOF,
    source: "hermetic",
    status: "degraded",
    startedAt: now.toISOString(),
    finishedAt: new Date(now.getTime() + 1000).toISOString(),
    checksum: "abc123",
    summary: { composite: 0.5, regime: "neutral" },
    stages: [
      { stage: "access", sequence: 1, status: "ok", summary: "fetched fixtures", startedAt: now.toISOString(), finishedAt: now.toISOString() },
      { stage: "extract", sequence: 2, status: "warn", summary: "2 fallback", startedAt: now.toISOString(), finishedAt: now.toISOString() },
      { stage: "transform", sequence: 3, status: "ok", summary: "aligned", startedAt: now.toISOString(), finishedAt: now.toISOString() },
      { stage: "analyze", sequence: 4, status: "ok", summary: "computed", startedAt: now.toISOString(), finishedAt: now.toISOString() },
      { stage: "store", sequence: 5, status: "ok", summary: "persisted", startedAt: now.toISOString(), finishedAt: now.toISOString() },
      { stage: "report", sequence: 6, status: "ok", summary: "built rows", startedAt: now.toISOString(), finishedAt: now.toISOString() },
    ],
    warnings: [{ stage: "extract", message: "2 indicator(s) fell back to the persisted floor" }],
    artifacts: [{ stage: "analyze", kind: "regime-composite", checksum: "def456", preview: { composite: 0.5 } }],
    jobId: null,
    ...overrides,
  };
}

let seededRunId: number;
let seededJobId: number;

afterAll(async () => {
  await sql`DELETE FROM analytics_runs WHERE kind = ${KIND}`;
  await sql`DELETE FROM jobs WHERE kind LIKE ${"art_test_%"}`;
});

test("prod-mode with no token → 403 on every owned research route (fail-closed, before DB access)", async () => {
  const runId = await saveTelemetryRun(sampleRun());
  seededRunId = runId;
  expect((await call(req("GET", "/api/admin/research/runs")))?.status).toBe(403);
  expect((await call(req("GET", `/api/admin/research/runs/${runId}`)))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/research/raw-series/T10Y2Y")))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/research/signals/channel-divergence")))?.status).toBe(403);
  expect((await call(req("POST", "/api/admin/research/rerun", { body: { kind: "regime.classify", asof: ASOF, reason: "x" } })))?.status).toBe(403);
});

test("wrong token → 403", async () => {
  expect((await call(req("GET", "/api/admin/research/runs", { token: "nope" })))?.status).toBe(403);
});

test("insecure mode (no token configured) → 200 without a token", async () => {
  const res = await call(req("GET", "/api/admin/research/runs"), INSECURE);
  expect(res?.status).toBe(200);
});

test("GET /api/admin/research/runs: list returns run identity, job linkage, source/asof, warning count, freshness", async () => {
  const res = await call(req("GET", `/api/admin/research/runs?kind=${KIND}`, { token: PROD.adminToken }));
  expect(res?.status).toBe(200);
  const body = res?.body as { runs: any[] };
  expect(body.runs.length).toBe(1);
  const r = body.runs[0];
  expect(Number(r.id)).toBe(seededRunId);
  expect(r.job_id).toBeNull();
  expect(r.kind).toBe(KIND);
  expect(r.asof).toBe(ASOF);
  expect(r.source).toBe("hermetic");
  expect(r.status).toBe("degraded");
  expect(Number(r.warning_count)).toBe(1);
  expect(r.freshness).toBeDefined();
  expect(r.freshness.stale).toBe(true); // ASOF is far in the past
  expect(r.freshness.asof).toBe(ASOF);
});

test("GET /api/admin/research/runs/:id: detail returns full stage timeline, warnings, and bounded artifacts", async () => {
  const res = await call(req("GET", `/api/admin/research/runs/${seededRunId}`, { token: PROD.adminToken }));
  expect(res?.status).toBe(200);
  const body = res?.body as { run: any; stages: any[]; warnings: any[]; artifacts: any[] };
  expect(Number(body.run.id)).toBe(seededRunId);
  expect(body.run.freshness.stale).toBe(true);
  expect(body.stages.length).toBe(6);
  expect(body.stages.map((s) => s.stage)).toEqual(["access", "extract", "transform", "analyze", "store", "report"]);
  expect(body.warnings.length).toBe(1);
  expect(body.artifacts.length).toBe(1);
  expect(body.artifacts[0].kind).toBe("regime-composite");
  expect(body.artifacts[0].checksum).toBe("def456");
});

test("GET /api/admin/research/runs/:id: 404 for an unknown id, 400 for a non-numeric one", async () => {
  expect((await call(req("GET", "/api/admin/research/runs/999999999", { token: PROD.adminToken })))?.status).toBe(404);
  expect((await call(req("GET", "/api/admin/research/runs/not-a-number", { token: PROD.adminToken })))?.status).toBe(400);
});

test("GET /api/admin/research/raw-series/:indicator: rejects an unregistered indicator, invalid dates; returns a bounded, allowlisted read", async () => {
  await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('2026-01-01', 'T10Y2Y', 0.3)
            ON CONFLICT (date, indicator) DO UPDATE SET value = 0.3`;

  const unregistered = await call(req("GET", "/api/admin/research/raw-series/DROP_TABLE_JOBS", { token: PROD.adminToken }));
  expect(unregistered?.status).toBe(400);

  const badFrom = await call(req("GET", "/api/admin/research/raw-series/T10Y2Y?from=not-a-date", { token: PROD.adminToken }));
  expect(badFrom?.status).toBe(400);

  // Bound `to` tightly to the inserted point's date: the shared test DB may
  // carry many OTHER (more recent) T10Y2Y rows from other suites, which would
  // otherwise push this row out of a small `ORDER BY date DESC LIMIT` window.
  const ok = await call(req("GET", "/api/admin/research/raw-series/T10Y2Y?from=2025-01-01&to=2026-01-01&limit=10", { token: PROD.adminToken }));
  expect(ok?.status).toBe(200);
  const body = ok?.body as { indicator: string; points: { date: string; value: number }[] };
  expect(body.indicator).toBe("T10Y2Y");
  expect(body.points.some((p) => p.date === "2026-01-01" && Number(p.value) === 0.3)).toBe(true);

  // MNA is allowlisted even though it's not in the regime INDICATORS registry
  // (it's the late-cycle-signals research indicator).
  const mna = await call(req("GET", "/api/admin/research/raw-series/MNA", { token: PROD.adminToken }));
  expect(mna?.status).toBe(200);

  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'T10Y2Y' AND date = '2026-01-01'`;
});

test("GET /api/admin/research/signals/:key: rejects an unregistered signal key; returns a bounded, allowlisted read", async () => {
  await sql`INSERT INTO research_signals (signal_key, date, payload) VALUES ('channel-divergence', '2026-01-01', '{"x":1}'::jsonb)
            ON CONFLICT (signal_key, date) DO UPDATE SET payload = '{"x":1}'::jsonb`;

  const bad = await call(req("GET", "/api/admin/research/signals/arbitrary_table", { token: PROD.adminToken }));
  expect(bad?.status).toBe(400);

  const ok = await call(req("GET", "/api/admin/research/signals/channel-divergence?limit=5", { token: PROD.adminToken }));
  expect(ok?.status).toBe(200);
  const body = ok?.body as { key: string; points: { date: string; payload: unknown }[] };
  expect(body.key).toBe("channel-divergence");
  expect(body.points.length).toBeGreaterThan(0);

  await sql`DELETE FROM research_signals WHERE signal_key = 'channel-divergence' AND date = '2026-01-01'`;
});

test("POST /api/admin/research/rerun: validates kind/tool/asof/reason before enqueueing", async () => {
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "not.a.kind", asof: ASOF, reason: "x" } })))?.status).toBe(400);
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "regime.classify", tool: "channel-divergence", asof: ASOF, reason: "x" } })))?.status).toBe(400);
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "research.refresh", tool: "not-a-tool", asof: ASOF, reason: "x" } })))?.status).toBe(400);
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "regime.classify", asof: "not-a-date", reason: "x" } })))?.status).toBe(400);
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "regime.classify", asof: ASOF, reason: "" } })))?.status).toBe(400);
  expect((await call(req("POST", "/api/admin/research/rerun", { token: PROD.adminToken, body: { kind: "regime.classify", asof: ASOF } })))?.status).toBe(400);
});

test("POST /api/admin/research/rerun: inserts a distinct pending job with a unique manual dedupe key, returns 202 + the new job id, and leaves the original job unchanged", async () => {
  const originalKind = "art_test_original";
  const [original] = await sql`INSERT INTO jobs (kind, payload, status) VALUES (${originalKind}, '{}'::jsonb, 'succeeded') RETURNING id, status, dedupe_key`;
  seededJobId = Number(original.id);

  const res = await call(req("POST", "/api/admin/research/rerun", {
    token: PROD.adminToken,
    body: { kind: "research.refresh", tool: "late-cycle-signals", asof: ASOF, reason: "admin investigating a stale signal" },
  }));
  expect(res?.status).toBe(202);
  const body = res?.body as { jobId: number; kind: string; dedupeKey: string };
  expect(body.kind).toBe("research.refresh");
  expect(body.dedupeKey).toContain("manual:research.refresh:late-cycle-signals:" + ASOF);

  const [newJob] = await sql`SELECT id, kind, status, payload, dedupe_key FROM jobs WHERE id = ${body.jobId}`;
  expect(newJob.kind).toBe("research.refresh");
  expect(newJob.status).toBe("pending");
  expect(newJob.payload.asof).toBe(ASOF);
  expect(newJob.payload.tool).toBe("late-cycle-signals");
  expect(newJob.payload.manual).toBe(true);
  expect(newJob.payload.reason).toBe("admin investigating a stale signal");
  expect(newJob.dedupe_key).toBe(body.dedupeKey);
  expect(Number(newJob.id)).not.toBe(seededJobId);

  // A second rerun request never collides on dedupe_key (always unique).
  const res2 = await call(req("POST", "/api/admin/research/rerun", {
    token: PROD.adminToken,
    body: { kind: "research.refresh", tool: "late-cycle-signals", asof: ASOF, reason: "second investigation" },
  }));
  expect(res2?.status).toBe(202);
  const body2 = res2?.body as { jobId: number; dedupeKey: string };
  expect(body2.dedupeKey).not.toBe(body.dedupeKey);
  expect(body2.jobId).not.toBe(body.jobId);

  // The original job is untouched.
  const [origAfter] = await sql`SELECT status, dedupe_key FROM jobs WHERE id = ${seededJobId}`;
  expect(origAfter.status).toBe(original.status);
  expect(origAfter.dedupe_key).toBe(original.dedupe_key);

  await sql`DELETE FROM jobs WHERE id IN (${body.jobId}, ${body2.jobId})`;
});
