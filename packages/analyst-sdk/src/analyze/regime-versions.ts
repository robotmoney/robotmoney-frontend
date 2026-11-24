import { ROLLING_WINDOW_DAYS } from "./indicators.ts";

// Methodology version tag stamped on every persisted regime snapshot row —
// mirrors agentjuno/robotmoney data/regime/regime-versions.json `current`.
//
// v3: point-in-time inverse-correlation weighting (the declared weight lookback
// per day, REGIME_LOOKBACK below; 21-day refresh, 25% cap) — every run recomputes the full history on
// best-available raw data. Raw input KEYS are never deleted, but
// raw_indicator_history VALUES are revised in place (ON CONFLICT DO UPDATE) when
// a fetched value differs beyond the D56 per-source tolerance; each revision is
// recorded in analytics_overwrite_events and source_value_versions. A run's
// recomputed history is kept in its frozen artifact (analytics_output_snapshots)
// and is not what readers are served: each day shows the figure published that
// day, frozen once the day is over (decision D83, issue 1182). See
// docs/technical/regime-engine.md section 8.1 and decision D59. The labels are
// cut on a second rolling rank, over the declared percentile lookback, of the
// composite and of each panel index.
//
// v4 (issue 1652, decisions D84 and D88; tagged v5 before D88): v3 with the regime label cut on the composite
// itself and each panel label on its panel index. The rolling ranks of the
// composite and the panel indices stay in the output as information only.
// Issue 1739 corrected v4 in place: its panel weights refit on a fixed 21-day
// calendar (REGIME_WEIGHT_REFRESH), never on the run's last day, which v3 keeps.
//
// Tags increase by one with no gaps (D88). The frozen, versioned publication
// model (docs/technical/regime-engine.md section 11.8.3, PD10) takes the next
// unused tag when it is built.
export const REGIME_VERSIONS = ["v3", "v4"] as const;
export type RegimeVersion = (typeof REGIME_VERSIONS)[number];
export const CURRENT_REGIME_VERSION: RegimeVersion = "v4";

/** True for a methodology version this engine can compute (and so replay). */
export function isRegimeVersion(v: unknown): v is RegimeVersion {
  return typeof v === "string" && (REGIME_VERSIONS as readonly string[]).includes(v);
}

/**
 * One lookback window of the regime engine (issue 1659). `trailing` is the
 * trailing `days` days ending on the day computed; `inception` is all history
 * from day 0 of the date axis, with no cap.
 */
export type LookbackWindow = { kind: "trailing"; days: number } | { kind: "inception" };

/**
 * The lookback windows of one methodology version: `rank` is the indicator
 * rank window, `weight` the panel weight window, `percentile` the window of the
 * composite and panel percentiles (which cut the label under v3).
 */
export interface RegimeLookback {
  rank: LookbackWindow;
  weight: LookbackWindow;
  percentile: LookbackWindow;
}

const TRAILING_3Y: LookbackWindow = Object.freeze({ kind: "trailing", days: ROLLING_WINDOW_DAYS });

/** The declared lookback of every methodology version (issue 1659). */
export const REGIME_LOOKBACK: Readonly<Record<RegimeVersion, RegimeLookback>> = Object.freeze({
  v3: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
  v4: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
});

/**
 * The panel weight refresh rule of one methodology version (issue 1739): refit
 * every `intervalDays` days on a fixed calendar that starts at `anchor`, so a
 * day's weights never depend on the run that computes it. `refitOnLastDay`
 * keeps the legacy refit on the run's last axis day: only v3 sets it.
 */
export interface WeightRefresh {
  intervalDays: number;
  /** Calendar date of day 0 of the refresh calendar (the regime backfill start). */
  anchor: string;
  refitOnLastDay: boolean;
}

export const WEIGHT_REFRESH_ANCHOR = "2018-01-01";

export const REGIME_WEIGHT_REFRESH: Readonly<Record<RegimeVersion, WeightRefresh>> = Object.freeze({
  v3: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: true }),
  v4: Object.freeze({ intervalDays: 21, anchor: WEIGHT_REFRESH_ANCHOR, refitOnLastDay: false }),
});

const MS_PER_DAY = 86_400_000;
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);

/** The latest refresh date on or before `day`; null before the anchor. */
export function refreshDateOn(day: string, refresh: WeightRefresh): string | null {
  const n = dayNumber(day) - dayNumber(refresh.anchor);
  if (!Number.isFinite(n)) throw new RangeError(`bad day ${JSON.stringify(day)}`);
  if (n < 0) return null;
  const fit = dayNumber(refresh.anchor) + Math.floor(n / refresh.intervalDays) * refresh.intervalDays;
  return new Date(fit * MS_PER_DAY).toISOString().slice(0, 10);
}

/** True when `day` is a refresh date of the calendar. */
export function isRefreshDate(day: string, refresh: WeightRefresh): boolean {
  return refreshDateOn(day, refresh) === day;
}
