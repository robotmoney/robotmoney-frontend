// Integration coverage for the `prod-bootstrap` orchestrator (migrate ->
// v0-seed:bootstrap -> edgar-seed:bootstrap), against the SAME ephemeral
// Postgres the rest of the suite uses. The underlying steps (migrate(),
// runV0SeedBootstrap(), bootstrapEdgarSeed()) are already covered by their
// own test files — this file exercises the orchestration logic that is
// UNIQUE to prod-bootstrap.ts and not exercised anywhere else: every step
// always runs (no fail-fast), the v0-seed drift outcome is aggregated into
// an overall "failing" result, and the edgar step's unreachable-vs-genuine-
// failure classification (skip vs. hard fail) is correct in both directions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import net from "node:net";
import { sql } from "../src/db/client.ts";
import { runProdBootstrap, type StepReport } from "../scripts/prod-bootstrap.ts";

const MEMBER_IDS = ["athena", "robotmoney", "woon"];
const SUBJECT_IDS = ["robotmoney-allocation", "robotmoney-treasury", "robotmoney-vault", "woon"];

async function cleanArchiveRows(): Promise<void> {
  await sql`DELETE FROM swarm_sessions WHERE subject_id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_subjects WHERE id = ANY(${SUBJECT_IDS})`;
  await sql`DELETE FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
}

const origAnalyticsToken = process.env.ANALYTICS_TOKEN;
const origAnalyticsApiUrl = process.env.ANALYTICS_API_URL;

function restoreEnv(): void {
  if (origAnalyticsToken === undefined) delete process.env.ANALYTICS_TOKEN;
  else process.env.ANALYTICS_TOKEN = origAnalyticsToken;
  if (origAnalyticsApiUrl === undefined) delete process.env.ANALYTICS_API_URL;
  else process.env.ANALYTICS_API_URL = origAnalyticsApiUrl;
}

beforeEach(async () => {
  await cleanArchiveRows();
  restoreEnv();
});
afterEach(async () => {
  await cleanArchiveRows();
  restoreEnv();
});

function reportFor(reports: StepReport[], name: string): StepReport {
  const r = reports.find((r) => r.name === name);
  if (!r) throw new Error(`no report for step "${name}"`);
  return r;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

test("cold DB: all three steps run, v0-seed inserts 3/4/32, edgar cleanly skips without ANALYTICS_TOKEN, nothing failing", async () => {
  delete process.env.ANALYTICS_TOKEN;

  const reports = await runProdBootstrap();
  expect(reports.map((r) => r.name)).toEqual(["migrations", "v0-seed:bootstrap", "edgar-seed:bootstrap"]);

  const migrations = reportFor(reports, "migrations");
  expect(migrations.status).toBe("success");
  expect(migrations.failing).toBe(false);

  const v0seed = reportFor(reports, "v0-seed:bootstrap");
  expect(v0seed.status).toBe("success");
  expect(v0seed.failing).toBe(false);
  expect(v0seed.summary).toBe("3 members, 4 subjects, 32 sessions inserted, 0 drift");

  const edgar = reportFor(reports, "edgar-seed:bootstrap");
  expect(edgar.status).toBe("skipped");
  expect(edgar.failing).toBe(false);
  expect(edgar.summary).toBe("skipped: ANALYTICS_TOKEN not set");

  expect(reports.some((r) => r.failing)).toBe(false);

  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM swarm_members WHERE id = ANY(${MEMBER_IDS})`;
  expect(n).toBe(3);
});

test("idempotent: a second full run inserts nothing further and still reports nothing failing", async () => {
  delete process.env.ANALYTICS_TOKEN;

  const first = await runProdBootstrap();
  expect(reportFor(first, "v0-seed:bootstrap").summary).toBe("3 members, 4 subjects, 32 sessions inserted, 0 drift");

  const second = await runProdBootstrap();
  expect(reportFor(second, "v0-seed:bootstrap").summary).toBe("0 members, 0 subjects, 0 sessions inserted, 0 drift");
  expect(second.some((r) => r.failing)).toBe(false);
});

test("drift aggregation: a v0-seed drift marks the run overall failing, but every step still runs (no fail-fast)", async () => {
  delete process.env.ANALYTICS_TOKEN;

  await runProdBootstrap();
  await sql`UPDATE swarm_members SET tagline = 'MUTATED for prod-bootstrap orchestration test' WHERE id = 'athena'`;

  const reports = await runProdBootstrap();
  // No fail-fast: migrations and the edgar step still ran even though v0-seed drifted.
  expect(reports.map((r) => r.name)).toEqual(["migrations", "v0-seed:bootstrap", "edgar-seed:bootstrap"]);

  const v0seed = reportFor(reports, "v0-seed:bootstrap");
  expect(v0seed.status).toBe("warning");
  expect(v0seed.failing).toBe(true);
  // "inserted" counts only — subjects/sessions already exist from the first
  // run (unchanged, not inserted), so this reads 0/0 even though the DB
  // still holds all of them; only the drift count reflects the mutation.
  expect(v0seed.summary).toBe("0 members, 0 subjects, 0 sessions inserted, 1 drift");

  expect(reportFor(reports, "migrations").failing).toBe(false);
  expect(reportFor(reports, "edgar-seed:bootstrap").failing).toBe(false);

  // The overall run-level signal (what main() turns into a non-zero exit code).
  expect(reports.some((r) => r.failing)).toBe(true);

  // Never silently overwritten.
  const [{ tagline }] = await sql<{ tagline: string }[]>`SELECT tagline FROM swarm_members WHERE id = 'athena'`;
  expect(tagline).toBe("MUTATED for prod-bootstrap orchestration test");
});

test("edgar step: an unreachable API is classified as SKIPPED, not FAILED (never blocks a DB-only bootstrap)", async () => {
  process.env.ANALYTICS_TOKEN = "tok_prod_bootstrap_test";
  // A port nothing is listening on (bound then immediately released) —
  // connecting to it fails fast with a real "unreachable" error.
  const deadPort = await freePort();
  process.env.ANALYTICS_API_URL = `http://127.0.0.1:${deadPort}`;

  const reports = await runProdBootstrap();
  const edgar = reportFor(reports, "edgar-seed:bootstrap");
  expect(edgar.status).toBe("skipped");
  expect(edgar.failing).toBe(false);
  expect(edgar.summary).toContain("unreachable");
  expect(reports.some((r) => r.failing)).toBe(false);
});

test("edgar step: a REACHABLE API that rejects the credential is classified as FAILED, not silently skipped", async () => {
  process.env.ANALYTICS_TOKEN = "tok_wrong_prod_bootstrap_test";
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("unauthorized", { status: 401 });
    },
  });
  process.env.ANALYTICS_API_URL = `http://localhost:${server.port}`;

  try {
    const reports = await runProdBootstrap();
    const edgar = reportFor(reports, "edgar-seed:bootstrap");
    expect(edgar.status).toBe("failed");
    expect(edgar.failing).toBe(true);
    expect(edgar.summary).toContain("HTTP 401");
    // A genuine (reachable, authenticated-but-rejected) failure DOES mark the
    // overall run failing — only unreachability degrades gracefully.
    expect(reports.some((r) => r.failing)).toBe(true);
  } finally {
    server.stop(true);
  }
});
