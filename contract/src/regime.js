// CANONICAL regime-classification thresholds and label rule — the single source
// of truth for turning a composite score into a regime label (0.33/0.67). The
// PRODUCTION classifier that PRODUCES the composite this module labels is
// `bucketFn` in backend/src/analytics/analyze/compute.ts, invoked from
// analytics/index.ts::runAnalytics — see docs/technical/regime-engine.md §5/§7
// for the full pipeline. backend/src/analytics/analyze/regime.ts (`regimeTool`)
// is a DEAD, unused, structurally different alternative classifier (11
// hardcoded indicators, 90-day window, static weights) — do not follow it as
// "the canon" (a stale pointer here previously did; see
// docs/audits/v0-v1-parity/A1-regime-core-procedures.md finding F4 and that
// file's own corrected header). Every surface that labels a composite — the
// swarm domain layer (backend/src/swarm/domain.ts) and the swarm memo builder
// (scripts/lib/swarm/memo.ts) — MUST consume this module rather than
// re-deriving its own thresholds. Pure data + one pure function, zero runtime
// deps, so both the backend and the swarm tooling can share it.
//
// Vocabulary note: labels are underscore-cased ("risk_off"/"risk_on") — the
// wire/DB vocabulary. Prose surfaces that render hyphenated forms ("risk-on")
// must map from these labels (e.g. label.replace(/_/g, "-")), never reclassify.

export const REGIME_RISK_OFF = 0.33;
export const REGIME_RISK_ON = 0.67;

/**
 * Classify a regime composite score into its canonical label.
 * composite < 0.33 → "risk_off"; composite >= 0.67 → "risk_on"; else "neutral".
 * @param {number} composite
 * @returns {"risk_off" | "neutral" | "risk_on"}
 */
export function classifyRegime(composite) {
  return composite < REGIME_RISK_OFF ? "risk_off" : composite >= REGIME_RISK_ON ? "risk_on" : "neutral";
}
