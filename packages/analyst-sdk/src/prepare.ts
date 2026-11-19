// Raw indicator history -> the arrays computeRegime consumes. This is the one
// place the date axis, per-indicator alignment, transform and fill policy are
// applied; backend/src/analytics/index.ts (production) and runRegime (the SDK)
// both call it, so they cannot drift. Pure: no filesystem, environment or database.
// Semantics: docs/technical/regime-engine.md section 8.1; decision D59 in docs/decisions.md.
// Guarded by backend/tests/regime-sdk-equivalence.test.ts.
import type { RawIndicatorHistory } from "./types.ts";
import { INDICATORS, fillMaxAgeDays, fillPolicyOf, type Indicator } from "./analyze/indicators.ts";
import { alignDailyForwardFill, alignDailyZeroFill, buildDateAxis, forwardFillAge } from "./transform/math.ts";
import { applyTransform } from "./transform/transforms.ts";

export interface PreparedRegimeInputs {
  dateAxis: string[];
  // Post-transform values. A day an indicator misses beyond its fill policy
  // is NaN (missing) for that indicator (issue 1655).
  transformed: Record<string, number[]>;
  // Days since the last real observation, per indicator whose policy is NOT
  // zero. Zero-fill indicators are left out: a gap there is a real 0.
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
//
// Fill policy (issue 1655): every indicator must declare one, or this throws
// FillPolicyError naming it before any computation. The series is carried
// forward (or zero-filled) and transformed as before; then each day whose last
// real observation is older than the policy allows (none: 0 days, forward:
// maxAgeDays) is set to NaN, so it is missing for that indicator. This is the
// masking computeRegime once applied with the global cap, moved per indicator.
export function prepareRegimeInputs(
  raw: RawIndicatorHistory,
  opts: { start: string; asof: string; indicators?: readonly Indicator[] },
): PreparedRegimeInputs {
  const indicators = opts.indicators ?? INDICATORS;
  const policies = indicators.map((ind) => fillPolicyOf(ind));
  const dateAxis = buildDateAxis(opts.start, opts.asof);
  const transformed: Record<string, number[]> = {};
  const ages: Record<string, number[]> = {};
  const lastRaw: PreparedRegimeInputs["lastRaw"] = {};
  indicators.forEach((ind, k) => {
    const policy = policies[k]!;
    const s = raw[ind.id] ?? [];
    lastRaw[ind.id] = s.length ? s[s.length - 1]! : null;
    if (policy.kind === "zero") {
      transformed[ind.id] = applyTransform(ind.transform, alignDailyZeroFill(s, dateAxis));
      return;
    }
    const age = forwardFillAge(s, dateAxis);
    ages[ind.id] = age;
    const maxAge = fillMaxAgeDays(policy);
    transformed[ind.id] = applyTransform(ind.transform, alignDailyForwardFill(s, dateAxis)).map((v, i) =>
      age[i]! > maxAge ? NaN : v,
    );
  });
  return { dateAxis, transformed, ages, lastRaw };
}

// ── Day completeness (issue 1655) ────────────────────────────────────────────

export interface MissingIndicator {
  id: string;
  // Date of the indicator's last real observation on or before the day.
  lastObserved: string;
}

const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

// Per indicator, the ascending finite observation dates. An indicator with no
// observation on or before a day (a series that has not started) does not make
// that day incomplete: it is excluded with weight 0, as before.
function observedDates(raw: RawIndicatorHistory, indicators: readonly Indicator[]) {
  const out: { id: string; maxAge: number; dates: string[] }[] = [];
  for (const ind of indicators) {
    const maxAge = fillMaxAgeDays(fillPolicyOf(ind));
    const dates = (raw[ind.id] ?? []).filter((p) => Number.isFinite(p.value)).map((p) => p.date).sort();
    if (dates.length) out.push({ id: ind.id, maxAge, dates });
  }
  return out;
}

// Last element <= day, by binary search over ascending ISO dates.
function lastOnOrBefore(dates: string[], day: string): string | null {
  let lo = 0;
  let hi = dates.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= day) {
      found = dates[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function missingFrom(obs: ReturnType<typeof observedDates>, day: string): MissingIndicator[] {
  const missing: MissingIndicator[] = [];
  const d = dayNumber(day);
  for (const o of obs) {
    // Before an indicator's first observation it does not exist yet: not missing.
    if (o.dates[0]! > day) continue;
    const last = lastOnOrBefore(o.dates, day)!;
    if (d - dayNumber(last) > o.maxAge) missing.push({ id: o.id, lastObserved: last });
  }
  return missing;
}

/**
 * The indicators that make `day` incomplete: each one that has observations
 * but neither a real observation on `day` nor a value its fill policy allows.
 * Empty when the day is complete. Rows dated after `day` are ignored.
 */
export function missingOnDay(
  raw: RawIndicatorHistory,
  day: string,
  indicators: readonly Indicator[] = INDICATORS,
): MissingIndicator[] {
  return missingFrom(observedDates(raw, indicators), day);
}

/**
 * The latest complete day on or before `notAfter`, or null when none is. The
 * search starts at `notAfter` itself: under a forward policy a day after an
 * indicator's newest row can be complete. Without `notAfter` it starts at the
 * newest observation of any indicator. `notBefore` bounds it below (default:
 * the oldest observation).
 */
export function latestCompleteDay(
  raw: RawIndicatorHistory,
  opts: { notAfter?: string; notBefore?: string; indicators?: readonly Indicator[] } = {},
): string | null {
  const obs = observedDates(raw, opts.indicators ?? INDICATORS);
  if (obs.length === 0) return null;
  let newest = opts.notAfter ?? null;
  if (newest === null) for (const o of obs) if (newest === null || o.dates.at(-1)! > newest) newest = o.dates.at(-1)!;
  const floor = opts.notBefore ?? obs.reduce((m, o) => (o.dates[0]! < m ? o.dates[0]! : m), obs[0]!.dates[0]!);
  for (let t = dayNumber(newest!); t >= dayNumber(floor); t--) {
    const day = new Date(t * DAY_MS).toISOString().slice(0, 10);
    if (missingFrom(obs, day).length === 0) return day;
  }
  return null;
}
