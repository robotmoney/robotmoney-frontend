// EXPLAIN check for the public analytics reads (issue #1095, D58): do the
// vintage and overwrite-event queries (and the two history queries beside them)
// run off the indexes the tables already have, or does serving them need a
// forward migration that adds one?
//
// OUTCOME, recorded here and in the change that added the routes: NO INDEX
// MIGRATION IS NEEDED. Every keyset page below is an index scan whose order
// satisfies the ORDER BY, so none sorts and none reads a table in full:
//   raw-history       raw_indicator_history_pkey (date, indicator)
//   asset-prices      asset_prices_pkey (price_date, symbol, time_basis)
//   overwrite-events  analytics_overwrite_events_pkey (id), including with a
//                     table_name filter (the primary key scan filters; it does
//                     not need analytics_overwrite_events_lookup_idx)
//   vintages          analytics_data_vintages_pkey (id) for the page, and the run_key
//                     filter reaches analytics_ledger_runs through its UNIQUE index.
//                     The planner hash-joins the page to the run and methodology
//                     tables and sorts the joined rows (a Sort is tolerated for
//                     this one query): that set is one row per vintage, i.e. per
//                     run and tool, a few thousand at most, so the cost grows with
//                     the number of vintages and no index changes it. What matters
//                     is that analytics_data_vintages and the member table, the
//                     large ones, are never read in full
//   vintage members   analytics_vintage_members' (vintage_id, source_value_version_id)
//                     unique index, in order, so LIMIT stops the expansion early
// The one migration this change DOES ship (0093) is a GRANT, not an index: the
// api's role could not read analytics_overwrite_events at all.
//
// The statements come from the registry's own probes (the call sites' text), so
// a change to a query that loses its index fails here instead of passing against
// a copy. The tables are loaded past the size where the planner prefers a
// sequential scan and ANALYZEd, because a plan on an empty table proves nothing.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { registeredSites } from "../src/db/registry.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import "../src/api/routes/public-analytics.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) flatten(child, out);
  return out;
}

async function plan(site: string, params: (string | number | null)[]): Promise<PlanNode[]> {
  const declaration = registeredSites().find((d) => d.site === site);
  if (!declaration?.probe) throw new Error(`no registered probe for ${site}`);
  const rows = (await fixtureDb.unsafe(`EXPLAIN (FORMAT JSON) ${declaration.probe.statement}`, params as never[])) as unknown as {
    "QUERY PLAN": { Plan: PlanNode }[];
  }[];
  const nodes = flatten(rows[0]!["QUERY PLAN"][0]!.Plan);
  console.log(
    `explain ${site}: ` +
      nodes.map((n) => `${n["Node Type"]}${n["Relation Name"] ? `(${n["Relation Name"]}${n["Index Name"] ? `:${n["Index Name"]}` : ""})` : ""}`).join(" > "),
  );
  return nodes;
}

const types = (nodes: PlanNode[]): string[] => nodes.map((n) => n["Node Type"]);
const indexes = (nodes: PlanNode[]): string[] => nodes.map((n) => n["Index Name"]).filter((n): n is string => !!n);

test("seed enough rows that a missing index would show", async () => {
  // raw_indicator_history: 3 indicators x 20k days.
  await fixtureDb`
    INSERT INTO raw_indicator_history (date, indicator, value, source)
    SELECT DATE '1960-01-01' + d, 'EX_' || k, d::float8, 'seed'
    FROM generate_series(0, 19999) d, generate_series(1, 3) k`;
  // asset_prices: 3 symbols x 10k days.
  await fixtureDb`
    INSERT INTO asset_prices (price_date, symbol, time_basis, price_usd, currency, source, observed_at, fetched_at, config_identity)
    SELECT DATE '1990-01-01' + d, 'EX' || k, 'utc-daily-close', 1 + d, 'USD', 'geckoterminal', now(), now(), 'cfg'
    FROM generate_series(0, 9999) d, generate_series(1, 3) k`;
  // analytics_overwrite_events: 30k rows over the three tables, inserted as the owner
  // (the PLAN is the subject here; the trigger path is covered in tests/api/public-analytics.test.ts).
  await fixtureDb`
    INSERT INTO analytics_overwrite_events (table_name, operation, natural_key, previous_row, replacement_row)
    SELECT (ARRAY['raw_indicator_history', 'regime_snapshots', 'research_signals'])[1 + g % 3], 'update',
           jsonb_build_object('indicator', 'EX_' || (g % 7), 'date', '2000-01-01'), '{"value": 1}'::jsonb, '{"value": 2}'::jsonb
    FROM generate_series(1, 30000) g`;
  // Vintages: 3000 runs, one vintage each; methodology shared.
  const [{ id: methodology }] = await fixtureDb<{ id: string }[]>`
    INSERT INTO analytics_ledger_methodology_versions (tool_id, version_label, config, config_digest)
    VALUES ('ex-tool', 'v1', '{}'::jsonb, repeat('a', 64)) RETURNING id::text AS id`;
  await fixtureDb`
    INSERT INTO analytics_ledger_runs (run_key, asof, tool_id, source_label, methodology_version_id, build_identity)
    SELECT gen_random_uuid()::text, DATE '2026-01-01', 'ex-tool', 'fixture', ${methodology}::bigint, 'ex-build'
    FROM generate_series(1, 3000) g`;
  await fixtureDb`
    INSERT INTO analytics_data_vintages (run_id, tool_id, knowledge_time_cutoff, market_time_cutoff, methodology_version_id,
                                         build_identity, manifest, manifest_digest, member_count)
    SELECT r.id, 'ex-tool', now(), DATE '2026-01-01', ${methodology}::bigint, 'ex-build', '{}'::jsonb, repeat('b', 64), 0
    FROM analytics_ledger_runs r WHERE r.tool_id = 'ex-tool'`;
  // Members need source_value_versions to point at: 18k real ones through the ledger writer.
  for (const key of ["series:ex-a", "series:ex-b"]) {
    await saveSourceAcquisition({
      id: randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: `explain-${key}`, requestedByRunId: null,
      events: [], fetches: [],
      values: Array.from({ length: 9000 }, (_, i) => ({
        sourceKey: key, marketDate: new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10), marketInstant: null, value: i, provenance: "live",
      })),
    });
  }
  // The vintage under test holds two big ranges plus 600 single ids; every other vintage holds a few singles.
  const [{ min, max }] = await fixtureDb<{ min: string; max: string }[]>`
    SELECT min(id)::text AS min, max(id)::text AS max FROM source_value_versions`;
  const first = Number(min);
  const mid = first + 9000;
  const [target] = await fixtureDb<{ id: string }[]>`SELECT min(id)::text AS id FROM analytics_data_vintages`;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, last_source_value_version_id, source_key)
    VALUES (${target!.id}::bigint, ${first}::bigint, ${first + 4000}::bigint, 'series:ex-a'),
           (${target!.id}::bigint, ${mid}::bigint, ${mid + 4000}::bigint, 'series:ex-b')`;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
    SELECT ${target!.id}::bigint, ${first + 5000}::bigint + g, 'series:ex-a' FROM generate_series(1, 600) g`;
  await fixtureDb`
    INSERT INTO analytics_vintage_members (vintage_id, source_value_version_id, source_key)
    SELECT v.id, ${first + 6000}::bigint + (v.id % 2000), 'series:ex-a'
    FROM analytics_data_vintages v WHERE v.id <> ${target!.id}::bigint`;
  expect(Number(max)).toBeGreaterThan(first + 8000);
  for (const table of [
    "raw_indicator_history", "asset_prices", "analytics_overwrite_events", "analytics_data_vintages",
    "analytics_ledger_runs", "analytics_vintage_members", "source_value_versions",
  ]) {
    await fixtureDb.unsafe(`ANALYZE ${table}`);
  }
}, 120_000);

test("raw-history page: an index scan on the primary key, ordered by it, no sort and no sequential scan", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listRawHistory", ["1990-06-01", "EX_2", "0001-01-01", "9999-12-31", null, null, "{VIX}", 1001]);
  expect(indexes(nodes)).toContain("raw_indicator_history_pkey");
  expect(types(nodes)).not.toContain("Sort");
  expect(types(nodes)).not.toContain("Seq Scan");
});

test("raw-history page filtered to one indicator is still a bounded index scan", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listRawHistory", ["1990-06-01", "", "0001-01-01", "9999-12-31", "EX_2", "EX_2", "{VIX}", 1001]);
  expect(types(nodes)).not.toContain("Sort");
  expect(types(nodes)).not.toContain("Seq Scan");
});

test("asset-prices page: an index scan on the primary key, no sort and no sequential scan", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listAssetPrices", ["2000-01-01", "EX2", "utc-daily-close", "0001-01-01", "9999-12-31", null, null, 1001]);
  expect(indexes(nodes)).toContain("asset_prices_pkey");
  expect(types(nodes)).not.toContain("Sort");
  expect(types(nodes)).not.toContain("Seq Scan");
});

test("overwrite-events page by id: an index scan on the primary key, no sort and no sequential scan", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listOverwriteEvents", [15000, null, null, "{VIX}", 1001]);
  expect(indexes(nodes)).toContain("analytics_overwrite_events_pkey");
  expect(types(nodes)).not.toContain("Sort");
  expect(types(nodes)).not.toContain("Seq Scan");
});

test("overwrite-events page filtered by table_name: the primary key scan filters, with no sort and no sequential scan", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listOverwriteEvents", [15000, "regime_snapshots", "regime_snapshots", "{VIX}", 1001]);
  expect(types(nodes)).not.toContain("Sort");
  expect(types(nodes)).not.toContain("Seq Scan");
});

test("vintages page: the primary key reads the vintages, the member table is not touched, and a Sort is the only extra work", async () => {
  const nodes = await plan("src/api/routes/public-analytics:listVintages", [1500, null, null, null, null, 1001]);
  expect(indexes(nodes)).toContain("analytics_data_vintages_pkey");
  expect(nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "analytics_data_vintages")).toEqual([]);
  expect(nodes.some((n) => n["Relation Name"] === "analytics_vintage_members")).toBe(false);
});

test("vintages filtered by run_key reach the run through its unique index", async () => {
  const [{ run_key }] = await fixtureDb<{ run_key: string }[]>`SELECT run_key FROM analytics_ledger_runs LIMIT 1`;
  const nodes = await plan("src/api/routes/public-analytics:listVintages", [0, run_key, run_key, "ex-tool", "ex-tool", 1001]);
  expect(indexes(nodes)).toContain("analytics_ledger_runs_run_key_key");
  expect(nodes.filter((n) => n["Node Type"] === "Seq Scan")).toEqual([]);
});

test("vintage members: the (vintage_id, source_value_version_id) index supplies the order, so the page does not sort the expansion", async () => {
  const [target] = await fixtureDb<{ id: string }[]>`SELECT min(id)::text AS id FROM analytics_data_vintages`;
  const nodes = await plan("src/api/routes/public-analytics:listVintageMembers", [0, Number(target!.id), 0, "{raw_indicator_history:VIX}", 1001]);
  expect(types(nodes)).not.toContain("Seq Scan");
  expect(nodes.filter((n) => n["Node Type"] === "Sort")).toEqual([]);
  expect(indexes(nodes).some((i) => i.startsWith("analytics_vintage_members_"))).toBe(true);
});

test("overwrite-events pages in NUMERIC id order over 30k rows (ids past 9 and 99 are not sorted as text)", async () => {
  const { handlePublicAnalytics } = await import("../src/api/routes/public-analytics.ts");
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`http://api.test/api/public/analytics/overwrite-events?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const res = await handlePublicAnalytics(new Request(url), url, "198.51.100.1");
    const body = (await res.json()) as { events: { id: number }[]; nextCursor: string | null };
    ids.push(...body.events.map((e) => e.id));
    cursor = body.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(30000);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(new Set(ids).size).toBe(30000);
}, 60_000);
