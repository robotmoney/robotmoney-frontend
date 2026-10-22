// Pipeline writes are idempotent, bounded and fenced (issue 1034, decision D75),
// proven against the RUNNING api over HTTP with a real pipeline-worker token.
//
//   - A replay with the same Idempotency-Key and body adds no row and returns
//     the recorded response; the same key with another body answers 409.
//   - A request carrying 1,001 rows answers 413 and writes nothing.
//   - A write or a settle after the reaper took the lease, or with a stale
//     attempt, answers 409 lease_lost and writes nothing.
//
// The write used for the row counts is `analytics.parity_sweep`: it APPENDS an
// observation on every execution, so a replay that ran again would show up as
// a second row (an upsert would hide it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { encodePipeline, IDEMPOTENCY_KEY_HEADER, PIPELINE_ROUTES, type PipelineLease } from "../src/lib/pipeline-wire.ts";
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
}, 120_000);
afterAll(() => api?.stop());

async function post(path: string, body: unknown, key?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${api.base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}) },
    body: typeof body === "string" ? body : encodePipeline(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Queue one job of `kind` and claim it over the route; the lease the claim gave. */
async function claimed(kind: string, workerId = "idem-worker"): Promise<PipelineLease> {
  await fixtureDb`INSERT INTO jobs (kind, payload) VALUES (${kind}, '{}'::jsonb)`;
  const r = await post(PIPELINE_ROUTES.claim, { lane: { include: [kind], exclude: [] }, workerId });
  expect(r.status).toBe(200);
  const job = JSON.parse(r.text).job as { id: number; attempts: number };
  return { jobId: job.id, workerId, attempt: job.attempts };
}

const observations = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_parity_observations`)[0]!.n;
const receipts = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pipeline_ingest_receipts`)[0]!.n;

describe("Idempotency-Key receipts", () => {
  test("a replay with the same key and body adds no row and returns the recorded response", async () => {
    const lease = await claimed("test.idem.replay");
    const body = { lease, args: ["raw_indicator_history"] };
    const key = `${lease.jobId}.${lease.attempt}.1.analytics.parity_sweep`;
    const before = await observations();
    const first = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), body, key);
    expect(first.status).toBe(200);
    expect(await observations()).toBe(before + 1);
    const receiptsAfterFirst = await receipts();

    const replay = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), body, key);
    expect(replay.status).toBe(200);
    // The recorded response, value for value (jsonb keeps no key order).
    expect(JSON.parse(replay.text)).toEqual(JSON.parse(first.text));
    expect(await observations()).toBe(before + 1);
    expect(await receipts()).toBe(receiptsAfterFirst);
  });

  test("the same key with a different body answers 409 and writes nothing", async () => {
    const lease = await claimed("test.idem.conflict");
    const key = `${lease.jobId}.${lease.attempt}.1.analytics.parity_sweep`;
    expect((await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease, args: ["raw_indicator_history"] }, key)).status).toBe(200);
    const before = await observations();
    const other = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease, args: ["regime_snapshots"] }, key);
    expect(other.status).toBe(409);
    expect(JSON.parse(other.text).error).toBe("idempotency_key_reused");
    expect(await observations()).toBe(before);
  });

  test("a write with no Idempotency-Key, or with no lease, is refused 400", async () => {
    const lease = await claimed("test.idem.nokey");
    const before = await observations();
    expect((await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease, args: ["raw_indicator_history"] })).status).toBe(400);
    expect((await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { args: ["raw_indicator_history"] }, "no-lease")).status).toBe(400);
    expect(await observations()).toBe(before);
  });
});

describe("the row and body bounds", () => {
  const adapterRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      vaultAddress: "0x00000000000000000000000000000000000000aa",
      adapterAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      adapterName: `a${i}`,
      sampleHour: new Date("2026-01-01T00:00:00Z"),
      balanceUsd: 1,
      configured: true,
      provenance: "live",
      sampledAt: new Date("2026-01-01T00:00:00Z"),
    }));

  test("a 1,001-row request answers 413 and writes nothing; a 1,000-row one lands", async () => {
    const lease = await claimed("test.idem.rows");
    const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_adapter_samples`)[0]!.n;
    const tooMany = await post(PIPELINE_ROUTES.ingest("vault.adapter_samples"), { lease, args: [adapterRows(1001)] }, "rows-1001");
    expect(tooMany.status).toBe(413);
    expect(JSON.parse(tooMany.text)).toMatchObject({ error: "payload_too_large", maxRows: 1000 });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_adapter_samples`)[0]!.n).toBe(before);

    const max = await post(PIPELINE_ROUTES.ingest("vault.adapter_samples"), { lease, args: [adapterRows(1000)] }, "rows-1000");
    expect(max.status).toBe(200);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_adapter_samples`)[0]!.n).toBe(before + 1000);
  }, 60_000);

  test("a body over 1 MiB answers 413", async () => {
    const lease = await claimed("test.idem.bytes");
    const padded = encodePipeline({ lease, args: ["raw_indicator_history"], pad: "x".repeat(1024 * 1024) });
    const r = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), padded, "bytes");
    expect(r.status).toBe(413);
  });
});

describe("lease fencing", () => {
  test("a write and a settle after the reaper took the lease answer 409 lease_lost and write nothing", async () => {
    const lease = await claimed("test.idem.reaped");
    // The lease expires and the reaper requeues the job.
    await fixtureDb`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${lease.jobId}`;
    expect((await post(PIPELINE_ROUTES.reap, { visibilitySeconds: 60 })).status).toBe(200);
    const [job] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${lease.jobId}`;
    expect(job!.status).toBe("pending");

    const before = await observations();
    const write = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease, args: ["raw_indicator_history"] }, "reaped-write");
    expect(write.status).toBe(409);
    expect(JSON.parse(write.text).error).toBe("lease_lost");
    expect(await observations()).toBe(before);

    const runsBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM job_runs WHERE job_id = ${lease.jobId}`)[0]!.n;
    const settle = await post(
      PIPELINE_ROUTES.settle,
      { lease, outcome: { kind: "succeeded", output: null }, startedAt: new Date() },
      `${lease.jobId}.${lease.attempt}.settle`,
    );
    expect(settle.status).toBe(409);
    expect(JSON.parse(settle.text).error).toBe("lease_lost");
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM job_runs WHERE job_id = ${lease.jobId}`)[0]!.n).toBe(runsBefore);
    const [after] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${lease.jobId}`;
    expect(after!.status).toBe("pending");
  });

  test("a write under a stale attempt answers 409 lease_lost and writes nothing, after a re-claim by the same worker", async () => {
    const first = await claimed("test.idem.stale", "stale-worker");
    // Requeued and claimed again by the SAME worker id: only the attempt differs.
    await fixtureDb`UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE id = ${first.jobId}`;
    const again = await post(PIPELINE_ROUTES.claim, { lane: { include: ["test.idem.stale"], exclude: [] }, workerId: "stale-worker" });
    const second = JSON.parse(again.text).job as { id: number; attempts: number };
    expect(second.id).toBe(first.jobId);
    expect(second.attempts).toBe(first.attempt + 1);

    const before = await observations();
    const stale = await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease: first, args: ["raw_indicator_history"] }, "stale-write");
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.text).error).toBe("lease_lost");
    expect(await observations()).toBe(before);

    // The current attempt writes.
    const current = { ...first, attempt: second.attempts };
    expect((await post(PIPELINE_ROUTES.ingest("analytics.parity_sweep"), { lease: current, args: ["raw_indicator_history"] }, "current-write")).status).toBe(200);
    expect(await observations()).toBe(before + 1);
  });
});
