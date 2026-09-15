import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { fetchAll } from "../src/analytics/extract/sources.ts";
import { fetchFred } from "../src/analytics/extract/fred.ts";
import { captureSourceAcquisition, payloadChecksum, type AcquisitionSink } from "../src/analytics/source-ledger.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const originalFetch = globalThis.fetch;
const originalTtl = process.env.HTTP_FETCH_CACHE_TTL_MS;
const originalCacheDir = process.env.FETCH_CACHE_DIR;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTtl === undefined) delete process.env.HTTP_FETCH_CACHE_TTL_MS;
  else process.env.HTTP_FETCH_CACHE_TTL_MS = originalTtl;
  if (originalCacheDir === undefined) delete process.env.FETCH_CACHE_DIR;
  else process.env.FETCH_CACHE_DIR = originalCacheDir;
});

const sink: AcquisitionSink = { saveSourceAcquisition };

function providerResponse(url: string): Response {
  if (url.includes("fredgraph.csv")) return new Response("DATE,VALUE\n2024-01-01,1.25\n", { headers: { etag: "fred-release-1" } });
  if (url.includes("query2.finance.yahoo.com")) return Response.json({ chart: { result: [{ timestamp: [1704067200], indicators: { adjclose: [{ adjclose: [2] }] } }] } });
  if (url.includes("historicalChainTvl")) return Response.json([{ date: 1704067200, tvl: 3 }]);
  if (url.includes("stablecoincharts")) return Response.json([{ date: 1704067200, totalCirculatingUSD: { peggedUSD: 4 } }]);
  if (url.includes("api.blockchain.info")) return Response.json({ values: [{ x: 1704067200, y: 5 }] });
  if (url.includes("community-api.coinmetrics.io")) {
    if (url.includes("next_page_token")) return Response.json({ data: [{ time: "2024-01-02", AdrActCnt: "7", CapMVRVCur: "7" }] });
    return Response.json({ data: [{ time: "2024-01-01", AdrActCnt: "6", CapMVRVCur: "6" }], next_page_token: "page-2" });
  }
  if (url.includes("api.geckoterminal.com")) return Response.json({ data: [{ attributes: { pool_created_at: "2000-01-01T00:00:00Z" } }] });
  if (url.includes("multpl.com")) return new Response("<tr><td>January 1, 2024</td><td>30.5</td></tr>");
  if (url.includes("raw.githubusercontent.com")) return new Response("Date,PE10\n2023-12,29.5\n");
  throw new Error(`unhandled fixture URL: ${url}`);
}

test("every sources.ts provider variant records requests, ratio/fallback legs, pagination, releases, normalized values, and exact payload bytes", async () => {
  globalThis.fetch = ((input: URL | RequestInfo) => Promise.resolve(providerResponse(String(input)))) as typeof fetch;
  const output = await fetchAll({ indicators: INDICATORS, acquisitionSink: sink, requestedByRunId: 42 });
  expect(Object.keys(output)).toHaveLength(INDICATORS.length);

  const acquisitions = await sql`SELECT id, provider, requested_by_run_id FROM source_acquisitions`;
  expect(acquisitions).toHaveLength(INDICATORS.length);
  expect(new Set(acquisitions.map((r) => r.provider))).toEqual(new Set([
    "fred", "yahoo", "defillama_tvl", "defillama_stables", "blockchain_com",
    "coinmetrics", "geckoterminal_newpools", "shiller_cape",
  ]));
  expect(acquisitions.every((r) => Number(r.requested_by_run_id) === 42)).toBe(true);

  const [{ ratioFetches }] = await sql`
    SELECT count(*)::int AS "ratioFetches" FROM source_fetches f
    JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.provider = 'yahoo'`;
  expect(ratioFetches).toBeGreaterThan(acquisitions.filter((r) => r.provider === "yahoo").length);
  const [{ coinmetricsFetches }] = await sql`
    SELECT count(*)::int AS "coinmetricsFetches" FROM source_fetches f
    JOIN source_acquisitions a ON a.id = f.acquisition_id WHERE a.provider = 'coinmetrics'`;
  expect(coinmetricsFetches).toBe(4); // two source variants, two pages each
  const [{ shillerFetches }] = await sql`
    SELECT count(*)::int AS "shillerFetches" FROM source_fetches f
    JOIN source_acquisitions a ON a.id = f.acquisition_id WHERE a.provider = 'shiller_cape'`;
  expect(shillerFetches).toBe(2); // primary + fallback/backfill leg

  const [fred] = await sql`
    SELECT f.provider_release_id, f.response_checksum, p.payload_bytes
    FROM source_fetches f JOIN source_acquisitions a ON a.id=f.acquisition_id
    JOIN source_payloads p ON p.checksum=f.response_checksum
    WHERE a.provider='fred' LIMIT 1`;
  const exact = new TextEncoder().encode("DATE,VALUE\n2024-01-01,1.25\n");
  expect(fred.provider_release_id).toBe("fred-release-1");
  expect(fred.response_checksum).toBe(payloadChecksum(exact));
  expect(Buffer.from(fred.payload_bytes)).toEqual(Buffer.from(exact));
  const [{ values }] = await sql`SELECT count(*)::int AS values FROM source_value_versions WHERE acquisition_id IS NOT NULL`;
  expect(values).toBeGreaterThan(INDICATORS.length);
});

test("cache hits remain independent immutable fetch evidence with checksum-addressed exact bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rm-source-ledger-"));
  process.env.HTTP_FETCH_CACHE_TTL_MS = "60000";
  process.env.FETCH_CACHE_DIR = dir;
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.resolve(new Response("DATE,VALUE\n2024-01-01,9\n")); }) as unknown as typeof fetch;
  try {
    for (let i = 0; i < 2; i++) {
      await captureSourceAcquisition({ provider: "fred", sourceKey: "cache:FRED", parserVersion: "fred:1", cacheIdentity: "cache-test" }, sink, () => fetchFred("CACHE_TEST"));
    }
    expect(calls).toBe(1);
    const rows = await sql`
      SELECT f.cache_status, p.payload_bytes FROM source_fetches f
      JOIN source_acquisitions a ON a.id=f.acquisition_id
      JOIN source_payloads p ON p.checksum=f.response_checksum
      WHERE a.cache_identity='cache-test' ORDER BY a.knowledge_time, f.sequence`;
    expect(rows.map((r) => r.cache_status)).toEqual(["miss", "hit"]);
    expect(rows.every((r) => Buffer.from(r.payload_bytes).toString() === "DATE,VALUE\n2024-01-01,9\n")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unchanged and revised observations retain every version in one deterministic prior-version chain", async () => {
  for (const value of [10, 10, 11]) {
    await captureSourceAcquisition({ provider: "fixture", sourceKey: "series:revision", parserVersion: "fixture:1", cacheIdentity: String(value) }, sink,
      async () => [{ date: "2024-01-01", value }]);
  }
  const rows = await sql`
    SELECT id, prior_version_id, revision_kind, value FROM source_value_versions
    WHERE source_key='series:revision' ORDER BY id`;
  expect(rows.map((r) => r.revision_kind)).toEqual(["initial", "unchanged", "revision"]);
  expect(rows[0]!.prior_version_id).toBeNull();
  expect(String(rows[1]!.prior_version_id)).toBe(String(rows[0]!.id));
  expect(String(rows[2]!.prior_version_id)).toBe(String(rows[1]!.id));
});

test("concurrent revisions serialize into a single chain without a duplicate successor or lost acquisition", async () => {
  await captureSourceAcquisition({ provider: "fixture", sourceKey: "series:race", parserVersion: "fixture:1", cacheIdentity: "base" }, sink,
    async () => [{ date: "2024-01-01", value: 1 }]);
  await Promise.all([2, 3].map((value) =>
    captureSourceAcquisition({ provider: "fixture", sourceKey: "series:race", parserVersion: "fixture:1", cacheIdentity: `race-${value}` }, sink,
      async () => [{ date: "2024-01-01", value }])));
  const rows = await sql`SELECT id, prior_version_id, value FROM source_value_versions WHERE source_key='series:race' ORDER BY id`;
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => Number(r.value)))).toEqual(new Set([1, 2, 3]));
  expect(rows.filter((r) => r.prior_version_id === null)).toHaveLength(1);
  expect(new Set(rows.filter((r) => r.prior_version_id !== null).map((r) => String(r.prior_version_id))).size).toBe(2);
});

test("date and instant market time round-trip exactly, and redaction removes credentials from identities and failures", async () => {
  const collected: any[] = [];
  const memorySink: AcquisitionSink = { saveSourceAcquisition: async (e) => { collected.push(e); return { acquisitionId: e.id, replayed: false }; } };
  globalThis.fetch = (() => Promise.reject(new Error("Bearer secret-token https://x.test/?api_key=sentinel-credential"))) as unknown as typeof fetch;
  await expect(captureSourceAcquisition({ provider: "fixture", sourceKey: "instant", parserVersion: "1", cacheIdentity: "x" }, memorySink,
    () => fetchFred("X"))).rejects.toThrow();
  expect(JSON.stringify(collected)).not.toContain("secret-token");
  expect(JSON.stringify(collected)).not.toContain("sentinel-credential");

  const dateEvidence = { provider: "fixture", sourceKey: "market:date", parserVersion: "1", cacheIdentity: "date" } as const;
  await captureSourceAcquisition(dateEvidence, sink, async () => [{ date: "2024-02-29", value: 1 }]);
  await captureSourceAcquisition({ ...dateEvidence, sourceKey: "market:instant", marketTime: "instant" }, sink,
    async () => [{ date: "2024-02-29T12:34:56.789Z", value: 2 }]);
  const rows = await sql`SELECT source_key, market_date::text, market_instant::text FROM source_value_versions WHERE source_key LIKE 'market:%' ORDER BY source_key`;
  expect(rows[0]).toMatchObject({ source_key: "market:date", market_date: "2024-02-29", market_instant: null });
  expect(new Date(rows[1]!.market_instant).toISOString()).toBe("2024-02-29T12:34:56.789Z");
  await expect(Promise.resolve(sql`INSERT INTO source_value_versions (source_key, value, revision_kind) VALUES ('bad:none', 1, 'legacy_baseline')`)).rejects.toThrow();
  await expect(Promise.resolve(sql`INSERT INTO source_value_versions (source_key, market_date, market_instant, value, revision_kind) VALUES ('bad:both', '2024-01-01', now(), 1, 'legacy_baseline')`)).rejects.toThrow();
});

test("evidence persistence failure is fatal and returns no fetched values to the caller", async () => {
  let received: unknown = null;
  const refusingSink: AcquisitionSink = { saveSourceAcquisition: async () => { throw new Error("ledger unavailable"); } };
  await expect(captureSourceAcquisition({ provider: "fixture", sourceKey: "fatal", parserVersion: "1", cacheIdentity: "fatal" }, refusingSink,
    async () => { received = [{ date: "2024-01-01", value: 99 }]; return received as any; })).rejects.toThrow("ledger unavailable");
  expect(received).not.toBeNull(); // provider completed, but capture never returned it
});
