// Issue #107 — regime and research are DISTINCT job kinds. Guards:
//   - the registry exposes regime.classify + research.refresh and has RETIRED
//     the combined analytics.run kind;
//   - each handler invokes ONLY its scoped analytics tools (regime never runs a
//     research fetch and vice versa) — proven with an injected recording runner;
//   - the seed defines independent cadences and retires analytics.run rows;
//   - the scheduler derives independent per-kind dedupe keys.
// Runs in the required backend-integration job against ephemeral Postgres.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { makeAnalyticsHandlers, RESEARCH_TOOLS, REGIME_TOOL, type AnalyticsRunner } from "../src/worker/handlers/analytics.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";
import { seed } from "../src/db/seed.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { LANES } from "../src/worker/lanes.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { directTelemetrySink } from "../src/analytics/store/telemetry-direct.ts";

import { useCleanDatabase } from "./support/clean-db.ts";

// Own database, cloned from the migrated template — see support/clean-db.ts.
useCleanDatabase(import.meta.file);

// Ordered DELETEs, not `TRUNCATE ... CASCADE`: jobs/job_runs/job_schedules are
// deliberately unprotected churn, but audit_log, swarm_session_events and
// analytics_runs all reference jobs(id), and CASCADE truncates a referencing
// table WHOLE regardless of its `ON DELETE SET NULL`. The queue fixture was
// destroying the audit trail; a DELETE merely detaches it.
beforeEach(async () => {
  await sql`DELETE FROM job_runs`;
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM job_schedules`;
});

test("registry: regime.classify and research.refresh are distinct kinds; analytics.run is retired", () => {
  expect(typeof handlers["regime.classify"]).toBe("function");
  expect(typeof handlers["research.refresh"]).toBe("function");
  expect(handlers["regime.classify"]).not.toBe(handlers["research.refresh"]);
  expect(handlers["analytics.run"]).toBeUndefined();
});

test("regime.classify invokes ONLY the regime tool (never a research fetch, never the full suite)", async () => {
  const calls: (string | undefined)[] = [];
  const h = makeAnalyticsHandlers(async (_asof, tool) => { calls.push(tool); return { [tool ?? "suite"]: true }; });
  const out = await h.regimeClassify({ asof: "2026-07-15" }) as { asof: string; tools: string[] };
  expect(calls).toEqual([REGIME_TOOL]);
  expect(out.asof).toBe("2026-07-15");
  expect(out.tools).toEqual([REGIME_TOOL]);
});

test("research.refresh invokes ONLY the research tools (never regime, never the full suite)", async () => {
  const calls: (string | undefined)[] = [];
  const h = makeAnalyticsHandlers(async (_asof, tool) => { calls.push(tool); return { [tool ?? "suite"]: true }; });
  const out = await h.researchRefresh({ asof: "2026-07-15" }) as { asof: string; tools: string[] };
  expect(calls).toEqual([...RESEARCH_TOOLS]);
  expect(calls).not.toContain(REGIME_TOOL);
  expect(calls).not.toContain(undefined); // undefined tool = the whole suite
  expect(out.tools).toEqual([...RESEARCH_TOOLS]);
});

test("seed: independent regime/research cadences; analytics.run schedules deleted and queued jobs dead-lettered", async () => {
  // Simulate an existing deployment that still carries the retired combined kind.
  await sql`INSERT INTO job_schedules (kind, cron) VALUES ('analytics.run', '30 22 * * *')`;
  const [{ id: staleJob }] = await sql`INSERT INTO jobs (kind, payload) VALUES ('analytics.run', '{}') RETURNING id`;

  await seed();

  const rows = await sql<{ kind: string; cron: string }[]>`
    SELECT kind, cron FROM job_schedules WHERE kind IN ('regime.classify', 'research.refresh', 'analytics.run')`;
  const byKind = new Map(rows.map((r) => [r.kind, r.cron]));
  expect(byKind.has("regime.classify")).toBe(true);
  expect(byKind.has("research.refresh")).toBe(true);
  expect(byKind.has("analytics.run")).toBe(false); // retired rows removed
  expect(byKind.get("regime.classify")).not.toBe(byKind.get("research.refresh")); // independent cadences

  const [job] = await sql`SELECT status, last_error FROM jobs WHERE id = ${staleJob}`;
  expect(job.status).toBe("dead");
  expect(job.last_error).toContain("retired kind");
});

// AC3 (issue #151) — telemetry failures are non-fatal to canonical analytics
// persistence but must still surface in job output and admin status. These
// tests prove the handler layer (the object `worker/loop.ts` persists to
// job_runs.output, and what GET /api/admin/jobs/:id then returns verbatim —
// see backend/tests/api/admin-jobs.test.ts for the admin-status pass-through)
// folds runAnalytics's non-enumerable `__telemetry` outcome into a plain,
// enumerable `telemetry` field without perturbing the canonical `tools` list.
function withTelemetry(out: Record<string, unknown>, outcome: unknown): Record<string, unknown> {
  Object.defineProperty(out, "__telemetry", { value: outcome, enumerable: false });
  return out;
}

test("regime.classify folds a successful telemetry outcome into output.telemetry", async () => {
  const h = makeAnalyticsHandlers(async (asof, tool) => withTelemetry({ [tool as string]: { asof } }, { ok: true, runId: 42 }));
  const out = (await h.regimeClassify({ asof: "2026-07-15" })) as { tools: string[]; telemetry: { ok: boolean; runId: number } };
  expect(out.tools).toEqual([REGIME_TOOL]);
  expect(out.telemetry).toEqual({ ok: true, runId: 42 });
});

test("regime.classify folds a FAILED telemetry outcome into output.telemetry without perturbing the canonical result (AC3: non-fatal, still surfaced)", async () => {
  const h = makeAnalyticsHandlers(async (asof, tool) =>
    withTelemetry({ [tool as string]: { asof } }, { ok: false, error: "simulated telemetry outage" }),
  );
  const out = (await h.regimeClassify({ asof: "2026-07-15" })) as {
    asof: string;
    tools: string[];
    telemetry: { ok: boolean; error: string };
  };
  // Canonical output is unaffected by the telemetry failure.
  expect(out.asof).toBe("2026-07-15");
  expect(out.tools).toEqual([REGIME_TOOL]);
  // The failure is surfaced on the handler's own return value — the exact
  // object worker/loop.ts writes to job_runs.output (status stays
  // succeeded/degraded per existing analytics-result semantics, unaffected by
  // telemetry) and GET /api/admin/jobs/:id returns to the admin.
  expect(out.telemetry.ok).toBe(false);
  expect(out.telemetry.error).toContain("simulated telemetry outage");
});

test("research.refresh folds each tool's telemetry outcome — including a per-tool failure — into a telemetry map keyed by tool", async () => {
  const h = makeAnalyticsHandlers(async (asof, tool) => {
    const outcome = tool === RESEARCH_TOOLS[0] ? { ok: false, error: "simulated telemetry outage" } : { ok: true, runId: 7 };
    return withTelemetry({ [tool as string]: { asof } }, outcome);
  });
  const out = (await h.researchRefresh({ asof: "2026-07-15" })) as {
    tools: string[];
    telemetry: Record<string, { ok: boolean; error?: string; runId?: number }>;
  };
  expect(out.tools).toEqual([...RESEARCH_TOOLS]);
  expect(out.telemetry[RESEARCH_TOOLS[0]].ok).toBe(false);
  expect(out.telemetry[RESEARCH_TOOLS[0]].error).toContain("simulated telemetry outage");
  expect(out.telemetry[RESEARCH_TOOLS[1]].ok).toBe(true);
  expect(out.telemetry[RESEARCH_TOOLS[1]].runId).toBe(7);
});

test("scheduler: separate per-kind dedupe keys — one slot per kind, never cross-kind", async () => {
  await sql`INSERT INTO job_schedules (kind, cron, enabled, next_run_at)
            VALUES ('regime.classify', '*/2 * * * *', true, now() - interval '3 minutes'),
                   ('research.refresh', '1-59/2 * * * *', true, now() - interval '3 minutes')`;
  expect(await tickScheduler()).toBeGreaterThan(0);
  const jobs = await sql<{ kind: string; dedupe_key: string }[]>`SELECT kind, dedupe_key FROM jobs`;
  expect(jobs.length).toBeGreaterThan(0);
  const kinds = new Set(jobs.map((j) => j.kind));
  expect(kinds.has("regime.classify")).toBe(true);
  expect(kinds.has("research.refresh")).toBe(true);
  for (const j of jobs) expect(j.dedupe_key.startsWith(`${j.kind}:`)).toBe(true); // key namespaced by kind
  expect(new Set(jobs.map((j) => j.dedupe_key)).size).toBe(jobs.length); // all keys distinct
});

// Issue #179 — worker/loop.ts previously dropped `job.id` when invoking a
// handler (`handler(job.payload)`), so `research_pipeline_runs.job_id` was
// ALWAYS NULL for real job executions even though the handler layer already
// accepted (and threaded through) an optional `jobId` param. This drives a
// REAL end-to-end `processOneJob()` claim — not just the handler in isolation
// — through the direct (SQL-backed) analytics persistence/telemetry ports
// (the same API-owned path analytics-telemetry.test.ts exercises) and asserts
// the persisted `research_pipeline_runs.job_id` matches the claimed job's id.
test(
  "processOneJob threads the claimed job.id into the analytics handler, and it lands in research_pipeline_runs.job_id",
  async () => {
    const directRunner: AnalyticsRunner = (asof, toolId, jobId) =>
      runAnalytics(asof, toolId, hermeticDataSource, directAnalyticsPersistence, directTelemetrySink, jobId);
    // Swap in a real (non-HTTP) analytics runner for this one claim, then
    // restore the production registry entry — mirrors the test-kind injection
    // pattern in worker-lease.test.ts.
    const originalHandler = handlers["regime.classify"];
    handlers["regime.classify"] = makeAnalyticsHandlers(directRunner).regimeClassify;
    try {
      const [{ id: jobId }] = await sql<{ id: number }[]>`
        INSERT INTO jobs (kind, payload) VALUES ('regime.classify', ${sql.json({ asof: "2026-05-15" })}) RETURNING id`;

      expect(await processOneJob({ lane: LANES.analytics })).toBe(true);

      const [jobRow] = await sql`SELECT status FROM jobs WHERE id = ${jobId}`;
      expect(jobRow.status).toBe("succeeded");

      const [run] = await sql<{ job_id: number | null }[]>`
        SELECT job_id FROM research_pipeline_runs WHERE kind = 'regime' ORDER BY id DESC LIMIT 1`;
      expect(run).toBeDefined();
      expect(run.job_id).not.toBeNull();
      expect(Number(run.job_id)).toBe(Number(jobId)); // the claimed job's id, not NULL (the bug this test guards)
    } finally {
      handlers["regime.classify"] = originalHandler;
    }
  },
  { timeout: 60_000 },
);
