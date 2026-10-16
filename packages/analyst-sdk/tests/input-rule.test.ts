// Two-layer input rule: loader STRICT (throws on non-finite), mergeSeries
// TOLERANT (drops). For inputs both accept, the aligned series are identical.
import { test, expect } from "bun:test";
import { parseRawJson, parseRawCsv, toHistory, InputRowError } from "../src/input/load.ts";
import { mergeSeries, alignDailyForwardFill, forwardFillAge, buildDateAxis } from "../src/transform/math.ts";

const rows = [
  { date: "2024-01-05", indicator: "A", value: 5, source: "s" },
  { date: "2024-01-02", indicator: "A", value: 2, source: "s" },
  { date: "2024-01-05", indicator: "A", value: 55, source: "s" }, // dup, last wins
  { date: "2024-01-03", indicator: "A", value: 3, source: "s" },
  { date: "2024-01-02", indicator: "A", value: 22, source: "s" }, // dup, last wins
];
const expected = [
  { date: "2024-01-02", value: 22 },
  { date: "2024-01-03", value: 3 },
  { date: "2024-01-05", value: 55 },
];

test("loader and mergeSeries agree: duplicates, out of order, last wins, ascending", () => {
  const pts = rows.map(({ date, value }) => ({ date, value }));
  expect(toHistory(rows).A).toEqual(expected);
  expect(mergeSeries([], pts)).toEqual(expected);
  expect(mergeSeries(pts, [])).toEqual(expected);
  // prior then fetched == one concatenated stream, last wins
  expect(mergeSeries(pts.slice(0, 2), pts.slice(2))).toEqual(expected);
});

test("non-finite row: loader throws, mergeSeries drops, survivors equal", () => {
  const bad = JSON.stringify([...rows, { date: "2024-01-04", indicator: "A", value: "NaN", source: "s" }]);
  expect(() => parseRawJson(bad)).toThrow(InputRowError);
  const csv = "date,indicator,value,source\n2024-01-04,A,Infinity,s\n";
  expect(() => parseRawCsv(csv)).toThrow(InputRowError);
  const pts = [...rows.map(({ date, value }) => ({ date, value })), { date: "2024-01-04", value: NaN }, { date: "2024-01-06", value: Infinity }];
  expect(mergeSeries([], pts)).toEqual(toHistory(rows).A!);
  // a dropped fetched hole leaves the persisted value for that date
  expect(mergeSeries([{ date: "2024-01-03", value: 3 }], [{ date: "2024-01-03", value: NaN }])).toEqual([{ date: "2024-01-03", value: 3 }]);
});

test("alignment and age are order-independent on deduped input", () => {
  const axis = buildDateAxis("2024-01-01", "2024-01-08");
  const sorted = toHistory(rows).A!;
  const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
  const a = alignDailyForwardFill(sorted, axis), b = alignDailyForwardFill(shuffled, axis);
  expect(b).toEqual(a);
  expect(forwardFillAge(shuffled, axis)).toEqual(forwardFillAge(sorted, axis));
});

test("alignDailyForwardFill is order-dependent only on duplicate dates (why dedupe precedes it)", () => {
  const axis = buildDateAxis("2024-01-01", "2024-01-03");
  const x = alignDailyForwardFill([{ date: "2024-01-02", value: 1 }, { date: "2024-01-02", value: 2 }], axis);
  const y = alignDailyForwardFill([{ date: "2024-01-02", value: 2 }, { date: "2024-01-02", value: 1 }], axis);
  expect(x).not.toEqual(y);
});
