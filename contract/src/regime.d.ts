// Types for the canonical regime-classification module (see regime.js).

export type RegimeLabel = "risk_off" | "neutral" | "risk_on";

export const REGIME_RISK_OFF: number;
export const REGIME_RISK_ON: number;

/**
 * Classify a regime composite score into its canonical label.
 * composite < REGIME_RISK_OFF → "risk_off"; composite >= REGIME_RISK_ON → "risk_on"; else "neutral".
 */
export function classifyRegime(composite: number): RegimeLabel;
