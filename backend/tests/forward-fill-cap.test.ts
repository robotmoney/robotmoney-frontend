// #402: cap the forward-fill window for indicators so a "dead" indicator (one
// whose upstream feed has gone dark) stops silently dragging its last real
// value's full panel weight into the composite forever.
//
// Two layers are pinned here:
//   1. forwardFillAge (transform/math.ts) — the pure per-day "how long has this
//      value been carried forward" counter that MAX_FORWARD_FILL_DAYS is
//      measured against. alignDailyForwardFill itself is left untouched (see
//      its comment) so regime-fidelity's byte-identical replay keeps
//      reproducing the original JS pipeline exactly — the cap is applied one
//      layer up, in computeRegime, and is OFF unless `ages` is supplied.
//   2. computeRegime (analyze/compute.ts) — given `ages`, a value whose age
//      exceeds the configured horizon is excluded from that day's percentile
//      rank / panel weighting / composite (same code path as "no data that
//      day"), and a resumed real observation re-enters normally with no
//      special-casing (age resets to 0 the moment a real print lands).
import { test, expect } from "bun:test";
import type { RegimeIndicator } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { computeRegime } from "../src/analytics/analyze/compute.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import {
  buildDateAxis,
  alignDailyForwardFill,
  forwardFillAge,
  MAX_FORWARD_FILL_DAYS,
} from "../src/analytics/transform/math.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { liveDataSource } from "../src/analytics/access/data-source.ts";
import { saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

function buildAxis(start: string, n: number): string[] {
  return buildDateAxis(start, addDays(start, n - 1));
}

// ─── forwardFillAge: pure boundary behaviour ─────────────────────────────────

test("forwardFillAge: NaN before the first observation, 0 on a real day, increments while carried forward, resets on the next real day", () => {
  const dateAxis = buildAxis("2020-01-01", 10);
  const series = [
    { date: dateAxis[2], value: 1 },
    { date: dateAxis[5], value: 2 },
  ];
  const age = forwardFillAge(series, dateAxis);
  expect(age[0]).toBeNaN();
  expect(age[1]).toBeNaN();
  expect(age[2]).toBe(0); // real observation
  expect(age[3]).toBe(1);
  expect(age[4]).toBe(2);
  expect(age[5]).toBe(0); // resumed real observation resets immediately, no lag
  expect(age[6]).toBe(1);
  expect(age[9]).toBe(4);
});

test("MAX_FORWARD_FILL_DAYS is the single documented default horizon", () => {
  expect(MAX_FORWARD_FILL_DAYS).toBe(120);
  expect(Number.isFinite(MAX_FORWARD_FILL_DAYS)).toBe(true);
});

// ─── computeRegime: capped contribution end-to-end ───────────────────────────
//
// TARGET_ID is fed a genuine oscillating series for REAL_DAYS days (enough for
// rollingPercentileRank's >=30-observation floor), then goes silent for the
// rest of the axis except one resumed real print well past the horizon. Every
// OTHER registry indicator gets an all-NaN series (same technique
// regime-fidelity.test.ts uses for indicators absent from its fixture) so it's
// excluded via minValidObs — making TARGET_ID the ONLY valid macro indicator,
// and the macro panel index a direct, unambiguous readout of whether
// TARGET_ID's forward-filled value is still contributing that day.
const TARGET_ID = "T10Y2Y"; // macro panel, sign +1
const REAL_DAYS = 300;
const CAP = 10; // small horizon so the test stays fast and readable

function scenario() {
  const dateAxis = buildAxis("2020-01-01", REAL_DAYS + 60);
  const series: { date: string; value: number }[] = [];
  for (let i = 0; i < REAL_DAYS; i++) {
    series.push({ date: dateAxis[i], value: 1 + Math.sin(i / 7) }); // genuine spread, band ~[0,2]
  }
  const recoveryIdx = REAL_DAYS + CAP + 15; // well past the horizon
  const recoveryValue = 9.5; // far outside the oscillation band — unmistakably a NEW print
  series.push({ date: dateAxis[recoveryIdx], value: recoveryValue });

  const aligned = alignDailyForwardFill(series, dateAxis);
  const age = forwardFillAge(series, dateAxis);

  const panelData: Record<string, number[]> = {};
  const nanSeries = new Array(dateAxis.length).fill(NaN);
  for (const ind of INDICATORS) {
    panelData[ind.id] = ind.id === TARGET_ID ? aligned : nanSeries.slice();
  }
  return { dateAxis, panelData, ages: { [TARGET_ID]: age }, recoveryIdx };
}

test("computeRegime: forward-filled value contributes through the horizon, is excluded immediately after, and resumes on a fresh real observation", () => {
  const { dateAxis, panelData, ages, recoveryIdx } = scenario();

  const capped = computeRegime(panelData, dateAxis, ["macro"], ages, CAP);
  // No `ages` passed → legacy, unbounded forward-fill: exactly what a reverted
  // ("planted uncapped forward-fill") implementation would compute.
  const uncapped = computeRegime(panelData, dateAxis, ["macro"]);

  const atHorizon = REAL_DAYS - 1 + CAP; // age === CAP exactly (inclusive boundary)
  const beforeHorizon = atHorizon - 1; // age === CAP - 1
  const justPastHorizon = atHorizon + 1; // age === CAP + 1

  // No divergence is possible yet at or before the horizon: neither run has
  // masked anything through this index, so the two pipelines see identical
  // inputs and must agree exactly.
  expect(Number.isFinite(capped.macroIndex![beforeHorizon])).toBe(true);
  expect(capped.macroIndex![beforeHorizon]).toBeCloseTo(uncapped.macroIndex![beforeHorizon]!, 9);

  expect(Number.isFinite(capped.macroIndex![atHorizon])).toBe(true);
  expect(capped.macroIndex![atHorizon]).toBeCloseTo(uncapped.macroIndex![atHorizon]!, 9);

  // Immediately past the horizon: TARGET_ID is the ONLY valid macro indicator
  // and has now gone stale beyond the configured maximum age, so the capped
  // composite has nothing left to weight that day and reads NaN. The uncapped
  // ("planted regression") pipeline keeps dragging the frozen value forward and
  // stays finite — this assertion is exactly what fails if the cap is reverted.
  expect(Number.isFinite(capped.macroIndex![justPastHorizon])).toBe(false);
  expect(Number.isFinite(uncapped.macroIndex![justPastHorizon])).toBe(true);

  // Recovery: a fresh real observation re-enters normally. The extreme
  // recovery value (9.5, far outside the [0,2] oscillation band) ranks near
  // the top of TARGET_ID's own history in EITHER pipeline, so both read a
  // high, finite panel index again — contribution is restored, not carried
  // forward from the stale frozen level.
  expect(Number.isFinite(capped.macroIndex![recoveryIdx])).toBe(true);
  expect(capped.macroIndex![recoveryIdx]!).toBeGreaterThan(0.9);
  expect(uncapped.macroIndex![recoveryIdx]!).toBeGreaterThan(0.9);
});

test("computeRegime: omitting `ages` (every existing call site) preserves current, uncapped behaviour exactly", () => {
  const { dateAxis, panelData } = scenario();
  const a = computeRegime(panelData, dateAxis, ["macro"]);
  const b = computeRegime(panelData, dateAxis, ["macro"]);
  const last = dateAxis.length - 1;
  expect(a.macroIndex![last]).toBe(b.macroIndex![last]);
  expect(Number.isFinite(a.macroIndex![last])).toBe(true); // still forward-filling unbounded, as before #402
});

// ─── AC3: exhausted forward-fill degrades visibly through the real production
// pipeline's provenance contract, rather than silently vanishing ───────────────
//
// Drives the REAL orchestrator (runAnalytics) through the REAL `liveDataSource`
// with every network fetch forced to fail (same technique as
// prod-honesty.test.ts). One macro indicator (VIX) gets a healthy, current
// floor so the macro panel/composite still classifies on `asof` (otherwise the
// day would have zero classifiable panels and buildSnapshotRows would skip it
// entirely — a floor-quality problem unrelated to this feature). The OTHER
// macro indicator under test (T10Y2Y) gets a genuinely OLD floor — its last
// real print is well beyond MAX_FORWARD_FILL_DAYS before `asof`. Every other
// registry indicator is left with no history at all (excluded via
// minValidObs, the existing no-data path — not this feature).
//
// Asserts the persisted snapshot's rich per-indicator object for the stale id:
//   - still carries its honest raw_value/raw_date (existing provenance field,
//     unchanged — this is NOT hidden or deleted),
//   - additionally surfaces forward_fill_age_days/forward_fill_expired so the
//     degradation is visible rather than presented as current, and
//   - has been excluded from that day's contribution (percentile/signed_percentile
//     null), tying AC1's composite-exclusion effect and AC3's provenance
//     surfacing together in one real end-to-end run.
test(
  "runAnalytics (LIVE path): an indicator whose real floor is older than the forward-fill horizon is served as visibly degraded, not current",
  async () => {
    await sql`DELETE FROM raw_indicator_history`;

    const asof = "2026-06-29";
    const STALE_ID = "T10Y2Y";
    const HEALTHY_ID = "VIX";

    // Last real print well past MAX_FORWARD_FILL_DAYS before asof — genuinely dead.
    const lastRealDate = "2025-09-01";
    const expectedAge = Math.round(
      (Date.parse(`${asof}T00:00:00Z`) - Date.parse(`${lastRealDate}T00:00:00Z`)) / 86_400_000,
    );
    expect(expectedAge).toBeGreaterThan(MAX_FORWARD_FILL_DAYS);

    const staleFloor = [
      { date: "2025-08-28", value: 0.3 },
      { date: "2025-08-29", value: 0.29 },
      { date: "2025-08-30", value: 0.31 },
      { date: lastRealDate, value: 0.32 },
    ];
    // A genuinely healthy, current floor ending the day before asof (age=1,
    // well within the horizon). Long enough (~3.3y) that inverseCorrelationWeights'
    // own minValidObs=60 floor is comfortably met at every periodic (21-day)
    // weight-refresh checkpoint, not just on asof itself — otherwise the macro
    // panel would go NaN (zero valid indicators) on most refresh windows and
    // the composite/regime would never accumulate the classifiable history
    // smoothRegimes needs, independent of anything this feature changes.
    const healthyFloor = Array.from({ length: 1200 }, (_, k) => ({
      date: addDays(asof, k - 1200),
      value: 18 + 4 * Math.sin(k / 6),
    }));
    await saveRawIndicatorHistory({ [STALE_ID]: staleFloor, [HEALTHY_ID]: healthyFloor });

    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = () => Promise.reject(new Error("network disabled for forward-fill-cap test"));
    try {
      await runAnalytics(asof, "regime", liveDataSource, directAnalyticsPersistence);
    } finally {
      (globalThis as any).fetch = origFetch;
    }

    const [row] = await sql`SELECT indicators FROM regime_snapshots WHERE date = ${asof}`;
    expect(row).toBeTruthy();
    // #450: type the persisted payload as the contract's RegimeIndicator[] (not
    // `any[]`) so every property access below is checked against the declared
    // interface — if forward_fill_age_days/forward_fill_expired were ever
    // dropped from contract/src/dashboards.d.ts, this file would fail
    // `bun run typecheck`, not just this runtime assertion.
    const inds = row.indicators as RegimeIndicator[];
    const stale: RegimeIndicator | undefined = inds.find((i) => i.id === STALE_ID);
    expect(stale).toBeTruthy();
    const staleIndicator = stale as RegimeIndicator;

    // Existing provenance is preserved verbatim — not hidden.
    expect(staleIndicator.raw_value).toBe(0.32);
    expect(staleIndicator.raw_date).toBe(lastRealDate);

    // New #402 provenance: visibly flagged as expired, with the real age.
    // Asserting on the typed field (RegimeIndicator['forward_fill_age_days'] is
    // `number | null`, ['forward_fill_expired'] is `boolean`) is the type-shape
    // proof that the runtime object satisfies the declared contract, not just
    // that these ad hoc property reads happen to succeed.
    const ageDays: RegimeIndicator["forward_fill_age_days"] = staleIndicator.forward_fill_age_days;
    const expired: RegimeIndicator["forward_fill_expired"] = staleIndicator.forward_fill_expired;
    expect(ageDays).toBe(expectedAge);
    expect(expired).toBe(true);

    // And actually excluded from that day's contribution (AC1), not merely
    // labeled — the rich object's own percentile/signed_percentile read null —
    // while the healthy indicator kept the panel alive and classifiable.
    expect(staleIndicator.percentile).toBeNull();
    expect(staleIndicator.signed_percentile).toBeNull();

    const healthy = inds.find((i) => i.id === HEALTHY_ID);
    expect(healthy).toBeTruthy();
    const healthyIndicator = healthy as RegimeIndicator;
    expect(healthyIndicator.forward_fill_expired).toBe(false);
    expect(healthyIndicator.percentile).not.toBeNull();
  },
  { timeout: 120_000 },
);
