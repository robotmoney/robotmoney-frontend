// Extract stage (pure, no network): feed canned upstream JSON/CSV/HTML to each
// source parser and assert it yields the right Point[] — and throws on garbage.
// THIS is the CI-gating extract coverage; the live drift test (fetchers-live)
// runs separately where network exists.
import { afterEach, test, expect } from "bun:test";
import { parseLlamaTvl, parseLlamaStables } from "../src/analytics/extract/defillama.ts";
import { parseYahoo } from "../src/analytics/extract/yahoo.ts";
import { parseFredCsv } from "../src/analytics/extract/fred.ts";
import { parseBlockchainChart } from "../src/analytics/extract/blockchain-com.ts";
import { parseCoinmetricsPage } from "../src/analytics/extract/coinmetrics.ts";
import { countNewPools24h, parseNewPoolsPage } from "../src/analytics/extract/geckoterminal.ts";
import { parseDatahubCsv, parseMultplHtml, mergeShiller } from "../src/analytics/extract/shiller.ts";
import { parseEdgarCount, enumerateMonths } from "../src/analytics/extract/edgar.ts";
import { mergeRatioSeries } from "../src/analytics/extract/sources.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { liveDataSource, liveYahooPlan } from "../src/analytics/access/data-source.ts";
import type { AcquisitionSink, SourceAcquisitionEvidence } from "../src/analytics/source-ledger.ts";
import { TOP7 } from "../src/analytics/analyze/research-signals.ts";

const TS = 1700000000; // seconds → 2023-11-14T22:13:20Z
const DAY = "2023-11-14";

test("parseLlamaTvl: rows → Point[], throws on non-array", () => {
  const pts = parseLlamaTvl([{ date: TS, tvl: 5e9 }]);
  expect(pts).toEqual([{ date: DAY, value: 5e9 }]);
  expect(() => parseLlamaTvl({} as unknown)).toThrow();
  expect(() => parseLlamaTvl(null as unknown)).toThrow();
});

test("parseLlamaStables: peggedUSD (with fallback key), throws on non-array", () => {
  const a = parseLlamaStables([{ date: TS, totalCirculatingUSD: { peggedUSD: 1.3e11 } }]);
  expect(a).toEqual([{ date: DAY, value: 1.3e11 }]);
  const b = parseLlamaStables([{ date: TS, totalCirculating: { peggedUSD: 9e10 } }]);
  expect(b).toEqual([{ date: DAY, value: 9e10 }]);
  expect(() => parseLlamaStables("nope" as unknown)).toThrow();
});

test("parseYahoo: timestamp/close → Point[], skips null closes, throws on missing", () => {
  const j = {
    chart: { result: [{ timestamp: [TS, TS + 86400], indicators: { quote: [{ close: [450.5, null] }] } }] },
  };
  expect(parseYahoo(j)).toEqual([{ date: DAY, value: 450.5 }]); // second point dropped (null close)
  expect(() => parseYahoo({} as unknown)).toThrow();
  expect(() => parseYahoo({ chart: { result: [{ timestamp: [TS] }] } } as unknown)).toThrow();
});

test("parseYahoo: prefers adjclose over close, falls back to close when NaN", () => {
  const j = {
    chart: {
      result: [
        {
          timestamp: [TS, TS + 86400],
          indicators: {
            adjclose: [{ adjclose: [448.1, null] }],
            quote: [{ close: [450.5, 451.2] }],
          },
        },
      ],
    },
  };
  // day1 uses adjclose (448.1); day2 adjclose null ⇒ falls back to close (451.2)
  expect(parseYahoo(j)).toEqual([
    { date: DAY, value: 448.1 },
    { date: "2023-11-15", value: 451.2 },
  ]);
});

test("parseFredCsv: DATE,VALUE rows; '.' (missing) dropped; header skipped", () => {
  const csv = "DATE,T10Y2Y\n2018-01-02,0.55\n2018-01-03,.\n2018-01-04,0.60\n";
  expect(parseFredCsv(csv, "T10Y2Y")).toEqual([
    { date: "2018-01-02", value: 0.55 },
    { date: "2018-01-04", value: 0.6 },
  ]);
  expect(parseFredCsv("DATE,X\n", "X")).toEqual([]); // header only
  expect(parseFredCsv("", "X")).toEqual([]);
});

test("parseFredCsv drops a row whose date is not YYYY-MM-DD even when its value is numeric (issue #1413)", () => {
  const csv = [
    "observation_date,UMCSENT",
    "2024-01-01,69.7",
    '<link href="https://fonts.googleapis.com/css?family=Open+Sans:300,400,700" rel="stylesheet">',
    "2024/02/01,76.9",
    "2024-3-01,79.4",
    "2024-04-01,77.2",
  ].join("\n");
  expect(parseFredCsv(csv, "UMCSENT")).toEqual([
    { date: "2024-01-01", value: 69.7 },
    { date: "2024-04-01", value: 77.2 },
  ]);
});

test("parseBlockchainChart: values[{x,y}] → Point[], drops non-finite, throws on garbage", () => {
  const j = { values: [{ x: TS, y: 452506 }, { x: TS + 86400, y: null }] };
  expect(parseBlockchainChart(j)).toEqual([{ date: DAY, value: 452506 }]);
  expect(() => parseBlockchainChart({} as unknown)).toThrow();
  expect(() => parseBlockchainChart({ values: "nope" } as unknown)).toThrow();
});

test("parseCoinmetricsPage: data[] → points + next token; drops non-finite; throws on garbage", () => {
  const j = {
    data: [
      { time: "2018-01-01T00:00:00.000000000Z", AdrActCnt: "881970" },
      { time: "2018-01-02T00:00:00.000000000Z", AdrActCnt: "NaN" },
    ],
    next_page_token: "abc123",
  };
  const r = parseCoinmetricsPage(j, "AdrActCnt");
  expect(r.points).toEqual([{ date: "2018-01-01", value: 881970 }]);
  expect(r.nextToken).toBe("abc123");
  expect(parseCoinmetricsPage({ data: [] }, "AdrActCnt").nextToken).toBe(null);
  expect(() => parseCoinmetricsPage({} as unknown, "AdrActCnt")).toThrow();
});

test("geckoterminal countNewPools24h: counts within window, stops at first stale entry", () => {
  const now = Date.parse("2026-06-27T12:00:00Z");
  const mk = (hoursAgo: number) => ({ attributes: { pool_created_at: new Date(now - hoursAgo * 3600_000).toISOString() } });
  const entries = [mk(1), mk(5), { attributes: {} }, mk(23), mk(30), mk(2)];
  // mk(1),mk(5) counted; {} skipped (not a stop); mk(23) counted; mk(30) is stale ⇒ stop
  const r = countNewPools24h(entries, now);
  expect(r).toEqual({ count: 3, stopped: true });
  // all within window ⇒ not stopped (pagination-truncatable)
  expect(countNewPools24h([mk(1), mk(2)], now)).toEqual({ count: 2, stopped: false });
  expect(() => parseNewPoolsPage({} as unknown)).toThrow();
  expect(parseNewPoolsPage({ data: [mk(1)] }).length).toBe(1);
});

test("parseDatahubCsv: finds PE10 col, YYYY-MM → -01, drops <=0, sorts; throws on empty/no-cols", () => {
  const csv = "Date,SP500,PE10\n2023-08,4400,31.2\n2023-09,4300,0\n2023-07,4500,30.5\n";
  expect(parseDatahubCsv(csv)).toEqual([
    { date: "2023-07-01", value: 30.5 },
    { date: "2023-08-01", value: 31.2 },
  ]);
  expect(() => parseDatahubCsv("Date,SP500\n2023-08,4400\n")).toThrow(); // no PE10 column
  expect(() => parseDatahubCsv("Date,PE10\n")).toThrow(); // 0 rows
});

test("parseMultplHtml: extracts month rows, dedups, drops <=0; throws when nothing parses", () => {
  const html =
    '<table><tr><td><a href="/x">Aug 1, 2023</a></td><td>31.20</td></tr>' +
    "<tr><td>Jul 1, 2023</td><td>30.50</td></tr>" +
    "<tr><td>Jun 1, 2023</td><td>0</td></tr></table>";
  expect(parseMultplHtml(html)).toEqual([
    { date: "2023-07-01", value: 30.5 },
    { date: "2023-08-01", value: 31.2 },
  ]);
  expect(() => parseMultplHtml("<table></table>")).toThrow();
});

test("parseMultplHtml: handles the CURRENT multpl.com markup (&#x2002; entity + newlines)", () => {
  // Real 2026 layout: value cell wraps the number in an EN-SPACE HTML entity.
  // The original `\s*` regex could not match this, silently breaking the scrape.
  const html =
    '<table id="datatable"><tr><th>Date</th><th>Value</th></tr>' +
    "<tr class=\"odd\">\n<td>Jun 30, 2026</td>\n<td>\n&#x2002;\n41.72\n</td>\n</tr>" +
    "<tr class=\"even\">\n<td>May 1, 2026</td>\n<td>\n&#x2002;\n41.10\n</td>\n</tr></table>";
  expect(parseMultplHtml(html)).toEqual([
    { date: "2026-05-01", value: 41.1 },
    { date: "2026-06-30", value: 41.72 },
  ]);
});

test("mergeShiller: multpl wins on overlap, datahub backfills older; sorted", () => {
  const multpl = [{ date: "2023-08-01", value: 31.2 }];
  const datahub = [
    { date: "2023-07-01", value: 30.5 },
    { date: "2023-08-01", value: 30.9 }, // loses to multpl
  ];
  expect(mergeShiller(multpl, datahub)).toEqual([
    { date: "2023-07-01", value: 30.5 },
    { date: "2023-08-01", value: 31.2 },
  ]);
});

test("parseEdgarCount: reads hits.total.value; null when absent/non-finite", () => {
  expect(parseEdgarCount({ hits: { total: { value: 42 } } })).toBe(42);
  expect(parseEdgarCount({ hits: { total: {} } })).toBe(null);
  expect(parseEdgarCount({} as unknown)).toBe(null);
});

test("enumerateMonths: month-start/month-end pairs across a range", () => {
  const months = enumerateMonths("2023-11-15", "2024-01-10");
  expect(months).toEqual([
    { monthStart: "2023-11-01", monthEnd: "2023-11-30" },
    { monthStart: "2023-12-01", monthEnd: "2023-12-31" },
    { monthStart: "2024-01-01", monthEnd: "2024-01-31" },
  ]);
});

// #127: blockchain.com removed its `mvrv` chart (the endpoint 404s), so BTC_MVRV
// was repointed to Coinmetrics community (btc / CapMVRVCur). This registry-wiring
// assertion is the deterministic per-PR guard that analytics.run can never again
// route an indicator to the known-dead chart: the only blockchain_com series left
// is n-unique-addresses (verified live), and the MVRV leg resolves through the
// coinmetrics extractor whose parser is exercised on a real-shape page below.
test("BTC_MVRV is wired to Coinmetrics; no indicator references the dead blockchain.com mvrv chart", () => {
  const mvrv = INDICATORS.find((i) => i.id === "BTC_MVRV");
  expect(mvrv).toBeDefined();
  expect(mvrv!.source).toBe("coinmetrics");
  expect(mvrv!.series).toEqual({ asset: "btc", metric: "CapMVRVCur" });
  // The dead chart must not be reachable from ANY registry entry.
  for (const ind of INDICATORS) {
    if (ind.source !== "blockchain_com") continue;
    expect(ind.series, `${ind.id}: blockchain.com only serves n-unique-addresses now`).toBe(
      "n-unique-addresses",
    );
  }
  // Real-shape CapMVRVCur page (captured 2026-07-15) parses to the ratio series
  // the regime classifier expects (unit ratio2, level transform).
  const page = {
    data: [
      { asset: "btc", time: "2026-07-12T00:00:00.000000000Z", CapMVRVCur: "1.202836" },
      { asset: "btc", time: "2026-07-13T00:00:00.000000000Z", CapMVRVCur: "1.174318" },
    ],
  };
  const { points, nextToken } = parseCoinmetricsPage(page, "CapMVRVCur");
  expect(points).toEqual([
    { date: "2026-07-12", value: 1.202836 },
    { date: "2026-07-13", value: 1.174318 },
  ]);
  expect(nextToken).toBe(null);
});

test("mergeRatioSeries: a/b on shared dates, skips 0/missing denominators", () => {
  const a = [
    { date: "2024-01-01", value: 10 },
    { date: "2024-01-02", value: 20 },
    { date: "2024-01-03", value: 30 },
  ];
  const b = [
    { date: "2024-01-01", value: 2 },
    { date: "2024-01-02", value: 0 }, // skipped (0 denom)
    { date: "2024-01-04", value: 5 }, // no matching a date
  ];
  expect(mergeRatioSeries(a, b)).toEqual([{ date: "2024-01-01", value: 5 }]);
});

// ── Issue 1514: one live run requests each symbol once ──────────────────────
// The live source's collectors, through liveDataSource.forRun, against
// counting fakes. Each fake answer carries its request number, so two
// requests for one symbol would give two consumers different values.

const realFetch = globalThis.fetch;
const realTtl = process.env.HTTP_FETCH_CACHE_TTL_MS;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realTtl === undefined) delete process.env.HTTP_FETCH_CACHE_TTL_MS;
  else process.env.HTTP_FETCH_CACHE_TTL_MS = realTtl;
});

const unixOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const FAKE_DAYS = ["2009-12-30", "2009-12-31", "2010-01-04", "2015-12-31", "2016-01-04", "2024-01-02", "2024-01-03"].map(unixOf);

/** Counting fakes for every provider a live run reaches. `failing` answers 500 for that Yahoo symbol. */
function countingProviders(counts: Map<string, number>, failing?: string): typeof fetch {
  const bump = (k: string) => { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n; };
  return ((input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("query2.finance.yahoo.com")) {
      const sym = decodeURIComponent(url.match(/\/chart\/([^?]+)\?/)![1]!);
      const n = bump(`yahoo:${sym}`);
      if (sym === failing) return Promise.resolve(new Response("down", { status: 500 }));
      const p1 = Number(url.match(/period1=(\d+)/)![1]);
      const ts = FAKE_DAYS.filter((t) => t >= p1);
      const base = [...sym].reduce((a, c) => a + c.charCodeAt(0), 0);
      return Promise.resolve(Response.json({ chart: { result: [{ timestamp: ts, indicators: { adjclose: [{ adjclose: ts.map((t, i) => base + i + n / 1000) }] } }] } }));
    }
    if (url.includes("historicalChainTvl")) { bump("defillama:tvl"); return Promise.resolve(Response.json([{ date: unixOf("2024-01-02"), tvl: 3 }])); }
    if (url.includes("stablecoincharts")) { bump("defillama:stables"); return Promise.resolve(Response.json([{ date: unixOf("2024-01-02"), totalCirculatingUSD: { peggedUSD: 4 } }])); }
    if (url.includes("yields.llama.fi")) { bump(`defillama:${url}`); return Promise.resolve(Response.json({ status: "success", data: [{ timestamp: "2024-01-02T23:01:00.000Z", apyBase: 4 }] })); }
    if (url.includes("fredgraph.csv")) return Promise.resolve(new Response("DATE,VALUE\n2024-01-01,1.25\n"));
    if (url.includes("api.blockchain.info")) return Promise.resolve(Response.json({ values: [{ x: unixOf("2024-01-01"), y: 5 }] }));
    if (url.includes("community-api.coinmetrics.io")) return Promise.resolve(Response.json({ data: [{ time: "2024-01-01", AdrActCnt: "6", CapMVRVCur: "6" }] }));
    if (url.includes("api.geckoterminal.com")) return Promise.resolve(Response.json({ data: [{ attributes: { pool_created_at: "2000-01-01T00:00:00Z" } }] }));
    if (url.includes("multpl.com")) return Promise.resolve(new Response("<tr><td>January 1, 2024</td><td>30.5</td></tr>"));
    if (url.includes("raw.githubusercontent.com")) return Promise.resolve(new Response("Date,PE10\n2023-12,29.5\n"));
    return Promise.reject(new Error(`unrecorded URL ${url}`));
  }) as typeof fetch;
}

/** An in-memory sink: every value is committed as collected. */
function memorySink(saved: SourceAcquisitionEvidence[]): AcquisitionSink {
  return {
    async saveSourceAcquisition(e) {
      saved.push(e);
      return { acquisitionId: e.id, replayed: false, committed: e.values.map((v, i) => ({ versionId: `${e.id}:${i}`, value: v.value })) };
    },
  };
}

const quiet = { log() {}, warn() {}, error() {} };
/** One whole-suite live run's collectors: the registry, the extras, the inventory and the research inputs. */
async function liveRun(source: typeof liveDataSource, sink: AcquisitionSink) {
  const registry = await source.fetchIndicators(INDICATORS, quiet, sink, 1);
  const extras = await source.fetchBacktestExtras(quiet, sink, 1);
  await source.collectModelPortfolioInputs!(quiet, sink, 1);
  const research = await source.fetchResearchInputs("2024-01-03", quiet, { persistedMna: [], deadlineAt: Date.now() - 1 }, sink, 1);
  return { registry, extras, research };
}
/** Per storage key: its acquisition metadata and its values by date. */
function byKey(saved: SourceAcquisitionEvidence[]) {
  const out = new Map<string, { meta: string; values: Map<string, number> }>();
  for (const e of saved) {
    for (const v of e.values) {
      const k = out.get(v.sourceKey) ?? { meta: `${e.provider}|${e.parserVersion}|${e.cacheIdentity}`, values: new Map() };
      k.values.set(v.marketDate!, v.value);
      out.set(v.sourceKey, k);
    }
  }
  return out;
}

test("issue 1514: one live run requests each Yahoo symbol and each DefiLlama endpoint exactly once", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  const counts = new Map<string, number>();
  globalThis.fetch = countingProviders(counts);
  await liveRun(liveDataSource.forRun!({ regime: true, research: true }), memorySink([]));
  const yahoo = [...counts].filter(([k]) => k.startsWith("yahoo:"));
  // Every planned symbol was requested, each once.
  expect(yahoo.map(([k]) => k.slice(6)).sort()).toEqual(Object.keys(liveYahooPlan({ regime: true, research: true })).sort());
  for (const [k, n] of counts) expect({ k, n }).toEqual({ k, n: 1 });
  for (const sym of ["SPY", "ETH-USD", "BTC-USD", "^GSPC", ...TOP7]) expect(counts.get(`yahoo:${sym}`)).toBe(1);
  expect(counts.get("defillama:tvl")).toBe(1);
  expect(counts.get("defillama:stables")).toBe(1);
  // Without the run's memo the same collectors request ETH-USD three times and SPY four (the defect).
  const before = new Map<string, number>();
  globalThis.fetch = countingProviders(before);
  await liveRun(liveDataSource, memorySink([]));
  expect(before.get("yahoo:ETH-USD")).toBe(3);
  expect(before.get("yahoo:SPY")).toBe(4);
});

test("issue 1514: SPX_TREND and backtest:^GSPC, and ETH_TREND, backtest:ETH-USD and BTC_ETH's ETH leg, hold the same values on every shared date", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  globalThis.fetch = countingProviders(new Map());
  const saved: SourceAcquisitionEvidence[] = [];
  const { registry, extras, research } = await liveRun(liveDataSource.forRun!({ regime: true, research: true }), memorySink(saved));
  const same = (a: { date: string; value: number }[], b: { date: string; value: number }[]) => {
    const m = new Map(b.map((p) => [p.date, p.value]));
    const shared = a.filter((p) => m.has(p.date));
    expect(shared.length).toBeGreaterThan(2);
    for (const p of shared) expect({ date: p.date, value: p.value }).toEqual({ date: p.date, value: m.get(p.date)! });
  };
  same(registry.SPX_TREND!, extras.spx);
  same(registry.ETH_TREND!, extras.eth);
  // BTC_ETH = BTC-USD / ETH-USD from the same requests that fed research:BTC-USD and ETH_TREND.
  const eth = new Map(registry.ETH_TREND!.map((p) => [p.date, p.value]));
  const btc = new Map(research.btc.map((p) => [p.date, p.value]));
  for (const p of registry.BTC_ETH!) if (btc.has(p.date)) expect(p.value).toBe(btc.get(p.date)! / eth.get(p.date)!);
  expect(registry.BTC_ETH!.some((p) => btc.has(p.date))).toBe(true);
  // SPY behind research:SPY and the SPY ratios is one request too.
  const keys = byKey(saved);
  expect(keys.get("research:SPY")!.values.size).toBeGreaterThan(0);
});

test("issue 1514: each key's acquisition metadata and first date are unchanged by the memo", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  const withMemo: SourceAcquisitionEvidence[] = [];
  const without: SourceAcquisitionEvidence[] = [];
  globalThis.fetch = countingProviders(new Map());
  await liveRun(liveDataSource.forRun!({ regime: true, research: true }), memorySink(withMemo));
  globalThis.fetch = countingProviders(new Map());
  await liveRun(liveDataSource, memorySink(without));
  const a = byKey(withMemo), b = byKey(without);
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [key, k] of b) {
    const m = a.get(key)!;
    const first = (v: Map<string, number>) => [...v.keys()].sort()[0];
    expect({ key, meta: m.meta, first: first(m.values), dates: [...m.values.keys()].sort() }).toEqual({ key, meta: k.meta, first: first(k.values), dates: [...k.values.keys()].sort() });
  }
  // The cut is real: backtest:^GSPC starts at its 2010 request, SPX_TREND reads full history.
  expect([...a.get("backtest:^GSPC")!.values.keys()].sort()[0]).toBe("2010-01-04");
  expect([...a.get("raw_indicator_history:SPX_TREND")!.values.keys()].sort()[0]).toBe("2009-12-30");
  expect([...a.get("research:BTC-USD")!.values.keys()].sort()[0]).toBe("2016-01-04");
});

test("issue 1514: a failing symbol leaves every key it feeds empty and fills the others", async () => {
  process.env.HTTP_FETCH_CACHE_TTL_MS = "0";
  const counts = new Map<string, number>();
  globalThis.fetch = countingProviders(counts, "ETH-USD");
  const { registry, extras, research } = await liveRun(liveDataSource.forRun!({ regime: true, research: true }), memorySink([]));
  expect(counts.get("yahoo:ETH-USD")).toBe(1);
  expect(registry.ETH_TREND).toEqual([]);
  expect(registry.BTC_ETH).toEqual([]);
  expect(extras.eth).toEqual([]);
  expect(registry.SPX_TREND!.length).toBeGreaterThan(0);
  expect(extras.spx.length).toBeGreaterThan(0);
  expect(research.btc.length).toBeGreaterThan(0);
});
