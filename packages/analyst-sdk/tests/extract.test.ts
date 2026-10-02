// Extractors run against an injected fake fetch with no ledger hook: the SDK
// preload makes globalThis.fetch a thrower, so a request that bypasses the
// seam fails loudly. Issue #1095 part B.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { configureHttp, fetchJson, fetchText, type FetchRecord } from "../src/extract/http.ts";
import { fetchFred } from "../src/extract/fred.ts";
import { fetchYahoo } from "../src/extract/yahoo.ts";
import { fetchEdgarMonthCount } from "../src/extract/edgar.ts";
import { fetchAll, fetchOne } from "../src/extract/sources.ts";
import { INDICATORS } from "../src/analyze/indicators.ts";

afterEach(() => { configureHttp({}); });

const fred = () => new Response("DATE,VALUE\n2024-01-01,1.25\n2024-01-02,.\n2024-01-03,1.5\n", { headers: { etag: "r1" } });

// REAL response bodies, captured once from the live endpoints (see
// fixtures/extract/): FRED's fredgraph.csv for T10Y2Y (note its current header
// is `observation_date`, and the last row is an empty value) and Yahoo's v8
// chart JSON for ^VIX (the last bar has a null close). expected-points.json is
// what the extractors must return for them, computed independently of the
// parsers (a python script over the raw bodies) and committed.
const FIX = join(import.meta.dir, "fixtures/extract");
const fredBody = await Bun.file(join(FIX, "fred-T10Y2Y.csv")).text();
const yahooBody = await Bun.file(join(FIX, "yahoo-VIX.json")).text();
const expected = (await Bun.file(join(FIX, "expected-points.json")).json()) as {
  fred: { series: string; points: { date: string; value: number }[] };
  yahoo: { symbol: string; points: { date: string; value: number }[] };
};

test("fetchFred and fetchYahoo turn real recorded response bodies into the committed expected points, through configureHttp({fetch})", async () => {
  const urls: string[] = [];
  configureHttp({
    fetch: (async (input: string) => {
      urls.push(String(input));
      return String(input).includes("fredgraph")
        ? new Response(fredBody, { headers: { "content-type": "text/csv" } })
        : new Response(yahooBody, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  const fredPoints = await fetchFred(expected.fred.series);
  const yahooPoints = await fetchYahoo(expected.yahoo.symbol);
  expect(fredPoints).toEqual(expected.fred.points);
  expect(yahooPoints).toEqual(expected.yahoo.points);
  // The fixtures exercise the edge cases the parsers exist for.
  expect(fredBody.trimEnd().split("\n").length - 1).toBe(expected.fred.points.length + 1); // one empty-value row dropped
  expect(JSON.parse(yahooBody).chart.result[0].timestamp.length).toBe(expected.yahoo.points.length + 1); // one null bar dropped
  expect(expected.fred.points.length).toBeGreaterThan(15);
  expect(urls).toHaveLength(2);
  expect(urls[0]).toContain("fredgraph.csv?id=T10Y2Y");
  expect(urls[1]).toContain("/v8/finance/chart/%5EVIX");
});

test("with no fetch injected the extractors fall through to globalThis.fetch (here the preload thrower)", async () => {
  await expect(fetchText("https://example.test/x")).rejects.toThrow(/must not use the network/);
});

test("the cache and recordFetch hooks wrap each GET; absent hooks change nothing", async () => {
  const records: FetchRecord[] = [];
  const kinds: string[] = [];
  configureHttp({
    fetch: (async () => Response.json({ ok: 1 }, { headers: { etag: "e1" } })) as unknown as typeof fetch,
    cache: async (kind, _url, load, opts) => { kinds.push(kind); opts.onStatus("miss"); return load(); },
    recordFetch: (r) => records.push(r),
  });
  expect(await fetchJson("https://example.test/a")).toEqual({ ok: 1 });
  expect(kinds).toEqual(["json"]);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ url: "https://example.test/a", cacheStatus: "miss", responseStatus: 200, providerReleaseId: "e1" });
});

test("a failed GET is recorded once and rethrown", async () => {
  const records: FetchRecord[] = [];
  configureHttp({ fetch: (async () => new Response("no", { status: 503, statusText: "Unavailable" })) as unknown as typeof fetch, recordFetch: (r) => records.push(r) });
  await expect(fetchJson("https://example.test/b")).rejects.toThrow(/503/);
  expect(records).toHaveLength(1);
  expect(records[0]!.responseStatus).toBe(503);
});

test("fetchEdgarMonthCount goes through the injected fetch and the record hook", async () => {
  const records: FetchRecord[] = [];
  configureHttp({ fetch: (async () => Response.json({ hits: { total: { value: 7 } } })) as unknown as typeof fetch, recordFetch: (r) => records.push(r) });
  expect(await fetchEdgarMonthCount("2024-01-01", "2024-01-31", 1000, { warn() {} })).toBe(7);
  expect(records).toHaveLength(1);
  expect(records[0]!.cacheStatus).toBe("disabled");
});

test("fetchOne needs a host adapter for geckoterminal_newpools; fetchAll degrades to []", async () => {
  const ind = INDICATORS.find((i) => i.source === "geckoterminal_newpools")!;
  await expect(fetchOne(ind)).rejects.toThrow(/host-supplied adapter/);
  const out = await fetchAll({ indicators: [ind], logger: { log() {}, error() {}, warn() {} } });
  expect(out[ind.id]).toEqual([]);
  expect(await fetchOne(ind, console, { geckoterminal_newpools: async () => [{ date: "2024-01-01", value: 3 }] })).toEqual([{ date: "2024-01-01", value: 3 }]);
});

test("fetchAll calls the acquire hook once per indicator with the ledger metadata", async () => {
  configureHttp({ fetch: (async () => fred()) as unknown as typeof fetch });
  const ind = INDICATORS.find((i) => i.source === "fred")!;
  const seen: string[] = [];
  const out = await fetchAll({
    indicators: [ind], requestedByRunId: 9, logger: { log() {}, error() {}, warn() {} },
    acquire: (meta, op) => { seen.push(`${meta.provider}|${meta.sourceKey}|${meta.requestedByRunId}`); return op(); },
  });
  expect(seen).toEqual([`fred|raw_indicator_history:${ind.id}|9`]);
  expect(out[ind.id]!.length).toBe(2);
});
