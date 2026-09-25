// Admin task-queue dashboard (read-only over jobs/job_schedules/job_runs). Runs
// against the ephemeral Postgres the preload provisions (real DB, never mocked) —
// if Postgres is absent the preload THROWS, so this suite fails red rather than
// skipping. Asserts the fail-closed auth guard (403 without a credential, 200
// with the operator's store token as X-Admin-Token, 403 with a wrong one — and
// still 403 without one in this RM_ENV=ephemeral process, which used to open
// the dashboard; D52 (1)), and that the endpoints surface the inserted job +
// its runs' output/error (the logs).
import { test, expect, afterAll, beforeAll } from "bun:test";
import { sql, jsonValue } from "../../src/db/client.ts";
import { handleAdmin } from "../../src/api/routes/admin.ts";
import { provisionOperatorToken } from "../support/automation-auth.ts";

// The operator's admin token, issued by the store like the real one.
let OPERATOR = "";
beforeAll(async () => {
  OPERATOR = await provisionOperatorToken();
});

// A unique kind per run so the summary/feed assertions don't collide with rows
// another test (or the seed) may have left behind.
const KIND = `az_${crypto.randomUUID().slice(0, 8)}`;

function req(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["X-Admin-Token"] = token;
  return new Request(`http://x${path}`, { method, headers });
}
const call = (r: Request) => handleAdmin(r, new URL(r.url));

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

test("no credential → 403 on every owned admin route (fail-closed)", async () => {
  const jobId = await seed();
  expect((await call(req("POST", "/api/admin/auth")))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/jobs")))?.status).toBe(403);
  expect((await call(req("GET", `/api/admin/jobs/${jobId}`)))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/runs")))?.status).toBe(403);
});

test("wrong token → 403", async () => {
  expect((await call(req("GET", "/api/admin/jobs", "nope")))?.status).toBe(403);
  expect((await call(req("POST", "/api/admin/auth", "nope")))?.status).toBe(403);
});

test("correct X-Admin-Token → auth ok + jobs list with the inserted job and a summary", async () => {
  const jobId = await seed();
  const auth = await call(req("POST", "/api/admin/auth", OPERATOR));
  expect(auth?.status).toBe(200);
  expect((auth?.body as { ok: boolean }).ok).toBe(true);

  const res = await call(req("GET", "/api/admin/jobs", OPERATOR));
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
  const res = await call(req("GET", `/api/admin/jobs/${jobId}`, OPERATOR));
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

// The `?id=` filter — the exact-lookup the swarm driver's judge wait uses to
// poll ONE known job by id (`GET /api/admin/jobs?id=<jobId>`). Must return
// precisely that job (never siblings sharing a kind), 400 on a malformed id,
// and the SAME row shape the list serves.
test("jobs list filters by exact id, and rejects a malformed id", async () => {
  const jobId = await seed();
  const otherId = await seed();

  const res = await call(req("GET", `/api/admin/jobs?id=${jobId}`, OPERATOR));
  expect(res?.status).toBe(200);
  const body = res?.body as { jobs: { id: number; kind: string; status: string; attempts: number }[] };
  expect(body.jobs).toHaveLength(1);
  expect(Number(body.jobs[0]!.id)).toBe(jobId);
  expect(body.jobs[0]!.kind).toBe(KIND);
  expect(body.jobs[0]!.status).toBe("succeeded");

  // A sibling sharing the same kind is NOT returned.
  const onlyOther = await call(req("GET", `/api/admin/jobs?id=${otherId}`, OPERATOR));
  const otherBody = onlyOther?.body as { jobs: { id: number }[] };
  expect(otherBody.jobs.map((j) => Number(j.id))).toEqual([otherId]);

  // Malformed id → 400, same discipline as the other strict filters.
  expect((await call(req("GET", "/api/admin/jobs?id=abc", OPERATOR)))?.status).toBe(400);
  expect((await call(req("GET", "/api/admin/jobs?id=0", OPERATOR)))?.status).toBe(400);
});

// AC3 (issue #151) — a non-fatal telemetry write failure must still be
// visible in admin status. worker/loop.ts persists whatever the handler
// returns (including a `telemetry` field folded in by
// worker/handlers/analytics.ts) verbatim into job_runs.output, and this
// endpoint returns that output verbatim — proven generically above by the
// `note` field; this asserts the specific `telemetry` shape survives too.
test("job detail surfaces a non-fatal telemetry failure recorded in a run's output (AC3: job output + admin status)", async () => {
  const [job] = await sql`
    INSERT INTO jobs ${sql({ kind: KIND, status: "succeeded", attempts: 1, last_error: null })}
    RETURNING id`;
  const jobId = Number(job.id);
  await sql`
    INSERT INTO job_runs ${sql({
      job_id: jobId, kind: KIND, status: "succeeded", error: null,
      output: sql.json(jsonValue({
        asof: "2026-07-15",
        tools: ["regime"],
        telemetry: { ok: false, error: "simulated telemetry outage" },
      })),
    })}`;

  const res = await call(req("GET", `/api/admin/jobs/${jobId}`, OPERATOR));
  expect(res?.status).toBe(200);
  const body = res?.body as { runs: { output: { telemetry: { ok: boolean; error: string } } }[] };
  const run = body.runs.find((r) => (r.output as any)?.telemetry !== undefined);
  expect(run).toBeDefined();
  expect(run!.output.telemetry.ok).toBe(false);
  expect(run!.output.telemetry.error).toContain("simulated telemetry outage");
});

test("runs feed filtered by ?kind= returns the inserted runs (the log feed)", async () => {
  await seed();
  const res = await call(req("GET", `/api/admin/runs?kind=${KIND}`, OPERATOR));
  expect(res?.status).toBe(200);
  const body = res?.body as { runs: { kind: string; job_id: number }[] };
  expect(body.runs.length).toBeGreaterThanOrEqual(2);
  expect(body.runs.every((r) => r.kind === KIND)).toBe(true);

  // ?status= narrows it further.
  const failedOnly = await call(req("GET", `/api/admin/runs?kind=${KIND}&status=failed`, OPERATOR));
  const fb = failedOnly?.body as { runs: { status: string }[] };
  expect(fb.runs.length).toBeGreaterThanOrEqual(1);
  expect(fb.runs.every((r) => r.status === "failed")).toBe(true);
});

test("RM_ENV=ephemeral no longer opens the dashboard without a credential (D52 (1))", async () => {
  // This process runs under RM_ENV=ephemeral (tests/preload.ts), which is
  // exactly the env that used to wave a tokenless caller through.
  expect(process.env.RM_ENV).toBe("ephemeral");
  const jobId = await seed();
  expect((await call(req("POST", "/api/admin/auth")))?.status).toBe(403);
  expect((await call(req("GET", "/api/admin/jobs")))?.status).toBe(403);
  expect((await call(req("GET", `/api/admin/jobs/${jobId}`)))?.status).toBe(403);
});

test("bad shapes: non-numeric id → 400; unknown numeric id → 404", async () => {
  const bad = await call(req("GET", "/api/admin/jobs/abc", OPERATOR));
  expect(bad?.status).toBe(400);
  const missing = await call(req("GET", "/api/admin/jobs/99999999", OPERATOR));
  expect(missing?.status).toBe(404);
});

test("a path this handler does not own returns null (index.ts falls through to 404)", async () => {
  expect(await call(req("GET", "/api/admin/nope"))).toBeNull();
});
