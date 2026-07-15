// EDGAR/MNA seed bootstrap over the REAL authenticated analytics API + REAL
// (ephemeral) Postgres (issue #108). A real Bun.serve() wraps the REAL
// handleAnalytics route handler (same code the api process mounts) — no live
// network, no mocked persistence. Covers: cold-DB load (empty→exact
// projection, second load is a no-op), overlap precedence (existing real
// value wins), authorization (401/403, zero row changes) for both the seed
// client and the research-eligibility endpoint, and the research-eligibility
// endpoint's real effect on job_schedules.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../../src/db/client.ts";
import { config } from "../../src/config.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { canonicalCsv, buildManifest, type EdgarSeedRow } from "../../src/analytics/extract/edgar-seed.ts";
import { bootstrapEdgarSeed, enableResearchEligibility } from "../../src/analytics/edgar-seed-loader.ts";
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

test("missing/invalid credentials: research-eligibility endpoint 401/403s and never flips the schedule", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES ('research.refresh', '0 23 * * *', false)`;

  await expect(enableResearchEligibility({ baseUrl: cfg.baseUrl, token: null })).rejects.toThrow(/HTTP 401/);
  await expect(enableResearchEligibility({ baseUrl: cfg.baseUrl, token: "wrong-token" })).rejects.toThrow(/HTTP 403/);

  const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(row!.enabled).toBe(false);
});

// ── research-eligibility: the real gate job_schedules effect ────────────────

test("research-eligibility flips a disabled research.refresh schedule to enabled, and is idempotent", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES ('research.refresh', '0 23 * * *', false)`;

  await enableResearchEligibility(cfg);
  const [after] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(after!.enabled).toBe(true);

  // Idempotent: calling again on an already-enabled schedule is a harmless no-op.
  await enableResearchEligibility(cfg);
  const [again] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(again!.enabled).toBe(true);
});

test("bootstrap ingestion succeeding, then research-eligibility: the full ordered gate over the real API", async () => {
  await sql`
    INSERT INTO job_schedules (kind, cron, enabled) VALUES ('research.refresh', '0 23 * * *', false)`;

  const result = await bootstrapEdgarSeed(cfg);
  expect(result.seededPoints).toBe(3);
  await enableResearchEligibility(cfg);

  const [row] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = 'research.refresh'`;
  expect(row!.enabled).toBe(true);

  // Every request carried the analytics-provider bearer over the real HTTP boundary.
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const r of requests) {
    expect(r.path.startsWith("/api/analytics/")).toBe(true);
    expect(r.auth).toBe(`Bearer ${TOKEN}`);
  }
});
