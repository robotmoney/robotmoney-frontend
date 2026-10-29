import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { INDICATORS, type Indicator } from "../src/analytics/analyze/indicators.ts";
import { fetchAll } from "../src/analytics/extract/sources.ts";
import { fetchFred } from "../src/analytics/extract/fred.ts";
import { fetchJson } from "../src/analytics/extract/http.ts";
import { fetchGeckoTerminalNewPools } from "../src/analytics/extract/geckoterminal.ts";
import { captureSourceAcquisition, payloadChecksum, type AcquisitionSink } from "../src/analytics/source-ledger.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { loadInventory, collectedByInventory } from "../src/analytics/extract/model-portfolio.ts";

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

/** The source variants fetchOne actually branches on, read from its own switch
 *  so this file cannot drift out of step with the adapter registry. */
async function enumeratedSourceVariants(): Promise<string[]> {
  const src = await Bun.file(new URL("../../packages/analyst-sdk/src/extract/sources.ts", import.meta.url)).text();
  const body = src.slice(src.indexOf("export async function fetchOne"), src.indexOf("export async function fetchAll"));
  const variants = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!);
  expect(variants.length).toBeGreaterThan(7);
  return variants;
}

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
  const enumerated = await enumeratedSourceVariants();
  // The registry happens not to use multpl_shiller_cape today, so INDICATORS
  // alone leaves that branch of fetchOne unexercised and its evidence unproven.
  // A synthetic indicator reaches it through the same production path.
  const indicators: Indicator[] = [
    ...INDICATORS,
    ...enumerated.filter((source) => !INDICATORS.some((i) => i.source === source))
      .map((source): Indicator => ({
        id: `synthetic_${source}`, name: source, panel: INDICATORS[0]!.panel,
        source, sign: 1, transform: INDICATORS[0]!.transform, unit: "index",
      })),
  ];
  const output = await fetchAll({ indicators, acquisitionSink: sink, requestedByRunId: 42 });
  expect(Object.keys(output)).toHaveLength(indicators.length);

  const acquisitions = await sql`SELECT id, provider, requested_by_run_id FROM source_acquisitions`;
  expect(acquisitions).toHaveLength(indicators.length);
  // ENUMERATED, not listed by hand. AC1 is "every source variant enumerated by
  // sources.ts", so the expectation is read out of that switch: adding a
  // provider there and no evidence for it has to fail here, which a literal
  // set written in this file would never do.
  expect(new Set(acquisitions.map((r) => r.provider))).toEqual(new Set(enumerated));
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
    SELECT f.provider_release_id, f.response_checksum
    FROM source_fetches f JOIN source_acquisitions a ON a.id=f.acquisition_id
    WHERE a.provider='fred' LIMIT 1`;
  const exact = new TextEncoder().encode("DATE,VALUE\n2024-01-01,1.25\n");
  expect(fred.provider_release_id).toBe("fred-release-1");
  // The body's fingerprint, not the body (issue #1035, decision D56).
  expect(fred.response_checksum).toBe(payloadChecksum(exact));
  const [{ values }] = await sql`SELECT count(*)::int AS values FROM source_value_versions WHERE acquisition_id IS NOT NULL`;
  expect(values).toBeGreaterThan(INDICATORS.length);
});

test("cache hits remain independent immutable fetch evidence, each fingerprinting the exact bytes it returned", async () => {
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
      SELECT f.cache_status, f.response_checksum FROM source_fetches f
      JOIN source_acquisitions a ON a.id=f.acquisition_id
      WHERE a.cache_identity='cache-test' ORDER BY a.knowledge_time, f.sequence`;
    expect(rows.map((r) => r.cache_status)).toEqual(["miss", "hit"]);
    const exact = payloadChecksum(new TextEncoder().encode("DATE,VALUE\n2024-01-01,9\n"));
    expect(rows.every((r) => r.response_checksum === exact)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a re-observation adds no version and a revision adds one, in one deterministic prior-version chain", async () => {
  for (const value of [10, 10, 11]) {
    await captureSourceAcquisition({ provider: "fixture", sourceKey: "series:revision", parserVersion: "fixture:1", cacheIdentity: String(value) }, sink,
      async () => [{ date: "2024-01-01", value }]);
  }
  const rows = await sql`
    SELECT id, prior_version_id, revision_kind, value FROM source_value_versions
    WHERE source_key='series:revision' ORDER BY id`;
  // The second acquisition of 10 is evidence that a fetch happened (its
  // acquisition, fetches and payload are all kept) but not a new version.
  expect(rows.map((r) => r.revision_kind)).toEqual(["initial", "revision"]);
  expect(rows.map((r) => Number(r.value))).toEqual([10, 11]);
  expect(rows[0]!.prior_version_id).toBeNull();
  expect(String(rows[1]!.prior_version_id)).toBe(String(rows[0]!.id));
  const [{ acquisitions }] = await sql`
    SELECT count(*)::int AS acquisitions FROM source_acquisitions WHERE cache_identity IN ('10', '11')`;
  expect(acquisitions).toBe(3);
});

// ── Issue #1035: re-observations and float noise add no versions ────────────
// A Yahoo-derived key, because that is the one D56 gives a non-zero tolerance
// (analytics/source-tolerance.ts); an exact key is covered by the case above.
const NOISY_KEY = "backtest:ETH-USD"; // no other case in this file writes it
const HISTORY = Array.from({ length: 40 }, (_, i) => ({
  date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
  value: 18.719999313354492 + i,
}));

async function acquireNoisy(points: { date: string; value: number }[], provenance: string = "live"): Promise<void> {
  await saveSourceAcquisition({
    id: randomUUID(),
    provider: "yahoo",
    parserVersion: "yahoo:1",
    cacheIdentity: `noise-${randomUUID()}`,
    requestedByRunId: null,
    events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
    fetches: [],
    values: points.map((p) => ({ sourceKey: NOISY_KEY, marketDate: p.date, marketInstant: null, value: p.value, provenance })),
  });
}

async function noisyVersions(): Promise<{ id: string; market_date: string; value: number; revision_kind: string; provenance: string | null }[]> {
  return (await sql`
    SELECT id::text AS id, market_date::text AS market_date, value, revision_kind, provenance
    FROM source_value_versions WHERE source_key = ${NOISY_KEY} ORDER BY id`) as never;
}

test("issue #1035 AC1: an acquisition whose values all equal the ledger head adds zero source_value_versions rows", async () => {
  await acquireNoisy(HISTORY);
  const [{ total: before }] = await sql`SELECT count(*)::int AS total FROM source_value_versions`;
  expect((await noisyVersions()).length).toBe(HISTORY.length);

  // The whole history re-fetched, twice — what every production fetch did.
  await acquireNoisy(HISTORY);
  await acquireNoisy(HISTORY);

  const [{ total: after }] = await sql`SELECT count(*)::int AS total FROM source_value_versions`;
  expect(after - before).toBe(0);
  expect((await noisyVersions()).every((v) => v.revision_kind === "initial")).toBe(true);
  // The re-fetches themselves are still on the record.
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM source_acquisitions WHERE cache_identity LIKE 'noise-%'`;
  expect(n).toBe(3);
});

test("issue #1035 AC2: a value within the source's tolerance adds no revision; one outside it adds exactly one", async () => {
  const date = "2023-06-01";
  const base = 4523.68017578125;
  await acquireNoisy([{ date, value: base }]);

  // Float32 jitter: a relative 1e-7 off the head, well inside D56's 1e-6.
  const jitter = base * (1 + 1e-7);
  expect(jitter).not.toBe(base);
  await acquireNoisy([{ date, value: jitter }]);
  let versions = (await noisyVersions()).filter((v) => v.market_date === date);
  expect(versions.map((v) => v.revision_kind)).toEqual(["initial"]);
  expect(Number(versions[0]!.value)).toBe(base);

  // A real revision: a relative 1e-5, ten times the tolerance.
  const revised = base * (1 + 1e-5);
  await acquireNoisy([{ date, value: revised }]);
  versions = (await noisyVersions()).filter((v) => v.market_date === date);
  expect(versions.map((v) => v.revision_kind)).toEqual(["initial", "revision"]);
  expect(Number(versions[1]!.value)).toBe(revised);

  // The tolerance is measured against the NEW head, so re-fetching the
  // revised value (with its own jitter) adds nothing further.
  await acquireNoisy([{ date, value: revised * (1 - 1e-7) }]);
  versions = (await noisyVersions()).filter((v) => v.market_date === date);
  expect(versions).toHaveLength(2);
});

test("a relabel within tolerance writes nothing: the head keeps its value and its label, the same rule raw history applies", async () => {
  // Owner, 2026-09-29: the live fetch and the 'seed' catch-up take turns on
  // the same points, and a row per turn was ~13 rows per point of no value.
  const date = "2023-07-01";
  const base = 31.5;
  await acquireNoisy([{ date, value: base }], "seed");
  await acquireNoisy([{ date, value: base * (1 + 1e-7) }], "live");
  await acquireNoisy([{ date, value: base }], "live");
  let versions = (await noisyVersions()).filter((v) => v.market_date === date);
  expect(versions.map((v) => [v.revision_kind, Number(v.value), v.provenance])).toEqual([
    ["initial", base, "seed"],
  ]);
  // A real change carries the label it arrived with.
  await acquireNoisy([{ date, value: base * (1 + 1e-5) }], "live");
  versions = (await noisyVersions()).filter((v) => v.market_date === date);
  expect(versions.map((v) => [v.revision_kind, v.provenance])).toEqual([
    ["initial", "seed"],
    ["revision", "live"],
  ]);
});

// ── Issue #1035: the ledger keeps no raw response bodies ────────────────────
test("issue #1035: an acquisition whose fetches carry response bodies stores no body, and each fetch keeps its response_checksum", async () => {
  // source_payloads no longer exists (migration 0080): there is nowhere a body
  // could be written, and this proves the migration really removed it here.
  const [{ table }] = await sql`SELECT to_regclass('public.source_payloads')::text AS table`;
  expect(table).toBeNull();

  const bodies = ["DATE,VALUE\n2024-01-01,1\n", "DATE,VALUE\n2024-01-01,2\n"];
  globalThis.fetch = (() => Promise.resolve(new Response(bodies.shift()!))) as unknown as typeof fetch;
  await captureSourceAcquisition({ provider: "fred", sourceKey: "series:bodies", parserVersion: "fred:1", cacheIdentity: "bodies-a" }, sink,
    () => fetchFred("BODIES_A"));
  await captureSourceAcquisition({ provider: "fred", sourceKey: "series:bodies", parserVersion: "fred:1", cacheIdentity: "bodies-b" }, sink,
    () => fetchFred("BODIES_B"));
  const rows = await sql`
    SELECT a.cache_identity, f.response_checksum FROM source_fetches f
    JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.cache_identity IN ('bodies-a', 'bodies-b') ORDER BY a.cache_identity`;
  expect(rows.map((r) => [r.cache_identity, r.response_checksum])).toEqual([
    ["bodies-a", payloadChecksum(new TextEncoder().encode("DATE,VALUE\n2024-01-01,1\n"))],
    ["bodies-b", payloadChecksum(new TextEncoder().encode("DATE,VALUE\n2024-01-01,2\n"))],
  ]);
  // No column anywhere in the source ledger holds a body.
  const [{ bytea }] = await sql`
    SELECT count(*)::int AS bytea FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'bytea'
      AND table_name IN ('source_acquisitions', 'source_acquisition_events', 'source_fetches', 'source_value_versions')`;
  expect(bytea).toBe(0);
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

test("large historical acquisitions split value inserts below PostgreSQL's parameter limit", async () => {
  const values = Array.from({ length: 9_000 }, (_, i) => ({
    sourceKey: "series:large",
    marketDate: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
    marketInstant: null,
    value: i,
    provenance: "live",
  }));
  await saveSourceAcquisition({
    id: randomUUID(),
    provider: "fixture",
    parserVersion: "fixture:1",
    cacheIdentity: "large",
    requestedByRunId: null,
    events: [],
    fetches: [],
    values,
  });
  const [{ count }] = await sql`
    SELECT count(*)::int AS count FROM source_value_versions WHERE source_key = 'series:large'`;
  expect(count).toBe(9_000);
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

// ── Attempt-level evidence (AC1/AC2/AC6) ────────────────────────────────────
// The cases above drive the happy path of every provider. These drive the legs
// that only appear when a request goes wrong — a retry, an empty body, a
// terminal failure — because those are the ones whose evidence a reader most
// needs and the ones an adapter most easily forgets to record.

test("every retry attempt is its own immutable fetch row, numbered in order, carrying that attempt's own status", async () => {
  const statuses = [429, 503, 200];
  let call = 0;
  globalThis.fetch = (() => {
    const status = statuses[Math.min(call++, statuses.length - 1)]!;
    const body = JSON.stringify({ data: [{ attributes: { pool_created_at: new Date().toISOString() } }] });
    return Promise.resolve(new Response(body, { status, headers: { "retry-after": "0" } }));
  }) as unknown as typeof fetch;

  await captureSourceAcquisition(
    { provider: "geckoterminal_newpools", sourceKey: "series:retry", parserVersion: "geckoterminal:1", cacheIdentity: "retry" },
    sink,
    () => fetchGeckoTerminalNewPools(Date.now(), 5_000, { sleep: async () => {}, logger: { warn: () => {} } }),
  );

  const rows = await sql`
    SELECT f.sequence, f.response_status, f.error_detail, f.cache_status
    FROM source_fetches f JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.cache_identity = 'retry' ORDER BY f.sequence`;
  // Three attempts against ONE page: two refusals then the success. Collapsing
  // them into a single row would erase the throttling the ledger exists to show.
  const firstPage = rows.slice(0, 3);
  expect(firstPage.map((r) => Number(r.response_status))).toEqual([429, 503, 200]);
  // Contiguous from 1: the sequence is what orders attempts, so a gap or a
  // repeat would make the attempt history unreadable.
  expect(rows.map((r) => Number(r.sequence))).toEqual(rows.map((_, i) => i + 1));
  // Each refused attempt carries its OWN failure, and the success carries none.
  expect(firstPage[0]!.error_detail).toContain("429");
  expect(firstPage[1]!.error_detail).toContain("503");
  expect(firstPage[2]!.error_detail).toBeNull();
  // AC1 names cache_status on every fetch, not only on the cache-hit case.
  expect(rows.every((r) => ["disabled", "hit", "miss"].includes(r.cache_status))).toBe(true);
});

test("a terminal failure persists its redacted error, a failed event, and no values at all", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("upstream is down", { status: 500 }))) as unknown as typeof fetch;
  await expect(captureSourceAcquisition(
    { provider: "fixture", sourceKey: "series:terminal", parserVersion: "fixture:terminal", cacheIdentity: "terminal" },
    sink,
    () => fetchJson("https://x.test/feed?api_key=sentinel-credential", 5_000, { authorization: "Bearer secret-token" }),
  )).rejects.toThrow();

  const [fetchRow] = await sql`
    SELECT f.response_status, f.error_detail, f.provider_release_id, f.request_identity, a.parser_version
    FROM source_fetches f JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.cache_identity = 'terminal' ORDER BY f.sequence`;
  expect(Number(fetchRow!.response_status)).toBe(500);
  expect(fetchRow!.error_detail).toContain("500");
  // AC1 names parser version and request identity as persisted columns — the
  // in-memory redaction case above cannot speak for what reached the database.
  expect(fetchRow!.parser_version).toBe("fixture:terminal");
  const identity = JSON.stringify(fetchRow!.request_identity);
  expect(identity).not.toContain("sentinel-credential");
  expect(identity).not.toContain("secret-token");
  expect(identity).toContain("[REDACTED]");
  // AC6: null is preserved, never a fabricated release identifier. This
  // response carries no etag or last-modified, so there is nothing to record.
  expect(fetchRow!.provider_release_id).toBeNull();

  const events = await sql`
    SELECT e.event_type, e.detail FROM source_acquisition_events e
    JOIN source_acquisitions a ON a.id = e.acquisition_id
    WHERE a.cache_identity = 'terminal' ORDER BY e.sequence`;
  expect(events.map((r) => r.event_type)).toEqual(["started", "failed"]);
  expect(JSON.stringify(events)).not.toContain("secret-token");
  // A failed acquisition must contribute nothing to analytics (Behaviour:
  // "values from that request cannot feed analytics").
  const [{ values }] = await sql`
    SELECT count(*)::int AS values FROM source_value_versions WHERE source_key = 'series:terminal'`;
  expect(values).toBe(0);
});

test("an empty response is recorded as a successful fetch with zero values, not as a missing acquisition", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("[]", { status: 200 }))) as unknown as typeof fetch;
  await captureSourceAcquisition(
    { provider: "fixture", sourceKey: "series:empty", parserVersion: "fixture:1", cacheIdentity: "empty" },
    sink,
    async () => (await fetchJson("https://x.test/empty", 5_000)) as { date: string; value: number }[],
  );
  const [row] = await sql`
    SELECT f.response_status, f.response_checksum, f.error_detail
    FROM source_fetches f JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.cache_identity = 'empty'`;
  // The request happened and the bytes are retained. "No data" is a finding
  // the ledger has to be able to prove, and it is not the same as "no fetch".
  expect(Number(row!.response_status)).toBe(200);
  expect(row!.response_checksum).toBe(payloadChecksum(new TextEncoder().encode("[]")));
  expect(row!.error_detail).toBeNull();
  const events = await sql`
    SELECT e.event_type FROM source_acquisition_events e
    JOIN source_acquisitions a ON a.id = e.acquisition_id
    WHERE a.cache_identity = 'empty' ORDER BY e.sequence`;
  expect(events.map((r) => r.event_type)).toEqual(["started", "succeeded"]);
  const [{ values }] = await sql`
    SELECT count(*)::int AS values FROM source_value_versions WHERE source_key = 'series:empty'`;
  expect(values).toBe(0);
});

test("a sweep-sized acquisition persists in a handful of statements, not two per fetch", async () => {
  // THE FAILURE THIS GUARDS
  // The api serves this submission on the same event loop it serves the site
  // from. When each fetch cost its own INSERT round trip, one EDGAR sweep held
  // that loop long enough for Bun.serve to cut the request at its 10s idle
  // timeout, and every page behind it answered 502. Volume here is a real
  // sweep's shape: many requests, bodies that repeat, one acquisition.
  const payloads = Array.from({ length: 8 }, (_, i) => `{"filing":"${"x".repeat(20_000)}-${i}"}`);
  const fetches = Array.from({ length: 300 }, (_, i) => {
    const body = new TextEncoder().encode(payloads[i % payloads.length]!);
    return {
      id: randomUUID(),
      sequence: i + 1,
      requestIdentity: { method: "GET" as const, url: `https://sec.test/archives/${i}`, headers: {} },
      cacheStatus: "miss" as const,
      responseStatus: 200,
      responseChecksum: payloadChecksum(body),
      providerReleaseId: null,
      errorDetail: null,
    };
  });

  const startedAt = Date.now();
  await saveSourceAcquisition({
    id: randomUUID(),
    provider: "edgar",
    parserVersion: "edgar:1",
    cacheIdentity: "sweep",
    requestedByRunId: null,
    events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
    fetches,
    values: [],
  });
  const elapsed = Date.now() - startedAt;

  const [{ fetchRows, checksums }] = await sql`
    SELECT count(*)::int AS "fetchRows", count(DISTINCT f.response_checksum)::int AS checksums
    FROM source_fetches f
    JOIN source_acquisitions a ON a.id = f.acquisition_id
    WHERE a.cache_identity = 'sweep'`;
  // Every attempt still gets its own row — batching changes how the write is
  // issued, never what is recorded.
  expect(fetchRows).toBe(300);
  // 300 fetches over 8 distinct bodies: 8 distinct fingerprints.
  expect(checksums).toBe(8);
  // Far below the 10s the api would be cut off at. Generous on purpose: this
  // is a floor against the per-row regression, not a benchmark.
  expect(elapsed).toBeLessThan(5_000);
});

test("re-acquiring a series stays fast as its revision history deepens", async () => {
  // THE FAILURE THIS GUARDS
  // Each re-acquisition of a series adds another generation of rows under the
  // same source_key. If the prior-revision lookup cannot use the index, every
  // value rescans every generation, so acquisition N costs N times acquisition
  // 1 — fine at fixture scale, quadratic in production, and slow enough to hold
  // a pooled api connection while the site waits behind it.
  const POINTS = 2_000;
  const points = Array.from({ length: POINTS }, (_, i) => ({
    date: new Date(Date.UTC(2015, 0, i + 1)).toISOString().slice(0, 10),
    value: i,
  }));
  const acquire = async (generation: number) => {
    const startedAt = Date.now();
    await captureSourceAcquisition(
      { provider: "fixture", sourceKey: "series:deep", parserVersion: "fixture:1", cacheIdentity: `gen-${generation}` },
      sink,
      async () => points.map((p) => ({ ...p, value: p.value + generation })),
    );
    return Date.now() - startedAt;
  };

  const first = await acquire(0);
  for (let generation = 1; generation <= 5; generation++) await acquire(generation);
  const sixth = await acquire(6);

  const [{ versions }] = await sql`
    SELECT count(*)::int AS versions FROM source_value_versions WHERE source_key = 'series:deep'`;
  // Nothing is collapsed: seven generations of every point are all retained.
  expect(versions).toBe(POINTS * 7);

  // The seventh acquisition searches seven generations instead of one. With an
  // index-searchable lookup that is roughly flat; with a scan it grows with the
  // history. 4x the first acquisition is far looser than the ~7x a linear scan
  // would cost here, so this fails on the regression without being timing-flaky.
  expect(sixth).toBeLessThan(Math.max(first * 4, 1_500));
});

// ── Issue 1398: the model portfolio inputs ──────────────────────────────────
// Recorded responses from packages/analyst-sdk/tests/fixtures/extract/model-portfolio
// (provenance in packages/analyst-sdk/tests/model-portfolio.test.ts). A missing
// fixture fails the file loudly at import.
const MP_FIX = new URL("../../packages/analyst-sdk/tests/fixtures/extract/model-portfolio/", import.meta.url);
const mpGz = async (name: string) => new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(new URL(name, MP_FIX)).arrayBuffer())));
const MP_BASE = "7e0661bf-8cf3-45e6-9424-31916d4c7b84";
const MP_ETH = "aa70268e-4b52-42bf-a116-608b370f9501";
// Every series the inventory collects under its own id, with its recorded body.
const MP_IDS = loadInventory().series.filter(collectedByInventory).map((s) => s.id);
const mpBodies: [string, string][] = [];
for (const s of loadInventory().series.filter(collectedByInventory)) {
  const fragment = s.provider === "yahoo" ? `/v8/finance/chart/${encodeURIComponent(s.symbol)}?` : `yields.llama.fi/chart/${s.symbol}`;
  mpBodies.push([fragment, await mpGz(`${s.id.replace(":", "-")}.json.gz`)]);
}
const mpExpected = JSON.parse(await mpGz("expected-points.json.gz")) as Record<string, { date: string; value: number }[]>;

test("issue 1398: a price, then a changed price for the same date, are both recoverable from source_value_versions under the source id, as rm_app within the existing grants", async () => {
  // The write runs as rm_app (the harness's session role), with the grants it
  // has today: SELECT and INSERT on the append-only ledger, nothing more. No
  // migration, no new grant: this is the table and the privilege set as they are.
  expect((await sql`SELECT current_user AS u`)[0]!.u).toBe("rm_app");
  const [priv] = await sql`
    SELECT has_table_privilege('rm_app', 'source_value_versions', 'INSERT') AS ins,
           has_table_privilege('rm_app', 'source_value_versions', 'SELECT') AS sel,
           has_table_privilege('rm_app', 'source_value_versions', 'UPDATE') AS upd,
           has_table_privilege('rm_app', 'source_value_versions', 'DELETE') AS del`;
  expect(priv).toEqual({ ins: true, sel: true, upd: false, del: false });

  for (const value of [125.1500015258789, 126.5]) {
    await captureSourceAcquisition({ provider: "yahoo", sourceKey: "yahoo:GLD", parserVersion: "yahoo:1", cacheIdentity: `GLD:${value}` }, sink,
      async () => [{ date: "2018-01-02", value }]);
  }
  const rows = await sql`
    SELECT id, market_date::text AS d, value, revision_kind, prior_version_id, knowledge_time
    FROM source_value_versions WHERE source_key = 'yahoo:GLD' ORDER BY id`;
  expect(rows.map((r) => [r.d, Number(r.value), r.revision_kind])).toEqual([
    ["2018-01-02", 125.1500015258789, "initial"],
    ["2018-01-02", 126.5, "revision"],
  ]);
  expect(String(rows[1]!.prior_version_id)).toBe(String(rows[0]!.id));
  // The head is the newer observation; the older one stays readable.
  const [head] = await sql`
    SELECT value FROM source_value_versions WHERE source_key = 'yahoo:GLD' AND market_date = '2018-01-02'
    ORDER BY knowledge_time DESC, id DESC LIMIT 1`;
  expect(Number(head!.value)).toBe(126.5);
  // Updating the first observation is refused: the earlier value cannot be lost.
  const update = await sql`UPDATE source_value_versions SET value = 1 WHERE id = ${rows[0]!.id}`.then(() => "updated", (e: Error) => e.message);
  expect(update).toBe("permission denied for table source_value_versions");
});

test("issue 1398: collectModelPortfolioInputs records every new inventory series from recorded responses under its source id, and fetches no series another collector holds", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  const urls: string[] = [];
  globalThis.fetch = ((input: URL | RequestInfo) => {
    const url = String(input);
    urls.push(url);
    const hit = mpBodies.find(([f]) => url.includes(f));
    if (!hit) return Promise.reject(new Error(`unrecorded URL ${url}`));
    return Promise.resolve(new Response(hit[1], { headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const warnings: string[] = [];
  const { liveDataSource } = await import("../src/analytics/access/data-source.ts");
  const out = await liveDataSource.collectModelPortfolioInputs!({ log() {}, warn: (m) => warnings.push(m), error() {} }, sink, 77);

  const ids = MP_IDS;
  expect(ids).toContain("yahoo:GLD");
  expect(ids).toContain("yahoo:USDC-USD");
  expect(ids.length).toBe(9);
  expect(out.map((c) => c.id)).toEqual(ids);
  expect(out.every((c) => c.error === null && c.storageKey === c.id)).toBe(true);
  expect(urls).toHaveLength(ids.length); // ^GSPC, ETH-USD, BTC-USD and DTB3 are not fetched again
  expect(urls.some((u) => /chart\/(%5EGSPC|ETH-USD|BTC-USD)\?|fredgraph/.test(u))).toBe(false);
  for (const id of ids) {
    const rows = await sql`
      SELECT market_date::text AS date, value FROM source_value_versions
      WHERE source_key = ${id} AND acquisition_id IN (SELECT id FROM source_acquisitions WHERE requested_by_run_id = 77)
      ORDER BY market_date`;
    expect(rows.map((r) => ({ date: r.date, value: Number(r.value) }))).toEqual(mpExpected[id]!);
  }
  const acq = await sql`SELECT provider, cache_identity, requested_by_run_id FROM source_acquisitions WHERE requested_by_run_id = 77 ORDER BY provider, cache_identity`;
  expect(acq.map((r) => r.provider)).toEqual([...Array(7).fill("defillama-yields"), "yahoo", "yahoo"]);
  // The late Base inception is reported, not repaired.
  expect(warnings.some((w) => w.includes(`defillama-yields:${MP_BASE} starts 2024-03-10, after the requested start 2018-01-01`))).toBe(true);

  // A second collection of the same responses adds no version.
  const before = (await sql`SELECT count(*)::int AS n FROM source_value_versions`)[0]!.n;
  await liveDataSource.collectModelPortfolioInputs!({ log() {}, warn() {}, error() {} }, sink, 78);
  expect((await sql`SELECT count(*)::int AS n FROM source_value_versions`)[0]!.n).toBe(before);
});

test("issue 1398: one failed model portfolio series is reported by id and drops only that series", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  globalThis.fetch = ((input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes(MP_ETH)) return Promise.resolve(Response.json({ status: "success", data: [] }));
    const hit = mpBodies.find(([f]) => url.includes(f));
    return hit ? Promise.resolve(new Response(hit[1])) : Promise.reject(new Error(`unrecorded URL ${url}`));
  }) as typeof fetch;
  const { liveDataSource } = await import("../src/analytics/access/data-source.ts");
  const out = await liveDataSource.collectModelPortfolioInputs!({ log() {}, warn() {}, error() {} }, sink, 79);
  const eth = out.find((c) => c.id === `defillama-yields:${MP_ETH}`)!;
  expect(eth.error).toBe(`defillama-yields:${MP_ETH}: the provider returned no observations from 2018-01-01`);
  expect(eth.rows).toBe(0);
  expect(out.filter((c) => c.error === null).map((c) => c.id)).toEqual(MP_IDS.filter((id) => id !== `defillama-yields:${MP_ETH}`));
});

// ── Issue 1514: the committed heads come from the rows written and the priors read ──
// A first submission used to read every value's head a second time after its
// inserts (committedHeads), one more lateral lookup per value while the
// transaction held its batch connection and its source-key lock. The heads now
// come from the rows the insert returned and the priors the tolerance decision
// already read. They must equal what the ledger holds, for every kind of value.

/** Each value's head as the ledger holds it, read independently of the store. */
async function ledgerHeads(values: { sourceKey: string; marketDate: string | null; marketInstant: string | null }[]): Promise<{ versionId: string; value: number }[]> {
  const out: { versionId: string; value: number }[] = [];
  for (const v of values) {
    const [row] = v.marketDate !== null
      ? await sql`SELECT id::text AS id, value FROM source_value_versions WHERE source_key = ${v.sourceKey} AND market_date = ${v.marketDate}::date AND market_instant IS NULL ORDER BY knowledge_time DESC, id DESC LIMIT 1`
      : await sql`SELECT id::text AS id, value FROM source_value_versions WHERE source_key = ${v.sourceKey} AND market_instant = ${v.marketInstant}::timestamptz AND market_date IS NULL ORDER BY knowledge_time DESC, id DESC LIMIT 1`;
    out.push({ versionId: String(row!.id), value: Number(row!.value) });
  }
  return out;
}

/** `sql`, with every prior lookup (the store's LEFT JOIN LATERAL reads) inside its transactions counted. */
function countingPool(): { db: Pick<typeof sql, "begin">; lookups: () => number } {
  let lookups = 0;
  const isTemplate = (a: unknown): a is TemplateStringsArray => Array.isArray(a) && "raw" in (a as object);
  const db = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => sql.begin((tx) => fn(new Proxy(tx, {
      apply(target, thisArg, args) {
        if (isTemplate(args[0]) && args[0].join("?").includes("LEFT JOIN LATERAL")) lookups++;
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
    }))),
  } as unknown as Pick<typeof sql, "begin">;
  return { db, lookups: () => lookups };
}

function evidence(values: { sourceKey: string; marketDate?: string; marketInstant?: string; value: number }[]): Parameters<typeof saveSourceAcquisition>[0] {
  return {
    id: randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: `heads-${randomUUID()}`, requestedByRunId: null,
    events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }], fetches: [],
    values: values.map((v) => ({ sourceKey: v.sourceKey, marketDate: v.marketDate ?? null, marketInstant: v.marketInstant ?? null, value: v.value, provenance: "live" })),
  };
}

test("issue 1514: the committed heads equal the ledger's for every kind of value, and a submission reads each prior once", async () => {
  // The ledger before: one dated head, one timestamped head, one Yahoo head.
  await saveSourceAcquisition(evidence([
    { sourceKey: "heads:exact", marketDate: "2024-01-01", value: 10 },
    { sourceKey: "heads:exact", marketDate: "2024-01-02", value: 20 },
    { sourceKey: "heads:instant", marketInstant: "2024-01-01T12:00:00.000Z", value: 5 },
    { sourceKey: "research:RSP", marketDate: "2024-01-01", value: 18.719999313354492 },
    { sourceKey: "heads:dup", marketDate: "2024-01-01", value: 1 },
  ]));
  const before = (await sql`SELECT count(*)::int AS n FROM source_value_versions`)[0]!.n as number;

  const { db, lookups } = countingPool();
  const ev = evidence([
    { sourceKey: "heads:exact", marketDate: "2024-01-01", value: 10 }, // unchanged: the head is the prior
    { sourceKey: "heads:exact", marketDate: "2024-01-02", value: 21 }, // revision: the head is the new row
    { sourceKey: "heads:exact", marketDate: "2024-01-03", value: 30 }, // initial: the head is the new row
    { sourceKey: "heads:instant", marketInstant: "2024-01-01T12:00:00.000Z", value: 6 }, // a timestamped revision
    { sourceKey: "heads:instant", marketInstant: "2024-01-02T12:00:00.000Z", value: 7 }, // a timestamped initial
    { sourceKey: "research:RSP", marketDate: "2024-01-01", value: 18.72 }, // within D56 tolerance: the head keeps its stored value
  ]);
  const saved = await saveSourceAcquisition(ev, db);
  expect(saved.replayed).toBe(false);
  expect(saved.committed).toEqual(await ledgerHeads(ev.values));
  expect(saved.committed!.map((c) => c.value)).toEqual([10, 21, 30, 6, 7, 18.719999313354492]);
  expect((await sql`SELECT count(*)::int AS n FROM source_value_versions`)[0]!.n).toBe(before + 4);
  // One prior lookup per representation present (dated, timestamped), not two.
  expect(lookups()).toBe(2);

  // A dated-only acquisition reads its priors in one lookup.
  const datedOnly = countingPool();
  const dated = evidence([{ sourceKey: "heads:exact", marketDate: "2024-01-04", value: 40 }, { sourceKey: "heads:exact", marketDate: "2024-01-01", value: 11 }]);
  const datedSaved = await saveSourceAcquisition(dated, datedOnly.db);
  expect(datedSaved.committed).toEqual(await ledgerHeads(dated.values));
  expect(datedOnly.lookups()).toBe(1);

  // A replay reads the heads it never wrote, once, and answers the same heads.
  const replay = countingPool();
  const replayed = await saveSourceAcquisition(ev, replay.db);
  expect(replayed.replayed).toBe(true);
  expect(replayed.committed).toEqual(await ledgerHeads(ev.values));
  expect(replay.lookups()).toBe(2);

  // Within-batch duplicates (the per-value path): the first revises the head, the
  // second re-observes it, and both answer the row the first wrote.
  const dup = countingPool();
  const dupEv = evidence([
    { sourceKey: "heads:dup", marketDate: "2024-01-01", value: 2 },
    { sourceKey: "heads:dup", marketDate: "2024-01-01", value: 2 },
    { sourceKey: "heads:dup", marketDate: "2024-01-02", value: 3 },
  ]);
  const dupSaved = await saveSourceAcquisition(dupEv, dup.db);
  const heads = await ledgerHeads(dupEv.values);
  expect(dupSaved.committed).toEqual(heads);
  expect(dupSaved.committed!.map((c) => c.value)).toEqual([2, 2, 3]);
  // One prior lookup per value on this path, as before; never a second pass.
  expect(dup.lookups()).toBe(3);
});
