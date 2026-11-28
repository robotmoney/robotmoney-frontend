// A synthetic two-year market for the issue 1766 tests: BTC and ETH every
// day, the S&P 500 and GLD on weekdays (none on 2023-07-04 or 2024-01-01),
// a T-bill quote on weekdays (below zero on 2023-03-15), and composite and
// panel labels that start on the tenth day and change every few weeks.
// Deterministic: a fixed linear congruential generator.
import type { BacktestLabels } from "../../src/analyze/backtest.ts";
import type { Point } from "../../src/types.ts";

export const dayFrom = (start: string, i: number) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
export const axisBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let i = 0; dayFrom(from, i) <= to; i++) out.push(dayFrom(from, i));
  return out;
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const weekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6;
};
const HOLIDAYS = new Set(["2023-07-04", "2024-01-01"]);

export interface SyntheticMarket {
  axis: string[];
  prices: Record<"btc" | "eth" | "sp500" | "gld", Point[]>;
  cashQuotes: Point[];
  labels: BacktestLabels;
}

export function syntheticMarket(from = "2023-01-01", to = "2024-12-31"): SyntheticMarket {
  const axis = axisBetween(from, to);
  const walk = (seed: number, start: number, vol: number, drift: number, open: (d: string) => boolean): Point[] => {
    const r = rng(seed);
    let v = start;
    const out: Point[] = [];
    for (const d of axis) {
      v *= 1 + drift + vol * (r() - 0.5);
      if (open(d)) out.push({ date: d, value: v });
    }
    return out;
  };
  const exchange = (d: string) => weekday(d) && !HOLIDAYS.has(d);
  const prices = {
    btc: walk(1, 20_000, 0.08, 0.001, () => true),
    eth: walk(2, 1_500, 0.1, 0.001, () => true),
    sp500: walk(3, 4_000, 0.03, 0.0004, exchange),
    gld: walk(4, 170, 0.02, 0.0002, exchange),
  };
  const cashQuotes = axis.filter(exchange).map((d, i) => ({ date: d, value: d === "2023-03-15" ? -0.02 : 4 + 0.5 * Math.sin(i / 40) }));
  const states = ["risk_off", "neutral", "risk_on"] as const;
  const label = (seed: number) => {
    const r = rng(seed);
    let cur: string = "neutral";
    return axis.map((d, i) => {
      if (d < dayFrom(from, 9)) return null;
      if (i % 17 === 0) cur = states[Math.floor(r() * 3)]!;
      // a day with no label inside the history: carried forward by the curves
      return d === "2023-06-15" ? null : cur;
    });
  };
  const labels: BacktestLabels = { regime: label(11), panelRegimes: { macro: label(12), onchain: label(13) }, panels: ["macro", "onchain"] };
  return { axis, prices, cashQuotes, labels };
}
