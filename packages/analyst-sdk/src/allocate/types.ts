// The rule file (issue 1401): a model portfolio as data, so a member can change
// it without touching the SDK. A rule file holds weights either per regime state
// (`states`) or as an engine spec (`engine`: neutral weights plus a bounded tilt
// per risky sleeve and a dollar book filled by yield). Caps are never in the
// rule file: they come from the universe (universe.ts). rules.ts validates a
// file; the engine (issue 1403) turns an engine spec into weights.
//
// Pure types, no I/O.
import type { RegimeState } from "./labels.ts";
import type { Holdings } from "./universe.ts";

/** reference: the model portfolio; hypothesis: a proposal; comparison: a row to compare against. */
export type RuleStatus = "reference" | "hypothesis" | "comparison";
export const RULE_STATUSES: readonly RuleStatus[] = ["reference", "hypothesis", "comparison"];

/**
 * Which label picks the state of a `states` rule: the composite label, the
 * conservative or aggressive panel vote (AsofLabel, issue 1399), or `fixed`
 * (no label: the `neutral` weights every decision, the portfolio held still).
 */
export type LabelSource = "composite" | "conservative" | "aggressive" | "fixed";
export const LABEL_SOURCES: readonly LabelSource[] = ["composite", "conservative", "aggressive", "fixed"];

export const RULE_STATES: readonly RegimeState[] = ["risk_off", "neutral", "risk_on"];

/**
 * When to trade back to the target: a holding has drifted when it is more than
 * max(points, relative x target) away from its target weight. `byHolding`
 * overrides `points` for one holding (for example 3 for Bitcoin).
 */
export interface DriftRule {
  /** Percentage points of NAV. */
  points: number;
  /** A fraction of the target weight, 0 to 1. */
  relative: number;
  byHolding?: Record<string, number>;
}

/** One risky sleeve of an engine rule: one holding, tilted by one signal inside its band. */
export interface EngineSleeve {
  /** The universe asset id the sleeve holds (BTC, GOLD, ...). */
  holding: string;
  /** A signal name (signals.ts grammar), for example `composite` or `inverse(composite)`. */
  signal: string;
  /** Band floor and ceiling, percent of NAV; the neutral weight lies inside. */
  min: number;
  max: number;
  /** z = (signal - 0.5) / scale; 0.17 puts z = 1 at the composite's risk_on edge. */
  scale: number;
  /** Optional volatility target, annualized percent: weight x target / realized 60-day volatility. */
  volTarget?: number;
}

export interface EngineSpec {
  /** The neutral portfolio, percent of NAV, summing to 100. */
  neutral: Holdings;
  sleeves: EngineSleeve[];
  /** The cash holding that keeps its neutral weight and takes what the dollar book cannot place. */
  buffer: string;
  dollarBook: {
    /** The instruments the yield program fills, highest trailing yield first; ties keep this order. */
    instruments: string[];
    /** The trailing window for the yield, in days. */
    trailingDays: number;
  };
}

interface RuleFileBase {
  id: string;
  name: string;
  author: string;
  /** YYYY-MM-DD. */
  date: string;
  status: RuleStatus;
  description?: string;
  drift: DriftRule;
}

/** Weights per regime state. With `label: "fixed"` only `neutral` is present. */
export interface StatesRuleFile extends RuleFileBase {
  label: LabelSource;
  states: Partial<Record<RegimeState, Holdings>>;
}

/** Weights from the engine; the sleeves name their own signals, so there is no label. */
export interface EngineRuleFile extends RuleFileBase {
  engine: EngineSpec;
}

export type RuleFile = StatesRuleFile | EngineRuleFile;
