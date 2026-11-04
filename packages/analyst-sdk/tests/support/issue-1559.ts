// Issue 1559 changed the reference backtest on purpose: within a market every
// strategy and baseline starts on the strategies' first labelled date, and each
// equity_curve opens with that start value (1) before the month-end values.
// The frozen originals were captured before it and are never regenerated, so
// the parity tests compare against them with this rule applied:
//
//   - S is the market's latest strategy start_date. A strategy that starts
//     before S is outside the rule and throws.
//   - A strategy keeps every number; its equity_curve gains {S, 1} when its
//     first point is not already S.
//   - A baseline (the market's hodl key and stables_only) is re-windowed to S
//     from the original's own daily values: values on and after S divided by
//     the value on S, returns read back from consecutive values (a baseline
//     pays no trading cost, so its net and pre-cost returns are the same), and
//     the statistics recomputed by periodStats over S..end_date.
//
// Rebasing and reading returns back from values move numbers by rounding only,
// so the result is compared up to rounding (support/numeric-diff.ts).
// No bun:test import: backend tests load this file too.
import { BACKTEST_IN_SAMPLE_END, periodStats, PORTFOLIO_SPECS, type BacktestMetrics, type BacktestPayload } from "../../src/analyze/backtest.ts";
import type { Point } from "../../src/types.ts";

/** portfolio -> strategy -> [date, value][]: the original daily values (originals' daily-portfolio files). */
export type DailyEvidence = Record<string, Record<string, [string, number][]>>;

const isBaseline = (market: string, name: string): boolean => name === "stables_only" || name === PORTFOLIO_SPECS[market]?.hodl.key;

function dailyOf(market: string, name: string, m: BacktestMetrics, evidence?: DailyEvidence): Point[] {
  if (m._daily) return m._daily;
  const rows = evidence?.[market]?.[name];
  if (!rows) throw new Error(`issue-1559 rule: ${market}.${name} has no daily values (pass the unstripped backtest or the daily evidence)`);
  return rows.map(([date, value]) => ({ date, value }));
}

/** The market's start: its latest strategy start_date. */
export function marketStart(market: string, strategies: Record<string, BacktestMetrics>): string {
  const starts = Object.entries(strategies).filter(([name]) => !isBaseline(market, name)).map(([, m]) => m.start_date);
  if (!starts.length) throw new Error(`issue-1559 rule: ${market} has no strategy`);
  return starts.reduce((a, b) => (b > a ? b : a));
}

/** One original backtest (stripped or not) as issue 1559 computes it. */
export function apply1559(original: BacktestPayload, evidence?: DailyEvidence): BacktestPayload {
  const out: BacktestPayload = {};
  for (const [market, strategies] of Object.entries(original)) {
    const start = marketStart(market, strategies);
    out[market] = {};
    for (const [name, m] of Object.entries(strategies)) {
      if (!isBaseline(market, name)) {
        if (m.start_date !== start) throw new Error(`issue-1559 rule: ${market}.${name} starts ${m.start_date}, before the market start ${start}`);
        const daily = m._daily;
        if (daily?.length && (daily[0]!.date !== start || daily[0]!.value !== 1)) throw new Error(`issue-1559 rule: ${market}.${name} does not open at 1 on ${start}`);
        // A strategy that never trades has no values, so no curve to open.
        const curve = !m.equity_curve.length || m.equity_curve[0]!.date === start ? m.equity_curve : [{ date: start, value: 1 }, ...m.equity_curve];
        out[market]![name] = { ...m, equity_curve: curve };
        continue;
      }
      const all = dailyOf(market, name, m, evidence);
      const at = all.findIndex((p) => p.date === start);
      if (at < 0) throw new Error(`issue-1559 rule: ${market}.${name} has no value on ${start}`);
      const base = all[at]!.value;
      const values = all.slice(at).map((p) => ({ date: p.date, value: p.value / base }));
      const returns = all.slice(at + 1).map((p, i) => ({ date: p.date, value: p.value / all[at + i]!.value - 1 }));
      if (m.transitions !== 0) throw new Error(`issue-1559 rule: baseline ${market}.${name} has trades`);
      const stats = periodStats(values, start, m.end_date, { returns, trades: [], splitDate: BACKTEST_IN_SAMPLE_END });
      if (!m._daily) delete stats._daily;
      out[market]![name] = stats;
    }
  }
  return out;
}

/** Original daily evidence as issue 1559 computes it: baselines rebased from the market start. */
export function apply1559ToDaily(evidence: DailyEvidence, original: BacktestPayload): DailyEvidence {
  const out: DailyEvidence = {};
  for (const [market, strategies] of Object.entries(evidence)) {
    const start = marketStart(market, original[market]!);
    out[market] = {};
    for (const [name, rows] of Object.entries(strategies)) {
      if (!isBaseline(market, name)) {
        out[market]![name] = rows;
        continue;
      }
      const at = rows.findIndex(([d]) => d === start);
      if (at < 0) throw new Error(`issue-1559 rule: ${market}.${name} has no daily value on ${start}`);
      const base = rows[at]![1];
      out[market]![name] = rows.slice(at).map(([d, v]) => [d, v / base]);
    }
  }
  return out;
}

/**
 * Apply the rule to every `backtest` member of a JSON report text (the shared
 * artifact, a report envelope, a snapshot row), returning the expected text.
 */
export function apply1559ToText(text: string, evidence?: DailyEvidence): string {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = k === "backtest" && x && typeof x === "object" ? apply1559(x as BacktestPayload, evidence) : visit(x);
      return o;
    }
    return v;
  };
  const indent = /^\{\n( +)"/.exec(text)?.[1]?.length ?? 0;
  return JSON.stringify(visit(JSON.parse(text)), null, indent || undefined) + (text.endsWith("\n") ? "\n" : "");
}
