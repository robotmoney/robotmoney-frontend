// EDGAR/MNA seed bootstrap over the REAL authenticated analytics API + REAL
// (ephemeral) Postgres (issue #108). A real Bun.serve() wraps the REAL
// handleAnalytics route handler (same code the api process mounts) — no live
// network, no mocked persistence. Covers: cold-DB load (empty→exact
// projection, second load is a no-op), overlap precedence (existing real
// value wins), authorization (401/403, zero row changes), and the retired
// research-eligibility control path's authenticated 409 with zero schedule/job
// mutations. Analytics cadence belongs to the independent producer (D25).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../../src/db/client.ts";
import { config } from "../../src/config.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { canonicalCsv, buildManifest, type EdgarSeedRow } from "../../src/analytics/extract/edgar-seed.ts";
import { bootstrapEdgarSeed } from "../../src/analytics/edgar-seed-loader.ts";
import type { AnalyticsApiConfig } from "../../src/analytics/api-client.ts";

const TOKEN = "tok_edgar_seed_test";

const SEED_ROWS: EdgarSeedRow[] = [
  { date: "2021-01-31", indicator: "MNA", value: 100 },
  { date: "2021-02-28", indicator: "MNA", value: 110 },
  { date: "2021-03-31", indicator: "MNA", value: 120 },
];

// Writes a tiny deterministic seed pair to a fresh temp dir and points
// EDGAR_SEED_PATH/EDGAR_SEED_MANIFEST_PATH at it (loadEdgarSeed's env
// fallback) so bootstrapEdgarSeed/repopulateEdgarSeed load THIS fixture
// instead of the real ~200-row committed artifact.
function installSeedFixture(rows: EdgarSeedRow[] = SEED_ROWS): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-seed-api-"));
  const gzPath = join(dir, "seed.csv.gz");
  const manifestPath = join(dir, "seed.manifest.json");
  const manifest = buildManifest(rows, { asOf: "2021-04-01" });
  writeFileSync(gzPath, gzipSync(Buffer.from(canonicalCsv(rows), "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  process.env.EDGAR_SEED_PATH = gzPath;
  process.env.EDGAR_SEED_MANIFEST_PATH = manifestPath;
  return { dir };
}

let fixtureDir: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let requests: { method: string; path: string; auth: string | null }[] = [];
let cfg: AnalyticsApiConfig;
const origAnalyticsToken = config.analyticsToken;
const origAllowInsecure = config.allowInsecure;

async function postResearchEligibility(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${cfg.baseUrl}/api/analytics/research-eligibility`, { method: "POST", headers });
}

beforeEach(async () => {
  ({ dir: fixtureDir } = installSeedFixture());
  requests = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
      const r = await handleAnalytics(req, url);
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  cfg = { baseUrl: `http://localhost:${server.port}`, token: TOKEN };
  config.analyticsToken = TOKEN;
  config.allowInsecure = false;

  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
  await sql`DELETE FROM job_schedules WHERE kind = 'research.refresh'`;
});

afterEach(async () => {
  server?.stop(true);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.EDGAR_SEED_PATH;
  delete process.env.EDGAR_SEED_MANIFEST_PATH;
  config.analyticsToken = origAnalyticsToken;
  config.allowInsecure = origAllowInsecure;
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
  await sql`DELETE FROM job_schedules WHERE kind = 'research.refresh'`;
  // #287: leave no demo flag or cold-start job behind for later test files.
  delete process.env.DEMO_MODE;
  await sql`DELETE FROM jobs WHERE dedupe_key = 'research.refresh:coldstart'`;
});

// ── cold-DB load: empty → exact projection; second load is a no-op ─────────

test("bootstrapEdgarSeed loads an empty DB to EXACTLY the manifest's projection; a second load inserts zero rows", async () => {
  const first = await bootstrapEdgarSeed(cfg);
  expect(first.seededPoints).toBe(3);
  expect(first.existingPoints).toBe(0);

  const rows = await sql<{ date: string; value: string }[]>`
    SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
  expect(rows.map((r) => ({ date: r.date, value: Number(r.value) }))).toEqual([
    { date: "2021-01-31", value: 100 },
    { date: "2021-02-28", value: 110 },
    { date: "2021-03-31", value: 120 },
  ]);

  const second = await bootstrapEdgarSeed(cfg);
  expect(second.seededPoints).toBe(0);
  expect(second.existingPoints).toBe(3);

  const rowsAfter = await sql<{ n: string }[]>`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'MNA'`;
  expect(Number(rowsAfter[0]!.n)).toBe(3);
});

// ── overlap precedence: existing real value wins, missing months filled ────

test("overlap precedence: a pre-existing DIFFERENT real value wins; every genuinely missing month is filled", async () => {
  // Simulate a warm DB where 2021-02-28 already holds a REAL observed value (999).
  await sql`
    INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('2021-02-28', 'MNA', 999)`;

  const res = await bootstrapEdgarSeed(cfg);
  expect(res.seededPoints).toBe(2); // 01-31 and 03-31 were missing
  expect(res.existingPoints).toBe(1); // 02-28 already present

  const rows = await sql<{ date: string; value: string }[]>`
    SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
  expect(rows.map((r) => ({ date: r.date, value: Number(r.value) }))).toEqual([
    { date: "2021-01-31", value: 100 },
    { date: "2021-02-28", value: 999 }, // existing real value preserved, NOT overwritten by the seed's 110
    { date: "2021-03-31", value: 120 },
  ]);
});

// ── authorization: 401/403, zero row changes ────────────────────────────────

test("missing credentials: bootstrap client gets 401 and writes zero rows", async () => {
  await expect(bootstrapEdgarSeed({ baseUrl: cfg.baseUrl, token: null })).rejects.toThrow(/HTTP 401/);
  const rows = await sql`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'MNA'`;
  expect(Number(rows[0]!.n)).toBe(0);
});

test("wrong credentials: bootstrap client gets 403 and writes zero rows", async () => {
  await expect(bootstrapEdgarSeed({ baseUrl: cfg.baseUrl, token: "wrong-token" })).rejects.toThrow(/HTTP 403/);
  const rows = await sql`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'MNA'`;
  expect(Number(rows[0]!.n)).toBe(0);
});

test("missing/invalid credentials: retired research-eligibility endpoint 401/403s before any mutation", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES ('research.refresh', '0 23 * * *', false)`;

  expect((await postResearchEligibility(null)).status).toBe(401);
  expect((await postResearchEligibility("wrong-token")).status).toBe(403);

  const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(row!.enabled).toBe(false);
});

// ── retired research-eligibility control plane ─────────────────────────────

test("authenticated research-eligibility fails closed without enabling schedules or enqueueing consumer research", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES
      ('research.refresh', '0 23 * * *', false),
      ('research.refresh', '37 * * * *', false),
      ('research.refresh', '1-59/2 * * * *', false)`;
  const [before] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM jobs WHERE kind = 'research.refresh'`;
  process.env.DEMO_MODE = "1";

  const res = await postResearchEligibility(TOKEN);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "research scheduling is owned by the independent analytics producer",
    code: "producer_owned",
  });

  const rows = await sql<{ cron: string; enabled: boolean }[]>`
    SELECT cron, enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  const byCron = Object.fromEntries(rows.map((r) => [r.cron, r.enabled]));
  expect(byCron["0 23 * * *"]).toBe(false);
  expect(byCron["37 * * * *"]).toBe(false);
  expect(byCron["1-59/2 * * * *"]).toBe(false);
  const [after] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM jobs WHERE kind = 'research.refresh'`;
  expect(after!.n).toBe(before!.n);
});

test("seed ingestion succeeds while the retired control path remains fail-closed", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES ('research.refresh', '0 23 * * *', false)`;
  const [beforeJobs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM jobs WHERE kind = 'research.refresh'`;

  const result = await bootstrapEdgarSeed(cfg);
  expect(result.seededPoints).toBe(3);
  const control = await postResearchEligibility(TOKEN);
  expect(control.status).toBe(409);

  const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(row!.enabled).toBe(false);
  const [jobs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM jobs WHERE kind = 'research.refresh'`;
  expect(jobs!.n).toBe(beforeJobs!.n);

  // Both the supported seed write and retired control path authenticate first.
  expect(requests.map((r) => r.path)).toEqual([
    "/api/analytics/raw-history/seed",
    "/api/analytics/research-eligibility",
  ]);
  for (const r of requests) {
    expect(r.auth).toBe(`Bearer ${TOKEN}`);
  }
});
