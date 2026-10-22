// The raw-history reads use index conditions (issue 1034). On the ~117k-row
// production table two of them used none: raw-history/gaps de-duplicated a
// `date::timestamptz` cast that no index holds, and the admin raw-series read
// wrapped its date bounds in `$x IS NULL OR date >= $x`. Each scanned the whole
// table on the api's request pool. The whole-table GET /api/analytics/raw-history
// is bulk work by design, so it runs on the batch pool instead. And the
// source-ledger writer's last `IS NOT DISTINCT FROM` lookup, which btree cannot
// search, is gone.
//
// The statements come from the registry's own probes (the call sites' text), so
// a query that loses its index fails here instead of passing against a copy.
// The table is loaded to production size, VACUUMed and ANALYZEd, because a plan
// on an empty table proves nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registeredSites } from "../src/db/registry.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import "../src/api/routes/admin.ts";
import "../src/ops/gap-detector.ts";
import { bearerHeaders, bootApi, provisionAnalyticsToken, type ApiProcess } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

async function explain(statement: string, params: (string | number | null)[]): Promise<PlanNode[]> {
  const rows = (await fixtureDb.unsafe(`EXPLAIN (FORMAT JSON) ${statement}`, params as never[])) as unknown as {
    "QUERY PLAN": { Plan: PlanNode }[];
  }[];
  return flatten(rows[0]!["QUERY PLAN"][0]!.Plan);
}

function probeOf(site: string): string {
  const declaration = registeredSites().find((d) => d.site === site);
  if (!declaration?.probe) throw new Error(`no registered probe for ${site}`);
  return declaration.probe.statement;
}

/** The index conditions the plan applies to raw_indicator_history (a bitmap index scan names only its index). */
const indexConds = (nodes: PlanNode[]): string[] =>
  nodes
    .filter((n) => n["Index Cond"] && (n["Relation Name"] === "raw_indicator_history" || n["Index Name"]?.startsWith("raw_indicator_history_")))
    .map((n) => n["Index Cond"]!);

const INDICATORS = 30;
const DAYS = 4_000;

beforeAll(async () => {
  // ~120k rows: 30 indicators x 4,000 days from 2015, the production shape.
  await fixtureDb`
    INSERT INTO raw_indicator_history (date, indicator, value, source)
    SELECT DATE '2015-01-01' + d, 'PLAN_' || k, d::float8, 'seed'
    FROM generate_series(0, ${DAYS - 1}) d, generate_series(1, ${INDICATORS}) k`;
  await fixtureDb.unsafe("VACUUM ANALYZE raw_indicator_history");
  const [{ n }] = await fixtureDb<{ n: number }[]>`SELECT count(*)::int AS n FROM raw_indicator_history`;
  expect(n).toBeGreaterThanOrEqual(INDICATORS * DAYS);
}, 120_000);

test("the raw-history/gaps scan reads raw_indicator_history through an index condition", async () => {
  for (const site of ["src/ops/gap-detector:detectGaps.raw_indicator_history.app", "src/ops/gap-detector:detectGaps.raw_indicator_history.worker"]) {
    const nodes = await explain(probeOf(site), ["2018-01-01"]);
    expect(indexConds(nodes).length, site).toBeGreaterThan(0);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan"), site).toBe(false);
  }
});

test("red control: the old cast form of the gaps scan has no index condition", async () => {
  const nodes = await explain(
    "SELECT DISTINCT date::timestamptz AS slot FROM raw_indicator_history WHERE date::timestamptz >= $1 ORDER BY slot",
    ["2018-01-01T00:00:00Z"],
  );
  expect(indexConds(nodes)).toEqual([]);
});

test("the admin raw-series read uses an index condition, bounded or not", async () => {
  const statement = probeOf("src/api/routes/admin:rawSeries");
  for (const params of [["PLAN_7", null, null, 500], ["PLAN_7", "2020-01-01", "2020-12-31", 500]] as (string | number | null)[][]) {
    const nodes = await explain(statement, params);
    expect(indexConds(nodes).length, JSON.stringify(params)).toBeGreaterThan(0);
  }
});

test("the gaps scan still reports what it did: one slot per stored day", async () => {
  const { detectGaps } = await import("../src/ops/gap-detector.ts");
  const { getSeriesDef } = await import("../src/ops/series-registry.ts");
  const { sql } = await import("../src/db/client.ts");
  // 2015..2025-12-14 is stored and every day is present, so nothing in that
  // range may be an interior gap, and the head is the last stored day.
  const report = await detectGaps(getSeriesDef("raw_indicator_history")!, sql, new Date("2026-01-01T12:00:00Z"));
  const lastDay = new Date(Date.UTC(2015, 0, 1 + DAYS - 1)).toISOString();
  expect(report.headDate).toBe(lastDay);
  expect(report.interiorGaps.filter((iso) => iso >= "2018-01-01" && iso <= lastDay)).toEqual([]);
});

test("no source_value_versions lookup contains IS NOT DISTINCT FROM", () => {
  const lookups = registeredSites().filter((d) => d.object === "source_value_versions" && d.privileges.includes("SELECT"));
  expect(lookups.length).toBeGreaterThan(0);
  for (const d of lookups) expect(d.probe?.statement ?? "", d.site).not.toMatch(/IS\s+NOT\s+DISTINCT\s+FROM/i);
  // The writer's own statements, comments stripped: the executed text, not a probe copy.
  const source = readFileSync(join(import.meta.dir, "..", "src", "analytics", "store", "source-ledger-store.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  expect(source).not.toMatch(/IS\s+NOT\s+DISTINCT\s+FROM/i);
});

test("a batch naming one coordinate twice still chains onto the stored head (the former fallback)", async () => {
  const key = `series:plan-dup-${randomUUID()}`;
  const acquire = (values: { marketDate: string | null; marketInstant: string | null; value: number }[]) =>
    saveSourceAcquisition({
      id: randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: `plan-${randomUUID()}`, requestedByRunId: null,
      events: [], fetches: [],
      values: values.map((v) => ({ sourceKey: key, ...v, provenance: "live" })),
    });
  const instant = "2024-01-01T10:00:00.000Z";
  await acquire([{ marketDate: "2024-01-01", marketInstant: null, value: 1 }, { marketDate: null, marketInstant: instant, value: 3 }]);
  // Each coordinate named twice in one batch: the per-value path. The first of
  // each pair revises the stored head; the second repeats it and adds nothing.
  await acquire([
    { marketDate: "2024-01-01", marketInstant: null, value: 2 },
    { marketDate: "2024-01-01", marketInstant: null, value: 2 },
    { marketDate: null, marketInstant: instant, value: 4 },
    { marketDate: null, marketInstant: instant, value: 4 },
  ]);
  const rows = await fixtureDb<{ id: string; value: number; prior: string | null; kind: string; dated: boolean }[]>`
    SELECT id::text AS id, value, prior_version_id::text AS prior, revision_kind AS kind, market_date IS NOT NULL AS dated
      FROM source_value_versions WHERE source_key = ${key} ORDER BY dated DESC, id`;
  expect(rows.map((r) => [r.dated, r.value, r.kind])).toEqual([
    [true, 1, "initial"], [true, 2, "revision"], [false, 3, "initial"], [false, 4, "revision"],
  ]);
  expect(rows[1]!.prior).toBe(rows[0]!.id);
  expect(rows[3]!.prior).toBe(rows[2]!.id);
});

let api: ApiProcess;

afterAll(() => api?.stop());

test("GET /api/analytics/raw-history runs on the batch pool", async () => {
  api = await bootApi();
  const token = await provisionAnalyticsToken();
  type Pool = { admitted_total: number };
  const pools = async () => ((await (await fetch(`${api.base}/health`)).json()) as { db_pool: { request: Pool; batch: Pool } }).db_pool;

  const before = await pools();
  const res = await fetch(`${api.base}/api/analytics/raw-history`, { headers: bearerHeaders(token), signal: AbortSignal.timeout(30_000) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { history: Record<string, unknown[]> };
  expect(body.history.PLAN_1?.length).toBe(DAYS);
  const after = await pools();

  // The token check and the whole-table read ran on the batch pool; the
  // request pool admitted nothing for it.
  expect(after.batch.admitted_total).toBeGreaterThan(before.batch.admitted_total);
  expect(after.request.admitted_total).toBe(before.request.admitted_total);
}, 90_000);
