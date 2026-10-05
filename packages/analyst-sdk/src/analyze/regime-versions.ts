// Methodology version tag stamped on every persisted regime snapshot row —
// mirrors agentjuno/robotmoney data/regime/regime-versions.json `current`.
//
// v3: point-in-time inverse-correlation weighting (trailing 3y window per day,
// 21-day refresh, 25% cap), no frozen lockout — every run recomputes the full
// history on best-available raw data. Raw input KEYS are never deleted, but
// raw_indicator_history VALUES are revised in place (ON CONFLICT DO UPDATE) when
// a fetched value differs beyond the D56 per-source tolerance; each revision is
// recorded in analytics_overwrite_events and source_value_versions. The DERIVED
// labels are recomputed from whatever the raw values currently are, so
// regime_snapshots is a current view, not a record: what was published on a day
// survives only in the ledger payloads (analytics_output_snapshots). See
// docs/technical/regime-engine.md section 8.1 and decision D59.
export const CURRENT_REGIME_VERSION = "v3";
