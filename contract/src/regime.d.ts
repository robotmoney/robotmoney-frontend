// Types for the canonical regime-classification module (see regime.js).

export type RegimeLabel = "risk_off" | "neutral" | "risk_on";

export const REGIME_RISK_OFF: number;
export const REGIME_RISK_ON: number;

export interface RegimeMethod {
  readonly id: "composite-v1";
  readonly inputs: readonly ["macro", "onchain"];
  readonly context: "trailing-3y-rolling-percentile";
  readonly basis: "utc-daily-close";
  readonly cuts: {
    readonly risk_off: 0.33;
    readonly risk_on: 0.67;
  };
}

export const REGIME_METHOD: RegimeMethod;

/**
 * Classify a regime composite score into its canonical label.
 * composite < REGIME_RISK_OFF → "risk_off"; composite >= REGIME_RISK_ON → "risk_on"; else "neutral".
 */
export function classifyRegime(composite: number): RegimeLabel;

