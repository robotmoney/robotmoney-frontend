// Extract stage (pure, no network): feed canned upstream JSON/CSV/HTML to each
// source parser and assert it yields the right Point[] — and throws on garbage.
// THIS is the CI-gating extract coverage; the live drift test (fetchers-live)
// runs separately where network exists.
import { test, expect } from "bun:test";
import { parseLlamaTvl, parseLlamaStables } from "../src/analytics/extract/defillama.ts";
import { parseYahoo } from "../src/analytics/extract/yahoo.ts";
import { parseFredCsv } from "../src/analytics/extract/fred.ts";
import { parseBlockchainChart } from "../src/analytics/extract/blockchain-com.ts";
import { parseCoinmetricsPage } from "../src/analytics/extract/coinmetrics.ts";
import { countNewPools24h, parseNewPoolsPage } from "../src/analytics/extract/geckoterminal.ts";
import { parseDatahubCsv, parseMultplHtml, mergeShiller } from "../src/analytics/extract/shiller.ts";
import { parseEdgarCount, enumerateMonths } from "../src/analytics/extract/edgar.ts";
import { mergeRatioSeries } from "../src/analytics/extract/sources.ts";

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
  expect(parseFredCsv(csv)).toEqual([
    { date: "2018-01-02", value: 0.55 },
    { date: "2018-01-04", value: 0.6 },
  ]);
  expect(parseFredCsv("DATE,X\n")).toEqual([]); // header only
  expect(parseFredCsv("")).toEqual([]);
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
