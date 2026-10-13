// The allocation backtest: the same engine as the allocation-proposals page
// (daily NAV, rebalance to the decided weights at each decision date, cost =
// one-sided turnover x 10 bps, stats on calendar days), generalized from a fixed
// quarterly target to a weekly decision series. Pure: series come in as arrays.
import type { Weights } from "./types.ts";
import { turnover } from "./rules.ts";

export interface Series { dateAxis: string[]; values: Record<string, number[]> }

export interface PathResult {
  nav: number[]; // one per day from start to end inclusive, nav[0] = 1
  costs: number; // total cost as a fraction of NAV
  turnover: number; // total one-sided turnover, percent of NAV
  rebalances: number; // decision dates where weights actually changed
}

// decisions: trade date (YYYY-MM-DD) -> weights in percent. The weights in force
// on the first day are the latest decision on or before it (else the earliest).
// Trade only when the target changed since the last decision, or a holding drifted
// more than max(bandPts, bandRel x target) from its target (the page's rebalance rule;
// bandPtsBySeries overrides the points for one series, e.g. 3 for Bitcoin).
export function runPath(series: Series, decisions: Map<string, Weights>, s: number, e: number, costBps = 10, bandPts = 2, bandRel = 0.25, bandPtsBySeries: Record<string, number> = {}): PathResult {
  const D = series.dateAxis;
  const px = (k: string, i: number) => {
    const v = series.values[k]?.[i];
    if (v === undefined || !Number.isFinite(v)) throw new Error(`no price for ${k} on ${D[i]}`);
    return v;
  };
  const dates = [...decisions.keys()].sort();
  let w0: Weights | undefined;
  for (const d of dates) if (d <= D[s]) w0 = decisions.get(d);
  if (!w0) w0 = decisions.get(dates[0]!)!;
  let cur: Weights = { ...w0 };
  let h: Record<string, number> = {};
  for (const k in cur) h[k] = cur[k]! / 100 / px(k, s);
  const nav = [1];
  let costs = 0, to = 0, rebalances = 0;
  for (let i = s + 1; i <= e; i++) {
    let v = 0;
    for (const k in h) v += h[k]! * px(k, i);
    const next = decisions.get(D[i]!);
    if (next && i < e) {
      // actual weights right now, then the move to the new target
      const actual: Weights = {};
      for (const k in h) actual[k] = (h[k]! * px(k, i) / v) * 100;
      const t = turnover(actual, next);
      const targetChanged = turnover(cur, next) > 1e-9;
      const drifted = Object.keys(next).some((k) => Math.abs((actual[k] ?? 0) - next[k]!) > Math.max(bandPtsBySeries[k] ?? bandPts, bandRel * next[k]!));
      if (t > 1e-9 && (targetChanged || drifted)) {
        const c = (t / 100) * (costBps / 1e4);
        v *= 1 - c; costs += c; to += t; rebalances++;
        h = {};
        for (const k in next) h[k] = (next[k]! / 100) * v / px(k, i);
        cur = { ...next };
      }
    }
    nav.push(v);
  }
  return { nav, costs, turnover: to, rebalances };
}

export interface Stats { total: number; cagr: number; vol: number; maxdd: number }

export function stats(nav: number[]): Stats {
  const n = nav.length - 1;
  const tot = nav[n]! / nav[0]! - 1;
  const cagr = Math.pow(1 + tot, 365 / n) - 1;
  const r: number[] = [];
  for (let i = 1; i <= n; i++) r.push(nav[i]! / nav[i - 1]! - 1);
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1)) * Math.sqrt(365);
  let pk = nav[0]!, dd = 0;
  for (const v of nav) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); }
  return { total: tot * 100, cagr: cagr * 100, vol: sd * 100, maxdd: dd * 100 };
}

// Stats over a sub-period of one continuous path (Lex's phase table: CAGR over
// the phase, worst drop within the phase), without restarting the path.
export function phaseStats(nav: number[], dateAxis: string[], s: number, from: string, to: string): Stats | null {
  const i0 = dateAxis.findIndex((d, i) => i >= s && d >= from);
  let i1 = -1;
  for (let i = dateAxis.length - 1; i >= s; i--) if (dateAxis[i]! <= to) { i1 = i; break; }
  if (i0 < 0 || i1 <= i0) return null;
  return stats(nav.slice(i0 - s, i1 - s + 1));
}
