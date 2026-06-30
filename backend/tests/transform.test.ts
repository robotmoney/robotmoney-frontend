// Transform stage (pure): the dense-grid reshaping the live provider relies on.
import { test, expect } from "bun:test";
import { shapeDaily, ratioByDate } from "../src/analytics/transform/grid.ts";

test("shapeDaily: forward-fills onto a dense grid of length lookbackDays", () => {
  const raw = [
    { date: "2024-01-10", value: 10 },
    { date: "2024-01-12", value: 20 },
    { date: "2024-01-20", value: 99 }, // after asof → must be ignored
  ];
  const out = shapeDaily(raw, "2024-01-13", 5)!;
  expect(out).not.toBeNull();
  expect(out.length).toBe(5); // == lookbackDays
  expect(out.map((p) => p.date)).toEqual([
    "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-13",
  ]);
  // back-fill before first obs (10), carry forward through the gap, step to 20.
  expect(out.map((p) => p.value)).toEqual([10, 10, 10, 20, 20]);
});

test("shapeDaily: null when there is no data at/-before asof", () => {
  const raw = [{ date: "2024-02-01", value: 5 }];
  expect(shapeDaily(raw, "2024-01-13", 5)).toBeNull();
  expect(shapeDaily([], "2024-01-13", 5)).toBeNull();
});

test("ratioByDate: aligns on shared dates only (a/b)", () => {
  const a = [
    { date: "2024-01-01", value: 100 },
    { date: "2024-01-02", value: 200 },
    { date: "2024-01-03", value: 300 },
  ];
  const b = [
    { date: "2024-01-01", value: 50 },
    { date: "2024-01-03", value: 150 },
  ];
  expect(ratioByDate(a, b)).toEqual([
    { date: "2024-01-01", value: 2 },
    { date: "2024-01-03", value: 2 },
  ]);
});
