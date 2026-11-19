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
// v4: reserved for the frozen, versioned publication model
// (docs/technical/regime-engine.md section 11.8.3, PD10). Never stamped here.
//
// v5 (issue 1652, decision D86): v3 with the regime label cut on the composite
// itself and each panel label on its panel index. The rolling ranks of the
// composite and the panel indices stay in the output as information only.
export const REGIME_VERSIONS = ["v3", "v5"] as const;
export type RegimeVersion = (typeof REGIME_VERSIONS)[number];
export const CURRENT_REGIME_VERSION: RegimeVersion = "v5";

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
  v5: Object.freeze({ rank: TRAILING_3Y, weight: TRAILING_3Y, percentile: TRAILING_3Y }),
});
