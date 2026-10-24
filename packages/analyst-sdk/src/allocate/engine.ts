// The allocation engine (issue 1403): an engine rule file (types.ts), the
// signals for one decision and the recent yields in, weights per holding out,
// summing to 100. Ported from the prototype (draft PR 1397, src/allocate/engine.ts)
// with caps taken from the universe instead of the rule file.
//
//   1. Each risky sleeve: weight = neutral + band x tanh(z), z = (signal - 0.5) / scale,
//      where band is max - neutral on the way up and neutral - min on the way down.
//      A missing signal (null) is neutral: z = 0, no tilt.
//   2. Optional volatility scaling: weight x volTarget / realized 60-day volatility,
//      the factor bounded to 0.5..1.5 and the result to the band.
//   3. Within a sleeve: a seam (WithinSleeve) splits the sleeve weight over its
//      assets; equal weight by default. Each sleeve holds one asset today.
//   4. The dollar book takes 100 - sleeves - buffer: highest trailing yield first,
//      each instrument up to its own cap and the room left in its groups (both from
//      the universe). What the caps cannot place stays in the buffer.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
import { parseSignalName, signalOrNeutral, signalPercentile, type ResearchSignalId, type Signal, type SignalInputs } from "./signals.ts";
import type { EngineRuleFile, EngineSleeve } from "./types.ts";
import type { Holdings, Universe } from "./universe.ts";

/** An engine input the rule needs but the caller did not pass. */
export class EngineInputError extends Error {
  override readonly name = "EngineInputError";
}

/**
 * What the engine reads for one decision: the signal inputs (one AsofLabel plus
 * research values when a sleeve uses a `research:` signal) and, for a sleeve with
 * a volTarget, the realized 60-day volatility per holding (annualized percent).
 * A value of null means the data is missing that day: the signal is neutral, or
 * the sleeve is not volatility-scaled.
 */
export type EngineSignals = SignalInputs & { realizedVol?: Record<string, number | null> };

/** Trailing yield per dollar-book instrument, percent per year. Missing or non-finite ranks last. */
export type Yields = Record<string, number | null>;

/** Splits a sleeve's weight over the sleeve's assets. */
export type WithinSleeve = (weight: number, assets: readonly string[]) => Holdings;

/** The default within-sleeve method: every asset gets an equal share. */
export const equalWeight: WithinSleeve = (weight, assets) =>
  Object.fromEntries(assets.map((a) => [a, weight / assets.length]));

export interface EngineOptions {
  /** The within-sleeve method; equalWeight by default. */
  withinSleeve?: WithinSleeve;
}

/** One sleeve's week, so a trace can explain it. */
export interface SleeveTrace {
  holding: string;
  signal: string;
  /** The signal's percentile as read, or null when its data is missing. */
  value: number | null;
  z: number;
  /** tanh(z), -1..1. */
  tilt: number;
  /** neutral + band x tilt, before volatility scaling. */
  tiltedWeight: number;
  /** The bounded volatility factor applied, or null when the sleeve was not scaled. */
  volScale: number | null;
  /** The sleeve's final weight. */
  weight: number;
}

export interface EngineOutput {
  /** Percent of NAV per holding, summing to 100. */
  weights: Holdings;
  sleeves: SleeveTrace[];
  dollarBook: {
    /** 100 - sleeves - the buffer's neutral weight. */
    total: number;
    /** The part the caps could not place; it is in the buffer's weight. */
    unplaced: number;
  };
}

const EPS = 1e-9;

/**
 * A sleeve's tilted weight for one signal value. The value is clamped to 0..1
 * (signals are not clamped upstream); null, NaN or Infinity is neutral.
 */
export function tiltWeight(sleeve: EngineSleeve, neutral: number, value: number | null): { weight: number; z: number; tilt: number } {
  const p = Math.min(1, Math.max(0, signalOrNeutral(value)));
  const z = (p - 0.5) / sleeve.scale;
  const tilt = Math.tanh(z);
  const band = tilt >= 0 ? sleeve.max - neutral : neutral - sleeve.min;
  const weight = Math.min(sleeve.max, Math.max(sleeve.min, neutral + band * tilt));
  return { weight, z, tilt };
}

/**
 * Fill `total` percent over the instruments, highest yield first (ties keep the
 * listed order), each up to its universe cap and the room left in every universe
 * group it belongs to. `held` is weight already placed outside the book (sleeves,
 * buffer) that counts against group caps. Returns the instrument weights and the
 * part no cap leaves room for.
 */
export function fillYieldBook(
  total: number,
  yields: Yields,
  instruments: readonly string[],
  universe: Universe,
  held: Holdings = {},
): { weights: Holdings; unplaced: number } {
  const assets = new Map(universe.assets.map((a) => [a.id, a]));
  const rank = (h: string) => {
    const y = yields[h];
    return typeof y === "number" && Number.isFinite(y) ? y : -Infinity;
  };
  const order = instruments.map((h, i) => ({ h, i, y: rank(h) })).sort((a, b) => (b.y - a.y) || (a.i - b.i));
  const room = new Map(universe.groups.map((g) => [g.id, g.cap - g.members.reduce((s, m) => s + (held[m] ?? 0), 0)]));
  const weights: Holdings = {};
  let left = total;
  for (const { h } of order) {
    const asset = assets.get(h);
    if (!asset) throw new EngineInputError(`dollar book: ${h} is not in the universe, so it has no cap`);
    if (left <= EPS) { weights[h] = 0; continue; }
    let take = Math.min(asset.maxWeight, left);
    const groups = universe.groups.filter((g) => g.members.includes(h));
    for (const g of groups) take = Math.min(take, room.get(g.id)!);
    take = Math.max(0, take);
    weights[h] = take;
    left -= take;
    for (const g of groups) room.set(g.id, room.get(g.id)! - take);
  }
  return { weights, unplaced: left > EPS ? left : 0 };
}

/** The research ids a signal reads. */
function researchIds(sig: Signal, out: Set<ResearchSignalId> = new Set()): Set<ResearchSignalId> {
  if (sig.kind === "research") out.add(sig.id);
  else if (sig.kind === "mean") for (const x of sig.of) researchIds(x, out);
  else if (sig.kind === "inverse") researchIds(sig.of, out);
  return out;
}

/**
 * The weights for one decision. Throws EngineInputError when a sleeve reads a
 * `research:` signal and `signals.research` does not carry that id (pass null
 * for a day the data is missing), when a sleeve with a volTarget has no entry in
 * `signals.realizedVol` (null for a missing day), or when a dollar-book
 * instrument is not in the universe.
 */
export function engineWeights(
  rule: EngineRuleFile,
  signals: EngineSignals,
  yields: Yields,
  universe: Universe,
  opts: EngineOptions = {},
): EngineOutput {
  const { engine } = rule;
  const within = opts.withinSleeve ?? equalWeight;
  const weights: Holdings = {};
  const sleeves: SleeveTrace[] = [];
  let risky = 0;
  for (const s of engine.sleeves) {
    const sig = parseSignalName(s.signal);
    for (const id of researchIds(sig)) {
      if (signals.research?.[id] === undefined) {
        throw new EngineInputError(
          `sleeve ${s.holding}: signal ${s.signal} reads research:${id}, but no research value was passed (signals.research.${id}; null for a missing day)`,
        );
      }
    }
    const neutral = engine.neutral[s.holding]!;
    const value = signalPercentile(sig, signals);
    const t = tiltWeight(s, neutral, value);
    let weight = t.weight;
    let volScale: number | null = null;
    if (s.volTarget !== undefined) {
      const rv = signals.realizedVol?.[s.holding];
      if (rv === undefined) {
        throw new EngineInputError(
          `sleeve ${s.holding}: volTarget is set, but no realized volatility was passed (signals.realizedVol.${s.holding}; null for a missing day)`,
        );
      }
      if (rv !== null && Number.isFinite(rv) && rv > 0) {
        volScale = Math.min(1.5, Math.max(0.5, s.volTarget / rv));
        weight = Math.min(s.max, Math.max(s.min, weight * volScale));
      }
    }
    Object.assign(weights, within(weight, [s.holding]));
    risky += weight;
    sleeves.push({ holding: s.holding, signal: s.signal, value, z: t.z, tilt: t.tilt, tiltedWeight: t.weight, volScale, weight });
  }
  const buffer = engine.neutral[engine.buffer]!;
  const total = 100 - risky - buffer;
  const book = fillYieldBook(total, yields, engine.dollarBook.instruments, universe, { ...weights, [engine.buffer]: buffer });
  Object.assign(weights, book.weights);
  weights[engine.buffer] = buffer + book.unplaced;
  return { weights, sleeves, dollarBook: { total, unplaced: book.unplaced } };
}
