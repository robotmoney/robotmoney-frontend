// The checks an output must pass before it is stored (issue 1766): results
// that are impossible in theory or contradict each other. Three validators,
// each reading only the outputs and returning one sentence per violation (an
// empty list when the output holds): each equity curve's own checks, the
// checks across curves, and each weighting rule's own rule. Ported from the
// research workbench's invariants.ts (experiment-lex-equity-lucky-rev). A
// comparison of computed numbers allows a relative error of 1e-9. Pure.
import { samplingOf, type Sampling } from "./backtest.ts";
import { monthsBefore, trailingKey, type CurveGroup, type EquityCurve, type Window } from "./equity-curves.ts";
import { riskContributions, tangencyExact } from "../allocate/optimize.ts";
import { WEIGHTING_RULE_KEYS, type WeightingFigures } from "../allocate/weighting-rules.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const DAY_MS = 86_400_000;
/** Calendar days from `a` to `b`. */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

export interface EquityCurveCheckOptions {
  trailingMonths: readonly number[];
  sampling: Sampling;
  /** Days whose cash quote is below zero: cash may lose value in a window holding one, or the week after one. */
  negativeQuoteDays?: readonly string[];
}

/**
 * One equity curve's own checks: the sampled curve starts at exactly 1 on its
 * first day, every point between its first and its last is on the sampling
 * weekday (under month-end, in a month of its own), it ends on its last day,
 * and it is finite and positive; since inception spans the curve and its
 * final value is the curve's last value; each trailing window is present
 * exactly when the curve covers it and spans N months to the last day; every
 * window measures one daily return per calendar day; every window's figures
 * are finite; cash scores a Sharpe ratio of 0; the CAGR has the sign of the
 * final value less 1; the maximum drawdown lies in [-1, 0] and is at least as
 * deep as the sampled curve's; a benchmark or cash never trades; and cash
 * never loses value in a window with no negative quote within it or the week
 * before.
 */
export function equityCurveViolations(name: string, curve: EquityCurve, options: EquityCurveCheckOptions): string[] {
  const out: string[] = [];
  const sampling = samplingOf(options.sampling);
  const negative = options.negativeQuoteDays ?? [];
  const cash = curve.kind === "cash";
  const points = curve.equity_curve;
  const all = curve.windows.since_inception;
  const first = points[0];
  if (first === undefined) return [`${name}: the equity curve is empty`];
  if (first.date !== curve.first_day || first.value !== 1) out.push(`${name}: the equity curve starts on ${first.date} at ${first.value}, not at 1 on its first day ${curve.first_day}`);
  const inner = points.slice(1, -1);
  if (sampling.kind === "weekday") {
    for (const p of inner) if (weekdayOf(p.date) !== sampling.weekday) out.push(`${name}: the equity curve has a point on ${p.date}, not on weekday ${sampling.weekday}`);
  } else {
    const months = inner.map((p) => p.date.slice(0, 7));
    if (new Set(months).size !== months.length) out.push(`${name}: the month-end equity curve has two points in one month`);
  }
  const last = points[points.length - 1]!;
  if (last.date !== curve.last_day) out.push(`${name}: the equity curve ends on ${last.date}, its last day is ${curve.last_day}`);
  for (const p of points) if (!(p.value > 0 && Number.isFinite(p.value))) out.push(`${name}: the equity curve is ${p.value} on ${p.date}`);
  if (all.first_day !== curve.first_day || all.last_day !== curve.last_day) out.push(`${name}: since inception spans ${all.first_day} to ${all.last_day}, the curve ${curve.first_day} to ${curve.last_day}`);
  if (!close(all.final_value, last.value)) out.push(`${name}: final value ${all.final_value} is not the curve's last value ${last.value}`);
  if (!close(curve.final_value, all.final_value)) out.push(`${name}: final value ${curve.final_value} is not since inception's ${all.final_value}`);

  const windows: [string, Window | null | undefined, number | null][] = [["since inception", all, null], ...options.trailingMonths.map((m): [string, Window | null | undefined, number] => [trailingKey(m), curve.windows[trailingKey(m)], m])];
  for (const [label, w, months] of windows) {
    const at = `${name} ${label}`;
    if (months !== null) {
      const from = monthsBefore(curve.last_day, months);
      if (w === undefined || (w === null) !== (from < curve.first_day)) {
        out.push(`${at}: ${w ? "present on a curve that does not cover it" : "missing on a curve that covers it"}`);
        continue;
      }
      if (w === null) continue;
      if (w.last_day !== curve.last_day) out.push(`${at}: ends on ${w.last_day}, the curve on ${curve.last_day}`);
      if (w.first_day !== from) out.push(`${at}: starts on ${w.first_day}, not ${months} months before ${curve.last_day}`);
    }
    if (!w) continue;
    for (const k of ["final_value", "cagr", "sharpe", "max_drawdown"] as const) if (!Number.isFinite(w[k])) out.push(`${at}: ${k} is ${w[k]}`);
    if (w.n_days !== daysBetween(w.first_day, w.last_day)) out.push(`${at}: ${w.n_days} daily returns, not the ${daysBetween(w.first_day, w.last_day)} days from ${w.first_day} to ${w.last_day}`);
    if (cash && w.sharpe !== 0) out.push(`${at}: cash has Sharpe ratio ${w.sharpe}, not 0`);
    if (Math.sign(w.cagr) !== Math.sign(w.final_value - 1)) out.push(`${at}: CAGR ${w.cagr} and final value ${w.final_value} disagree in sign`);
    if (!(w.max_drawdown <= 0 && w.max_drawdown >= -1)) out.push(`${at}: maximum drawdown ${w.max_drawdown} is outside [-1, 0]`);
    if (curve.kind !== "strategy" && w.trades !== 0) out.push(`${at}: a ${cash ? "cash" : "buy-and-hold"} benchmark traded ${w.trades} times`);
    if (cash && !negative.some((d) => daysBetween(d, w.first_day) <= 7 && d <= w.last_day)) {
      if (w.max_drawdown < -1e-12) out.push(`${at}: cash has a drawdown of ${w.max_drawdown} with no cash quote below zero`);
      if (w.final_value < 1) out.push(`${at}: cash ends at ${w.final_value}, below 1, with no cash quote below zero`);
    }
    let peak = -Infinity;
    let worst = 0;
    for (const p of points) {
      if (p.date < w.first_day || p.date > w.last_day) continue;
      peak = Math.max(peak, p.value);
      worst = Math.min(worst, p.value / peak - 1);
    }
    if (w.max_drawdown > worst + 1e-9) out.push(`${at}: maximum drawdown ${w.max_drawdown} is shallower than its own sampled curve's ${worst}`);
  }
  return out;
}

export interface CrossCurveCheckOptions {
  lastAxisDay: string;
  trailingMonths: readonly number[];
  commonPeriodMonths: number;
}

/** The figures two curves that hold the same thing share in a window. */
const SHARED = ["first_day", "n_days", "final_value", "cagr", "sharpe", "max_drawdown"] as const;

/**
 * The checks across curves: every curve ends on lastAxisDay and covers the
 * common period (the trailing window of commonPeriodMonths) from one start
 * day, and every two cash or buy-and-hold curves that hold the same thing
 * (the same name), in any group, have the same first day, day count, final
 * value, CAGR, Sharpe ratio and maximum drawdown to 1e-9 in every window both
 * have from the same first day.
 */
export function crossCurveViolations(groups: Readonly<Record<string, CurveGroup>>, options: CrossCurveCheckOptions): string[] {
  const out: string[] = [];
  const curves = Object.entries(groups).flatMap(([g, cs]) => Object.entries(cs).map(([n, c]): [string, string, EquityCurve] => [`${g}.${n}`, n, c]));
  const starts = new Set<string>();
  for (const [full, , c] of curves) {
    if (c.last_day !== options.lastAxisDay) out.push(`${full}: ends on ${c.last_day}, not on the last axis day ${options.lastAxisDay}`);
    const common = c.windows[trailingKey(options.commonPeriodMonths)];
    if (!common) out.push(`${full}: does not cover the common period of ${options.commonPeriodMonths} months`);
    else starts.add(common.first_day);
  }
  if (starts.size > 1) out.push(`the common periods start on different days: ${[...starts].sort().join(", ")}`);
  const byHolding = new Map<string, [string, EquityCurve][]>();
  for (const [full, n, c] of curves) {
    if (c.kind === "strategy") continue;
    byHolding.set(n, [...(byHolding.get(n) ?? []), [full, c]]);
  }
  const keys = ["since_inception", ...options.trailingMonths.map(trailingKey)] as const;
  for (const same of byHolding.values()) {
    same.forEach(([an, a], i) => {
      for (const [bn, b] of same.slice(i + 1)) {
        if (a === b) continue;
        for (const key of keys) {
          const wa = a.windows[key as "since_inception"];
          const wb = b.windows[key as "since_inception"];
          if (!wa || !wb || wa.first_day !== wb.first_day) continue;
          for (const k of SHARED) {
            const x = wa[k];
            const y = wb[k];
            if (typeof x === "string" || typeof y === "string" ? x !== y : !close(x, y)) out.push(`${an} and ${bn} hold the same thing, and their ${key} ${k} differs: ${x} against ${y}`);
          }
        }
      }
    });
  }
  return out;
}

export interface WeightingRuleCheckOptions {
  riskBudget: Readonly<Record<string, number>>;
  expectedReturn: Readonly<Record<string, number>>;
  riskOnShare: Readonly<Record<string, number>>;
  /** The newest label (carried), the one the targets read; null with none. */
  label: string | null;
}

/**
 * Each weighting rule's own rule: money shares are long only and sum to 1;
 * risk shares sum to 1 and are riskContributions of the money shares under the
 * covariance the rule solved on (covariance_full for markowitz, covariance_1y
 * for the others); each rule meets its rule under that covariance (naive a
 * share each, inverse_vol equal weight times volatility, equal_risk an equal
 * share of the risk each, risk_budget each class its budget's risk share,
 * min_variance no other risk rule with a lower variance, markowitz the
 * tangency mix of the expected returns less cash_rate); and each target is
 * the risk-on share of the newest label times the money shares, the rest cash.
 */
export function weightingRuleViolations(figures: WeightingFigures, options: WeightingRuleCheckOptions): string[] {
  const out: string[] = [];
  const classes = figures.assets;
  const vec = (x: Readonly<Record<string, number>>) => classes.map((c) => x[c] ?? NaN);
  const S = figures.covariance_1y;
  const covOf = (key: string) => (key === "markowitz" ? figures.covariance_full : S);
  const variance = (w: readonly number[]) => w.reduce((a, wi, i) => a + wi * S[i]!.reduce((b, sij, j) => b + sij * w[j]!, 0), 0);
  const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);
  const n = classes.length;
  for (const key of WEIGHTING_RULE_KEYS) {
    const e = figures.engines[key];
    if (e === undefined) {
      out.push(`no ${key} weighting rule`);
      continue;
    }
    const w = vec(e.money);
    for (const [c, x] of Object.entries(e.money)) if (!(x >= -1e-12)) out.push(`${key}: ${c} has money share ${x}`);
    if (!close(sum(w), 1)) out.push(`${key}: the money shares sum to ${sum(w)}`);
    const r = vec(e.risk);
    if (!close(sum(r), 1)) out.push(`${key}: the risk shares sum to ${sum(r)}`);
    if (!riskContributions(covOf(key), w).every((x, i) => close(x, r[i]!, 1e-6))) out.push(`${key}: the risk shares are not the money shares' risk contributions under its covariance`);
    const s = options.label === null ? undefined : options.riskOnShare[options.label];
    const target: Record<string, number> | null = s === undefined ? null : { cash: 1 - s, ...Object.fromEntries(classes.map((c) => [c, s * e.money[c]!])) };
    const same = target === null || e.target === null ? target === e.target : Object.keys({ ...target, ...e.target }).every((k) => close(target[k] ?? NaN, e.target![k] ?? NaN));
    if (!same) out.push(`${key}: the target ${JSON.stringify(e.target)} is not the risk-on share of the newest label times the money shares`);
  }
  const rule = (key: (typeof WEIGHTING_RULE_KEYS)[number], ok: (w: number[], r: number[]) => boolean, says: string) => {
    const e = figures.engines[key];
    if (e !== undefined && !ok(vec(e.money), vec(e.risk))) out.push(`${key}: ${says}`);
  };
  const excess = () => vec(options.expectedReturn).map((m) => m - figures.cash_rate);
  rule("naive", (w) => w.every((x) => close(x, 1 / n)), `the money shares are not 1/${n} each`);
  rule("inverse_vol", (w) => w.every((x, i) => close(x * Math.sqrt(S[i]![i]!), w[0]! * Math.sqrt(S[0]![0]!), 1e-6)), "money share times volatility differs across classes");
  rule("equal_risk", (w) => riskContributions(S, w).every((x) => close(x, 1 / n, 1e-6)), `the classes do not carry 1/${n} of the risk each`);
  rule("risk_budget", (w) => riskContributions(S, w).every((x, i) => close(x, options.riskBudget[classes[i]!] ?? NaN, 1e-6)), `the classes do not carry their risk budget ${JSON.stringify(options.riskBudget)}`);
  rule(
    "min_variance",
    (w) => WEIGHTING_RULE_KEYS.filter((k) => k !== "markowitz" && figures.engines[k] !== undefined).every((k) => variance(w) <= variance(vec(figures.engines[k].money)) + 1e-12),
    "another risk rule has a lower variance",
  );
  rule("markowitz", (w) => tangencyExact(figures.covariance_full, excess()).every((x, i) => close(x, w[i]!, 1e-6)), "the money shares are not the tangency mix of covariance_full and the expected returns less cash_rate");
  return out;
}
