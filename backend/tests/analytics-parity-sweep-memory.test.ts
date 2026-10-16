// Issue 1375: on a production-sized database, each per-domain parity request
// answers in under 5 s and the api's memory stays flat.
//
// WHY. The sweep used to load both sides of every domain into the api. Stage
// QA on 2026-10-15, with that day's production dump, saw one sweep take the
// api from 71 MiB to 5.9 GiB in 30 s on a 7.75 GiB host, and an in-flight
// sweep killed the api. Each domain is now one set-based statement in
// Postgres that returns one small row.
//
// THE FIXTURE has production's shape on 2026-10-15 (the dump stage QA used),
// built in SQL so it costs seconds, not a replay of every writer:
//   - raw_indicator_history: 117,868 rows (30 indicators x 3,929 days); its
//     source_value_versions chains: 291,700 versions (a legacy baseline per
//     point, a revision for every point, a second revision for 47%).
//   - 426 terminal runs over 25 settled as-of days, each with a report
//     snapshot, a regime artifact of 3,076 elements (about 600 B each, 1.8 MB
//     per artifact, 784 MB in all, as in production) and a research artifact
//     (243 empty, 183 with two ~450 KB elements); regime_snapshots 3,076 rows;
//     research_signals 142 rows (50 on settled days).
//   - swarm_briefs 347 session briefs: 93 after migration 0059 with a
//     revision each (bodies about 1 MB, as in production), 254 before it.
// Everything matches, so the statements do the whole comparison.
//
// RSS is the test process's, which runs the route handler exactly as the api
// mounts it. Growth is measured across the four requests after one warm-up
// request, so module loading and the connection pool are not counted.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ROUTES } from "@robotmoney/contract";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { ALL_PARITY_DOMAINS } from "../src/analytics/cutover/parity-domains.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { provisionAnalyticsToken } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const MIB = 1024 * 1024;
const REQUEST_BUDGET_MS = 5_000;
const RSS_BUDGET_BYTES = 64 * MIB;

const RUNS = 426;
const SETTLED_DAYS = 25;
const REGIME_DAYS = 3_076;
const RAW_INDICATORS = 30;
const RAW_DAYS = 3_929;
const BRIEFS_LEDGER_ERA = 93;
const BRIEFS_BEFORE = 254;

let TOKEN = "";

async function build(): Promise<void> {
  const db = fixtureDb;
  // Regime days end on the last settled as-of day; the settled days are the last 25.
  const lastDay = "2026-10-15";
  await db.unsafe(`
    CREATE TEMP TABLE fx_days AS
      SELECT (DATE '${lastDay}' - (${REGIME_DAYS} - n))::date AS day, n
        FROM generate_series(1, ${REGIME_DAYS}) AS n;
    CREATE TEMP TABLE fx_settled AS SELECT day FROM fx_days WHERE n > ${REGIME_DAYS - SETTLED_DAYS};
  `);

  // ── raw_indicator_history and its source_value_versions chains ──
  await db.unsafe(`
    INSERT INTO raw_indicator_history (indicator, date, value, source)
    SELECT 'FX_' || i, DATE '2015-12-01' + d, round((1000 + i * 10 + d * 0.01)::numeric, 6)::float8, 'live'
      FROM generate_series(1, ${RAW_INDICATORS}) AS i, generate_series(0, ${RAW_DAYS - 1}) AS d;
    INSERT INTO source_acquisitions (id, provider, parser_version, cache_identity)
    VALUES ('00000000-0000-4000-8000-000000000001', 'fixture', 'fixture:1', 'parity-memory-1'),
           ('00000000-0000-4000-8000-000000000002', 'fixture', 'fixture:1', 'parity-memory-2');
    INSERT INTO source_value_versions (source_key, market_date, value, revision_kind)
    SELECT 'raw_indicator_history:' || indicator, date, value - 1, 'legacy_baseline' FROM raw_indicator_history;
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind)
    SELECT '00000000-0000-4000-8000-000000000001', b.source_key, b.market_date,
           CASE WHEN (extract(day FROM b.market_date))::int % 2 = 0 THEN b.value + 0.5 ELSE b.value + 1 END,
           b.id, 'revision'
      FROM source_value_versions b WHERE b.revision_kind = 'legacy_baseline';
    INSERT INTO source_value_versions (acquisition_id, source_key, market_date, value, prior_version_id, revision_kind)
    SELECT '00000000-0000-4000-8000-000000000002', r.source_key, r.market_date, r.value + 0.5, r.id, 'revision'
      FROM source_value_versions r
     WHERE r.revision_kind = 'revision' AND (extract(day FROM r.market_date))::int % 2 = 0;
  `);

  // ── runs, report snapshots, regime and research artifacts ──
  await db.unsafe(`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES ('parity-memory', 'v1', '{}', repeat('a', 64));
    CREATE TEMP TABLE fx_runs AS
      SELECT r, (SELECT day FROM fx_settled ORDER BY day OFFSET (r % ${SETTLED_DAYS}) LIMIT 1) AS asof
        FROM generate_series(1, ${RUNS}) AS r;
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    SELECT gen_random_uuid()::text, asof, 'parity-memory', 'fixture',
           (SELECT id FROM analytics_ledger_methodology_versions WHERE tool_id = 'parity-memory'), 'build-' || r
      FROM fx_runs ORDER BY r;
    INSERT INTO analytics_report_snapshots (run_id, asof, report_bytes, checksum)
    SELECT id, asof, convert_to('report ' || id, 'UTF8'), encode(sha256(convert_to('report ' || id, 'UTF8')), 'hex')
      FROM analytics_ledger_runs WHERE tool_id = 'parity-memory';
  `);
  // One regime element per day, about 600 B: the production element's fields.
  const percentiles = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`IND_${i}`, 0.123456]));
  await db.unsafe(`
    CREATE TEMP TABLE fx_regime AS
      SELECT day::text AS day, round((n % 1000) / 1000.0, 6)::float8 AS composite FROM fx_days;
    CREATE TEMP TABLE fx_regime_payload AS
      SELECT convert_to(json_agg(json_build_object(
               'backtest', null, 'bucketThresholds', null, 'composite', composite, 'compositePercentile', 0.5,
               'correlations', null, 'date', day, 'extras', null, 'factorIndex', 0.84, 'factorPercentile', 0.98,
               'factorRegime', 'risk_on', 'indicators', '[]'::json, 'macroIndex', 0.49, 'macroPercentile', 0.78,
               'macroRegime', 'risk_on', 'onchainIndex', 0.61, 'onchainPercentile', 0.75, 'onchainRegime', 'risk_on',
               'panelWeights', null, 'panels', null, 'percentiles', '${JSON.stringify(percentiles)}'::json,
               'regime', 'risk_on', 'source', 'live', 'version', 'v1') ORDER BY day)::text, 'UTF8') AS bytes
        FROM fx_regime;
    INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
    SELECT r.id, 'regime_snapshots', p.bytes, encode(sha256(p.bytes), 'hex')
      FROM analytics_ledger_runs r, fx_regime_payload p WHERE r.tool_id = 'parity-memory';
    INSERT INTO regime_snapshots (date, composite, regime)
    SELECT day::date, composite, 'risk_on' FROM fx_regime;
  `);
  // Research: two keys per settled day, each payload about 450 KB; 183 runs carry them, 243 are empty.
  await db.unsafe(`
    CREATE TEMP TABLE fx_research AS
      SELECT s.day::text AS day, k.key,
             jsonb_build_object('asof', s.day::text, 'title', k.key, 'question', 'q',
               'btc_price', (SELECT jsonb_agg(jsonb_build_object('date', (DATE '2018-01-01' + g)::text, 'value', 10000 + g * 1.5)) FROM generate_series(0, 9999) AS g)) AS payload
        FROM fx_settled s, (VALUES ('channel-divergence'), ('breadth-thrust')) AS k(key);
    CREATE TEMP TABLE fx_research_payload AS
      SELECT day, convert_to(jsonb_agg(jsonb_build_object('date', day, 'key', key, 'payload', payload) ORDER BY key)::text, 'UTF8') AS bytes
        FROM fx_research GROUP BY day;
    INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
    SELECT r.id, 'research_signals',
           CASE WHEN r.id % 7 < 3 THEN p.bytes ELSE convert_to('[]', 'UTF8') END,
           encode(sha256(CASE WHEN r.id % 7 < 3 THEN p.bytes ELSE convert_to('[]', 'UTF8') END), 'hex')
      FROM analytics_ledger_runs r JOIN fx_research_payload p ON p.day = r.asof::text
     WHERE r.tool_id = 'parity-memory';
    INSERT INTO research_signals (signal_key, date, payload)
    SELECT key, day::date, payload FROM fx_research
     WHERE day IN (SELECT asof::text FROM analytics_ledger_runs r WHERE r.tool_id = 'parity-memory' AND r.id % 7 < 3);
    INSERT INTO research_signals (signal_key, date, payload)
    SELECT 'old-signal-' || (n % 4), DATE '2026-01-01' + n, jsonb_build_object('n', n)
      FROM generate_series(1, 92) AS n;
  `);

  // ── swarm briefs: 93 ledger-era with a revision, 254 before migration 0059 ──
  const [boundary] = await db<{ applied_at: Date }[]>`
    SELECT applied_at FROM schema_migrations WHERE name = '0059_analytics_output_and_report_snapshots.sql'`;
  await db`INSERT INTO swarm_subjects (id, name) VALUES ('parity-memory', 'Parity Memory') ON CONFLICT DO NOTHING`;
  const bigBody = (i: number) => ({
    sessionNote: `brief ${i}`,
    // About 1 MB, as production's are.
    regime: Array.from({ length: 16_000 }, (_, d) => ({ date: `2026-${String((d % 12) + 1).padStart(2, "0")}-01`, value: d * 1.25, label: "risk_on" })),
  });
  for (let i = 0; i < BRIEFS_LEDGER_ERA + BRIEFS_BEFORE; i++) {
    const ledgerEra = i < BRIEFS_LEDGER_ERA;
    const createdAt = new Date(boundary!.applied_at.getTime() + (ledgerEra ? 1 : -1) * (i + 1) * 60_000);
    const [session] = await db<{ id: string }[]>`
      INSERT INTO swarm_sessions (subject_id, convened_at) VALUES ('parity-memory', ${new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)})
      RETURNING id`;
    const body = ledgerEra ? bigBody(i) : { sessionNote: `old brief ${i}` };
    await db`
      INSERT INTO swarm_briefs (date, subject_id, body, created_at, session_id)
      VALUES (${new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)}, 'parity-memory', ${db.json(body as never)}, ${createdAt}, ${session!.id})`;
    if (ledgerEra) {
      const bytes = Buffer.from(JSON.stringify(body), "utf8");
      await db`
        INSERT INTO swarm_brief_revisions (session_id, revision, body_bytes, checksum)
        VALUES (${session!.id}, 1, ${bytes}, ${createHash("sha256").update(bytes).digest("hex")})`;
    }
  }
  await db.unsafe("ANALYZE");
}

async function sweepDomain(domain: string): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const req = new Request(`http://x${ROUTES.analytics.paritySweep}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ domain }),
  });
  const started = performance.now();
  const res = await handleAnalytics(req, new URL(req.url));
  return { status: res!.status, body: res!.body as Record<string, unknown>, ms: performance.now() - started };
}

describe("the parity sweep on a production-sized database", () => {
  beforeAll(async () => {
    TOKEN = await provisionAnalyticsToken();
    await build();
  }, 600_000);

  test("the fixture has production's shape", async () => {
    const [c] = await fixtureDb<Record<string, number>[]>`
      SELECT (SELECT count(*) FROM raw_indicator_history)::int AS raw,
             (SELECT count(*) FROM source_value_versions WHERE source_key LIKE 'raw_indicator_history:%')::int AS versions,
             (SELECT count(*) FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots')::int AS regime_artifacts,
             (SELECT sum(byte_length) FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots')::bigint AS regime_bytes,
             (SELECT count(*) FROM regime_snapshots)::int AS regime_rows,
             (SELECT count(*) FROM research_signals)::int AS research_rows,
             (SELECT count(*) FROM swarm_briefs WHERE session_id IS NOT NULL)::int AS briefs,
             (SELECT count(*) FROM swarm_brief_revisions)::int AS revisions,
             (SELECT count(DISTINCT asof) FROM analytics_report_snapshots)::int AS settled`;
    expect(c!.raw).toBe(RAW_INDICATORS * RAW_DAYS);
    expect(c!.versions).toBeGreaterThan(280_000);
    expect(c!.regime_artifacts).toBe(RUNS);
    expect(Number(c!.regime_bytes)).toBeGreaterThan(700 * MIB);
    expect(c!.regime_rows).toBe(REGIME_DAYS);
    expect(c!.research_rows).toBeGreaterThan(130);
    expect(c!.briefs).toBe(BRIEFS_LEDGER_ERA + BRIEFS_BEFORE);
    expect(c!.revisions).toBe(BRIEFS_LEDGER_ERA);
    expect(c!.settled).toBe(SETTLED_DAYS);
  });

  test("each per-domain request answers 200 in under 5 s, every domain matches, and RSS grows by less than 64 MiB across all four", async () => {
    // Warm-up: module code, the pool's connections and the route's first
    // allocations are not the sweep's working set.
    expect((await sweepDomain("swarm_briefs")).status).toBe(200);
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const timings: Record<string, number> = {};
    for (const domain of ALL_PARITY_DOMAINS) {
      const r = await sweepDomain(domain);
      peak = Math.max(peak, process.memoryUsage().rss);
      timings[domain] = Math.round(r.ms);
      expect({ domain, status: r.status }).toEqual({ domain, status: 200 });
      expect({ domain, matched: r.body.matched, mismatchCount: r.body.mismatchCount }).toEqual({ domain, matched: true, mismatchCount: 0 });
      expect({ domain, underBudget: r.ms < REQUEST_BUDGET_MS }).toEqual({ domain, underBudget: true });
    }
    Bun.gc(true);
    const growth = Math.max(process.memoryUsage().rss, peak) - before;
    console.log(`[parity-sweep-memory] per-domain ms ${JSON.stringify(timings)}; rss before ${Math.round(before / MIB)} MiB, growth ${Math.round(growth / MIB)} MiB`);
    expect(growth).toBeLessThan(RSS_BUDGET_BYTES);
  }, 120_000);
});
