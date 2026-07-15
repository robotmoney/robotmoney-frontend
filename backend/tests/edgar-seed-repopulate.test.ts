// Offline EDGAR/MNA repopulation client over the REAL authenticated analytics
// API + REAL (ephemeral) Postgres (issue #108). Deletes a deterministic
// subset of rows, restores them via repopulateEdgarSeed, and asserts ONLY the
// missing rows return while the final canonical DB projection matches the
// seed's manifest exactly.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { canonicalCsv, buildManifest, type EdgarSeedRow } from "../src/analytics/extract/edgar-seed.ts";
import { bootstrapEdgarSeed, repopulateEdgarSeed } from "../src/analytics/edgar-seed-loader.ts";
import type { AnalyticsApiConfig } from "../src/analytics/api-client.ts";

const TOKEN = "tok_edgar_repopulate_test";

const SEED_ROWS: EdgarSeedRow[] = [
  { date: "2022-01-31", indicator: "MNA", value: 50 },
  { date: "2022-02-28", indicator: "MNA", value: 60 },
  { date: "2022-03-31", indicator: "MNA", value: 70 },
  { date: "2022-04-30", indicator: "MNA", value: 80 },
];

function installSeedFixture(rows: EdgarSeedRow[] = SEED_ROWS): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-edgar-repopulate-"));
  const gzPath = join(dir, "seed.csv.gz");
  const manifestPath = join(dir, "seed.manifest.json");
  const manifest = buildManifest(rows, { asOf: "2022-05-01" });
  writeFileSync(gzPath, gzipSync(Buffer.from(canonicalCsv(rows), "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  process.env.EDGAR_SEED_PATH = gzPath;
  process.env.EDGAR_SEED_MANIFEST_PATH = manifestPath;
  return { dir };
}

let fixtureDir: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cfg: AnalyticsApiConfig;
const origAnalyticsToken = config.analyticsToken;
const origAllowInsecure = config.allowInsecure;

beforeEach(async () => {
  ({ dir: fixtureDir } = installSeedFixture());
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const r = await handleAnalytics(req, url);
      if (!r) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    },
  });
  cfg = { baseUrl: `http://localhost:${server.port}`, token: TOKEN };
  config.analyticsToken = TOKEN;
  config.allowInsecure = false;
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
});

afterEach(async () => {
  server?.stop(true);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.EDGAR_SEED_PATH;
  delete process.env.EDGAR_SEED_MANIFEST_PATH;
  config.analyticsToken = origAnalyticsToken;
  config.allowInsecure = origAllowInsecure;
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA'`;
});

test("repopulation restores ONLY a deleted subset; final DB projection matches the manifest exactly", async () => {
  // Fully seed, then delete a deterministic subset (the middle two months) to
  // simulate a partial data-loss scenario.
  await bootstrapEdgarSeed(cfg);
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA' AND date IN ('2022-02-28', '2022-03-31')`;
  const afterDelete = await sql`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'MNA'`;
  expect(Number(afterDelete[0]!.n)).toBe(2);

  const report = await repopulateEdgarSeed(cfg);
  expect(report.seeded).toBe(2); // exactly the two deleted months return
  expect(report.existing).toBe(2); // the two untouched months matched as-is
  expect(report.rejected).toBe(0); // no value conflicts in this scenario

  const rows = await sql<{ date: string; value: string }[]>`
    SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = 'MNA' ORDER BY date`;
  expect(rows.map((r) => ({ date: r.date, value: Number(r.value) }))).toEqual([
    { date: "2022-01-31", value: 50 },
    { date: "2022-02-28", value: 60 },
    { date: "2022-03-31", value: 70 },
    { date: "2022-04-30", value: 80 },
  ]);
});

test("repopulation on a completely empty DB reports every row as seeded, none existing or rejected", async () => {
  const report = await repopulateEdgarSeed(cfg);
  expect(report.seeded).toBe(4);
  expect(report.existing).toBe(0);
  expect(report.rejected).toBe(0);

  const rows = await sql`SELECT count(*)::int AS n FROM raw_indicator_history WHERE indicator = 'MNA'`;
  expect(Number(rows[0]!.n)).toBe(4);
});

test("repopulation reports a REJECTED count for a month whose persisted real value disagrees with the artifact — and never overwrites it", async () => {
  await bootstrapEdgarSeed(cfg);
  // Simulate a later REAL correction that diverges from the committed artifact's value.
  await sql`UPDATE raw_indicator_history SET value = 12345 WHERE indicator = 'MNA' AND date = '2022-03-31'`;
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA' AND date = '2022-04-30'`;

  const report = await repopulateEdgarSeed(cfg);
  expect(report.seeded).toBe(1); // 2022-04-30 restored
  expect(report.existing).toBe(2); // 01-31 and 02-28 matched as-is
  expect(report.rejected).toBe(1); // 03-31 disagreed — the real value is left standing

  const [row] = await sql<{ value: string }[]>`
    SELECT value FROM raw_indicator_history WHERE indicator = 'MNA' AND date = '2022-03-31'`;
  expect(Number(row!.value)).toBe(12345); // untouched — the seed never overwrites a real observation
});

test("repopulation is idempotent: a second run over an already-restored DB seeds nothing further", async () => {
  await bootstrapEdgarSeed(cfg);
  await sql`DELETE FROM raw_indicator_history WHERE indicator = 'MNA' AND date = '2022-02-28'`;

  const first = await repopulateEdgarSeed(cfg);
  expect(first.seeded).toBe(1);

  const second = await repopulateEdgarSeed(cfg);
  expect(second.seeded).toBe(0);
  expect(second.existing).toBe(4);
  expect(second.rejected).toBe(0);
});
