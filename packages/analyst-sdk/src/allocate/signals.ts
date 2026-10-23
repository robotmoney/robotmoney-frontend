// Sleeve signals (issue 1402): the signal a sleeve moves on, named in the rule
// file. A name is parsed once (parseSignalName, shared with the rule-file
// validator) and read against one decision's inputs (signalPercentile), which
// gives a percentile from 0 to 1, high meaning risk-on, or null when the data is
// missing. The engine treats null as neutral: signalOrNeutral maps it to 0.5,
// which is a tilt of zero.
//
// Grammar:
//   composite                     the composite percentile
//   macro | onchain               a panel's percentile (every id in PANELS)
//   indicator:<ID>                a registry indicator (every id in INDICATORS)
//   research:channel_divergence   the channel-divergence composite gauge
//   research:late_cycle           1 - the mean late-cycle gauge percentile
//   mean(<a>,<b>,...)             the mean of two or more signals' non-null values
//   inverse(<x>)                  1 - x
//
// Indicator values come from AsofLabel.indicators, which is the regime's signed
// series: the registry sign is already applied there (1399), so it is not
// applied again here.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
import { INDICATORS, PANELS } from "../analyze/indicators.ts";
import type { ResearchPayload } from "../analyze/research.ts";
import type { AsofLabel } from "./labels.ts";

export type ResearchSignalId = "channel_divergence" | "late_cycle";
export const RESEARCH_SIGNALS: readonly ResearchSignalId[] = ["channel_divergence", "late_cycle"];

/** A parsed signal name. */
export type Signal =
  | { kind: "composite" }
  | { kind: "panel"; panel: string }
  | { kind: "indicator"; id: string }
  | { kind: "research"; id: ResearchSignalId }
  | { kind: "mean"; of: Signal[] }
  | { kind: "inverse"; of: Signal };

/** A name that does not parse, with the reason. */
export class SignalNameError extends Error {}

const INDICATOR_IDS = new Set(INDICATORS.map((i) => i.id));
const PANEL_IDS = new Set<string>(PANELS);

/** Split a call's argument text on the commas at depth 0. */
function splitArgs(s: string, name: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) throw new SignalNameError(`unbalanced ")" in signal ${JSON.stringify(name)}`);
    } else if (c === "," && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  if (depth !== 0) throw new SignalNameError(`unbalanced "(" in signal ${JSON.stringify(name)}`);
  out.push(s.slice(from));
  return out;
}

/**
 * Parse a signal name. Throws SignalNameError on an unknown name, an unknown
 * indicator or research id, `mean` with fewer than two arguments, or `inverse`
 * with other than one. Whitespace around names and arguments is ignored.
 */
export function parseSignalName(name: string): Signal {
  if (typeof name !== "string") throw new SignalNameError(`signal name must be a string, got ${typeof name}`);
  const s = name.trim();
  const call = /^(mean|inverse)\s*\(([\s\S]*)\)$/.exec(s);
  if (call) {
    const fn = call[1]!;
    const body = call[2]!;
    const args = body.trim() === "" ? [] : splitArgs(body, name);
    if (args.some((a) => a.trim() === "")) throw new SignalNameError(`empty argument in signal ${JSON.stringify(name)}`);
    if (fn === "mean") {
      if (args.length < 2) throw new SignalNameError(`mean() needs at least two signals, got ${args.length} in ${JSON.stringify(name)}`);
      return { kind: "mean", of: args.map(parseSignalName) };
    }
    if (args.length !== 1) throw new SignalNameError(`inverse() takes exactly one signal, got ${args.length} in ${JSON.stringify(name)}`);
    return { kind: "inverse", of: parseSignalName(args[0]!) };
  }
  if (s === "composite") return { kind: "composite" };
  if (PANEL_IDS.has(s)) return { kind: "panel", panel: s };
  if (s.startsWith("indicator:")) {
    const id = s.slice("indicator:".length);
    if (!INDICATOR_IDS.has(id)) throw new SignalNameError(`unknown indicator ${JSON.stringify(id)} in signal ${JSON.stringify(name)}`);
    return { kind: "indicator", id };
  }
  if (s.startsWith("research:")) {
    const id = s.slice("research:".length);
    if (!(RESEARCH_SIGNALS as readonly string[]).includes(id)) {
      throw new SignalNameError(`unknown research signal ${JSON.stringify(id)} in signal ${JSON.stringify(name)}`);
    }
    return { kind: "research", id: id as ResearchSignalId };
  }
  throw new SignalNameError(`unknown signal ${JSON.stringify(name)}`);
}

/** The research signals on one decision's as-of day, 0..1 with high meaning risk-on, or null. */
export type ResearchSignalValues = Record<ResearchSignalId, number | null>;

/** What a signal reads: one as-of label, plus the research signals when the caller has them. */
export type SignalInputs = Pick<AsofLabel, "compositePercentile" | "panels" | "indicators"> & {
  research?: Partial<ResearchSignalValues>;
};

const finite = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const LATE_CYCLE_GAUGES = ["CONCENTRATION", "TOP7_VS_SPY", "MNA", "MARGIN", "CONF"];

/**
 * The research signals from the payloads of computeChannelDivergence and
 * computeLateCycle, each computed as-of the decision's as-of day.
 * channel_divergence: the CHANNEL gauge percentile (high = channel intact).
 * late_cycle: 1 - the mean of the late-cycle gauge percentiles, so high means
 * early in the cycle (risk-on); `inverse(research:late_cycle)` reads saturation.
 * A missing payload or gauge gives null.
 */
export function researchSignalValues(
  channel?: Pick<ResearchPayload, "gauges"> | null,
  lateCycle?: Pick<ResearchPayload, "gauges"> | null,
): ResearchSignalValues {
  const ch = finite(channel?.gauges.find((g) => g.id === "CHANNEL")?.percentile);
  const lc = (lateCycle?.gauges ?? [])
    .filter((g) => LATE_CYCLE_GAUGES.includes(g.id))
    .map((g) => finite(g.percentile))
    .filter((v): v is number => v !== null);
  return {
    channel_divergence: ch,
    late_cycle: lc.length ? 1 - lc.reduce((a, b) => a + b, 0) / lc.length : null,
  };
}

function evaluate(sig: Signal, s: SignalInputs): number | null {
  switch (sig.kind) {
    case "composite":
      return finite(s.compositePercentile);
    case "panel":
      return finite(s.panels[sig.panel]?.percentile);
    case "indicator":
      return finite(s.indicators[sig.id]);
    case "research":
      return finite(s.research?.[sig.id]);
    case "mean": {
      const xs = sig.of.map((x) => evaluate(x, s)).filter((v): v is number => v !== null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
    case "inverse": {
      const v = evaluate(sig.of, s);
      return v === null ? null : 1 - v;
    }
  }
}

/**
 * The signal's percentile for one decision, 0..1 with high meaning risk-on, or
 * null when its data is missing. `mean` averages the values it has and is null
 * only when all are missing. Throws SignalNameError on an unknown name.
 */
export function signalPercentile(name: string | Signal, inputs: SignalInputs): number | null {
  return evaluate(typeof name === "string" ? parseSignalName(name) : name, inputs);
}

/** The percentile that means no tilt. */
export const NEUTRAL_SIGNAL = 0.5;

/** How the engine reads a signal: a missing value (null) is neutral, so the sleeve does not tilt. */
export function signalOrNeutral(p: number | null): number {
  return p === null || !Number.isFinite(p) ? NEUTRAL_SIGNAL : p;
}
