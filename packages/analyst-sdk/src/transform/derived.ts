// Derived series (issue 1751, gap 7). Pure: no fs, env, db or network.
//
// A DerivedSeries declares, as plain data, a series computed from
// supplementary series, and deriveSeries computes it. The four data ops
// reproduce the downstream FISCAL, SKEW, VIX_TERM and UPVOL_SHARE series bit for bit, so
// the order of every addition and division below is part of the contract.
//
// Every op but custom takes an optional publication rule: each output date is
// moved to the day that value is published (publishedOn). Without one the
// dates stay.
//
// The custom op (issue 1765, phase 5) is a research indicator written as a
// pure function with a declared publication lag, so a new indicator needs no
// SDK release. deriveSeries calls it once per calendar day, and cuts every
// input before the call, so the function never reads a value dated after the
// day minus its lag.
import type { Point } from "../types.ts";
import { sum2 } from "./exact.ts";
import { mergeRatioSeries } from "./grid.ts";
import { publicationRuleOf, publishedOn, type PublicationRule } from "./knowledge-time.ts";
import { V5_INPUT_IDS } from "../analyze/indicators.ts";

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

/**
 * A research indicator as a pure function (issue 1765, phase 5). On each
 * calendar day `day`, `fn(inputs, day)` gives the value known on that day, or
 * null for none. `lagDays` is the declared publication lag: `inputs` holds only
 * the points of each named input dated on or before `day` minus `lagDays`. The
 * inputs are cut before the call, so fn cannot read a later value. The arrays
 * and points are frozen, so fn cannot change them either.
 *
 * The value is dated `day` itself: the lag is the publication rule, so a custom
 * op takes no `publication`. The days run from the first day any input point is
 * known (its date plus `lagDays`) through deriveSeries' `through` (default the
 * newest input date plus `lagDays`). A null or a non-finite number gives no
 * point.
 *
 * A function cannot be digested by value. The stage cache (engine/cache.ts)
 * therefore names a custom op by its declared `id` and `version`, never by the
 * body of `fn`. Bump `version` whenever `fn` changes: a cache that ran the old
 * fn under the same id and version serves its stale stages.
 */
export interface DerivedCustom {
  op: "custom";
  id: string;
  /** The version of `fn`. The stage cache keys a custom op by `id` and `version` only. */
  version: string;
  /** The input series ids `fn` reads, each given to it under its own id. */
  inputs: readonly string[];
  /** The publication lag in calendar days: on day d, fn sees points dated on or before d minus lagDays. */
  lagDays: number;
  fn: (inputs: Record<string, Point[]>, day: string) => number | null;
}

export type DerivedSeries = DerivedLevel | DerivedRatio | DerivedRollingSumOverKnownLevel | DerivedUpVolumeShare | DerivedCustom;

// Raised when a declaration names an input series that was not supplied.
export class DerivedSeriesError extends Error {
  constructor(readonly seriesId: string, readonly inputId: string) {
    super(`derived series ${seriesId}: input series ${JSON.stringify(inputId)} is missing`);
    this.name = "DerivedSeriesError";
  }
}

// ── Methodology v5 (issue 1753, decision D96) ───────────────────────────────
// The four derived indicators of the v5 registry (analyze/indicators.ts
// V5_INDICATORS), as declarations. The publication lag of each is stated here,
// once, as a calendar-days rule.
const NEXT_DAY: PublicationRule = { kind: "calendar-days", days: 1 };

/** The four derived series of v5, by indicator id. */
export const V5_DERIVED_SERIES: readonly DerivedSeries[] = Object.freeze([
  {
    op: "rolling-sum-over-known-level",
    id: "FISCAL",
    flow: V5_INPUT_IDS.deficit,
    level: V5_INPUT_IDS.gdp,
    periods: 12,
    // The plain in-order sum: the published golden holds it, and a compensated sum differs in the last digit.
    summation: "plain",
    negate: true,
    divisor: 1000,
    multiplier: 100,
    // A GDP observation is public 120 calendar days after its date; the result 43 days after the month's date.
    levelPublication: { kind: "calendar-days", days: 120 },
    publication: { kind: "calendar-days", days: 43 },
  },
  { op: "ratio", id: "VIX_TERM", numerator: V5_INPUT_IDS.vix3m, denominator: V5_INPUT_IDS.vix, publication: NEXT_DAY },
  { op: "level", id: "SKEW", input: V5_INPUT_IDS.skew, publication: NEXT_DAY },
  { op: "up-volume-share", id: "UPVOL_SHARE", close: V5_INPUT_IDS.close, volume: V5_INPUT_IDS.volume, window: 20, publication: NEXT_DAY },
] satisfies DerivedSeries[]);

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
    case "custom":
      checkCustom(d);
      return [...d.inputs];
    default:
      throw new RangeError(`derived series ${(d as { id?: unknown }).id}: unknown op ${JSON.stringify((d as { op?: unknown }).op)}`);
  }
}

const positiveInt = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n > 0;

// A custom declaration's fields; a RangeError names the bad one.
function checkCustom(d: DerivedCustom): void {
  if (typeof d.id !== "string" || d.id === "") throw new RangeError(`derived series ${JSON.stringify(d.id)}: a custom op needs a non-empty string id`);
  if (typeof d.version !== "string" || d.version === "") {
    throw new RangeError(`derived series ${d.id}: version must be a non-empty string (the stage cache names fn by id and version), got ${JSON.stringify(d.version)}`);
  }
  if (!Array.isArray(d.inputs) || d.inputs.length === 0 || d.inputs.some((id) => typeof id !== "string" || id === "")) {
    throw new RangeError(`derived series ${d.id}: inputs must be a non-empty list of input series ids, got ${JSON.stringify(d.inputs)}`);
  }
  if (new Set(d.inputs).size !== d.inputs.length) throw new RangeError(`derived series ${d.id}: inputs names a series twice: ${JSON.stringify(d.inputs)}`);
  if (typeof d.lagDays !== "number" || !Number.isInteger(d.lagDays) || d.lagDays < 0) {
    throw new RangeError(`derived series ${d.id}: lagDays must be an integer of 0 or more, got ${JSON.stringify(d.lagDays)}`);
  }
  if (typeof d.fn !== "function") throw new RangeError(`derived series ${d.id}: fn must be a function`);
}

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

const DAY_MS = 86_400_000;
// The calendar day `n` days after `day` (YYYY-MM-DD, UTC). A bad date is a RangeError.
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// The custom op: fn on every calendar day, each input cut at the day minus the lag first.
function custom(d: DerivedCustom, inputs: Readonly<Record<string, readonly Point[]>>, through: string | undefined): Point[] {
  checkCustom(d);
  // Each input sorted by date, as frozen copies of its points.
  const series = d.inputs.map((id) => input(d, inputs, id).map((p) => Object.freeze({ date: p.date, value: p.value })));
  let first: string | undefined;
  let last: string | undefined;
  for (const s of series) {
    if (s.length === 0) continue;
    if (first === undefined || s[0]!.date < first) first = s[0]!.date;
    if (last === undefined || s[s.length - 1]!.date > last) last = s[s.length - 1]!.date;
  }
  if (through !== undefined && (typeof through !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(through))) {
    throw new RangeError(`derived series ${d.id}: through must be a YYYY-MM-DD day, got ${JSON.stringify(through)}`);
  }
  if (first === undefined || last === undefined) return [];
  const end = through ?? addDays(last, d.lagDays);
  // How many points of each input are known, and the frozen prefix fn reads. A
  // prefix is copied again only on a day a new point of that input is known.
  const known = series.map(() => 0);
  const cut: Point[][] = series.map(() => Object.freeze([]) as unknown as Point[]);
  let view: Record<string, Point[]> | undefined;
  const out: Point[] = [];
  for (let day = addDays(first, d.lagDays); day <= end; day = addDays(day, 1)) {
    const cutoff = addDays(day, -d.lagDays);
    let moved = view === undefined;
    series.forEach((s, j) => {
      let k = known[j]!;
      while (k < s.length && s[k]!.date <= cutoff) k++;
      if (k !== known[j]) {
        known[j] = k;
        cut[j] = Object.freeze(s.slice(0, k)) as Point[];
        moved = true;
      }
    });
    if (moved) view = Object.freeze(Object.fromEntries(d.inputs.map((id, j) => [id, cut[j]!])));
    const value = d.fn(view!, day);
    if (value === null) continue;
    if (typeof value !== "number") throw new RangeError(`derived series ${d.id}: fn must return a number or null, got ${JSON.stringify(value)} on ${day}`);
    if (Number.isFinite(value)) out.push({ date: day, value });
  }
  return out;
}

/** What deriveSeries reads besides the declaration and its inputs. */
export interface DeriveOptions {
  /** The last day a custom op is evaluated (default its newest input date plus its lag). The other ops ignore it. */
  through?: string;
}

/**
 * The series `declaration` describes, computed from `inputs` (supplementary
 * series by id, in any date order). Throws DerivedSeriesError for a missing
 * input, RangeError for a malformed declaration and PublicationRuleError for a
 * malformed publication rule.
 */
export function deriveSeries(declaration: DerivedSeries, inputs: Readonly<Record<string, readonly Point[]>>, opts: DeriveOptions = {}): Point[] {
  const d = declaration;
  // A custom op dates each value on its own day: its lag is its publication rule.
  if (d.op === "custom") return custom(d, inputs, opts.through);
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
