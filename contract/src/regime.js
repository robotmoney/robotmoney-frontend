// CANONICAL regime-classification thresholds and label rule — the single source
// of truth for turning a composite score into a regime label. The canon is the
// analytics classifier (backend/src/analytics/analyze/regime.ts, historically
// 0.33/0.67); every other surface that labels a composite — the committee
// domain layer (backend/src/committee/domain.ts) and the committee memo builder
// (scripts/lib/committee/memo.ts) — MUST consume this module rather than re-deriving its own
// thresholds. Pure data + one pure function, zero runtime deps, so both the
// backend and the committee tooling can share it.
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
