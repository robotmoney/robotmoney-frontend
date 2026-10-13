// Allocation harness: the shapes a rule file, a weekly decision and a backtest share.
// Pure types, no I/O. A rule file is data: anyone can write one, the harness runs it.

export type State = "risk_off" | "neutral" | "risk_on";
export const STATES: State[] = ["risk_off", "neutral", "risk_on"];

import type { EngineSpec } from "./engine.ts";

// Weights in percent of NAV, keyed by the backtest series id (AAVE, SUSDS, GOLD, BTC, ...).
export type Weights = Record<string, number>;

// Which label picks the state: the composite (what members see in the brief), or
// Lex's panel votes from backtest.ts (conservative: risk_off if any panel says so;
// aggressive: majority).
export type LabelKind = "composite" | "conservative" | "aggressive";

// A tilt is a rule that moves one sleeve by one or more notches when a research
// signal fires. Signals come from research-signals.ts (Lex's previews).
export interface Tilt {
  id: string;
  sleeve: string; // the series the tilt moves, e.g. "BTC"
  signal: "channel_divergence" | "late_cycle";
  // What the tilt does when the signal fires, expressed on the state ladder.
  // "down_one_notch": the sleeve takes the weight of the state one notch lower
  //   (risk_on -> neutral, neutral -> risk_off). Freed weight goes to the yield book.
  // "halfway_to_neutral": the sleeve moves halfway from its state weight to its
  //   neutral weight.
  action: "down_one_notch" | "halfway_to_neutral";
  onlyIn?: State[]; // states the tilt applies in (default: all)
  params: Record<string, number>;
  reason: string;
}

export interface RuleFile {
  id: string;
  name: string;
  author: string;
  date: string;
  status: "reference" | "hypothesis" | "parked" | "ablation";
  description: string;
  label: LabelKind;
  // Decision calendar: every Monday, using the regime computed as-of the previous
  // Friday, applied at Monday's close. A frozen state (ablation) ignores the label.
  frozen?: State;
  states: Record<State, Weights>;
  // Series that make up the dollar-yield book, in the order freed weight is
  // redistributed (pro rata to the state's own book weights).
  yieldBook: string[];
  tilts?: Tilt[];
  // Per-state hard-asset volatility budget, points of expected vol above the yield
  // book, from the page's forward model. Metadata the page shows; not enforced here.
  hardAssetVolBudget?: Record<State, number>;
  // Drift band in points per series, overriding the CLI default (the page's rule: 3 for Bitcoin).
  driftPtsBySeries?: Record<string, number>;
  // When present, weights come from the engine (engine.ts) instead of `states`;
  // `states.neutral` then only names the series the weights CSV lists.
  engine?: EngineSpec;
}

export interface Decision {
  date: string; // Monday (trade date)
  asof: string; // Friday the regime was computed as-of
  label: State | null; // the label used (after frozen / kind)
  composite: State | null;
  conservative: State | null;
  aggressive: State | null;
  macro: State | null;
  onchain: State | null;
  compositePercentile: number | null;
  macroPercentile: number | null;
  tiltsFired: string[];
  weights: Weights;
}
