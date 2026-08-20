// Source-calendar guard (issue #616 / D6-D7): makes the v0-forward-fill defect
// class (fabricated rows on dates a source could never publish — see
// docs/code-review/20260814-review-data-integrity-macro-index-discrepancy.md)
// unrepresentable in the committed vendored floor going forward. Runs in the
// required backend.yml bun test job, no network.
import { test, expect } from "bun:test";
import { validateFloorCalendar, sourceCalendar } from "../src/analytics/extract/floor-seed-calendar.ts";
import { loadRawFloorSeed, DEFAULT_FLOOR_SEED_PATH } from "../src/analytics/extract/floor-seed.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import type { RawIndicatorHistory } from "../src/analytics/types.ts";

test("rejects a non-Saturday ICSA row and a weekend DXY row (named violations)", () => {
  const floor: RawIndicatorHistory = {
    ICSA: [
      { date: "2026-08-08", value: 209000 }, // Saturday — valid
      { date: "2026-08-10", value: 215000 }, // Monday — INVALID (D6: ICSA is Saturday-only)
    ],
    DXY: [
      { date: "2026-08-07", value: 119.0649 }, // Friday — valid
      { date: "2026-08-09", value: 119.2868 }, // Sunday — INVALID (D6: DXY is business-daily)
    ],
  };
  const violations = validateFloorCalendar(floor);
  expect(violations).toContainEqual({
    indicatorId: "ICSA",
    date: "2026-08-10",
    calendar: "weekly_saturday",
    reason: "non-saturday",
  });
  expect(violations).toContainEqual({
    indicatorId: "DXY",
    date: "2026-08-09",
    calendar: "business_day",
    reason: "weekend",
  });
  expect(violations.length).toBe(2);
});

test("committed vendored floor seed carries zero calendar-invalid rows", async () => {
  const floor = await loadRawFloorSeed(DEFAULT_FLOOR_SEED_PATH);
  const violations = validateFloorCalendar(floor);
  expect(violations).toEqual([]);
});

test("missing fixture path fails loudly — never silently skips", async () => {
  await expect(
    loadRawFloorSeed("/nonexistent/floor-seed-calendar-guard-fixture.csv.gz"),
  ).rejects.toThrow(/floor seed not found/);
});

// Issue #637: DXY's derivation prose once claimed "weekly" while D6 and
// sourceCalendar() both established DTWEXBGS is business-daily. Lock in the
// enforced calendar directly, independent of the prose-scan below.
test("DXY's enforced calendar is business_day, never weekly_saturday", () => {
  expect(sourceCalendar("DXY")).toBe("business_day");
});

// Guards against the #637 defect class recurring for any other indicator:
// derivation prose claiming a weekly cadence must agree with the calendar
// sourceCalendar() actually enforces for that id, and vice versa.
test("every indicator's derivation prose agrees with its enforced source calendar", () => {
  const contradictions: string[] = [];
  for (const ind of INDICATORS) {
    const prose = ind.derivation ?? "";
    const claimsWeekly = /\bweekly\b/i.test(prose);
    const calendar = sourceCalendar(ind.id);
    const enforcesWeekly = calendar === "weekly_saturday";
    if (claimsWeekly !== enforcesWeekly) {
      contradictions.push(
        `${ind.id}: derivation ${claimsWeekly ? "claims" : "does not claim"} weekly cadence, ` +
          `but sourceCalendar() returns "${calendar}" (derivation: ${JSON.stringify(prose)})`,
      );
    }
  }
  expect(contradictions).toEqual([]);
});
