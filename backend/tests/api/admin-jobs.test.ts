// Admin task-queue dashboard (read-only over jobs/job_schedules/job_runs). Runs
// against the ephemeral Postgres the preload provisions (real DB, never mocked) —
// if Postgres is absent the preload THROWS, so this suite fails red rather than
// skipping. Asserts the fail-closed auth guard (403 without a token in prod-mode,
// 200 with the right X-Admin-Token, 403 with a wrong one, 200 when insecure), and
// that the endpoints surface the inserted job + its runs' output/error (the logs).
import { test, expect, afterAll } from "bun:test";
import { sql, jsonValue } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";

// Prod-mode auth: a token is configured and the insecure convenience path is off,
// so a request WITHOUT the matching X-Admin-Token must be rejected (fail-closed).
const PROD = { adminToken: "s3cret-admin-token", allowInsecure: false } as const;
const INSECURE = { adminToken: null, allowInsecure: true } as const;
const LOCKED = { adminToken: null, allowInsecure: false } as const;

// A unique kind per run so the summary/feed assertions don't collide with rows
// another test (or the seed) may have left behind.
const KIND = `az_${crypto.randomUUID().slice(0, 8)}`;

function req(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["X-Admin-Token"] = token;
  return new Request(`http://x${path}`, { method, headers });
}
const call = (r: Request, cfg: typeof PROD | typeof INSECURE | typeof LOCKED) =>
  handleAdmin(r, new URL(r.url), cfg);

// Insert one job + two runs (one succeeded with jsonb output, one failed with an
// error string) — the runs' output/error are the "logs" the dashboard renders.
async function seed(): Promise<number> {
  const [job] = await sql`
    INSERT INTO jobs ${sql({ kind: KIND, status: "succeeded", attempts: 1, last_error: null })}
    RETURNING id`;
  const jobId = Number(job.id);
  await sql`
    INSERT INTO job_runs ${sql({
      job_id: jobId, kind: KIND, status: "succeeded", error: null,
      output: sql.json(jsonValue({ ran: true, note: "analytics ok" })),
    })}`;
  await sql`
    INSERT INTO job_runs ${sql({
      job_id: jobId, kind: KIND, status: "failed", error: "boom: upstream 500",
      output: sql.json(jsonValue({ ran: false })),
    })}`;
  return jobId;
}

afterAll(async () => {
  await sql`DELETE FROM job_runs WHERE kind = ${KIND}`;
  await sql`DELETE FROM jobs WHERE kind = ${KIND}`;
});

test("prod-mode with no token → 403 on every owned admin route (fail-closed)", async () => {
  const jobId = await seed();
  expect((await call(req("POST", "/api/admin/auth"), PROD))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/jobs"), PROD))?.status).toBe(403);
  expect((await call(req("GET", `/api/admin/jobs/${jobId}`), PROD))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/runs"), PROD))?.status).toBe(403);
});

test("wrong token → 403", async () => {
  expect((await call(req("GET", "/api/admin/jobs", "nope"), PROD))?.status).toBe(403);
  expect((await call(req("POST", "/api/admin/auth", "nope"), PROD))?.status).toBe(403);
});

test("correct X-Admin-Token → auth ok + jobs list with the inserted job and a summary", async () => {
  const jobId = await seed();
  const auth = await call(req("POST", "/api/admin/auth", PROD.adminToken), PROD);
  expect(auth?.status).toBe(200);
  expect((auth?.body as { ok: boolean }).ok).toBe(true);

  const res = await call(req("GET", "/api/admin/jobs", PROD.adminToken), PROD);
  expect(res?.status).toBe(200);
  const body = res?.body as {
    jobs: { id: number; kind: string }[];
    schedules: unknown[];
    summary: { byStatus: Record<string, number>; byKind: Record<string, number> };
  };
  expect(body.jobs.some((j) => Number(j.id) === jobId && j.kind === KIND)).toBe(true);
  expect(Array.isArray(body.schedules)).toBe(true);
  // The summary counts our unique kind and the succeeded status it carries.
  expect(body.summary.byKind[KIND]).toBeGreaterThanOrEqual(1);
  expect(body.summary.byStatus.succeeded).toBeGreaterThanOrEqual(1);
});

test("job detail returns the job + its runs including the output/error logs", async () => {
  const jobId = await seed();
  const res = await call(req("GET", `/api/admin/jobs/${jobId}`, PROD.adminToken), PROD);
  expect(res?.status).toBe(200);
  const body = res?.body as {
    job: { id: number; kind: string };
    runs: { status: string; error: string | null; output: unknown }[];
  };
  expect(Number(body.job.id)).toBe(jobId);
  expect(body.runs.length).toBe(2);
  const failed = body.runs.find((r) => r.status === "failed");
  expect(failed?.error).toBe("boom: upstream 500");
  const ok = body.runs.find((r) => r.status === "succeeded");
  expect((ok?.output as { note: string }).note).toBe("analytics ok");
});

test("runs feed filtered by ?kind= returns the inserted runs (the log feed)", async () => {
  await seed();
  const res = await call(req("GET", `/api/admin/runs?kind=${KIND}`, PROD.adminToken), PROD);
  expect(res?.status).toBe(200);
  const body = res?.body as { runs: { kind: string; job_id: number }[] };
  expect(body.runs.length).toBeGreaterThanOrEqual(2);
  expect(body.runs.every((r) => r.kind === KIND)).toBe(true);

  // ?status= narrows it further.
  const failedOnly = await call(req("GET", `/api/admin/runs?kind=${KIND}&status=failed`, PROD.adminToken), PROD);
  const fb = failedOnly?.body as { runs: { status: string }[] };
  expect(fb.runs.length).toBeGreaterThanOrEqual(1);
  expect(fb.runs.every((r) => r.status === "failed")).toBe(true);
});

test("insecure config (RM_ALLOW_INSECURE/ephemeral) opens the dashboard without a token", async () => {
  const jobId = await seed();
  expect((await call(req("POST", "/api/admin/auth"), INSECURE))?.status).toBe(200);
  expect((await call(req("GET", "/api/admin/jobs"), INSECURE))?.status).toBe(200);
  expect((await call(req("GET", `/api/admin/jobs/${jobId}`), INSECURE))?.status).toBe(200);
});

test("bad shapes: non-numeric id → 400; unknown numeric id → 404", async () => {
  const bad = await call(req("GET", "/api/admin/jobs/abc", PROD.adminToken), PROD);
  expect(bad?.status).toBe(400);
  const missing = await call(req("GET", "/api/admin/jobs/99999999", PROD.adminToken), PROD);
  expect(missing?.status).toBe(404);
});

test("a path this handler does not own returns null (index.ts falls through to 404)", async () => {
  expect(await call(req("GET", "/api/admin/nope"), INSECURE)).toBeNull();
});
