// Extract stage (pure, no network): feed canned upstream JSON to each source
// parser and assert it yields the right Point[] — and throws on garbage.
import { test, expect } from "bun:test";
import { parseLlamaTvl, parseLlamaStables } from "../src/analytics/extract/defillama.ts";
import { parseCoinGecko } from "../src/analytics/extract/coingecko.ts";
import { parseYahoo } from "../src/analytics/extract/yahoo.ts";

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

test("parseCoinGecko: [[ms, v]] for a key, throws when key missing", () => {
  const j = { prices: [[1700000000000, 42000]], total_volumes: [[1700000000000, 1.2e10]] };
  expect(parseCoinGecko(j, "prices")).toEqual([{ date: DAY, value: 42000 }]);
  expect(parseCoinGecko(j, "total_volumes")).toEqual([{ date: DAY, value: 1.2e10 }]);
  expect(() => parseCoinGecko(j, "market_caps")).toThrow();
  expect(() => parseCoinGecko({} as unknown, "prices")).toThrow();
});

test("parseYahoo: timestamp/close → Point[], skips null closes, throws on missing", () => {
  const j = {
    chart: { result: [{ timestamp: [TS, TS + 86400], indicators: { quote: [{ close: [450.5, null] }] } }] },
  };
  expect(parseYahoo(j)).toEqual([{ date: DAY, value: 450.5 }]); // second point dropped (null close)
  expect(() => parseYahoo({} as unknown)).toThrow();
  expect(() => parseYahoo({ chart: { result: [{ timestamp: [TS] }] } } as unknown)).toThrow();
});
