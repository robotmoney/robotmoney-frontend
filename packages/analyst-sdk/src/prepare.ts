// Raw indicator history -> the arrays computeRegime consumes. This is the one
// place the date axis, per-indicator alignment, transform and forward-fill age
// are built; backend/src/analytics/index.ts (production) and runRegime (the SDK)
// both call it, so they cannot drift. Pure: no filesystem, environment or database.
// Semantics: docs/technical/regime-engine.md section 8.1; decision D59 in docs/decisions.md.
// Guarded by backend/tests/regime-sdk-equivalence.test.ts.
import type { RawIndicatorHistory } from "./types.ts";
import { INDICATORS, type Indicator } from "./analyze/indicators.ts";
import { alignDailyForwardFill, alignDailyZeroFill, buildDateAxis, forwardFillAge } from "./transform/math.ts";
import { applyTransform } from "./transform/transforms.ts";

export interface PreparedRegimeInputs {
  dateAxis: string[];
  transformed: Record<string, number[]>;
  // Days since the last real observation, per indicator that is NOT zero_fill.
  // zero_fill indicators are left out: a gap there is a real 0, never capped.
  ages: Record<string, number[]>;
  // Last row of each input series as given (null when empty). Not cut at asof.
  lastRaw: Record<string, { date: string; value: number } | null>;
}

// Rows on or before `asof`, in input order. Backtest extras (SPX, ETH, TBILL3M)
// do not go through the axis, so the backend job and runRegime both cut them with
// this before computeCorrelations/computeBacktest (issue #1162 Part 0: without the
// cut, a job run for a past as-of day read prices dated after it).
export function cutAtAsof<T extends { date: string }>(rows: readonly T[], asof: string): T[] {
  return rows.filter((r) => r.date <= asof);
}

// Axis start..asof (inclusive). Rows dated after asof never land on the axis, so
// they are ignored (indicator rows; backtest extras are cut with cutAtAsof above).
// An indicator with no rows is all-NaN (weight 0 downstream): the aligners return
// NaN for an empty series and no transform maps all-NaN to a number; both are
// pinned by tests/prepare.test.ts. `indicators` defaults to the registry; the
// research comparisons pass the registry they were handed.
export function prepareRegimeInputs(
  raw: RawIndicatorHistory,
  opts: { start: string; asof: string; indicators?: readonly Indicator[] },
): PreparedRegimeInputs {
  const dateAxis = buildDateAxis(opts.start, opts.asof);
  const transformed: Record<string, number[]> = {};
  const ages: Record<string, number[]> = {};
  const lastRaw: PreparedRegimeInputs["lastRaw"] = {};
  for (const ind of opts.indicators ?? INDICATORS) {
    const s = raw[ind.id] ?? [];
    lastRaw[ind.id] = s.length ? s[s.length - 1]! : null;
    const isZeroFill = ind.align === "zero_fill";
    if (!isZeroFill) ages[ind.id] = forwardFillAge(s, dateAxis);
    const aligner = isZeroFill ? alignDailyZeroFill : alignDailyForwardFill;
    transformed[ind.id] = applyTransform(ind.transform, aligner(s, dateAxis));
  }
  return { dateAxis, transformed, ages, lastRaw };
}
