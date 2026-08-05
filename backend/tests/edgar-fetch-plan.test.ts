// Pure planning + batch-validation coverage for the two-tier EDGAR/MNA
// research refresh. R6 (docs/v0-v1-quant-platform-parity-report.md, finding
// 1.10): v0's late-cycle-signals.js re-crawls EVERY month from 2010 on
// EVERY run, so any EDGAR back-revision to any historical month lands — the
// old fixed 2-month revision window meant an older revision never landed
// and diverged permanently from v0. The first R6 fix over-corrected by
// making EVERY run a full ~200-month crawl, forever; this module now
// exposes BOTH planners so the orchestrator (edgar-incremental-refresh.ts)
// can pick the cheap one (Tier 1, `planEdgarFetchIncremental`) most days and
// the expensive one (Tier 2, `planEdgarFetch`) on a bounded periodic
// cadence. No network, no DB — every case below is a direct function call
// over deterministic inputs.
import { test, expect } from "bun:test";
import {
  planEdgarFetch,
  planEdgarFetchIncremental,
  validateEdgarBatch,
  assessEdgarBatchDivergence,
  EDGAR_FLOOR_START,
  EDGAR_REVISION_WINDOW_MONTHS,
  EDGAR_DEGENERACY_MIN_ROWS,
  EDGAR_DEGENERATE_ZERO_RATIO,
  EDGAR_MIN_COMPARABLE_MONTHS,
  EDGAR_MAX_REVISED_HISTORY_RATIO,
  EDGAR_MAX_AGGREGATE_DRIFT_RATIO,
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

// ── Tier 2: planEdgarFetch (full re-crawl, unchanged from the first R6 fix,
//    now reserved for the periodic full reconciliation sweep) ────────────

test("planEdgarFetch: an EMPTY persisted floor plans EVERY month from floorStart to asof, chronological, no duplicates", () => {
  const asOf = "2010-06-30";
  const plan = planEdgarFetch({ asOf });
  const keys = monthKeys(plan);
  expect(keys).toEqual(["2010-01", "2010-02", "2010-03", "2010-04", "2010-05", "2010-06"]);
  expect(new Set(keys).size).toBe(keys.length); // no duplicates
  // chronological
  for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
});

test("planEdgarFetch: a FULLY seeded floor still plans EVERY month — the full-sweep tier ignores what is already persisted", () => {
  const asOf = "2020-12-31";
  const expected = allMonthsBetween("2010-01", "2020-12");
  // planEdgarFetch takes no persisted-floor input at all — there is nothing
  // for a caller to pass that would narrow the plan. That is Tier 2's whole
  // point: an EDGAR back-revision to ANY historical month, however old,
  // lands the next time this tier runs.
  const plan = planEdgarFetch({ asOf });
  const keys = monthKeys(plan);
  expect(keys).toEqual(expected);
  expect(keys.length).toBe(expected.length);
});

test("planEdgarFetch: a floor missing interior months plans those months too — same full range as an empty floor", () => {
  const asOf = "2015-06-30";
  const all = allMonthsBetween("2010-01", "2015-06");
  // Whether or not 2012-03/2013-11 were ever persisted is irrelevant to this
  // planner's output — every month always appears.
  const plan = planEdgarFetch({ asOf });
  const keys = new Set(monthKeys(plan));
  expect(keys.has("2012-03")).toBe(true);
  expect(keys.has("2013-11")).toBe(true);
  expect(keys.size).toBe(all.length);
  expect([...keys].sort()).toEqual(all);
});

test("planEdgarFetch: never requests a month before the declared floor start", () => {
  const asOf = "2010-03-31";
  const plan = planEdgarFetch({ asOf });
  for (const m of plan) expect(m.monthStart >= EDGAR_FLOOR_START).toBe(true);
});

test("planEdgarFetch: never requests a month after the pinned as-of date", () => {
  const asOf = "2019-07-15"; // mid-month as-of
  const plan = planEdgarFetch({ asOf });
  // no request STARTS in a month after asof's month (the as-of month itself,
  // even mid-month/partial, is still planned — it is never excluded merely
  // for being the current incomplete month; but nothing past it ever
  // appears).
  for (const m of plan) expect(m.monthStart.slice(0, 7) <= asOf.slice(0, 7)).toBe(true);
  expect(monthKeys(plan)).toContain("2019-07");
});

test("planEdgarFetch: a fully current floor at asof still plans the FULL range deterministically (no revision-window shortcut)", () => {
  const asOf = "2021-01-31";
  const plan1 = planEdgarFetch({ asOf });
  const plan2 = planEdgarFetch({ asOf });
  expect(plan1).toEqual(plan2); // deterministic — same inputs, same plan
  expect(plan1.length).toBe(allMonthsBetween("2010-01", "2021-01").length);
});

test("planEdgarFetch: an out-of-range floor start (after asof) yields an empty plan", () => {
  const plan = planEdgarFetch({ asOf: "2009-06-30" });
  expect(plan).toEqual([]);
});

// ── Tier 1: planEdgarFetchIncremental (restored issue #109 design — missing
//    months + a small trailing revision window; used every day) ──────────

test("planEdgarFetchIncremental: an EMPTY persisted floor plans EVERY month from floorStart to asof, chronological, no duplicates", () => {
  const asOf = "2010-06-30";
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths: [] });
  const keys = monthKeys(plan);
  expect(keys).toEqual(["2010-01", "2010-02", "2010-03", "2010-04", "2010-05", "2010-06"]);
  expect(new Set(keys).size).toBe(keys.length);
  for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
});

test("planEdgarFetchIncremental: a FULLY seeded floor plans ONLY the trailing revision window (zero historical crawl)", () => {
  const asOf = "2020-12-31";
  const persistedMonths = allMonthsBetween("2010-01", "2020-12");
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths });
  const keys = monthKeys(plan);
  // Only the trailing EDGAR_REVISION_WINDOW_MONTHS are re-requested — the
  // ~200-month historical range is NOT re-crawled by this tier; that is
  // Tier 2's job, on its own periodic cadence.
  expect(keys).toEqual(["2020-11", "2020-12"]);
  expect(keys.length).toBe(EDGAR_REVISION_WINDOW_MONTHS);
});

test("planEdgarFetchIncremental: a floor missing interior months plans exactly those, PLUS the revision window — no more", () => {
  const asOf = "2015-06-30";
  const all = allMonthsBetween("2010-01", "2015-06");
  const missing = new Set(["2012-03", "2013-11"]);
  const persistedMonths = all.filter((m) => !missing.has(m));
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths });
  const keys = new Set(monthKeys(plan));
  expect(keys.has("2012-03")).toBe(true);
  expect(keys.has("2013-11")).toBe(true);
  expect(keys.has("2015-05")).toBe(true); // revision window
  expect(keys.has("2015-06")).toBe(true); // revision window
  expect(keys.size).toBe(2 + EDGAR_REVISION_WINDOW_MONTHS);
  // every other already-persisted, non-revisable month is EXCLUDED — this
  // is exactly the cheap-daily-run property Tier 1 exists for.
  expect(keys.has("2014-01")).toBe(false);
  expect(keys.has("2010-01")).toBe(false);
});

test("planEdgarFetchIncremental: never requests a month before the declared floor start", () => {
  const asOf = "2010-03-31";
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths: [] });
  for (const m of plan) expect(m.monthStart >= EDGAR_FLOOR_START).toBe(true);
});

test("planEdgarFetchIncremental: never requests a month after the pinned as-of date", () => {
  const asOf = "2019-07-15"; // mid-month as-of
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths: allMonthsBetween("2010-01", "2019-06") });
  for (const m of plan) expect(m.monthStart.slice(0, 7) <= asOf.slice(0, 7)).toBe(true);
  expect(monthKeys(plan)).toContain("2019-07");
});

test("planEdgarFetchIncremental: a fully current floor at asof (nothing missing) still re-plans the fixed trailing window deterministically", () => {
  const asOf = "2021-01-31";
  const persistedMonths = allMonthsBetween("2010-01", "2021-01");
  const plan1 = planEdgarFetchIncremental({ asOf, persistedMonths });
  const plan2 = planEdgarFetchIncremental({ asOf, persistedMonths });
  expect(plan1).toEqual(plan2); // deterministic — same inputs, same plan
  expect(plan1.length).toBe(EDGAR_REVISION_WINDOW_MONTHS);
});

test("planEdgarFetchIncremental: an out-of-range floor start (after asof) yields an empty plan", () => {
  const plan = planEdgarFetchIncremental({ asOf: "2009-06-30", persistedMonths: [] });
  expect(plan).toEqual([]);
});

test("planEdgarFetchIncremental: a custom revisionWindowMonths overrides the default", () => {
  const asOf = "2020-12-31";
  const persistedMonths = allMonthsBetween("2010-01", "2020-12");
  const plan = planEdgarFetchIncremental({ asOf, persistedMonths, revisionWindowMonths: 1 });
  expect(monthKeys(plan)).toEqual(["2020-12"]);
});

// ── batch validation (feeds AC4's failure-matrix cases; shared by both
//    tiers, so exercised against BOTH planners' output shape) ────────────

test("validateEdgarBatch: a complete, in-order, valid batch is accepted (full-tier plan)", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31" });
  const fetched = plan.map((m) => ({ date: m.monthEnd, value: 5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.rows.length).toBe(plan.length);
    expect(result.rows.map((r) => r.date)).toEqual(plan.map((m) => m.monthEnd));
  }
});

test("validateEdgarBatch: a complete, in-order, valid batch is accepted (incremental-tier plan)", () => {
  const plan = planEdgarFetchIncremental({ asOf: "2010-03-31", persistedMonths: [] });
  const fetched = plan.map((m) => ({ date: m.monthEnd, value: 5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.rows.length).toBe(plan.length);
});

test("validateEdgarBatch: one missing month (null) fails the WHOLE batch", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31" });
  const fetched = plan.map((m, i) => (i === 1 ? null : { date: m.monthEnd, value: 5 }));
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/missing/);
});

test("validateEdgarBatch: a duplicate date across two batch entries fails", () => {
  const plan = planEdgarFetch({ asOf: "2010-03-31" });
  const fetched = plan.map((m) => ({ date: plan[0]!.monthEnd, value: 5 })); // every entry stamped on the SAME date
  const result = validateEdgarBatch(plan, fetched, { asOf: "2010-03-31" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/expected date|duplicate/);
});

test("validateEdgarBatch: an invalid (negative / non-integer) count fails", () => {
  const plan = planEdgarFetch({ asOf: "2010-02-28" });
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

// ── assessEdgarBatchDivergence: the batch-level guard (issue #509) ────────
//
// validateEdgarBatch above is per-ROW and, correctly, accepts 0. This guard
// is the whole-BATCH gate that stands between a well-formed-but-wrong Tier 2
// sweep and an irreversible overwrite of ~200 months of archived history.
// Pure — direct calls over deterministic inputs, no network, no DB.

// A floor of `n` consecutive month-end rows starting at 2010-01, all `value`.
function floorOf(n: number, value = 100): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (let i = 0; i < n; i++) {
    const y = 2010 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, value });
  }
  return out;
}

test("assessEdgarBatchDivergence: an ALL-ZERO batch is degenerate by definition and is refused", () => {
  const floor = floorOf(24);
  const batch = floor.map((p) => ({ date: p.date, value: 0 }));
  const result = assessEdgarBatchDivergence(batch, floor);
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/degenerate batch/);
  // Every value in the batch is individually a finite non-negative integer,
  // so the PER-ROW validator would have waved this through — which is the
  // whole reason this guard exists.
  const plan = batch.map((p) => ({ monthStart: `${p.date.slice(0, 7)}-01`, monthEnd: p.date }));
  expect(validateEdgarBatch(plan, batch, { asOf: batch[batch.length - 1]!.date }).ok).toBe(true);
});

test("assessEdgarBatchDivergence: a NEAR-all-zero batch (>= the zero ratio) is refused too", () => {
  const floor = floorOf(20);
  // 18 of 20 zero = 90%, exactly at EDGAR_DEGENERATE_ZERO_RATIO.
  const batch = floor.map((p, i) => ({ date: p.date, value: i < 18 ? 0 : 100 }));
  const result = assessEdgarBatchDivergence(batch, floor);
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/degenerate batch/);
});

test("assessEdgarBatchDivergence: a SMALL all-zero batch is ACCEPTED — a 1-2 month incremental plan can legitimately be zero (e.g. the current month on its first day)", () => {
  const floor = floorOf(3);
  const batch = [{ date: "2010-04-30", value: 0 }];
  expect(assessEdgarBatchDivergence(batch, floor).ok).toBe(true);
  expect(EDGAR_DEGENERACY_MIN_ROWS).toBeGreaterThan(1);
});

test("assessEdgarBatchDivergence: a bulk REWRITE of historical months is refused (too many changed), while a realistic back-revision to a handful of months is accepted", () => {
  const floor = floorOf(100);
  // A revision touching 3 of 100 already-persisted months by a few filings —
  // exactly what Tier 2 exists to land. Must NOT be refused.
  const revision = floor.map((p, i) => ({ date: p.date, value: i < 3 ? p.value + 2 : p.value }));
  expect(assessEdgarBatchDivergence(revision, floor).ok).toBe(true);

  // Half the series rewritten in one batch — a rewrite, not a revision.
  const rewrite = floor.map((p, i) => ({ date: p.date, value: i < 50 ? 7 : p.value }));
  const result = assessEdgarBatchDivergence(rewrite, floor);
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/bulk rewrite/);
  expect(result.comparedMonths).toBe(100);
  expect(result.changedMonths).toBe(50);
});

test("assessEdgarBatchDivergence: an AGGREGATE drift beyond bounds is refused even when few months changed", () => {
  const floor = floorOf(40, 100); // sum 4000
  // Only 4 of 40 months change (10%, under the changed-months bound) but they
  // each explode, dragging the aggregate far past the drift bound.
  const batch = floor.map((p, i) => ({ date: p.date, value: i < 4 ? 100_000 : p.value }));
  const result = assessEdgarBatchDivergence(batch, floor);
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/aggregate diverges/);
  expect(result.changedMonths).toBe(4);
});

test("assessEdgarBatchDivergence: the ratio checks do NOT apply to a small incremental batch — a 2-month revision window legitimately changes 100% of what it re-fetches", () => {
  const floor = floorOf(100);
  const batch = [
    { date: floor[98]!.date, value: floor[98]!.value * 3 },
    { date: floor[99]!.date, value: floor[99]!.value * 3 },
  ];
  const result = assessEdgarBatchDivergence(batch, floor);
  expect(result.ok).toBe(true);
  expect(result.comparedMonths).toBe(2);
  expect(result.changedMonths).toBe(2);
  expect(result.comparedMonths).toBeLessThan(EDGAR_MIN_COMPARABLE_MONTHS);
});

test("assessEdgarBatchDivergence: a batch of genuinely NEW months (no overlap with the floor) is accepted — nothing is being overwritten", () => {
  const floor = floorOf(12);
  const batch = floorOf(24).slice(12); // months 13..24, none persisted yet
  const result = assessEdgarBatchDivergence(batch, floor);
  expect(result.ok).toBe(true);
  expect(result.comparedMonths).toBe(0);
});

test("assessEdgarBatchDivergence: an identical replay of the persisted floor is accepted and reports zero changed months (idempotent re-submission is not divergence)", () => {
  const floor = floorOf(150);
  const result = assessEdgarBatchDivergence(floor.map((p) => ({ ...p })), floor);
  expect(result.ok).toBe(true);
  expect(result.changedMonths).toBe(0);
  expect(result.comparedMonths).toBe(150);
});

test("assessEdgarBatchDivergence: thresholds are overridable (so callers/tests can tighten or relax them) and the exported defaults are the documented ones", () => {
  expect(EDGAR_DEGENERATE_ZERO_RATIO).toBe(0.9);
  expect(EDGAR_DEGENERACY_MIN_ROWS).toBe(6);
  expect(EDGAR_MIN_COMPARABLE_MONTHS).toBe(12);
  expect(EDGAR_MAX_REVISED_HISTORY_RATIO).toBe(0.25);
  expect(EDGAR_MAX_AGGREGATE_DRIFT_RATIO).toBe(0.25);

  const floor = floorOf(20);
  const batch = floor.map((p, i) => ({ date: p.date, value: i < 6 ? p.value + 1 : p.value })); // 30% changed
  expect(assessEdgarBatchDivergence(batch, floor).ok).toBe(false);
  expect(assessEdgarBatchDivergence(batch, floor, { maxRevisedHistoryRatio: 0.5 }).ok).toBe(true);
});
