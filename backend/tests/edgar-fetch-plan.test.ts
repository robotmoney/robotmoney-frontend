// Pure planning + batch-validation coverage for the incremental EDGAR/MNA
// research refresh (issue #109). No network, no DB — every case below is a
// direct function call over deterministic inputs.
import { test, expect } from "bun:test";
import {
  planEdgarFetch,
  validateEdgarBatch,
  EDGAR_FLOOR_START,
  EDGAR_REVISION_WINDOW_MONTHS,
  type EdgarPlanMonth,
} from "../src/analytics/extract/edgar-fetch-plan.ts";

function monthKeys(plan: EdgarPlanMonth[]): string[] {
  return plan.map((m) => m.monthStart.slice(0, 7));
}

function allMonthsBetween(startYm: string, endYm: string): string[] {
  const out: string[] = [];
  let [y, m] = startYm.split("-").map(Number) as [number, number];
  const [ey, em] = endYm.split("-").map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ── AC1: pure planning ───────────────────────────────────────────────────

test("planEdgarFetch: an EMPTY persisted floor plans EVERY month from floorStart to asof, chronological, no duplicates", () => {
  const asOf = "2010-06-30";
  const plan = planEdgarFetch({ asOf, persistedMonths: [] });
  const keys = monthKeys(plan);
  expect(keys).toEqual(["2010-01", "2010-02", "2010-03", "2010-04", "2010-05", "2010-06"]);
  expect(new Set(keys).size).toBe(keys.length); // no duplicates
  // chronological
  for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
});

test("planEdgarFetch: a FULLY seeded floor plans ONLY the trailing revision window (zero historical crawl)", () => {
  const asOf = "2020-12-31";
  const persistedMonths = allMonthsBetween("2010-01", "2020-12");
  const plan = planEdgarFetch({ asOf, persistedMonths });
  const keys = monthKeys(plan);
  // Only the trailing EDGAR_REVISION_WINDOW_MONTHS are re-requested.
  expect(keys).toEqual(["2020-11", "2020-12"]);
  expect(keys.length).toBe(EDGAR_REVISION_WINDOW_MONTHS);
});

test("planEdgarFetch: a floor missing interior months plans exactly those, PLUS the revision window — no more", () => {
  const asOf = "2015-06-30";
  const all = allMonthsBetween("2010-01", "2015-06");
  const missing = new Set(["2012-03", "2013-11"]);
  const persistedMonths = all.filter((m) => !missing.has(m));
  const plan = planEdgarFetch({ asOf, persistedMonths });
  const keys = new Set(monthKeys(plan));
  expect(keys.has("2012-03")).toBe(true);
  expect(keys.has("2013-11")).toBe(true);
  expect(keys.has("2015-05")).toBe(true); // revision window
  expect(keys.has("2015-06")).toBe(true); // revision window
  expect(keys.size).toBe(2 + EDGAR_REVISION_WINDOW_MONTHS);
  // every other already-persisted, non-revisable month is EXCLUDED
  expect(keys.has("2014-01")).toBe(false);
  expect(keys.has("2010-01")).toBe(false);
});

test("planEdgarFetch: never requests a month before the declared floor start", () => {
  const asOf = "2010-03-31";
  const plan = planEdgarFetch({ asOf, persistedMonths: [] });
  for (const m of plan) expect(m.monthStart >= EDGAR_FLOOR_START).toBe(true);
});

test("planEdgarFetch: never requests a month after the pinned as-of date", () => {
  const asOf = "2019-07-15"; // mid-month as-of
  const plan = planEdgarFetch({ asOf, persistedMonths: allMonthsBetween("2010-01", "2019-06") });
  // no request STARTS in a month after asof's month (the as-of month itself,
  // even mid-month/partial, is still planned — it is within the revision
  // window and never excluded merely for being the current incomplete
  // month; but nothing past it ever appears).
  for (const m of plan) expect(m.monthStart.slice(0, 7) <= asOf.slice(0, 7)).toBe(true);
  expect(monthKeys(plan)).toContain("2019-07");
});

test("planEdgarFetch: a fully current floor at asof (nothing missing, revision window already fresh) still re-plans the fixed trailing window deterministically", () => {
  const asOf = "2021-01-31";
  const persistedMonths = allMonthsBetween("2010-01", "2021-01");
  const plan1 = planEdgarFetch({ asOf, persistedMonths });
  const plan2 = planEdgarFetch({ asOf, persistedMonths });
  expect(plan1).toEqual(plan2); // deterministic — same inputs, same plan
  expect(plan1.length).toBe(EDGAR_REVISION_WINDOW_MONTHS);
});

test("planEdgarFetch: an out-of-range floor start (after asof) yields an empty plan", () => {
  const plan = planEdgarFetch({ asOf: "2009-06-30", persistedMonths: [] });
  expect(plan).toEqual([]);
});

// ── batch validation (feeds AC4's failure-matrix cases) ──────────────────

test("validateEdgarBatch: a complete, in-order, valid batch is accepted", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31", persistedMonths: [] });
  const fetched = plan.map((m) => ({ date: m.monthEnd, value: 5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.rows.length).toBe(plan.length);
    expect(result.rows.map((r) => r.date)).toEqual(plan.map((m) => m.monthEnd));
  }
});

test("validateEdgarBatch: one missing month (null) fails the WHOLE batch", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31", persistedMonths: [] });
  const fetched = plan.map((m, i) => (i === 1 ? null : { date: m.monthEnd, value: 5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/missing/);
});

test("validateEdgarBatch: a duplicate date across two batch entries fails", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31", persistedMonths: [] });
  const fetched = plan.map((m) => ({ date: plan[0]!.monthEnd, value: 5 })); // every entry stamped on the SAME date
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/expected date|duplicate/);
});

test("validateEdgarBatch: an invalid (negative / non-integer) count fails", () => {
  const plan = planEdgarFetch({ asOf: "2010-02-28", persistedMonths: [] });
  const fetched = plan.map((m, i) => ({ date: m.monthEnd, value: i === 0 ? -1 : 3.5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-02-28" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/finite non-negative integer/);
});

test("validateEdgarBatch: an out-of-range date (past asof) fails", () => {
  const plan: EdgarPlanMonth[] = [{ monthStart: "2010-01-01", monthEnd: "2010-01-31" }];
  const fetched = [{ date: "2099-01-31", value: 1 }]; // wrong/future date entirely
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-01-31" });
  expect(result.ok).toBe(false);
});
