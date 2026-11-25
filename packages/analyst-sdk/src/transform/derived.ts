// Derived series (issue 1751, gap 7). Pure: no fs, env, db or network.
//
// A DerivedSeries declares, as plain data, a series computed from
// supplementary series, and deriveSeries computes it. The four ops reproduce
// the downstream FISCAL, SKEW, VIX_TERM and UPVOL_SHARE series bit for bit, so
// the order of every addition and division below is part of the contract.
//
// Every op takes an optional publication rule: each output date is moved to
// the day that value is published (publishedOn). Without one the dates stay.
import type { Point } from "../types.ts";
import { sum2 } from "./exact.ts";
import { mergeRatioSeries } from "./grid.ts";
import { publicationRuleOf, publishedOn, type PublicationRule } from "./knowledge-time.ts";

/** The values of `input`, re-dated. */
export interface DerivedLevel {
  op: "level";
  id: string;
  input: string;
  publication?: PublicationRule;
}

/** mergeRatioSeries(numerator, denominator): the ratio on shared dates, re-dated. */
export interface DerivedRatio {
  op: "ratio";
  id: string;
  numerator: string;
  denominator: string;
  publication?: PublicationRule;
}

/**
 * On each observation of `flow`, the sum of the last `periods` observations
 * (counted as observations, not calendar months) over the latest `level` value
 * public by that observation date:
 *   value = ((negate ? -sum : sum) / divisor / G) * multiplier
 * summation "plain" adds left to right with `+`; "compensated" is the sum
 * rollingSum gives (sum2). A level value dated d is public on
 * publishedOn(d, levelPublication), and counts from that day on. A non-finite
 * value (no level public yet) gives no point.
 */
export interface DerivedRollingSumOverKnownLevel {
  op: "rolling-sum-over-known-level";
  id: string;
  flow: string;
  level: string;
  periods: number;
  summation: "plain" | "compensated";
  negate: boolean;
  divisor: number;
  multiplier: number;
  levelPublication: PublicationRule;
  publication?: PublicationRule;
}

/**
 * The share of volume on up days over `window` rows. Rows are the `volume`
 * points whose date also has a `close` and whose volume is above 0. A row is
 * an up day when its close is strictly above the previous row's close. The
 * first value needs window + 1 rows.
 */
export interface DerivedUpVolumeShare {
  op: "up-volume-share";
  id: string;
  close: string;
  volume: string;
  window: number;
  publication?: PublicationRule;
}

export type DerivedSeries = DerivedLevel | DerivedRatio | DerivedRollingSumOverKnownLevel | DerivedUpVolumeShare;

// Raised when a declaration names an input series that was not supplied.
export class DerivedSeriesError extends Error {
  constructor(readonly seriesId: string, readonly inputId: string) {
    super(`derived series ${seriesId}: input series ${JSON.stringify(inputId)} is missing`);
    this.name = "DerivedSeriesError";
  }
}

/** The input series ids a declaration reads, in declaration order (issue 1753). */
export function derivedInputIds(d: DerivedSeries): string[] {
  switch (d.op) {
    case "level":
      return [d.input];
    case "ratio":
      return [d.numerator, d.denominator];
    case "rolling-sum-over-known-level":
      return [d.flow, d.level];
    case "up-volume-share":
      return [d.close, d.volume];
    default:
      throw new RangeError(`derived series ${(d as { id?: unknown }).id}: unknown op ${JSON.stringify((d as { op?: unknown }).op)}`);
  }
}

const positiveInt = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n > 0;

// The named input, sorted by date (stable). The caller's array is not changed.
function input(d: DerivedSeries, inputs: Readonly<Record<string, readonly Point[]>>, id: string): Point[] {
  if (typeof id !== "string" || !Object.hasOwn(inputs, id) || !Array.isArray(inputs[id])) throw new DerivedSeriesError(d.id, String(id));
  return [...inputs[id]!].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function rollingSumOverKnownLevel(d: DerivedRollingSumOverKnownLevel, inputs: Readonly<Record<string, readonly Point[]>>): Point[] {
  if (!positiveInt(d.periods)) throw new RangeError(`derived series ${d.id}: periods must be a positive integer, got ${JSON.stringify(d.periods)}`);
  if (d.summation !== "plain" && d.summation !== "compensated") {
    throw new RangeError(`derived series ${d.id}: summation must be "plain" or "compensated", got ${JSON.stringify(d.summation)}`);
  }
  if (typeof d.negate !== "boolean") throw new RangeError(`derived series ${d.id}: negate must be a boolean`);
  if (!Number.isFinite(d.divisor)) throw new RangeError(`derived series ${d.id}: divisor must be a finite number`);
  if (!Number.isFinite(d.multiplier)) throw new RangeError(`derived series ${d.id}: multiplier must be a finite number`);
  const levelRule = publicationRuleOf({ id: d.id, publication: d.levelPublication });
  const flow = input(d, inputs, d.flow);
  const level = input(d, inputs, d.level).map((p) => ({ value: p.value, pub: publishedOn(p.date, levelRule) }));
  const out: Point[] = [];
  for (let i = d.periods - 1; i < flow.length; i++) {
    const first = i - (d.periods - 1);
    let sum: number;
    if (d.summation === "plain") {
      sum = flow[first]!.value;
      for (let j = first + 1; j <= i; j++) sum = sum + flow[j]!.value;
    } else {
      sum = sum2(flow.slice(first, i + 1).map((p) => p.value));
    }
    // G: the latest level value, by level date, public on or before this day.
    let g = NaN;
    for (let k = level.length - 1; k >= 0; k--) {
      if (level[k]!.pub <= flow[i]!.date) { g = level[k]!.value; break; }
    }
    // Negate, then the divisor, then G, then the multiplier: the order is the contract.
    const value = ((d.negate ? -sum : sum) / d.divisor / g) * d.multiplier;
    if (Number.isFinite(value)) out.push({ date: flow[i]!.date, value });
  }
  return out;
}

function upVolumeShare(d: DerivedUpVolumeShare, inputs: Readonly<Record<string, readonly Point[]>>): Point[] {
  if (!positiveInt(d.window)) throw new RangeError(`derived series ${d.id}: window must be a positive integer, got ${JSON.stringify(d.window)}`);
  const close = new Map(input(d, inputs, d.close).map((p) => [p.date, p.value]));
  const rows = input(d, inputs, d.volume)
    .filter((p) => close.has(p.date) && p.value > 0)
    .map((p) => ({ date: p.date, volume: p.value, close: close.get(p.date)! }));
  const out: Point[] = [];
  for (let i = d.window; i < rows.length; i++) {
    let all = 0;
    let up = 0;
    for (let j = i - (d.window - 1); j <= i; j++) {
      all = all + rows[j]!.volume;
      // Strictly above the previous row (not the previous calendar day): a tie is not an up day.
      if (rows[j]!.close > rows[j - 1]!.close) up = up + rows[j]!.volume;
    }
    out.push({ date: rows[i]!.date, value: up / all });
  }
  return out;
}

/**
 * The series `declaration` describes, computed from `inputs` (supplementary
 * series by id, in any date order). Throws DerivedSeriesError for a missing
 * input, RangeError for a malformed declaration and PublicationRuleError for a
 * malformed publication rule.
 */
export function deriveSeries(declaration: DerivedSeries, inputs: Readonly<Record<string, readonly Point[]>>): Point[] {
  const d = declaration;
  const rule: PublicationRule =
    d.publication === undefined ? { kind: "same-day" } : publicationRuleOf({ id: d.id, publication: d.publication });
  let points: Point[];
  switch (d.op) {
    case "level":
      points = input(d, inputs, d.input);
      break;
    case "ratio":
      points = mergeRatioSeries(input(d, inputs, d.numerator), input(d, inputs, d.denominator));
      break;
    case "rolling-sum-over-known-level":
      points = rollingSumOverKnownLevel(d, inputs);
      break;
    case "up-volume-share":
      points = upVolumeShare(d, inputs);
      break;
    default:
      throw new RangeError(`derived series ${(d as { id?: unknown }).id}: unknown op ${JSON.stringify((d as { op?: unknown }).op)}`);
  }
  return points.map((p) => ({ date: publishedOn(p.date, rule), value: p.value }));
}
