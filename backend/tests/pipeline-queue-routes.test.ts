// The queue through the routes (issue 1034, decision D75), against the RUNNING
// api over HTTP with a real pipeline-worker token. The semantics are the ones
// queue.test.ts, worker-lease.test.ts and worker-degrade-settlement.test.ts
// proved when the worker ran the statements itself:
//
//   - claim: the lane allowlist (include / exclude), priority first, then
//     run_after, then id; a claim increments the attempt;
//   - renew: refreshes the lease, 409 lease_lost once the job is not this
//     lease's;
//   - settle: succeeded; degraded with backoff, a terminal degrade straight to
//     failed, an exhausted degrade to failed (never dead); a throw retried with
//     backoff, then dead; each with its job_runs row;
//   - enqueue: idempotent on a dedupe key, and suppressed while a live job of
//     the kind exists when asked;
//   - tick: a due schedule's slot is enqueued once;
//   - reap: an expired lease is requeued, an exhausted one goes dead.
//
// And through the worker's own client: a renew the api answers 503 is retried
// after Retry-After, and the job keeps its lease.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { encodePipeline, PIPELINE_ROUTES, type PipelineLease } from "../src/lib/pipeline-wire.ts";
import { renewLease, setPipelineTransport } from "../src/worker/pipeline-client.ts";
import { inProcessPipelineTransport } from "./support/pipeline-in-process.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { bootApi, provisionPipelineToken, type ApiProcess } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

let api: ApiProcess;
let token = "";

beforeAll(async () => {
  token = await provisionPipelineToken();
  api = await bootApi();
  await fixtureDb`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE status IN ('pending', 'running')`;
  await fixtureDb`UPDATE job_schedules SET enabled = false`;
}, 120_000);
afterAll(() => api?.stop());

let keys = 0;
async function post(path: string, body: unknown, key: string | null = `k${++keys}`): Promise<{ status: number; body: any; retryAfter: string | null }> {
  const res = await fetch(`${api.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    body: encodePipeline(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, retryAfter: res.headers.get("Retry-After") };
}

const claim = async (include: string[], exclude: string[] = [], workerId = "routes-worker") => {
  const r = await post(PIPELINE_ROUTES.claim, { lane: { include, exclude }, workerId }, null);
  expect(r.status).toBe(200);
  const job = r.body.job as { id: number; kind: string; attempts: number; max_attempts: number } | null;
  return job ? { job, lease: { jobId: job.id, workerId, attempt: job.attempts } as PipelineLease } : null;
};

const settle = (lease: PipelineLease, outcome: unknown) =>
  post(PIPELINE_ROUTES.settle, { lease, outcome, startedAt: new Date() }, `${lease.jobId}.${lease.attempt}.settle`);

const jobRow = async (id: number) =>
  (await sql<{ status: string; attempts: number; run_after: Date; last_error: string | null; locked_by: string | null }[]>`
    SELECT status, attempts, run_after, last_error, locked_by FROM jobs WHERE id = ${id}`)[0]!;
const runs = async (id: number) =>
  (await sql<{ status: string }[]>`SELECT status FROM job_runs WHERE job_id = ${id} ORDER BY id`).map((r) => r.status);

describe("claim", () => {
  test("honours the lane allowlist: include patterns, exclude patterns", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('lane.keep', '{}'), ('lane.skip', '{}')`;
    const got = await claim(["lane.%"], ["lane.skip"]);
    expect(got!.job.kind).toBe("lane.keep");
    expect(await claim(["lane.%"], ["lane.skip"])).toBeNull();
    const skip = await claim(["lane.skip"]);
    expect(skip!.job.kind).toBe("lane.skip");
  });

  test("takes priority first, then run_after, then id; and increments the attempt", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload, priority, run_after) VALUES
      ('order.low', '{}', 0, now() - interval '1 hour'),
      ('order.high', '{}', 5, now()),
      ('order.tie-a', '{}', 1, '2026-01-01T00:00:00Z'),
      ('order.tie-b', '{}', 1, '2026-01-01T00:00:00Z')`;
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await claim(["order.%"]))!.job.kind);
    expect(order).toEqual(["order.high", "order.tie-a", "order.tie-b", "order.low"]);
    const [row] = await sql<{ attempts: number }[]>`SELECT attempts FROM jobs WHERE kind = 'order.high'`;
    expect(row!.attempts).toBe(1);
  });
});

describe("renew", () => {
  test("refreshes the lease while it holds, and answers 409 lease_lost after the reaper took it", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('renew.one', '{}')`;
    const { job, lease } = (await claim(["renew.one"]))!;
    await fixtureDb`UPDATE jobs SET locked_at = now() - interval '2 minutes' WHERE id = ${job.id}`;
    expect((await post(PIPELINE_ROUTES.renew, { lease }, null)).status).toBe(200);
    const [fresh] = await sql<{ age: number }[]>`SELECT extract(epoch FROM now() - locked_at)::float AS age FROM jobs WHERE id = ${job.id}`;
    expect(fresh!.age).toBeLessThan(30);

    await fixtureDb`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${job.id}`;
    expect((await post(PIPELINE_ROUTES.reap, { visibilitySeconds: 60 }, null)).status).toBe(200);
    const lost = await post(PIPELINE_ROUTES.renew, { lease }, null);
    expect(lost.status).toBe(409);
    expect(lost.body.error).toBe("lease_lost");
  });

  test("through the worker's client, a renew the api answers 503 is retried after Retry-After and keeps the lease", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('renew.saturated', '{}')`;
    const { job, lease } = (await claim(["renew.saturated"]))!;
    let refused = 0;
    const calls: number[] = [];
    setPipelineTransport(async (path, body, headers) => {
      calls.push(Date.now());
      if (refused === 0) {
        refused++;
        return { status: 503, text: JSON.stringify({ error: "db_saturated" }), retryAfter: "0" };
      }
      const res = await fetch(`${api.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
        body,
      });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get("Retry-After") };
    });
    try {
      expect(await renewLease(lease)).toBe(true);
    } finally {
      setPipelineTransport(inProcessPipelineTransport);
    }
    expect(calls.length).toBe(2);
    const row = await jobRow(job.id);
    expect({ status: row.status, lockedBy: row.locked_by }).toEqual({ status: "running", lockedBy: "routes-worker" });
  });
});

describe("settle", () => {
  test("succeeded: status succeeded and a succeeded run carrying the output", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('settle.ok', '{}')`;
    const { job, lease } = (await claim(["settle.ok"]))!;
    const r = await settle(lease, { kind: "succeeded", output: { done: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ settled: true, status: "succeeded" });
    expect((await jobRow(job.id)).status).toBe("succeeded");
    const [run] = await sql<{ status: string; output: unknown }[]>`SELECT status, output FROM job_runs WHERE job_id = ${job.id}`;
    expect(run).toEqual({ status: "succeeded", output: { done: true } });
  });

  test("degraded: pending with backoff and a degraded run; a terminal degrade settles failed at once; an exhausted degrade settles failed, never dead", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('settle.degraded', '{}', 2)`;
    let { job, lease } = (await claim(["settle.degraded"]))!;
    let r = await settle(lease, { kind: "degraded", error: "provider down", terminal: false, output: { ok: false } });
    expect(r.body).toMatchObject({ settled: true, status: "pending", backoffSeconds: 2 });
    let row = await jobRow(job.id);
    expect(row.status).toBe("pending");
    expect(new Date(row.run_after).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_error).toBe("provider down");

    await fixtureDb`UPDATE jobs SET run_after = now() WHERE id = ${job.id}`;
    ({ job, lease } = (await claim(["settle.degraded"]))!);
    r = await settle(lease, { kind: "degraded", error: "still down", terminal: false, output: { ok: false } });
    expect(r.body).toMatchObject({ settled: true, status: "failed" });
    expect((await jobRow(job.id)).status).toBe("failed");
    expect(await runs(job.id)).toEqual(["degraded", "degraded"]);

    await fixtureDb`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('settle.terminal', '{}', 5)`;
    const t = (await claim(["settle.terminal"]))!;
    r = await settle(t.lease, { kind: "degraded", error: "refused for good", terminal: true, output: { ok: false, terminal: true } });
    expect(r.body).toMatchObject({ settled: true, status: "failed" });
    expect(await runs(t.job.id)).toEqual(["failed"]);
  });

  test("failed (the handler threw): retried with backoff, then dead on the last attempt", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload, max_attempts) VALUES ('settle.throw', '{}', 2)`;
    let { job, lease } = (await claim(["settle.throw"]))!;
    let r = await settle(lease, { kind: "failed", error: "boom" });
    expect(r.body).toMatchObject({ settled: true, status: "pending", backoffSeconds: 2 });
    await fixtureDb`UPDATE jobs SET run_after = now() WHERE id = ${job.id}`;
    ({ job, lease } = (await claim(["settle.throw"]))!);
    r = await settle(lease, { kind: "failed", error: "boom" });
    expect(r.body).toMatchObject({ settled: true, status: "dead" });
    expect(await runs(job.id)).toEqual(["failed", "dead"]);
  });

  test("a settle replayed with its key returns the recorded answer and records no second run", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('settle.replay', '{}')`;
    const { job, lease } = (await claim(["settle.replay"]))!;
    const body = { lease, outcome: { kind: "succeeded", output: null }, startedAt: new Date("2026-01-01T00:00:00Z") };
    const first = await post(PIPELINE_ROUTES.settle, body, `${lease.jobId}.${lease.attempt}.settle`);
    const replay = await post(PIPELINE_ROUTES.settle, body, `${lease.jobId}.${lease.attempt}.settle`);
    expect(replay).toEqual(first);
    expect(await runs(job.id)).toEqual(["succeeded"]);
  });
});

describe("enqueue", () => {
  test("is idempotent on its dedupe key, and suppressed while a live job of the kind exists when asked", async () => {
    await fixtureDb`INSERT INTO jobs (kind, payload) VALUES ('enqueue.parent', '{}')`;
    const { lease } = (await claim(["enqueue.parent"]))!;
    const a = await post(PIPELINE_ROUTES.enqueue, { lease, request: { kind: "enqueue.child", payload: { n: 1 }, dedupeKey: "child:1", unlessLive: false } });
    expect(typeof a.body.id).toBe("number");
    const dup = await post(PIPELINE_ROUTES.enqueue, { lease, request: { kind: "enqueue.child", payload: { n: 1 }, dedupeKey: "child:1", unlessLive: false } });
    expect(dup.body.id).toBeNull();

    const window1 = await post(PIPELINE_ROUTES.enqueue, { lease, request: { kind: "enqueue.window", payload: { dates: ["2026-01-01"] }, dedupeKey: null, unlessLive: true } });
    expect(typeof window1.body.id).toBe("number");
    const window2 = await post(PIPELINE_ROUTES.enqueue, { lease, request: { kind: "enqueue.window", payload: { dates: ["2026-01-02"] }, dedupeKey: null, unlessLive: true } });
    expect(window2.body.id).toBeNull();
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind IN ('enqueue.child', 'enqueue.window')`;
    expect(n!.n).toBe(2);
  });
});

describe("tick and reap", () => {
  test("tick enqueues a due schedule's slot once", async () => {
    await fixtureDb`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, next_run_at, catchup_policy)
      VALUES ('tick.hourly', '0 * * * *', '{}', 'UTC', true, date_trunc('hour', now()), 'all')`;
    const first = await post(PIPELINE_ROUTES.tick, {}, null);
    expect(first.body.enqueued).toBe(1);
    expect((await post(PIPELINE_ROUTES.tick, {}, null)).body.enqueued).toBe(0);
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = 'tick.hourly'`;
    expect(n!.n).toBe(1);
  });

  test("reap requeues an expired lease with backoff, and an exhausted one goes dead", async () => {
    const [{ id: a }] = await fixtureDb<{ id: number }[]>`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
      VALUES ('reap.a', '{}', 'running', now() - interval '10 minutes', 'gone', 1, 5) RETURNING id`;
    const [{ id: b }] = await fixtureDb<{ id: number }[]>`INSERT INTO jobs (kind, payload, status, locked_at, locked_by, attempts, max_attempts)
      VALUES ('reap.b', '{}', 'running', now() - interval '10 minutes', 'gone', 5, 5) RETURNING id`;
    const r = await post(PIPELINE_ROUTES.reap, { visibilitySeconds: 300 }, null);
    expect(r.body.reaped).toBeGreaterThanOrEqual(2);
    expect((await jobRow(a)).status).toBe("pending");
    expect((await jobRow(b)).status).toBe("dead");
  });
});
