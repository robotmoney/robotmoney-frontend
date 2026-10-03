// Methodology version tag stamped on every persisted regime snapshot row —
// mirrors agentjuno/robotmoney data/regime/regime-versions.json `current`.
//
// v3: point-in-time inverse-correlation weighting (trailing 3y window per day,
// 21-day refresh, 25% cap), no frozen lockout — every run recomputes the full
// history on best-available raw data. Raw inputs remain strictly append-only
// (raw_indicator_history via mergeSeries); only the DERIVED labels are recomputed.
export const CURRENT_REGIME_VERSION = "v3";
