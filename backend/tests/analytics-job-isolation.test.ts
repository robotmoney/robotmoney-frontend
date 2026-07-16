// Issue #107 — regime and research are DISTINCT job kinds. Guards:
//   - the registry exposes regime.classify + research.refresh and has RETIRED
//     the combined analytics.run kind;
//   - each handler invokes ONLY its scoped analytics tools (regime never runs a
//     research fetch and vice versa) — proven with an injected recording runner;
//   - the seed defines independent cadences and retires analytics.run rows;
//   - the scheduler derives independent per-kind dedupe keys.
// Runs in the required backend-integration job against ephemeral Postgres.
import { test, expect, beforeEach } from "bun:test";
import { sql } from "../src/db/client.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { makeAnalyticsHandlers, RESEARCH_TOOLS, REGIME_TOOL } from "../src/worker/handlers/analytics.ts";
import { tickScheduler } from "../src/worker/scheduler.ts";
import { seed } from "../src/db/seed.ts";

beforeEach(async () => { await sql`TRUNCATE jobs, job_runs, job_schedules RESTART IDENTITY CASCADE`; });

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
