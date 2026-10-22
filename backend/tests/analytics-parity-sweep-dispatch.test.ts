// Job-kind wiring for the dual-write parity sweep (issue #979 AC2, issue 1375).
//
// The mechanism has to be reachable from the REAL dispatch registry and the
// REAL schedule seed, not just callable from a test: without a job_schedules
// row and a handler, analytics_parity_observations stays empty and the cutover
// gate can never accumulate its window.
//
// Issue 1375: the sweep runs once a day and posts ONE request per domain, each
// answered by one set-based statement in Postgres. Issue 1034: the worker
// sends each as the pipeline ingestion operation `analytics.parity_sweep`, with
// its pipeline-worker token, never the analytics token. This file drives a
// real processOneJob() claim of an analytics.parity_sweep job through the
// pipeline router (in process, tests/support/pipeline-in-process.ts) and
// asserts the four fenced, receipted writes, the four observations, the job
// output, and the analytics route's 400 paths that record nothing.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { SCHEDULES } from "../src/db/seed.ts";
import { getHandler } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { ALL_PARITY_DOMAINS } from "../src/analytics/cutover/parity-domains.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { provisionAnalyticsToken, writeTokenFile } from "./support/automation-auth.ts";
import { setPipelineTransport } from "../src/worker/pipeline-client.ts";
import { inProcessPipelineTransport } from "./support/pipeline-in-process.ts";
import { encodePipeline } from "../src/lib/pipeline-wire.ts";

useCleanDatabase(import.meta.file);

test("analytics.parity_sweep is a seeded, enabled, once-a-day schedule at 04:47 UTC with a registered handler", () => {
  const rows = SCHEDULES.filter((s) => s.kind === "analytics.parity_sweep");
  expect(rows.map((r) => r.cron), "db/seed.ts::SCHEDULES must hold exactly one analytics.parity_sweep row").toEqual(["47 4 * * *"]);
  expect(rows[0]!.enabled).toBe(true);
  expect(rows[0]!.timezone).toBe("UTC");
  expect(getHandler("analytics.parity_sweep"), "worker/handlers/index.ts must map analytics.parity_sweep to a handler").toBeDefined();
});

test("the seeded database holds one analytics.parity_sweep row at 47 4 * * *, and both supporting indexes exist", async () => {
  const rows = await sql<{ cron: string }[]>`SELECT cron FROM job_schedules WHERE kind = 'analytics.parity_sweep'`;
  expect(rows.map((r) => r.cron)).toEqual(["47 4 * * *"]);
  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('analytics_output_snapshots_natural_keys_idx', 'swarm_brief_revisions_session_newest_idx')
     ORDER BY indexname`;
  expect(indexes.map((r) => r.indexname)).toEqual(["analytics_output_snapshots_natural_keys_idx", "swarm_brief_revisions_session_newest_idx"]);
});

async function withApi<T>(fn: (requests: { method: string; path: string; auth: string | null; body: unknown }[], token: string) => Promise<T>): Promise<T> {
  const TOKEN = await provisionAnalyticsToken();
  const TOKEN_FILE = writeTokenFile(TOKEN);
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.clone().text();
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization"), body: text ? JSON.parse(text) : null });
      const r = await handleAnalytics(req, url);
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  const origEnv = { ANALYTICS_API_URL: process.env.ANALYTICS_API_URL, ANALYTICS_TOKEN_FILE: process.env.ANALYTICS_TOKEN_FILE };
  try {
    process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;
    process.env.ANALYTICS_TOKEN_FILE = TOKEN_FILE;
    return await fn(requests, TOKEN);
  } finally {
    server.stop(true);
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof origEnv];
      else process.env[k as keyof typeof origEnv] = v;
    }
  }
}

const observationCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_parity_observations`)[0]!.n;

test(
  "a claimed analytics.parity_sweep job sends one pipeline write per domain in ALL_PARITY_DOMAINS order, appends four observations, and its job output carries each domain's duration and counts",
  async () => {
    const before = await observationCount();
    const [{ id: jobId }] = await fixtureDb<{ id: number }[]>`
      INSERT INTO jobs (kind, payload) VALUES ('analytics.parity_sweep', ${fixtureDb.json({})}) RETURNING id`;

    // Only this kind, so no other pending job can win the claim.
    expect(await processOneJob({ lane: { ...LANES.analytics, include: ["analytics.parity_sweep"] } })).toBe(true);

    const [job] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
    expect(job!.status).toBe("succeeded");

    // One fenced write per domain, in order, each keyed by the job's lease and
    // recorded with its receipt.
    const receipts = await sql<{ idempotency_key: string; operation: string }[]>`
      SELECT idempotency_key, operation FROM pipeline_ingest_receipts
       WHERE job_id = ${jobId} AND operation = 'analytics.parity_sweep' ORDER BY recorded_at, idempotency_key`;
    expect(receipts.map((r) => r.idempotency_key)).toEqual(
      ALL_PARITY_DOMAINS.map((_, i) => `${jobId}.1.${i + 1}.analytics.parity_sweep`),
    );

    // Exactly four new observations, one per domain, all matched on a clean database.
    expect(await observationCount()).toBe(before + ALL_PARITY_DOMAINS.length);
    const rows = await sql<{ domain: string; matched: boolean }[]>`
      SELECT domain, matched FROM analytics_parity_observations ORDER BY id DESC LIMIT ${ALL_PARITY_DOMAINS.length}`;
    expect(rows.map((r) => r.domain).sort()).toEqual([...ALL_PARITY_DOMAINS].sort());
    for (const r of rows) expect(r.matched).toBe(true);

    // The job output, as job_runs stores it.
    const [run] = await sql<{ status: string; output: { domains: Record<string, unknown>[]; matched: string[]; mismatched: string[] } }[]>`
      SELECT status, output FROM job_runs WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`;
    expect(run!.status).toBe("succeeded");
    expect(run!.output.domains.map((d) => d.domain)).toEqual([...ALL_PARITY_DOMAINS]);
    for (const d of run!.output.domains) {
      expect(typeof d.durationMs).toBe("number");
      expect(d.legacyRowCount).toBe(0);
      expect(d.ledgerRowCount).toBe(0);
      expect(d.mismatchCount).toBe(0);
      expect(d.matched).toBe(true);
    }
    expect(run!.output.matched).toEqual([...ALL_PARITY_DOMAINS]);
    expect(run!.output.mismatched).toEqual([]);
  },
  { timeout: 60_000 },
);

test("a body with no domain, or an unknown domain, answers 400 and records no observation", async () => {
  await withApi(async (_requests, token) => {
    const before = await observationCount();
    for (const body of [undefined, {}, { domain: "everything" }, { domain: 7 }]) {
      const res = await fetch(`${process.env.ANALYTICS_API_URL}${ROUTES.analytics.paritySweep}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await observationCount()).toBe(before);
  });
});

test("a failed domain call fails the handler and names the domain", async () => {
  // An api that answers the first domain and refuses the second.
  let calls = 0;
  setPipelineTransport(async (path, body) => {
    if (!path.endsWith("/analytics.parity_sweep")) return inProcessPipelineTransport(path, body, {});
    calls++;
    if (calls === 1) {
      const domain = ALL_PARITY_DOMAINS[0];
      return {
        status: 200,
        text: encodePipeline({ result: { domain, matched: true, legacyRowCount: 0, ledgerRowCount: 0, mismatchCount: 0, durationMs: 1 } }),
        retryAfter: null,
      };
    }
    return { status: 500, text: JSON.stringify({ error: "internal error", detail: "boom" }), retryAfter: null };
  });
  try {
    await expect(getHandler("analytics.parity_sweep")!({})).rejects.toThrow(`parity sweep failed on domain ${ALL_PARITY_DOMAINS[1]}`);
  } finally {
    setPipelineTransport(inProcessPipelineTransport);
  }
});
