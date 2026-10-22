// Pipeline bulk work exhausts only the batch pool, and the worker's client
// lands every batch exactly once (issue 1034, decision D75).
//
// Against the RUNNING api, with PIPELINE_TOKEN_CONCURRENCY=2 (the token's share
// of the batch pool): eight max-size (1,000-row) ingestion batches are sent at
// once, four times the share. The two admitted batches are held at their lease
// fence by a row lock this file takes on the job, so the flood is real and its
// timing does not depend on how fast the database writes. While it holds:
//
//   - a public request-pool route (GET comments) answers 200 in under 1 s;
//   - every batch beyond the share answers 503 db_saturated with Retry-After in
//     under 1.5 s.
//
// The lock is then released. The worker's own client (worker/pipeline-client.ts
// over HTTP, honouring Retry-After) retries the refused batches with their
// Idempotency-Keys, and afterwards every batch has landed exactly once: 8,000
// rows and eight receipts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import type { PipelineLease } from "../src/lib/pipeline-wire.ts";
import { pipelineIngest, runWithLease, setPipelineTransport, type PipelineTransport } from "../src/worker/pipeline-client.ts";
import { inProcessPipelineTransport } from "./support/pipeline-in-process.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { bootApi, provisionPipelineToken, type ApiProcess } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const SHARE = 2;
const BATCHES = SHARE * 4;

let api: ApiProcess;
let token = "";

beforeAll(async () => {
  token = await provisionPipelineToken();
  api = await bootApi({ env: { PIPELINE_TOKEN_CONCURRENCY: String(SHARE), PG_ADMISSION_WAIT_MS: "500" } });
  await fixtureDb`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE status IN ('pending', 'running')`;
}, 120_000);
afterAll(() => api?.stop());

function batch(n: number): Record<string, unknown>[] {
  return Array.from({ length: 1000 }, (_, i) => ({
    vaultAddress: "0x00000000000000000000000000000000000000bb",
    adapterAddress: `0x${(n * 1000 + i + 1).toString(16).padStart(40, "0")}`,
    adapterName: `flood-${n}-${i}`,
    sampleHour: new Date("2026-02-01T00:00:00Z"),
    balanceUsd: i,
    configured: true,
    provenance: "live",
    sampledAt: new Date("2026-02-01T00:00:00Z"),
  }));
}

test(
  "a flood at 4x the token's share: public routes stay fast, the excess is refused fast with Retry-After, and the client lands every batch exactly once",
  async () => {
    // A claimed job whose lease the batches carry.
    const [{ id: jobId }] = await fixtureDb<{ id: number }[]>`
      INSERT INTO jobs (kind, payload, status, attempts, locked_at, locked_by) VALUES ('flood.job', '{}', 'running', 1, now(), 'flood-worker') RETURNING id`;
    const lease: PipelineLease = { jobId: Number(jobId), workerId: "flood-worker", attempt: 1 };

    // Hold the job row: every admitted batch waits at its fence.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = fixtureDb.begin(async (tx) => {
      await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    // The worker's client, over HTTP, with every exchange recorded.
    const exchanges: { status: number; ms: number; retryAfter: string | null; error: string | null }[] = [];
    const transport: PipelineTransport = async (path, body, headers) => {
      const started = performance.now();
      const res = await fetch(`${api.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
        body,
      });
      const text = await res.text();
      exchanges.push({
        status: res.status,
        ms: performance.now() - started,
        retryAfter: res.headers.get("Retry-After"),
        error: res.status === 503 ? (JSON.parse(text) as { error: string }).error : null,
      });
      return { status: res.status, text, retryAfter: res.headers.get("Retry-After") };
    };
    const prevDeadline = process.env.PIPELINE_RETRY_DEADLINE_MS;
    process.env.PIPELINE_RETRY_DEADLINE_MS = "60000";
    setPipelineTransport(transport);
    try {
      const sends = runWithLease(lease, () =>
        Promise.all(Array.from({ length: BATCHES }, (_, n) => pipelineIngest<number>("vault.adapter_samples", batch(n)))),
      );

      // The first round: everything beyond the share is refused, fast.
      const deadline = Date.now() + 5_000;
      while (exchanges.filter((e) => e.status === 503).length < BATCHES - SHARE && Date.now() < deadline) await Bun.sleep(20);
      const refused = exchanges.filter((e) => e.status === 503);
      expect(refused.length).toBeGreaterThanOrEqual(BATCHES - SHARE);
      for (const e of refused) {
        expect({ error: e.error, retryAfter: e.retryAfter }).toEqual({ error: "db_saturated", retryAfter: "1" });
        expect(e.ms).toBeLessThan(1_500);
      }

      // The request pool is untouched by the flood.
      const started = performance.now();
      const pub = await fetch(`${api.base}${ROUTES.comments.list}?page=projects`);
      const publicMs = performance.now() - started;
      expect(pub.status).toBe(200);
      expect(publicMs).toBeLessThan(1_000);

      // Release the fence; the client retries what was refused.
      release();
      const written = await sends;
      expect(written).toEqual(Array.from({ length: BATCHES }, () => 1000));
    } finally {
      release();
      await holder;
      setPipelineTransport(inProcessPipelineTransport);
      if (prevDeadline === undefined) delete process.env.PIPELINE_RETRY_DEADLINE_MS;
      else process.env.PIPELINE_RETRY_DEADLINE_MS = prevDeadline;
    }

    // Exactly once: every row once, one receipt per batch.
    const [rows] = await sql<{ n: number; distinct: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT adapter_address)::int AS distinct
        FROM vault_adapter_samples WHERE vault_address = '0x00000000000000000000000000000000000000bb'`;
    expect(rows).toEqual({ n: BATCHES * 1000, distinct: BATCHES * 1000 });
    const [receipts] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pipeline_ingest_receipts WHERE job_id = ${jobId} AND operation = 'vault.adapter_samples'`;
    expect(receipts!.n).toBe(BATCHES);
  },
  120_000,
);
