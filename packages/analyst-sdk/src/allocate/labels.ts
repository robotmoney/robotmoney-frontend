// Point-in-time regime labels (issue 1399): one runRegime per decision date,
// as-of that date, so no row dated after the decision is seen. A single
// full-history run uses end-of-history panel weights for every day, so its past
// labels carry hindsight; `hindsight` counts how many labels that changes.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
// The cache is a store the caller injects (a Map works); an on-disk cache is the
// caller's adapter, never this module's.
import { createHash } from "node:crypto";
import type { RawIndicatorHistory } from "../types.ts";
import { runRegime, BACKFILL_START, type RunResult } from "../run.ts";
import { INDICATORS } from "../analyze/indicators.ts";
import { combineAggressiveN, combineConservativeN } from "../analyze/backtest.ts";
import { CURRENT_REGIME_VERSION } from "../analyze/regime-versions.ts";

export type RegimeState = "risk_off" | "neutral" | "risk_on";

/** One decision: the day weights change, and the last day of data it may see. */
export interface DecisionDate {
  date: string;
  asof: string;
}

/** `weekly`: every Monday, as-of the Friday before. `daily`: every day, as-of the day before. */
export type DecisionCadence = "weekly" | "daily";

export interface PanelLabel {
  label: RegimeState | null;
  percentile: number | null;
}

/** The regime as it read on one as-of day. Every number is finite or null, never NaN. */
export interface AsofLabel {
  date: string;
  asof: string;
  /** The composite regime label. */
  label: RegimeState | null;
  /** Panel labels combined: any risk_off wins (conservative), or the majority (aggressive). */
  conservative: RegimeState | null;
  aggressive: RegimeState | null;
  compositePercentile: number | null;
  /** Per panel (macro, onchain): its label and percentile. */
  panels: Record<string, PanelLabel>;
  /**
   * Per registry indicator id (every id in INDICATORS): the sign-aligned
   * percentile rank, 0..1 with high meaning risk-on, or null when the indicator
   * had no data on the as-of day.
   */
  indicators: Record<string, number | null>;
}

/** The injected cache. `new Map<string, AsofLabel>()` satisfies it. */
export interface LabelCache {
  get(key: string): AsofLabel | undefined;
  set(key: string, value: AsofLabel): unknown;
}

const DAY_MS = 864e5;
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const minusDays = (d: string, n: number) => toDay(ms(d) - n * DAY_MS);

function assertIsoDate(name: string, v: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || toDay(ms(v)) !== v) {
    throw new RangeError(`${name} must be a real date in YYYY-MM-DD form, got ${JSON.stringify(v)}`);
  }
}

/**
 * The decision calendar from `start` to `end` inclusive. The first decision is
 * `start` itself, as-of the day before (the backtest opens on its first day).
 * Weekly: then every Monday after `start`, as-of the Friday before. Daily: every
 * day after `start`, as-of the day before.
 */
export function decisionDates(start: string, end: string, cadence: DecisionCadence = "weekly"): DecisionDate[] {
  assertIsoDate("start", start);
  assertIsoDate("end", end);
  if (end < start) throw new RangeError(`end ${end} is before start ${start}`);
  if (cadence !== "weekly" && cadence !== "daily") throw new RangeError(`unknown cadence ${JSON.stringify(cadence)}`);
  const out: DecisionDate[] = [{ date: start, asof: minusDays(start, 1) }];
  for (let t = ms(start) + DAY_MS; t <= ms(end); t += DAY_MS) {
    const date = toDay(t);
    if (cadence === "daily") out.push({ date, asof: minusDays(date, 1) });
    else if (new Date(t).getUTCDay() === 1) out.push({ date, asof: minusDays(date, 3) });
  }
  return out;
}

/** sha256 of the input rows in a canonical order (id, then date), so equal data gives an equal hash. */
export function inputSha256(raw: RawIndicatorHistory): string {
  const h = createHash("sha256");
  for (const id of Object.keys(raw).sort()) {
    const rows = [...raw[id]!].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const r of rows) h.update(`${id},${r.date},${r.value}\n`);
  }
  return h.digest("hex");
}

/** The cache key: regime version, axis start, as-of day and the input hash. */
export function labelCacheKey(asof: string, inputHash: string, start: string = BACKFILL_START): string {
  return `${CURRENT_REGIME_VERSION}|${start}|${asof}|${inputHash}`;
}

const state = (s: string | null | undefined): RegimeState | null =>
  s === "risk_off" || s === "neutral" || s === "risk_on" ? s : null;
const finite = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

/** Read one day of a run as an AsofLabel. */
export function labelAt(run: RunResult, date: string, asof: string): AsofLabel {
  const r = run.result;
  const at = run.dateAxis.lastIndexOf(asof);
  const i = at >= 0 ? at : run.dateAxis.length - 1;
  const panels: Record<string, PanelLabel> = {};
  for (const p of r.panels) {
    panels[p] = { label: state(r.panelRegimes[p]?.[i]), percentile: finite(r.panelPercentiles[p]?.[i]) };
  }
  const panelLabels = r.panels.map((p) => panels[p]!.label);
  const indicators: Record<string, number | null> = {};
  for (const ind of INDICATORS) indicators[ind.id] = finite(r.signed[ind.id]?.[i]);
  return {
    date,
    asof,
    label: state(r.regime[i]),
    conservative: state(combineConservativeN(panelLabels)),
    aggressive: state(combineAggressiveN(panelLabels)),
    compositePercentile: finite(r.compositePercentile[i]),
    panels,
    indicators,
  };
}

/** The label for one decision, from a run that sees only rows dated on or before `asof`. */
export function asofLabel(raw: RawIndicatorHistory, d: DecisionDate, opts: { start?: string } = {}): AsofLabel {
  return labelAt(runRegime(raw, { asof: d.asof, ...(opts.start ? { start: opts.start } : {}) }), d.date, d.asof);
}

export interface AsofLabelsOptions {
  /** The decisions, e.g. `decisionDates(start, end)`. */
  dates: readonly DecisionDate[];
  /** Hit: no regime run. Miss: one run, then `set`. */
  cache?: LabelCache;
  /** The regime axis start (runRegime's `start`). Default BACKFILL_START. */
  start?: string;
}

/** One AsofLabel per decision, in order. A repeat call with the same input and cache makes no regime run. */
export function asofLabels(raw: RawIndicatorHistory, opts: AsofLabelsOptions): AsofLabel[] {
  const start = opts.start ?? BACKFILL_START;
  const hash = opts.cache ? inputSha256(raw) : "";
  return opts.dates.map((d) => {
    if (!opts.cache) return asofLabel(raw, d, { start });
    const key = labelCacheKey(d.asof, hash, start);
    const hit = opts.cache.get(key);
    // A cached label is keyed by its as-of day; two decisions may share one.
    if (hit) return { ...hit, date: d.date };
    const label = asofLabel(raw, d, { start });
    opts.cache.set(key, label);
    return label;
  });
}

export interface HindsightReport {
  /** Decisions where both the as-of label and the full-history label exist. */
  compared: number;
  /** Of those, how many differ. */
  differ: number;
  /** The decision dates that differ. */
  dates: string[];
}

/**
 * How many as-of labels differ from one full-history run as-of `end` (the
 * current view). That run's end-of-history weights are the hindsight.
 */
export function hindsight(raw: RawIndicatorHistory, labels: readonly AsofLabel[], end: string, opts: { start?: string } = {}): HindsightReport {
  const run = runRegime(raw, { asof: end, ...(opts.start ? { start: opts.start } : {}) });
  const view = new Map(run.dateAxis.map((d, i) => [d, state(run.result.regime[i])] as const));
  const out: HindsightReport = { compared: 0, differ: 0, dates: [] };
  for (const l of labels) {
    const v = view.get(l.asof);
    if (!l.label || !v) continue;
    out.compared++;
    if (l.label !== v) {
      out.differ++;
      out.dates.push(l.date);
    }
  }
  return out;
}
