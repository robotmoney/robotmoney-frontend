// REGIME STALENESS: the /api/dashboards/regime-snapshots response must flag a
// FROZEN snapshot loudly instead of serving it silently as current. The pipeline
// forward-fills its date axis to `asof=today` on every run, so a healthy
// deployment always serves a snapshot dated today (± a couple of days for
// weekend/holiday EOD settlement); a larger lag means the analytics job is not
// refreshing in that deployment. These assertions pin the pure classifier.
import { test, expect } from "bun:test";
import {
  computeRegimeStaleness,
  computeRegimeSnapshotStaleness,
  panelObservationDates,
  overallObservationDate,
  REGIME_STALE_THRESHOLD_DAYS,
} from "../src/analytics/report/regime-projection.ts";

test("same-day snapshot is fresh", () => {
  const s = computeRegimeStaleness("2026-07-14", "2026-07-14");
  expect(s.ageDays).toBe(0);
  expect(s.stale).toBe(false);
  expect(s.asof).toBe("2026-07-14");
});

test("one-day-old snapshot (unsettled close / next UTC day) is still fresh", () => {
  const s = computeRegimeStaleness("2026-07-13", "2026-07-14");
  expect(s.ageDays).toBe(1);
  expect(s.stale).toBe(false);
});

test("weekend-aged snapshot at the threshold is fresh; one day past is stale", () => {
  expect(computeRegimeStaleness("2026-07-11", "2026-07-14").stale).toBe(false); // 3d == threshold
  expect(computeRegimeStaleness("2026-07-10", "2026-07-14").stale).toBe(true); // 4d > threshold
  expect(REGIME_STALE_THRESHOLD_DAYS).toBe(3);
});

test("snapshot frozen weeks back (analytics not running) is stale with the real age", () => {
  // The reported symptom: served data frozen at the ~June-29 seed floor while the
  // deployment clock has moved on — must read as loudly stale, not current.
  const s = computeRegimeStaleness("2026-06-29", "2026-07-14");
  expect(s.stale).toBe(true);
  expect(s.ageDays).toBe(15);
});

test("no snapshot at all is stale (a deployment serving zero rows is not fresh)", () => {
  const s = computeRegimeStaleness(null, "2026-07-14");
  expect(s.stale).toBe(true);
  expect(s.asof).toBeNull();
  expect(s.ageDays).toBeNull();
});

test("unparseable asof degrades to stale rather than throwing", () => {
  const s = computeRegimeStaleness("not-a-date", "2026-07-14");
  expect(s.stale).toBe(true);
  expect(s.ageDays).toBeNull();
});

test("custom threshold is honored", () => {
  expect(computeRegimeStaleness("2026-07-13", "2026-07-14", 0).stale).toBe(true); // 1d > 0
  expect(computeRegimeStaleness("2026-07-14", "2026-07-14", 0).stale).toBe(false); // 0d == 0
});

// ── #398: staleness derived from real per-panel raw observation dates ──────
// (not the pipeline's forward-filled `date` write time). These pin the new
// pure helpers computeRegimeSnapshotStaleness relies on.

test("panelObservationDates: takes the max raw_date per panel, ignoring invalid/missing ones", () => {
  const indicators = [
    { id: "A", panel: "macro", raw_date: "2026-07-01" },
    { id: "B", panel: "macro", raw_date: "2026-07-10" }, // newer macro observation wins
    { id: "C", panel: "onchain", raw_date: "not-a-date" }, // invalid: excluded
    { id: "D", panel: "onchain", raw_date: null }, // missing: excluded
    { id: "E", panel: "factor", raw_date: "2026-06-01" },
  ];
  expect(panelObservationDates(indicators)).toEqual({
    macro: "2026-07-10",
    onchain: null, // no valid raw_date anywhere in this panel
    factor: "2026-06-01",
  });
});

test("panelObservationDates: non-array / missing indicators yields an empty map", () => {
  expect(panelObservationDates(null)).toEqual({});
  expect(panelObservationDates(undefined)).toEqual({});
  expect(panelObservationDates("not an array")).toEqual({});
  expect(panelObservationDates([])).toEqual({});
});

test("overallObservationDate: the OLDEST per-panel max wins, so one frozen panel can't hide behind a fresher one", () => {
  expect(overallObservationDate({ macro: "2026-07-10", onchain: "2026-07-01" })).toBe("2026-07-01");
});

test("overallObservationDate: any panel with a null (no valid observation) date fails the whole thing closed", () => {
  expect(overallObservationDate({ macro: "2026-07-10", onchain: null })).toBeNull();
});

test("overallObservationDate: no panels at all is null", () => {
  expect(overallObservationDate({})).toBeNull();
});

test("computeRegimeSnapshotStaleness: a today-dated real observation in every panel is fresh", () => {
  const indicators = [
    { id: "A", panel: "macro", raw_date: "2026-07-14" },
    { id: "B", panel: "onchain", raw_date: "2026-07-14" },
  ];
  const s = computeRegimeSnapshotStaleness(indicators, "2026-07-14");
  expect(s.stale).toBe(false);
  expect(s.asof).toBe("2026-07-14");
  expect(s.ageDays).toBe(0);
  expect(s.panelObservationDates).toEqual({ macro: "2026-07-14", onchain: "2026-07-14" });
});

test("computeRegimeSnapshotStaleness: #398 core regression — stale real observations under a today-dated (forward-filled) row read as stale", () => {
  // The scenario this issue exists to fix: a snapshot ROW dated today (the
  // pipeline forward-fills its date axis every run) whose indicators carry
  // OLD real observation dates. The row's own `date` is irrelevant here —
  // computeRegimeSnapshotStaleness never sees it, only `indicators`.
  const indicators = [
    { id: "A", panel: "macro", raw_date: "2026-07-01" },
    { id: "B", panel: "onchain", raw_date: "2026-07-01" },
  ];
  const s = computeRegimeSnapshotStaleness(indicators, "2026-07-14");
  expect(s.stale).toBe(true);
  expect(s.asof).toBe("2026-07-01");
  expect(s.ageDays).toBe(13);
});

test("computeRegimeSnapshotStaleness: missing/invalid observation dates fail closed as stale", () => {
  expect(computeRegimeSnapshotStaleness(null, "2026-07-14").stale).toBe(true);
  expect(computeRegimeSnapshotStaleness([], "2026-07-14").stale).toBe(true);
  const allInvalid = [{ id: "A", panel: "macro", raw_date: "garbage" }];
  expect(computeRegimeSnapshotStaleness(allInvalid, "2026-07-14").stale).toBe(true);
});

test("computeRegimeStaleness: panelObservationDates passes through and defaults to {} for bare-asof callers", () => {
  expect(computeRegimeStaleness("2026-07-14", "2026-07-14").panelObservationDates).toEqual({});
  expect(
    computeRegimeStaleness("2026-07-14", "2026-07-14", REGIME_STALE_THRESHOLD_DAYS, { macro: "2026-07-14" })
      .panelObservationDates,
  ).toEqual({ macro: "2026-07-14" });
});
