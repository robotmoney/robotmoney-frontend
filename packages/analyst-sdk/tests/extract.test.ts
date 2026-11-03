// Extractors run against an injected fake fetch with no ledger hook: the SDK
// preload makes globalThis.fetch a thrower, so a request that bypasses the
// seam fails loudly. Issue #1095 part B.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { configureHttp, fetchJson, fetchText, type FetchRecord } from "../src/extract/http.ts";
import { fetchFred, parseFredCsv } from "../src/extract/fred.ts";
import { fetchYahoo } from "../src/extract/yahoo.ts";
import { fetchEdgarMonthCount } from "../src/extract/edgar.ts";
import { createFetchMemo, fetchAll, fetchOne, mergeRatioSeries, mergeYahooPlans, registryRecordedLegs, registryYahooPlan, type AcquisitionMeta } from "../src/extract/sources.ts";
import { RATIO_LEG_MAPPING, ratioLegStorageKey } from "../src/series-ids.ts";
import { CalculatedRowError, parseInput } from "../src/input/load.ts";
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

// FRED's HTTP 200 maintenance page (issue #1413): the old parser read its
// `<link ...Open+Sans:300,400,700>` line as a point dated `<link href=...`.
const maintenanceBody = await Bun.file(join(FIX, "fred-maintenance.html")).text();

test("parseFredCsv throws on FRED's HTML maintenance page, naming the series, and returns no point", () => {
  let points: unknown = "unset";
  expect(() => { points = parseFredCsv(maintenanceBody, "UMCSENT"); }).toThrow("FRED UMCSENT: response is not CSV");
  expect(points).toBe("unset");
});

test("fetchFred rejects the maintenance page so the acquisition fails instead of returning bad points", async () => {
  configureHttp({ fetch: (async () => new Response(maintenanceBody, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch });
  await expect(fetchFred("BOGZ1FL663067003Q")).rejects.toThrow("FRED BOGZ1FL663067003Q: response is not CSV");
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

// ── Issue 1514: one request per (provider, symbol) per run ──────────────────
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
/** A Yahoo chart over a few fixed days, from max(period1, the first day); each answer differs by its request count. */
function countingYahoo(counts: Map<string, number>) {
  const DAYS = ["2009-12-30", "2009-12-31", "2010-01-04", "2015-12-31", "2016-01-04", "2024-01-02"];
  return (async (input: string) => {
    const url = String(input);
    if (url.includes("api.llama.fi")) { counts.set("tvl", (counts.get("tvl") ?? 0) + 1); return Response.json([{ date: day("2024-01-02"), tvl: 3 + counts.get("tvl")! }]); }
    if (url.includes("stablecoins.llama.fi")) { counts.set("stables", (counts.get("stables") ?? 0) + 1); return Response.json([{ date: day("2024-01-02"), totalCirculatingUSD: { peggedUSD: 4 } }]); }
    const sym = decodeURIComponent(url.match(/\/chart\/([^?]+)\?/)![1]!);
    const n = (counts.get(sym) ?? 0) + 1;
    counts.set(sym, n);
    const p1 = Number(url.match(/period1=(\d+)/)![1]);
    const ts = DAYS.map(day).filter((t) => t >= p1);
    return Response.json({ chart: { result: [{ timestamp: ts, indicators: { adjclose: [{ adjclose: ts.map((t, i) => 100 + i + n / 1000) }] } }] } });
  }) as unknown as typeof fetch;
}

test("issue 1514: a fetch memo requests each Yahoo symbol once from the plan's widest start and cuts each consumer at its own start", async () => {
  const counts = new Map<string, number>();
  const urls: string[] = [];
  const fake = countingYahoo(counts);
  configureHttp({ fetch: (async (u: string) => { urls.push(String(u)); return fake(u); }) as unknown as typeof fetch });
  const memo = createFetchMemo({ "ETH-USD": 0, SPY: day("2010-01-01") });
  const later = await memo.yahoo("ETH-USD", day("2016-01-01"));
  const mid = await memo.yahoo("ETH-USD", day("2010-01-01"));
  const all = await memo.yahoo("ETH-USD", 0);
  expect(counts.get("ETH-USD")).toBe(1);
  expect(urls[0]).toContain("period1=0&");
  expect(all.map((p) => p.date)).toEqual(["2009-12-30", "2009-12-31", "2010-01-04", "2015-12-31", "2016-01-04", "2024-01-02"]);
  expect(mid).toEqual(all.slice(2));
  expect(later).toEqual(all.slice(4));
  // The same request's values on every shared date.
  expect(later[0]!.value).toBe(all[4]!.value);
  // A consumer's result is its own array: changing it changes no other.
  later.pop();
  expect((await memo.yahoo("ETH-USD", day("2016-01-01"))).length).toBe(2);
  // Without a plan entry a symbol is fetched from the first start asked for.
  await memo.yahoo("SPY", day("2016-01-01"));
  expect(urls.at(-1)).toContain(`period1=${day("2010-01-01")}&`);
  expect(counts.get("SPY")).toBe(1);
});

test("issue 1514: DefiLlama endpoints are requested once per memo, and a failed request fails every consumer", async () => {
  const counts = new Map<string, number>();
  configureHttp({ fetch: countingYahoo(counts) });
  const memo = createFetchMemo();
  const tvl = INDICATORS.filter((i) => i.source === "defillama_tvl");
  expect(tvl.length).toBeGreaterThan(0);
  const [a, b] = await Promise.all([memo.defillamaTvl(), memo.defillamaTvl(), memo.defillamaStables(), memo.defillamaStables()]);
  expect(a).toEqual(b!);
  expect(counts.get("tvl")).toBe(1);
  expect(counts.get("stables")).toBe(1);

  configureHttp({ fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
  const failing = createFetchMemo();
  await expect(failing.yahoo("ETH-USD", 0)).rejects.toThrow();
  await expect(failing.yahoo("ETH-USD", day("2010-01-01"))).rejects.toThrow();
});

test("issue 1514: fetchAll with a memo requests each Yahoo symbol and DefiLlama endpoint once", async () => {
  const counts = new Map<string, number>();
  const fake = countingYahoo(counts);
  configureHttp({ fetch: (async (u: string) => (String(u).includes("finance.yahoo") || String(u).includes("llama.fi") ? fake(u) : fred())) as unknown as typeof fetch });
  const inds = INDICATORS.filter((i) => i.source === "yahoo" || i.source.startsWith("defillama"));
  const out = await fetchAll({ indicators: inds, logger: {}, memo: createFetchMemo(registryYahooPlan(inds)) });
  for (const [k, n] of counts) expect({ k, n }).toEqual({ k, n: 1 });
  expect(counts.has("SPY") && counts.has("ETH-USD") && counts.has("tvl")).toBe(true);
  // ETH_TREND and the ETH-USD leg of BTC_ETH read the same values.
  const eth = new Map(out.ETH_TREND!.map((p) => [p.date, p.value]));
  for (const p of out.BTC_ETH!) expect(eth.has(p.date)).toBe(true);
  expect(mergeYahooPlans({ A: 5, B: 0 }, { A: 2, C: 7 })).toEqual({ A: 2, B: 0, C: 7 });
});

// ── Issue 1514: the ratio legs ──────────────────────────────────────────────
test("issue 1514: one live fetch records both legs of every Yahoo ratio, and each stored ratio is mergeRatioSeries of those legs byte for byte", async () => {
  const counts = new Map<string, number>();
  configureHttp({ fetch: countingYahoo(counts) });
  const ratios = INDICATORS.filter((i) => i.source === "yahoo" && Array.isArray(i.series));
  expect(ratios.map((i) => i.id).sort()).toEqual(["BTC_ETH", "COPPER_GOLD", "IWF_IWD", "IWM_SPY", "MTUM_SPY", "SPHB_SPLV", "XLP_XLY", "XLU_SPY"]);
  const memo = createFetchMemo(registryYahooPlan(ratios));
  const recorded = new Map<string, { meta: AcquisitionMeta; points: { date: string; value: number }[] }>();
  const out = await fetchAll({
    indicators: ratios, logger: {}, memo, requestedByRunId: 9,
    acquire: async (meta, op) => { const points = await op(); recorded.set(meta.sourceKey, { meta, points }); return points; },
  });
  const own = registryRecordedLegs(ratios);
  for (const ind of ratios) {
    const [n, d] = (ind.series as [string, string]).map((sym) => `yahoo:${sym}`) as [string, string];
    // Each leg is recorded under its mapped key: by this fetch for its own-id
    // legs; the others (research:SPY, backtest:ETH-USD, ...) by their own
    // collector from the same request, which the memo serves without a new one.
    const legPoints = async (id: string) => {
      const key = ratioLegStorageKey(id);
      if (own.has(id)) {
        expect(recorded.get(key)!.meta).toMatchObject({ provider: "yahoo", sourceKey: key, parserVersion: "yahoo:1", requestedByRunId: 9 });
        return recorded.get(key)!.points;
      }
      expect(recorded.has(key)).toBe(false);
      return memo.yahoo(id.slice(6), 0);
    };
    const ratio = JSON.stringify(mergeRatioSeries(await legPoints(n), await legPoints(d)));
    expect({ id: ind.id, ratio: JSON.stringify(recorded.get(`raw_indicator_history:${ind.id}`)!.points) }).toEqual({ id: ind.id, ratio });
    expect(JSON.stringify(out[ind.id])).toBe(ratio);
  }
  expect([...own].sort()).toEqual(["yahoo:IWD", "yahoo:IWF", "yahoo:IWM", "yahoo:MTUM", "yahoo:SPHB", "yahoo:SPLV", "yahoo:XLP", "yahoo:XLU", "yahoo:XLY"]);
  for (const [sym, n] of counts) expect({ sym, n }).toEqual({ sym, n: 1 });
  // Every leg has one storage key, the same for every ratio that reads it.
  expect(RATIO_LEG_MAPPING.filter((m) => m.series === "yahoo:SPY").map((m) => m.storageKey)).toEqual(["research:SPY", "research:SPY", "research:SPY"]);
  expect(ratioLegStorageKey("yahoo:HG=F")).toBe("yahoo:HG=F");
  expect(ratioLegStorageKey("yahoo:ETH-USD")).toBe("backtest:ETH-USD");
});

test("issue 1514: a source input naming the legs yahoo:HG=F and yahoo:GC=F loads, and a source row keyed COPPER_GOLD is still a calculated row", () => {
  const parsed = parseInput("date,series,value\n2024-01-02,yahoo:HG=F,3.9\n2024-01-02,yahoo:GC=F,2050.5\n");
  expect(parsed.history["yahoo:HG=F"]).toEqual([{ date: "2024-01-02", value: 3.9 }]);
  expect(parsed.history["yahoo:GC=F"]).toEqual([{ date: "2024-01-02", value: 2050.5 }]);
  expect(() => parseInput("date,series,value\n2024-01-02,COPPER_GOLD,0.0019\n")).toThrow(CalculatedRowError);
});
