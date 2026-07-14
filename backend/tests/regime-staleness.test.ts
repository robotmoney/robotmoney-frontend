// REGIME STALENESS: the /api/dashboards/regime-snapshots response must flag a
// FROZEN snapshot loudly instead of serving it silently as current. The pipeline
// forward-fills its date axis to `asof=today` on every run, so a healthy
// deployment always serves a snapshot dated today (± a couple of days for
// weekend/holiday EOD settlement); a larger lag means the analytics job is not
// refreshing in that deployment. These assertions pin the pure classifier.
import { test, expect } from "bun:test";
import {
  computeRegimeStaleness,
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
