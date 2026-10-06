// Backend side of the two-layer input rule (parse strict / merge tolerant):
// the SDK loader's series equal the backend mergeSeries series for any input
// both accept; see packages/analyst-sdk/tests/input-rule.test.ts.
// NOTE: src/analytics/transform/math.ts currently re-exports the SDK math.ts, so
// mergeSeries here is the same function the SDK test exercises. This file is the
// guard that stays meaningful if the backend ever forks its own copy.
import { test, expect } from "bun:test";
import { mergeSeries } from "../src/analytics/transform/math.ts";
import { parseRawJson, toHistory, InputRowError } from "../../packages/analyst-sdk/src/input/load.ts";

const base = [
  { date: "2024-03-09", indicator: "X", value: 9, source: "" },
  { date: "2024-03-01", indicator: "X", value: 1, source: "" },
  { date: "2024-03-09", indicator: "X", value: 90, source: "" },
  { date: "2024-03-05", indicator: "X", value: 5, source: "" },
];

test("backend mergeSeries == loader toHistory for accepted input", () => {
  const pts = base.map(({ date, value }) => ({ date, value }));
  expect(mergeSeries([], pts)).toEqual(toHistory(base).X!);
  expect(mergeSeries(pts.slice(0, 1), pts.slice(1))).toEqual(toHistory(base).X!);
});

test("non-finite: loader throws, mergeSeries drops, survivors equal", () => {
  expect(() => parseRawJson(JSON.stringify([...base, { date: "2024-03-06", indicator: "X", value: "abc", source: "" }]))).toThrow(InputRowError);
  const pts = [...base.map(({ date, value }) => ({ date, value })), { date: "2024-03-06", value: NaN }];
  expect(mergeSeries([], pts)).toEqual(toHistory(base).X!);
});
